import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  MetricCapability,
  TransformContext,
  TransformResult,
  UnknownArtifactBundle,
} from '@lucasschirm/sal-transformer-shared';
import { describe, expect, it } from 'vitest';
import { ClaudeCodeTransformer } from '../../src/plugin/claude-code.js';
import type { ClaudeMetricValue } from '../../src/plugin/claude-code-metrics.js';
import {
  getClaudeCodeOptimizationMetricCapabilities,
  getClaudeCodeOptimizationMetricDefinitions,
} from '../../src/plugin/claude-code-optimization-metrics.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const parserFixtures = join(__dirname, '../../../../parsers/claude-session-parser/tests/fixtures');

function fixture(name: string): string {
  return readFileSync(join(parserFixtures, name), 'utf8');
}

function artifact(relativePath: string, content: string, mediaType = 'text/plain') {
  return { relativePath, mediaType, content };
}

const defaultContext: TransformContext = {
  analysisReleaseId: 'r1',
  parserId: '@lucasschirm/sal-claude-session-parser',
  parserVersion: '0.1.0',
  sourceFingerprint: 'fp-1',
  sourceEnvironmentId: 'env-1',
  sourceProjectId: 'proj-1',
  sourceSessionId: 'sess-1',
};

function bundle(
  artifacts: { relativePath: string; mediaType: string; content: string }[],
): UnknownArtifactBundle {
  return {
    artifacts,
    sourceIdentity: {
      sourceId: 'test-source',
      environmentId: 'test-env',
      projectId: 'test-proj',
      sessionId: 'test-sess',
    },
    sourceFingerprint: 'fp-test',
  };
}

function findMetric(
  result: TransformResult,
  metricId: string,
  dimensionValue?: string,
): ClaudeMetricValue | undefined {
  const value = (result.metricValues as readonly ClaudeMetricValue[]).find((m) => {
    if (m.metricId !== metricId) return false;
    if (!dimensionValue) return true;
    return m.dimensions?.payload_type === dimensionValue;
  });
  expect(value).toBeDefined();
  return value;
}

function findCapability(caps: readonly MetricCapability[], metricId: string) {
  const cap = caps.find((c) => c.metricId === metricId);
  expect(cap).toBeDefined();
  return cap;
}

