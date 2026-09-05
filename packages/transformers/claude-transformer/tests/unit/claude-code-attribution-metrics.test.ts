import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSession, parseSessionTranscript } from '@lucasschirm/sal-claude-session-parser';
import type {
  MetricCapability,
  ScalarMetricValue,
  TransformContext,
  UnknownArtifactBundle,
} from '@lucasschirm/sal-transformer-shared';
import { describe, expect, it } from 'vitest';
import { ClaudeCodeTransformer } from '../../src/plugin/claude-code.js';
import {
  deriveClaudeCodeAttributionMetrics,
  getAttributionReleaseMatrix,
  getClaudeCodeAttributionMetricCapabilities,
  getClaudeCodeAttributionMetricDefinitions,
} from '../../src/plugin/claude-code-attribution-metrics.js';
import type { ClaudeMetricValue } from '../../src/plugin/claude-code-metrics.js';

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
  result: { metricValues: readonly ScalarMetricValue[] },
  metricId: string,
): ClaudeMetricValue | undefined {
  const value = result.metricValues.find((m) => m.metricId === metricId);
  expect(value).toBeDefined();
  // Both TransformResult (ClaudeCodeTransformer.transform()) and
  // ClaudeMetricsResult (deriveClaudeCodeAttributionMetrics()) declare
  // metricValues against the shared base ScalarMetricValue contract; this
  // cast surfaces the Claude-specific fields both actually emit at runtime.
  return value as ClaudeMetricValue | undefined;
}

function findCapability(caps: readonly MetricCapability[], metricId: string) {
  const cap = caps.find((c) => c.metricId === metricId);
  expect(cap).toBeDefined();
  return cap;
}

function mainWithSubagentBundle(): UnknownArtifactBundle {
  return bundle([
    artifact('transcript.jsonl', fixture('e2e-main-session.jsonl'), 'application/jsonl'),
    artifact(
      'subagents/agent-e2e-agent-0001.jsonl',
      fixture('e2e-subagent-transcript.jsonl'),
      'application/jsonl',
    ),
    artifact(
      'subagents/agent-e2e-agent-0001.meta.json',
      fixture('e2e-subagent-meta.json'),
      'application/json',
    ),
  ]);
}

function mainWithMissingSubagentBundle(): UnknownArtifactBundle {
  return bundle([
    artifact('transcript.jsonl', fixture('e2e-main-session.jsonl'), 'application/jsonl'),
  ]);
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
  ];
  return lines.join('\n');
}

function contextAndCacheBundle(): UnknownArtifactBundle {
  return bundle([artifact('transcript.jsonl', contextAndCacheJsonl(), 'application/jsonl')]);
}

