import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { UnknownArtifactBundle } from '../../src/bundle.js';
import type { TransformContext } from '../../src/context.js';
import { ClaudeCodeTransformer } from '../../src/plugin/claude-code.js';
import {
  getClaudeCodeMetricCapabilities,
  getClaudeCodeMetricDefinitions,
} from '../../src/plugin/claude-code-metrics.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const parserFixtures = join(__dirname, '../../../parsers/claude-session-parser/tests/fixtures');

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
  result: { metricValues: readonly { metricId: string; value: number | null; exact: boolean }[] },
  metricId: string,
) {
  const value = result.metricValues.find((m) => m.metricId === metricId);
  expect(value).toBeDefined();
  return value;
}

function happyPathBundle(): UnknownArtifactBundle {
  return bundle([
    artifact('transcript.jsonl', fixture('t2-happy-path.jsonl'), 'application/jsonl'),
  ]);
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

function knownModelBundle(): UnknownArtifactBundle {
  const jsonl = [
    JSON.stringify({ type: 'permission-mode', permissionMode: 'normal', sessionId: 'synth-1' }),
    JSON.stringify({
      parentUuid: null,
      type: 'user',
      uuid: 'u-synth-1',
      timestamp: '2026-08-01T10:00:00.000Z',
      timestampMs: 1_722_506_400_000,
      sessionId: 'synth-1',
      lineNumber: 2,
      message: { role: 'user', content: 'Hello' },
    }),
    JSON.stringify({
      parentUuid: 'u-synth-1',
      type: 'assistant',
      uuid: 'a-synth-1',
      timestamp: '2026-08-01T10:00:01.000Z',
      timestampMs: 1_722_506_401_000,
      sessionId: 'synth-1',
      lineNumber: 3,
      requestId: 'req-synth-1',
      message: {
        model: 'claude-3-5-sonnet-20241022',
        role: 'assistant',
        content: [{ type: 'text', text: 'Hi' }],
        usage: {
          input_tokens: 1_000,
          output_tokens: 200,
          cache_creation_input_tokens: 150,
          cache_read_input_tokens: 50,
        },
      },
    }),
  ].join('\n');
  return bundle([artifact('transcript.jsonl', jsonl, 'application/jsonl')]);
}

describe('claude-code-metrics', () => {
  describe('definitions', () => {
    it('exports a metric definition for every Phase 1 root and inclusive metric', () => {
      const definitions = getClaudeCodeMetricDefinitions();
      expect(definitions.length).toBe(28);
      const ids = new Set(definitions.map((d) => d.metricId));
      expect(ids.has('claude:tokens:input:root_only')).toBe(true);
      expect(ids.has('claude:tokens:input:inclusive')).toBe(true);
      expect(ids.has('claude:invocations:tool:root_only')).toBe(true);
      expect(ids.has('claude:invocations:tool:inclusive')).toBe(true);
      expect(ids.has('claude:cost:total:root_only')).toBe(true);
      expect(ids.has('claude:cost:total:inclusive')).toBe(true);
    });

    it('includes required MetricDefinition fields', () => {
      for (const def of getClaudeCodeMetricDefinitions()) {
        expect(def.metricId).toBeDefined();
        expect(def.version).toBeGreaterThan(0);
        expect(def.unit).toBeDefined();
        expect(def.grain).toBe('session');
        expect(def.comparabilityGroupInputs.length).toBeGreaterThan(0);
        expect(def.missingDataBehavior).toBe('unknown');
      }
    });
  });

  describe('getClaudeCodeMetricCapabilities', () => {
    it('returns partial capabilities when no bundle is supplied', () => {
      const caps = getClaudeCodeMetricCapabilities();
      expect(caps.length).toBe(28);
      for (const cap of caps) {
        expect(cap.state).toBe('partial');
        expect(cap.reason).toContain('no bundle');
      }
    });

    it('returns unavailable capabilities when bundle has no root transcript', () => {
      const b = bundle([artifact('unknown.bin', 'not claude')]);
      const caps = getClaudeCodeMetricCapabilities(b);
      expect(caps.length).toBe(28);
      for (const cap of caps) {
        expect(cap.state).toBe('unavailable');
        expect(cap.reason).toContain('root transcript');
      }
    });

    it('returns mixed availability for a valid transcript', () => {
      const caps = getClaudeCodeMetricCapabilities(happyPathBundle());
      expect(caps.length).toBe(28);
      const byId = new Map(caps.map((c) => [c.metricId, c]));
      expect(byId.get('claude:tokens:input:root_only')?.state).toBe('available');
      expect(byId.get('claude:turns:count:root_only')?.state).toBe('available');
      expect(byId.get('claude:cost:total:root_only')?.state).toBe('unavailable');
    });
  });

  describe('transform() metric output', () => {
    it('produces metric values for a root-only session', () => {
      const result = ClaudeCodeTransformer.transform(happyPathBundle(), defaultContext);
      expect(result.metricValues.length).toBeGreaterThan(0);
      expect(result.capabilities.length).toBe(result.metricValues.length);
      expect(
        result.unavailableReasons.some((r) => r.metricId === 'claude:cost:total:root_only'),
      ).toBe(true);
    });

    it('reports token usage by class for the happy path', () => {
      const result = ClaudeCodeTransformer.transform(happyPathBundle(), defaultContext);
      expect(findMetric(result, 'claude:tokens:input:root_only')?.value).toBe(5);
      expect(findMetric(result, 'claude:tokens:output:root_only')?.value).toBe(40);
      expect(findMetric(result, 'claude:tokens:cache_creation:root_only')?.value).toBe(100);
      expect(findMetric(result, 'claude:tokens:cache_read:root_only')?.value).toBe(20);
      expect(findMetric(result, 'claude:tokens:total:root_only')?.value).toBe(165);
    });

    it('marks cost unavailable for unknown models (unknown is not zero)', () => {
      const result = ClaudeCodeTransformer.transform(happyPathBundle(), defaultContext);
      const cost = findMetric(result, 'claude:cost:total:root_only');
      expect(cost?.value).toBeNull();
      expect(cost?.exact).toBe(false);
      const reason = result.unavailableReasons.find(
        (r) => r.metricId === 'claude:cost:total:root_only',
      );
      expect(reason?.reason).toContain('pricing');
    });

    it('computes cost for a recognized priced model', () => {
      const result = ClaudeCodeTransformer.transform(knownModelBundle(), defaultContext);
      const cost = findMetric(result, 'claude:cost:total:root_only');
      expect(cost?.value).toBeGreaterThan(0);
      expect(cost?.exact).toBe(false);
    });

    it('counts turns and invocations', () => {
      const result = ClaudeCodeTransformer.transform(happyPathBundle(), defaultContext);
      expect(findMetric(result, 'claude:turns:count:root_only')?.value).toBe(3);
      expect(findMetric(result, 'claude:invocations:tool:root_only')?.value).toBe(1);
      expect(findMetric(result, 'claude:invocations:skill:root_only')?.value).toBe(0);
      expect(findMetric(result, 'claude:invocations:agent:root_only')?.value).toBe(0);
    });

    it('excludes skill and agent invocations from the generic tool count', () => {
      const result = ClaudeCodeTransformer.transform(mainWithSubagentBundle(), defaultContext);
      const tool = findMetric(result, 'claude:invocations:tool:root_only');
      const skill = findMetric(result, 'claude:invocations:skill:root_only');
      const agent = findMetric(result, 'claude:invocations:agent:root_only');
      expect(typeof tool?.value).toBe('number');
      expect(typeof skill?.value).toBe('number');
      expect(typeof agent?.value).toBe('number');
      expect((tool?.value ?? 0) + (skill?.value ?? 0) + (agent?.value ?? 0)).toBeGreaterThan(
        tool?.value ?? 0,
      );
    });

    it('computes wall duration from event timestamps', () => {
      const result = ClaudeCodeTransformer.transform(happyPathBundle(), defaultContext);
      const duration = findMetric(result, 'claude:duration:wall_ms:root_only');
      expect(duration?.value).toBeGreaterThan(0);
      expect(duration?.exact).toBe(true);
    });

    it('produces root and inclusive values for sessions with subagents', () => {
      const result = ClaudeCodeTransformer.transform(mainWithSubagentBundle(), defaultContext);
      const rootTokens = findMetric(result, 'claude:tokens:total:root_only')?.value ?? 0;
      const inclusiveTokens = findMetric(result, 'claude:tokens:total:inclusive')?.value ?? 0;
      expect(inclusiveTokens).toBeGreaterThanOrEqual(rootTokens);
      const rootTurns = findMetric(result, 'claude:turns:count:root_only')?.value ?? 0;
      const inclusiveTurns = findMetric(result, 'claude:turns:count:inclusive')?.value ?? 0;
      expect(inclusiveTurns).toBeGreaterThanOrEqual(rootTurns);
      const rootTools = findMetric(result, 'claude:invocations:tool:root_only')?.value ?? 0;
      const inclusiveTools = findMetric(result, 'claude:invocations:tool:inclusive')?.value ?? 0;
      expect(inclusiveTools).toBeGreaterThanOrEqual(rootTools);
    });

    it('marks inclusive metrics unavailable when a subagent transcript is missing', () => {
      const b = bundle([
        artifact('transcript.jsonl', fixture('e2e-main-session.jsonl'), 'application/jsonl'),
      ]);
      const result = ClaudeCodeTransformer.transform(b, defaultContext);
      const inclusiveCost = findMetric(result, 'claude:cost:total:inclusive');
      expect(inclusiveCost?.value).toBeNull();
      expect(inclusiveCost?.unavailableReason).toContain('subagent');
    });

    it('links every metric value to evidence record ids and provenance', () => {
      const result = ClaudeCodeTransformer.transform(happyPathBundle(), defaultContext);
      for (const metric of result.metricValues) {
        expect(metric.evidenceRecordIds.length).toBeGreaterThan(0);
        expect(metric.comparabilityGroupId).toBeDefined();
        expect(metric.definition).toBeDefined();
      }
      expect(result.provenance.some((p) => 'metricId' in p)).toBe(true);
    });

    it('produces deterministic metric ids and comparability groups for the same bundle', () => {
      const first = ClaudeCodeTransformer.transform(mainWithSubagentBundle(), defaultContext);
      const second = ClaudeCodeTransformer.transform(mainWithSubagentBundle(), defaultContext);
      expect(first.metricValues.map((m) => m.metricId)).toEqual(
        second.metricValues.map((m) => m.metricId),
      );
      expect(first.metricValues.map((m) => m.comparabilityGroupId)).toEqual(
        second.metricValues.map((m) => m.comparabilityGroupId),
      );
    });

    it('reports file operation, command, and validation counts for the happy path', () => {
      const result = ClaudeCodeTransformer.transform(happyPathBundle(), defaultContext);
      expect(findMetric(result, 'claude:file_operations:count:root_only')?.value).toBe(1);
      expect(findMetric(result, 'claude:commands:count:root_only')?.value).toBeGreaterThan(0);
      expect(findMetric(result, 'claude:validations:count:root_only')?.value).toBe(0);
    });
  });
});