function contextAndCacheJsonl(): string {
  const lines = [
    JSON.stringify({ type: 'permission-mode', permissionMode: 'normal', sessionId: 'synth-ctx' }),
    JSON.stringify({
      type: 'mode',
      mode: 'normal',
      sessionId: 'synth-ctx',
    }),
    JSON.stringify({
      parentUuid: null,
      type: 'user',
      uuid: 'u-ctx-1',
      timestamp: '2026-08-01T10:00:00.000Z',
      timestampMs: 1_722_506_400_000,
      cwd: '/project',
      sessionId: 'synth-ctx',
      lineNumber: 3,
      message: { role: 'user', content: 'Hello' },
    }),
    JSON.stringify({
      parentUuid: 'u-ctx-1',
      type: 'assistant',
      uuid: 'a-ctx-1',
      timestamp: '2026-08-01T10:00:01.000Z',
      timestampMs: 1_722_506_401_000,
      cwd: '/project',
      sessionId: 'synth-ctx',
      lineNumber: 4,
      requestId: 'req-ctx-1',
      message: {
        model: 'claude-3-5-sonnet-20241022',
        role: 'assistant',
        content: [{ type: 'text', text: 'Hi' }],
        usage: {
          input_tokens: 1_000,
          output_tokens: 50,
          cache_creation_input_tokens: 100,
          cache_read_input_tokens: 50,
        },
      },
    }),
    JSON.stringify({
      parentUuid: 'a-ctx-1',
      type: 'user',
      uuid: 'u-ctx-2',
      timestamp: '2026-08-01T10:00:02.000Z',
      timestampMs: 1_722_506_402_000,
      cwd: '/project',
      sessionId: 'synth-ctx',
      lineNumber: 5,
      message: { role: 'user', content: 'Use the skill' },
    }),
    JSON.stringify({
      parentUuid: 'u-ctx-2',
      type: 'assistant',
      uuid: 'a-ctx-2',
      timestamp: '2026-08-01T10:00:03.000Z',
      timestampMs: 1_722_506_403_000,
      cwd: '/project',
      sessionId: 'synth-ctx',
      lineNumber: 6,
      requestId: 'req-ctx-2',
      message: {
        model: 'claude-3-5-sonnet-20241022',
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tool-skill-1', name: 'Skill', input: { skill: 'csv-wrangler' } },
        ],
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    }),
    JSON.stringify({
      parentUuid: 'a-ctx-2',
      type: 'user',
      uuid: 'u-ctx-3',
      timestamp: '2026-08-01T10:00:04.000Z',
      timestampMs: 1_722_506_404_000,
      cwd: '/project',
      sessionId: 'synth-ctx',
      lineNumber: 7,
      sourceToolUseID: 'tool-skill-1',
      toolUseResult: { stdout: 'Skill csv-wrangler invoked', stderr: '', exitCode: 0 },
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool-skill-1',
            content: 'Skill csv-wrangler invoked',
          },
        ],
      },
    }),
    JSON.stringify({
      parentUuid: 'u-ctx-3',
      type: 'user',
      uuid: 'u-ctx-4',
      timestamp: '2026-08-01T10:00:04.100Z',
      timestampMs: 1_722_506_404_100,
      cwd: '/project',
      sessionId: 'synth-ctx',
      lineNumber: 8,
      isMeta: true,
      message: {
        role: 'user',
        content: 'Base directory for this skill: csv-wrangler\n\n# CSV Wrangler\n\nSkill body.',
      },
    }),
    JSON.stringify({
      parentUuid: 'u-ctx-4',
      type: 'assistant',
      uuid: 'a-ctx-3',
      timestamp: '2026-08-01T10:00:05.000Z',
      timestampMs: 1_722_506_405_000,
      cwd: '/project',
      sessionId: 'synth-ctx',
      lineNumber: 9,
      requestId: 'req-ctx-3',
      message: {
        model: 'claude-3-5-sonnet-20241022',
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tool-read-1', name: 'Read', input: { file_path: 'README.md' } },
        ],
        usage: {
          input_tokens: 1_200,
          output_tokens: 40,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 100,
        },
      },
    }),
    JSON.stringify({
      parentUuid: 'a-ctx-3',
      type: 'user',
      uuid: 'u-ctx-5',
      timestamp: '2026-08-01T10:00:06.000Z',
      timestampMs: 1_722_506_406_000,
      cwd: '/project',
      sessionId: 'synth-ctx',
      lineNumber: 10,
      sourceToolUseID: 'tool-read-1',
      toolUseResult: {
        file: { filePath: 'README.md', content: '# Readme', numLines: 3, totalLines: 3 },
      },
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tool-read-1', content: '# Readme' }],
      },
    }),
    JSON.stringify({
      parentUuid: 'u-ctx-5',
      type: 'assistant',
      uuid: 'a-ctx-4',
      timestamp: '2026-08-01T10:00:07.000Z',
      timestampMs: 1_722_506_407_000,
      cwd: '/project',
      sessionId: 'synth-ctx',
      lineNumber: 11,
      requestId: 'req-ctx-4',
      message: {
        model: 'claude-3-5-sonnet-20241022',
        role: 'assistant',
        content: [{ type: 'text', text: 'Compacted' }],
        usage: {
          input_tokens: 900,
          output_tokens: 30,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    }),
  ];
  return lines.join('\n');
}

function contextAndCacheBundle(): UnknownArtifactBundle {
  return bundle([artifact('transcript.jsonl', contextAndCacheJsonl(), 'application/jsonl')]);
}