function conversationOnlyJsonl(): string {
  const lines = [
    JSON.stringify({ type: 'permission-mode', permissionMode: 'normal', sessionId: 'synth-conv' }),
    JSON.stringify({
      parentUuid: null,
      type: 'user',
      uuid: 'u-conv-1',
      timestamp: '2026-08-01T10:00:00.000Z',
      timestampMs: 1_722_506_400_000,
      sessionId: 'synth-conv',
      lineNumber: 2,
      message: { role: 'user', content: 'Hello' },
    }),
    JSON.stringify({
      parentUuid: 'u-conv-1',
      type: 'assistant',
      uuid: 'a-conv-1',
      timestamp: '2026-08-01T10:00:01.000Z',
      timestampMs: 1_722_506_401_000,
      sessionId: 'synth-conv',
      lineNumber: 3,
      requestId: 'req-conv-1',
      message: {
        model: 'claude-3-5-sonnet-20241022',
        role: 'assistant',
        content: [{ type: 'text', text: 'Hi there' }],
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    }),
  ];
  return lines.join('\n');
}

function conversationOnlyBundle(): UnknownArtifactBundle {
  return bundle([artifact('transcript.jsonl', conversationOnlyJsonl(), 'application/jsonl')]);
}

function twoConcurrentSubagentsJsonl(): { root: string; sa1: string; sa2: string } {
  const root = [
    JSON.stringify({
      parentUuid: null,
      type: 'user',
      uuid: 'u-2c-1',
      timestamp: '2026-08-01T10:00:00.000Z',
      timestampMs: 1_722_506_400_000,
      sessionId: 'synth-2c',
      lineNumber: 1,
      message: { role: 'user', content: 'Launch two subagents' },
    }),
    JSON.stringify({
      parentUuid: 'u-2c-1',
      type: 'assistant',
      uuid: 'a-2c-1',
      timestamp: '2026-08-01T10:00:02.000Z',
      timestampMs: 1_722_506_402_000,
      sessionId: 'synth-2c',
      lineNumber: 2,
      requestId: 'req-2c-1',
      message: {
        model: 'claude-3-5-sonnet-20241022',
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tool-sa-1', name: 'Agent', input: { subagent_type: 'sa-1' } },
          { type: 'tool_use', id: 'tool-sa-2', name: 'Agent', input: { subagent_type: 'sa-2' } },
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
      parentUuid: 'a-2c-1',
      type: 'user',
      uuid: 'u-2c-2',
      timestamp: '2026-08-01T10:00:03.000Z',
      timestampMs: 1_722_506_403_000,
      sessionId: 'synth-2c',
      lineNumber: 3,
      sourceToolUseID: 'tool-sa-1',
      toolUseResult: { agentId: 'sa-1', status: 'completed' },
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tool-sa-1', content: 'sa-1 done' }],
      },
    }),
    JSON.stringify({
      parentUuid: 'a-2c-1',
      type: 'user',
      uuid: 'u-2c-3',
      timestamp: '2026-08-01T10:00:04.000Z',
      timestampMs: 1_722_506_404_000,
      sessionId: 'synth-2c',
      lineNumber: 4,
      sourceToolUseID: 'tool-sa-2',
      toolUseResult: { agentId: 'sa-2', status: 'completed' },
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tool-sa-2', content: 'sa-2 done' }],
      },
    }),
    JSON.stringify({
      parentUuid: 'u-2c-3',
      type: 'assistant',
      uuid: 'a-2c-2',
      timestamp: '2026-08-01T10:00:25.000Z',
      timestampMs: 1_722_506_425_000,
      sessionId: 'synth-2c',
      lineNumber: 5,
      requestId: 'req-2c-2',
      message: {
        model: 'claude-3-5-sonnet-20241022',
        role: 'assistant',
        content: [{ type: 'text', text: 'Both subagents finished' }],
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    }),
  ].join('\n');

  const sa1 = [
    JSON.stringify({
      parentUuid: null,
      isSidechain: true,
      agentId: 'sa-1',
      type: 'user',
      uuid: 'sa1-u-1',
      timestamp: '2026-08-01T10:00:05.000Z',
      timestampMs: 1_722_506_405_000,
      sessionId: 'synth-2c',
      lineNumber: 1,
      message: { role: 'user', content: 'Do work for sa-1' },
    }),
    JSON.stringify({
      parentUuid: 'sa1-u-1',
      isSidechain: true,
      agentId: 'sa-1',
      type: 'assistant',
      uuid: 'sa1-a-1',
      timestamp: '2026-08-01T10:00:12.000Z',
      timestampMs: 1_722_506_412_000,
      sessionId: 'synth-2c',
      lineNumber: 2,
      requestId: 'req-sa1-1',
      message: {
        model: 'claude-3-5-sonnet-20241022',
        role: 'assistant',
        content: [{ type: 'text', text: 'Done' }],
        usage: {
          input_tokens: 50,
          output_tokens: 10,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    }),
  ].join('\n');

  const sa2 = [
    JSON.stringify({
      parentUuid: null,
      isSidechain: true,
      agentId: 'sa-2',
      type: 'user',
      uuid: 'sa2-u-1',
      timestamp: '2026-08-01T10:00:08.000Z',
      timestampMs: 1_722_506_408_000,
      sessionId: 'synth-2c',
      lineNumber: 1,
      message: { role: 'user', content: 'Do work for sa-2' },
    }),
    JSON.stringify({
      parentUuid: 'sa2-u-1',
      isSidechain: true,
      agentId: 'sa-2',
      type: 'assistant',
      uuid: 'sa2-a-1',
      timestamp: '2026-08-01T10:00:18.000Z',
      timestampMs: 1_722_506_418_000,
      sessionId: 'synth-2c',
      lineNumber: 2,
      requestId: 'req-sa2-1',
      message: {
        model: 'claude-3-5-sonnet-20241022',
        role: 'assistant',
        content: [{ type: 'text', text: 'Done' }],
        usage: {
          input_tokens: 50,
          output_tokens: 10,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    }),
  ].join('\n');

  return { root, sa1, sa2 };
}

function twoConcurrentSubagentsBundle(): UnknownArtifactBundle {
  const { root, sa1, sa2 } = twoConcurrentSubagentsJsonl();
  return bundle([
    artifact('transcript.jsonl', root, 'application/jsonl'),
    artifact('subagents/agent-sa-1.jsonl', sa1, 'application/jsonl'),
    artifact('subagents/agent-sa-2.jsonl', sa2, 'application/jsonl'),
  ]);
}

describe('claude-code-attribution-metrics', () => {
  describe('definitions', () => {
    it('exports all Phase 3 attribution metric definitions', () => {
      const definitions = getClaudeCodeAttributionMetricDefinitions();
      expect(definitions.length).toBe(6);
      const ids = new Set(definitions.map((d) => d.metricId));
      expect(ids.has('claude:attribution:context_retention:root_only')).toBe(true);
      expect(ids.has('claude:attribution:context_retention:inclusive')).toBe(true);
      expect(ids.has('claude:attribution:subagent_overlap_ms:root_only')).toBe(true);
      expect(ids.has('claude:attribution:subagent_overlap_ms:inclusive')).toBe(true);
      expect(ids.has('claude:attribution:critical_path_ms:root_only')).toBe(true);
      expect(ids.has('claude:attribution:critical_path_ms:inclusive')).toBe(true);
    });

    it('includes required attribution metadata on every definition', () => {
      for (const def of getClaudeCodeAttributionMetricDefinitions()) {
        expect(def.metricId).toBeDefined();
        expect(def.version).toBeGreaterThan(0);
        expect(def.unit).toBeDefined();
        expect(def.grain).toBe('session');
        expect(def.comparabilityGroupInputs.length).toBeGreaterThan(0);
        expect(def.missingDataBehavior).toBe('unknown');
        expect(def.allocationMethod).toBeDefined();
        expect(def.attributionPolicyId).toBe('claude-attribution-default');
      }
    });
  });

  describe('release matrix', () => {
    it('publishes a release matrix with additive/non-additive and evidence gates', () => {
      const matrix = getAttributionReleaseMatrix();
      expect(matrix.length).toBe(3);
      const byId = new Map(matrix.map((e) => [e.metricId, e]));
      const context = byId.get('claude:attribution:context_retention');
      expect(context?.requiredEvidence).toContain('invocation_payload');
      expect(context?.additive).toBe(false);
      expect(context?.allocationMethod).toBe('proportional');
      const overlap = byId.get('claude:attribution:subagent_overlap_ms');
      expect(overlap?.requiredEvidence).toContain('session');
      expect(overlap?.requiredEvidence).toContain('session_relation');
      expect(overlap?.additive).toBe(false);
      expect(overlap?.allocationMethod).toBe('overlap-window');
      const path = byId.get('claude:attribution:critical_path_ms');
      expect(path?.requiredEvidence).toContain('session');
      expect(path?.allocationMethod).toBe('critical-path');
    });
  });

  describe('getClaudeCodeAttributionMetricCapabilities', () => {
    it('returns partial capabilities when no bundle is supplied', () => {
      const caps = getClaudeCodeAttributionMetricCapabilities();
      expect(caps.length).toBe(6);
      for (const cap of caps) {
        expect(cap.state).toBe('partial');
        expect(cap.reason).toContain('no bundle');
      }
    });

    it('returns unavailable capabilities when bundle has no root transcript', () => {
      const caps = getClaudeCodeAttributionMetricCapabilities(bundle([]));
      expect(caps.length).toBe(6);
      for (const cap of caps) {
        expect(cap.state).toBe('unavailable');
        expect(cap.reason).toContain('root transcript');
      }
    });

    it('marks context retention unavailable when there are no invocations', () => {
      const caps = getClaudeCodeAttributionMetricCapabilities(conversationOnlyBundle());
      const context = findCapability(caps, 'claude:attribution:context_retention:root_only');
      expect(context?.state).toBe('unavailable');
      expect(context?.reason).toContain('invocation');
    });

    it('marks inclusive attribution unavailable when a subagent transcript is missing', () => {
      const caps = getClaudeCodeAttributionMetricCapabilities(mainWithMissingSubagentBundle());
      const overlap = findCapability(caps, 'claude:attribution:subagent_overlap_ms:inclusive');
      expect(overlap?.state).toBe('unavailable');
      expect(overlap?.reason).toContain('subagent');
    });
  });

  describe('context retention attribution', () => {
    it('computes a non-zero context retention share when skill context is injected', () => {
      const result = ClaudeCodeTransformer.transform(contextAndCacheBundle(), defaultContext);
      const retention = findMetric(result, 'claude:attribution:context_retention:root_only');
      expect(retention?.value).toBeGreaterThan(0);
      expect(retention?.value).toBeLessThan(1);
      expect(retention?.allocationMethod).toBe('proportional');
    });

    it('marks context retention unavailable when there are no invocation payloads', () => {
      const result = ClaudeCodeTransformer.transform(conversationOnlyBundle(), defaultContext);
      const retention = findMetric(result, 'claude:attribution:context_retention:root_only');
      expect(retention?.value).toBeNull();
      expect(result.unavailableReasons.some((r) => r.metricId === retention?.metricId)).toBe(true);
    });

    it('produces root-only and inclusive context retention for a session with subagents', () => {
      const result = ClaudeCodeTransformer.transform(mainWithSubagentBundle(), defaultContext);
      const root = findMetric(result, 'claude:attribution:context_retention:root_only');
      const inclusive = findMetric(result, 'claude:attribution:context_retention:inclusive');
      expect(root?.value).toBeGreaterThan(0);
      expect(inclusive?.value).toBeGreaterThan(0);
    });
  });

  describe('Sub Agent overlap and critical path', () => {
    it('computes non-additive overlap and critical path for a session with one subagent', () => {
      const result = ClaudeCodeTransformer.transform(mainWithSubagentBundle(), defaultContext);
      const overlap = findMetric(result, 'claude:attribution:subagent_overlap_ms:inclusive');
      const path = findMetric(result, 'claude:attribution:critical_path_ms:inclusive');
      expect(overlap?.value).toBeGreaterThan(0);
      expect(path?.value).toBeGreaterThan(0);
      expect(path?.value).toBeGreaterThanOrEqual(overlap?.value ?? 0);
      expect(findMetric(result, 'claude:attribution:subagent_overlap_ms:root_only')?.value).toBe(0);
    });

    it('does not double-count concurrent Sub Agent overlap', () => {
      const result = ClaudeCodeTransformer.transform(
        twoConcurrentSubagentsBundle(),
        defaultContext,
      );
      const overlap = findMetric(result, 'claude:attribution:subagent_overlap_ms:inclusive');
      const path = findMetric(result, 'claude:attribution:critical_path_ms:inclusive');

      // Root runs 10:00:00 -> 10:00:25 (25000ms)
      // sa-1 runs 10:00:05 -> 10:00:12 (7000ms)
      // sa-2 runs 10:00:08 -> 10:00:18 (10000ms)
      // Union overlap is 10:00:05 -> 10:00:18 = 13000ms
      expect(overlap?.value).toBe(13_000);
      expect(path?.value).toBe(25_000);
    });

    it('marks inclusive overlap and critical path unavailable when a subagent transcript is missing', () => {
      const result = ClaudeCodeTransformer.transform(
        mainWithMissingSubagentBundle(),
        defaultContext,
      );
      const overlap = findMetric(result, 'claude:attribution:subagent_overlap_ms:inclusive');
      const path = findMetric(result, 'claude:attribution:critical_path_ms:inclusive');
      expect(overlap?.value).toBeNull();
      expect(path?.value).toBeNull();
      expect(overlap?.unavailableReason).toContain('subagent');
    });
  });

  describe('unknown parent inclusion semantics', () => {
    it('does not produce an inclusive sum when the parent relation semantics are unknown', () => {
      const b = mainWithSubagentBundle();
      const transformResult = ClaudeCodeTransformer.transform(b, defaultContext);
      const evidence = transformResult.evidence.map((r) => ({ ...r }));
      const relation = evidence.find((r) => r.recordType === 'session_relation');
      expect(relation).toBeDefined();
      if (relation) {
        const payload = relation.payload as { nativeInclusionSemantics: string };
        payload.nativeInclusionSemantics = 'unknown';
      }

      const child = parseSessionTranscript(fixture('e2e-subagent-transcript.jsonl'));
      const session = parseSession(fixture('e2e-main-session.jsonl'))
        .appendSubAgent('e2e-agent-0001', child)
        .toSession();

      const attribution = deriveClaudeCodeAttributionMetrics(
        session,
        evidence,
        b,
        defaultContext,
        'transcript.jsonl',
      );

      const overlap = findMetric(attribution, 'claude:attribution:subagent_overlap_ms:inclusive');
      const path = findMetric(attribution, 'claude:attribution:critical_path_ms:inclusive');
      const context = findMetric(attribution, 'claude:attribution:context_retention:inclusive');
      expect(overlap?.value).toBeNull();
      expect(path?.value).toBeNull();
      expect(context?.value).toBeNull();
      expect(overlap?.unavailableReason).toContain('unknown parent inclusion');
      expect(
        attribution.unavailableReasons.some((r) => r.reason?.includes('unknown parent inclusion')),
      ).toBe(true);
    });
  });
});