function latencyAndParallelismJsonl(): string {
  const lines = [
    JSON.stringify({ type: 'permission-mode', permissionMode: 'normal', sessionId: 'synth-lat' }),
    JSON.stringify({
      parentUuid: null,
      type: 'user',
      uuid: 'u-lat-1',
      timestamp: '2026-08-01T10:00:00.000Z',
      timestampMs: 1_722_506_400_000,
      cwd: '/project',
      sessionId: 'synth-lat',
      lineNumber: 2,
      message: { role: 'user', content: 'Read both files' },
    }),
    JSON.stringify({
      parentUuid: 'u-lat-1',
      type: 'assistant',
      uuid: 'a-lat-1',
      timestamp: '2026-08-01T10:00:01.000Z',
      timestampMs: 1_722_506_401_000,
      cwd: '/project',
      sessionId: 'synth-lat',
      lineNumber: 3,
      requestId: 'req-lat-1',
      message: {
        model: 'claude-3-5-sonnet-20241022',
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tool-read-a', name: 'Read', input: { file_path: 'a.md' } },
          { type: 'tool_use', id: 'tool-read-b', name: 'Read', input: { file_path: 'b.md' } },
        ],
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    }),
    JSON.stringify({
      parentUuid: 'a-lat-1',
      type: 'user',
      uuid: 'u-lat-2',
      timestamp: '2026-08-01T10:00:03.000Z',
      timestampMs: 1_722_506_403_000,
      cwd: '/project',
      sessionId: 'synth-lat',
      lineNumber: 4,
      sourceToolUseID: 'tool-read-a',
      toolUseResult: { file: { filePath: 'a.md', content: 'A', numLines: 1, totalLines: 1 } },
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tool-read-a', content: 'A' }],
      },
    }),
    JSON.stringify({
      parentUuid: 'a-lat-1',
      type: 'user',
      uuid: 'u-lat-3',
      timestamp: '2026-08-01T10:00:04.000Z',
      timestampMs: 1_722_506_404_000,
      cwd: '/project',
      sessionId: 'synth-lat',
      lineNumber: 5,
      sourceToolUseID: 'tool-read-b',
      toolUseResult: { file: { filePath: 'b.md', content: 'B', numLines: 1, totalLines: 1 } },
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tool-read-b', content: 'B' }],
      },
    }),
  ];
  return lines.join('\n');
}

function latencyAndParallelismBundle(): UnknownArtifactBundle {
  return bundle([artifact('transcript.jsonl', latencyAndParallelismJsonl(), 'application/jsonl')]);
}

function validationAndEditCycleJsonl(): string {
  const lines = [
    JSON.stringify({ type: 'permission-mode', permissionMode: 'normal', sessionId: 'synth-edit' }),
    JSON.stringify({
      parentUuid: null,
      type: 'user',
      uuid: 'u-edit-1',
      timestamp: '2026-08-01T10:00:00.000Z',
      timestampMs: 1_722_506_400_000,
      cwd: '/project',
      sessionId: 'synth-edit',
      lineNumber: 2,
      message: { role: 'user', content: 'Fix and test' },
    }),
    JSON.stringify({
      parentUuid: 'u-edit-1',
      type: 'assistant',
      uuid: 'a-edit-1',
      timestamp: '2026-08-01T10:00:01.000Z',
      timestampMs: 1_722_506_401_000,
      cwd: '/project',
      sessionId: 'synth-edit',
      lineNumber: 3,
      requestId: 'req-edit-1',
      message: {
        model: 'claude-3-5-sonnet-20241022',
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'tool-bash-1',
            name: 'Bash',
            input: { command: 'pnpm test src/ingest.ts' },
          },
        ],
        usage: {
          input_tokens: 500,
          output_tokens: 10,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    }),
    JSON.stringify({
      parentUuid: 'a-edit-1',
      type: 'user',
      uuid: 'u-edit-2',
      timestamp: '2026-08-01T10:00:02.000Z',
      timestampMs: 1_722_506_402_000,
      cwd: '/project',
      sessionId: 'synth-edit',
      lineNumber: 4,
      sourceToolUseID: 'tool-bash-1',
      toolUseResult: { stdout: '1 test failed', stderr: '', exitCode: 1 },
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tool-bash-1', content: '1 test failed' }],
      },
    }),
    JSON.stringify({
      parentUuid: 'u-edit-2',
      type: 'assistant',
      uuid: 'a-edit-2',
      timestamp: '2026-08-01T10:00:03.000Z',
      timestampMs: 1_722_506_403_000,
      cwd: '/project',
      sessionId: 'synth-edit',
      lineNumber: 5,
      requestId: 'req-edit-2',
      message: {
        model: 'claude-3-5-sonnet-20241022',
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'tool-write-1',
            name: 'Write',
            input: {
              file_path: 'src/ingest.ts',
              content: 'export function ingest() { return true; }',
            },
          },
        ],
        usage: {
          input_tokens: 500,
          output_tokens: 15,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    }),
    JSON.stringify({
      parentUuid: 'a-edit-2',
      type: 'user',
      uuid: 'u-edit-3',
      timestamp: '2026-08-01T10:00:04.000Z',
      timestampMs: 1_722_506_404_000,
      cwd: '/project',
      sessionId: 'synth-edit',
      lineNumber: 6,
      sourceToolUseID: 'tool-write-1',
      toolUseResult: { file: { filePath: 'src/ingest.ts', content: '...' } },
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool-write-1',
            content: 'File written successfully.',
          },
        ],
      },
    }),
    JSON.stringify({
      parentUuid: 'u-edit-3',
      type: 'assistant',
      uuid: 'a-edit-3',
      timestamp: '2026-08-01T10:00:05.000Z',
      timestampMs: 1_722_506_405_000,
      cwd: '/project',
      sessionId: 'synth-edit',
      lineNumber: 7,
      requestId: 'req-edit-3',
      message: {
        model: 'claude-3-5-sonnet-20241022',
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'tool-bash-2',
            name: 'Bash',
            input: { command: 'pnpm test src/ingest.ts' },
          },
        ],
        usage: {
          input_tokens: 500,
          output_tokens: 10,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    }),
    JSON.stringify({
      parentUuid: 'a-edit-3',
      type: 'user',
      uuid: 'u-edit-4',
      timestamp: '2026-08-01T10:00:06.000Z',
      timestampMs: 1_722_506_406_000,
      cwd: '/project',
      sessionId: 'synth-edit',
      lineNumber: 8,
      sourceToolUseID: 'tool-bash-2',
      toolUseResult: { stdout: 'tests passed', stderr: '', exitCode: 0 },
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tool-bash-2', content: 'tests passed' }],
      },
    }),
  ];
  return lines.join('\n');
}

function validationAndEditCycleBundle(): UnknownArtifactBundle {
  return bundle([artifact('transcript.jsonl', validationAndEditCycleJsonl(), 'application/jsonl')]);
}

function censoredJsonl(): string {
  const lines = [
    JSON.stringify({ type: 'permission-mode', permissionMode: 'normal', sessionId: 'synth-cen' }),
    JSON.stringify({
      parentUuid: null,
      type: 'user',
      uuid: 'u-cen-1',
      timestamp: '2026-08-01T10:00:00.000Z',
      timestampMs: 1_722_506_400_000,
      cwd: '/project',
      sessionId: 'synth-cen',
      lineNumber: 2,
      message: { role: 'user', content: 'Hello' },
    }),
    JSON.stringify({
      parentUuid: 'u-cen-1',
      type: 'assistant',
      uuid: 'a-cen-1',
      timestamp: '2026-08-01T10:00:01.000Z',
      timestampMs: 1_722_506_401_000,
      cwd: '/project',
      sessionId: 'synth-cen',
      lineNumber: 3,
      requestId: 'req-cen-1',
      message: {
        model: 'claude-3-5-sonnet-20241022',
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tool-cen-1', name: 'Read', input: { file_path: 'x.md' } },
        ],
        usage: {
          input_tokens: 1_000,
          output_tokens: 10,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    }),
  ];
  return lines.join('\n');
}

function censoredBundle(): UnknownArtifactBundle {
  return bundle([artifact('transcript.jsonl', censoredJsonl(), 'application/jsonl')]);
}

function compactionBundle(): UnknownArtifactBundle {
  return bundle([
    artifact('transcript.jsonl', fixture('t2-happy-path.jsonl'), 'application/jsonl'),
  ]);
}

describe('claude-code-optimization-metrics', () => {
  describe('definitions', () => {
    it('exports all Phase 2 metric definitions', () => {
      const definitions = getClaudeCodeOptimizationMetricDefinitions();
      expect(definitions.length).toBe(36);
      expect(
        definitions.every((d) => d.metricId && d.version && d.comparabilityGroupInputs.length > 0),
      ).toBe(true);
    });

    it('includes both root-only and inclusive scopes', () => {
      const definitions = getClaudeCodeOptimizationMetricDefinitions();
      const root = definitions.filter((d) => d.rootInclusion === 'root_only');
      const inclusive = definitions.filter((d) => d.rootInclusion === 'inclusive');
      expect(root.length).toBe(inclusive.length);
      expect(root.length).toBeGreaterThan(0);
    });
  });

  describe('capabilities', () => {
    it('returns partial when no bundle is supplied', () => {
      const caps = getClaudeCodeOptimizationMetricCapabilities();
      expect(caps.length).toBe(36);
      expect(caps.every((c) => c.state === 'partial')).toBe(true);
    });

    it('returns unavailable when bundle has no transcript', () => {
      const caps = getClaudeCodeOptimizationMetricCapabilities(bundle([]));
      expect(caps.length).toBe(36);
      expect(caps.every((c) => c.state === 'unavailable')).toBe(true);
    });

    it('returns available and partial states for a valid transcript', () => {
      const caps = getClaudeCodeOptimizationMetricCapabilities(contextAndCacheBundle());
      const countDef = findCapability(caps, 'claude:context:first_request_tokens:root_only');
      expect(countDef?.state).toBe('available');
      const growthDef = findCapability(caps, 'claude:context:growth_max_tokens:root_only');
      expect(growthDef?.state).toBe('partial');
    });

    it('marks right-censored metrics as partial', () => {
      const caps = getClaudeCodeOptimizationMetricCapabilities(censoredBundle());
      const contextGrowth = findCapability(caps, 'claude:context:growth_max_tokens:root_only');
      expect(contextGrowth?.state).toBe('partial');
      expect(contextGrowth?.reason).toContain('right-censored');
    });
  });

  describe('context and cache', () => {
    it('uses the first request as the token anchor and never subtracts growth', () => {
      const result = ClaudeCodeTransformer.transform(contextAndCacheBundle(), defaultContext);
      const first = findMetric(result, 'claude:context:first_request_tokens:root_only');
      const growthMax = findMetric(result, 'claude:context:growth_max_tokens:root_only');
      const growthMean = findMetric(result, 'claude:context:growth_mean_tokens:root_only');

      expect(first?.value).toBe(1_150); // 1_000 + 100 + 50
      expect(growthMax?.value).toBe(150); // 1_300 - 1_150; the later 900 drop is ignored
      expect(growthMean?.value).toBeCloseTo(37.5, 1);
    });

    it('computes cache hit and write rates from total input tokens', () => {
      const result = ClaudeCodeTransformer.transform(contextAndCacheBundle(), defaultContext);
      const hitRate = findMetric(result, 'claude:cache:hit_rate:root_only');
      const writeRate = findMetric(result, 'claude:cache:write_rate:root_only');

      // total input = 1_150 + 0 + 1_300 + 900 = 3_350
      // cache_read = 50 + 0 + 100 + 0 = 150
      // cache_creation = 100 + 0 + 0 + 0 = 100
      expect(hitRate?.value).toBeCloseTo(150 / 3_350, 6);
      expect(writeRate?.value).toBeCloseTo(100 / 3_350, 6);
    });
  });

  describe('payload size distributions', () => {
    it('counts input, result, and injection payloads', () => {
      const result = ClaudeCodeTransformer.transform(contextAndCacheBundle(), defaultContext);
      const inputCount = findMetric(result, 'claude:payload:count:root_only', 'input');
      const resultCount = findMetric(result, 'claude:payload:count:root_only', 'result');
      const injectionCount = findMetric(result, 'claude:payload:count:root_only', 'injection');

      expect(inputCount?.value).toBeGreaterThan(0);
      expect(resultCount?.value).toBeGreaterThan(0);
      expect(injectionCount?.value).toBeGreaterThan(0);
    });

    it('exposes max and mean byte sizes per payload type', () => {
      const result = ClaudeCodeTransformer.transform(contextAndCacheBundle(), defaultContext);
      const inputMax = findMetric(result, 'claude:payload:max_bytes:root_only', 'input');
      const inputMean = findMetric(result, 'claude:payload:mean_bytes:root_only', 'input');

      expect(inputMax?.value).toBeGreaterThan(0);
      expect(inputMean?.value).toBeGreaterThan(0);
      expect(inputMax?.value).toBeGreaterThanOrEqual(inputMean?.value ?? 0);
    });
  });

  describe('compaction effects', () => {
    it('counts, totals dropped tokens, and computes retention ratio', () => {
      const result = ClaudeCodeTransformer.transform(compactionBundle(), defaultContext);
      const count = findMetric(result, 'claude:compaction:count:root_only');
      const dropped = findMetric(result, 'claude:compaction:dropped_tokens:root_only');
      const retention = findMetric(result, 'claude:compaction:retention_ratio:root_only');

      expect(count?.value).toBe(1);
      expect(dropped?.value).toBe(880_000);
      expect(retention?.value).toBeCloseTo(20_000 / 900_000, 6);
    });
  });

  describe('latency and parallelism', () => {
    it('computes max and mean invocation latency from completed tool results', () => {
      const result = ClaudeCodeTransformer.transform(latencyAndParallelismBundle(), defaultContext);
      const max = findMetric(result, 'claude:latency:max_invocation_ms:root_only');
      const mean = findMetric(result, 'claude:latency:mean_invocation_ms:root_only');

      expect(max?.value).toBe(3_000);
      expect(mean?.value).toBe(2_500);
    });

    it('measures max concurrent invocations per assistant turn', () => {
      const result = ClaudeCodeTransformer.transform(latencyAndParallelismBundle(), defaultContext);
      const concurrent = findMetric(
        result,
        'claude:parallelism:max_concurrent_invocations:root_only',
      );

      expect(concurrent?.value).toBe(2);
    });
  });

  describe('validation and edit cycle', () => {
    it('computes validation success and failure rates', () => {
      const result = ClaudeCodeTransformer.transform(
        validationAndEditCycleBundle(),
        defaultContext,
      );
      const success = findMetric(result, 'claude:validation:success_rate:root_only');
      const failure = findMetric(result, 'claude:validation:failure_rate:root_only');

      expect(success?.value).toBeCloseTo(0.5, 6);
      expect(failure?.value).toBeCloseTo(0.5, 6);
    });

    it('counts edit cycles and computes their success rate', () => {
      const result = ClaudeCodeTransformer.transform(
        validationAndEditCycleBundle(),
        defaultContext,
      );
      const count = findMetric(result, 'claude:edit_cycle:count:root_only');
      const success = findMetric(result, 'claude:edit_cycle:success_rate:root_only');

      expect(count?.value).toBe(1);
      expect(success?.value).toBe(1);
    });
  });

  describe('censoring and provenance', () => {
    it('tags right-censored derived metrics with partial reasons', () => {
      const result = ClaudeCodeTransformer.transform(censoredBundle(), defaultContext);
      const growth = findMetric(result, 'claude:context:growth_mean_tokens:root_only');

      expect(growth?.partialReason).toContain('right-censored');
    });

    it('provides every metric value with evidence record ids and a comparability group', () => {
      const result = ClaudeCodeTransformer.transform(contextAndCacheBundle(), defaultContext);
      for (const metric of result.metricValues as readonly ClaudeMetricValue[]) {
        expect(metric.evidenceRecordIds).toBeDefined();
        expect(metric.comparabilityGroupId).toBeDefined();
      }
    });
  });
});
