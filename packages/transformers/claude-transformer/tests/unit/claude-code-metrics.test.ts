import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  TransformContext,
  TransformResult,
  UnknownArtifactBundle,
} from '@lucasschirm/sal-transformer-shared';
import { describe, expect, it } from 'vitest';
import { ClaudeCodeTransformer } from '../../src/plugin/claude-code.js';
import type { ClaudeMetricValue } from '../../src/plugin/claude-code-metrics.js';
import {
  getClaudeCodeMetricCapabilities,
  getClaudeCodeMetricDefinitions,
} from '../../src/plugin/claude-code-metrics.js';

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

function findMetric(result: TransformResult, metricId: string): ClaudeMetricValue | undefined {
  const value = result.metricValues.find((m) => m.metricId === metricId);
  expect(value).toBeDefined();
  // ClaudeCodeTransformer emits the Claude-specific ClaudeMetricValue shape
  // at runtime; TransformResult only declares the shared base
  // ScalarMetricValue contract, so this cast makes the extended fields
  // (unavailableReason, evidenceRecordIds, definition, ...) available to
  // this test file's assertions.
  return value as ClaudeMetricValue | undefined;
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

function effortTurns(
  sessionId: string,
  efforts: (string | undefined)[],
  opts: { agentId?: string; isSidechain?: boolean } = {},
): string[] {
  const lines: string[] = [];
  let parentUuid: string | null = null;
  const extra: Record<string, unknown> = {};
  if (opts.agentId) extra.agentId = opts.agentId;
  if (opts.isSidechain) extra.isSidechain = true;
  efforts.forEach((effort, i) => {
    const userUuid = `${sessionId}-u-${i}`;
    const assistantUuid = `${sessionId}-a-${i}`;
    lines.push(
      JSON.stringify({
        ...extra,
        parentUuid,
        type: 'user',
        uuid: userUuid,
        sessionId,
        timestamp: `2026-08-01T10:${String(i).padStart(2, '0')}:00.000Z`,
        message: { role: 'user', content: `turn ${i}` },
      }),
    );
    const assistantEntry: Record<string, unknown> = {
      ...extra,
      parentUuid: userUuid,
      type: 'assistant',
      uuid: assistantUuid,
      sessionId,
      timestamp: `2026-08-01T10:${String(i).padStart(2, '0')}:30.000Z`,
      requestId: `req-${sessionId}-${i}`,
      message: {
        model: 'model-a',
        role: 'assistant',
        content: [{ type: 'text', text: `reply ${i}` }],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    };
    if (effort !== undefined) assistantEntry.effort = effort;
    lines.push(JSON.stringify(assistantEntry));
    parentUuid = assistantUuid;
  });
  return lines;
}

function effortBundle(
  efforts: (string | undefined)[],
  sessionId = 'eff-root',
): UnknownArtifactBundle {
  const lines = [
    JSON.stringify({ type: 'permission-mode', permissionMode: 'normal', sessionId }),
    ...effortTurns(sessionId, efforts),
  ];
  return bundle([artifact('transcript.jsonl', lines.join('\n'), 'application/jsonl')]);
}

/**
 * A root session (3 assistant entries: high, high, xhigh — one transition)
 * that launches a Sub Agent (3 assistant entries of its own: medium, low,
 * medium — two transitions), so root-only and inclusive scope produce
 * different, independently-contributed evidence sets.
 */
function effortBundleWithSubagent(): UnknownArtifactBundle {
  const sessionId = 'eff-root-sub';
  const agentId = 'eff-agent-1';
  const toolUseId = 'toolu_eff_1';

  const rootLines = [
    JSON.stringify({ type: 'permission-mode', permissionMode: 'normal', sessionId }),
    JSON.stringify({
      parentUuid: null,
      type: 'user',
      uuid: 'r-u-1',
      sessionId,
      timestamp: '2026-08-01T10:00:00.000Z',
      message: { role: 'user', content: 'start' },
    }),
    JSON.stringify({
      parentUuid: 'r-u-1',
      type: 'assistant',
      uuid: 'r-a-1',
      sessionId,
      timestamp: '2026-08-01T10:00:01.000Z',
      requestId: 'req-r-1',
      effort: 'high',
      message: {
        model: 'model-a',
        role: 'assistant',
        content: [{ type: 'text', text: 'first reply' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    }),
    JSON.stringify({
      parentUuid: 'r-a-1',
      type: 'user',
      uuid: 'r-u-2',
      sessionId,
      timestamp: '2026-08-01T10:00:02.000Z',
      message: { role: 'user', content: 'please delegate' },
    }),
    JSON.stringify({
      parentUuid: 'r-u-2',
      type: 'assistant',
      uuid: 'r-a-2',
      sessionId,
      timestamp: '2026-08-01T10:00:03.000Z',
      requestId: 'req-r-2',
      effort: 'high',
      message: {
        model: 'model-a',
        role: 'assistant',
        content: [{ type: 'tool_use', id: toolUseId, name: 'Agent', input: { prompt: 'go' } }],
      },
    }),
    JSON.stringify({
      parentUuid: 'r-a-2',
      type: 'user',
      uuid: 'r-u-3',
      sessionId,
      timestamp: '2026-08-01T10:00:04.000Z',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'done' }],
      },
      toolUseResult: { agentId, resolvedModel: 'model-a', totalTokens: 10, status: 'completed' },
    }),
    JSON.stringify({
      parentUuid: 'r-u-3',
      type: 'assistant',
      uuid: 'r-a-3',
      sessionId,
      timestamp: '2026-08-01T10:00:05.000Z',
      requestId: 'req-r-3',
      effort: 'xhigh',
      message: {
        model: 'model-a',
        role: 'assistant',
        content: [{ type: 'text', text: 'final reply' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    }),
  ];

  const subLines = effortTurns(sessionId, ['medium', 'low', 'medium'], {
    agentId,
    isSidechain: true,
  });

  const metaJson = JSON.stringify({
    agentType: 'effort-subagent',
    description: 'Effort transition fixture subagent',
    toolUseId,
    spawnDepth: 1,
    model: 'model-a',
  });

  return bundle([
    artifact('transcript.jsonl', rootLines.join('\n'), 'application/jsonl'),
    artifact(`subagents/agent-${agentId}.jsonl`, subLines.join('\n'), 'application/jsonl'),
    artifact(`subagents/agent-${agentId}.meta.json`, metaJson, 'application/json'),
  ]);
}

/**
 * Root session (2 assistant entries: high, medium — one transition) and a
 * Sub Agent session (2 assistant entries: low, xhigh — one transition) that
 * are constructed so both sessions' `model_request` records land on the
 * exact same per-session `requestOrder` values (each session's own turn
 * counter restarts at the same ordinals). This proves the inclusive-scope
 * transition count sums each session's own transitions independently
 * rather than merging raw records across sessions and sorting by the
 * shared, per-session-relative ordinal — which would interleave the two
 * unrelated sessions and fabricate transitions that never happened
 * adjacently.
 */
function effortBundleWithCollidingRequestOrders(): UnknownArtifactBundle {
  const sessionId = 'eff-collide-root';
  const agentId = 'eff-collide-agent-1';
  const toolUseId = 'toolu_eff_collide_1';

  const rootLines = [
    JSON.stringify({ type: 'permission-mode', permissionMode: 'normal', sessionId }),
    JSON.stringify({
      parentUuid: null,
      type: 'user',
      uuid: 'rc-u-1',
      sessionId,
      timestamp: '2026-08-01T10:00:00.000Z',
      message: { role: 'user', content: 'start' },
    }),
    JSON.stringify({
      parentUuid: 'rc-u-1',
      type: 'assistant',
      uuid: 'rc-a-1',
      sessionId,
      timestamp: '2026-08-01T10:00:01.000Z',
      requestId: 'req-rc-1',
      effort: 'high',
      message: {
        model: 'model-a',
        role: 'assistant',
        content: [{ type: 'text', text: 'first reply' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    }),
    JSON.stringify({
      parentUuid: 'rc-a-1',
      type: 'user',
      uuid: 'rc-u-2',
      sessionId,
      timestamp: '2026-08-01T10:00:02.000Z',
      message: { role: 'user', content: [{ type: 'tool_use', id: toolUseId }] },
    }),
    JSON.stringify({
      parentUuid: 'rc-u-2',
      type: 'assistant',
      uuid: 'rc-a-2',
      sessionId,
      timestamp: '2026-08-01T10:00:03.000Z',
      requestId: 'req-rc-2',
      effort: 'medium',
      message: {
        model: 'model-a',
        role: 'assistant',
        content: [{ type: 'tool_use', id: toolUseId, name: 'Agent', input: { prompt: 'go' } }],
      },
    }),
    JSON.stringify({
      parentUuid: 'rc-a-2',
      type: 'user',
      uuid: 'rc-u-3',
      sessionId,
      timestamp: '2026-08-01T10:00:04.000Z',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'done' }],
      },
      toolUseResult: { agentId, resolvedModel: 'model-a', totalTokens: 10, status: 'completed' },
    }),
  ];

  // Same shape as the root transcript (1 user turn, then 2 user/assistant
  // pairs) so its own turnOrdinal counter lands on the same requestOrder
  // values (2, 4) as the root session above — a literal collision.
  const subLines = effortTurns(sessionId, ['low', 'xhigh'], {
    agentId,
    isSidechain: true,
  });

  const metaJson = JSON.stringify({
    agentType: 'effort-collide-subagent',
    description: 'Effort transition collision fixture subagent',
    toolUseId,
    spawnDepth: 1,
    model: 'model-a',
  });

  return bundle([
    artifact('transcript.jsonl', rootLines.join('\n'), 'application/jsonl'),
    artifact(`subagents/agent-${agentId}.jsonl`, subLines.join('\n'), 'application/jsonl'),
    artifact(`subagents/agent-${agentId}.meta.json`, metaJson, 'application/json'),
  ]);
}

describe('claude-code-metrics', () => {
  describe('definitions', () => {
    it('exports a metric definition for every Phase 1 root and inclusive metric', () => {
      const definitions = getClaudeCodeMetricDefinitions();
      expect(definitions.length).toBe(30);
      const ids = new Set(definitions.map((d) => d.metricId));
      expect(ids.has('claude:tokens:input:root_only')).toBe(true);
      expect(ids.has('claude:tokens:input:inclusive')).toBe(true);
      expect(ids.has('claude:invocations:tool:root_only')).toBe(true);
      expect(ids.has('claude:invocations:tool:inclusive')).toBe(true);
      expect(ids.has('claude:cost:total:root_only')).toBe(true);
      expect(ids.has('claude:cost:total:inclusive')).toBe(true);
      expect(ids.has('claude:effort:changes:root_only')).toBe(true);
      expect(ids.has('claude:effort:changes:inclusive')).toBe(true);
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
      expect(caps.length).toBe(30);
      for (const cap of caps) {
        expect(cap.state).toBe('partial');
        expect(cap.reason).toContain('no bundle');
      }
    });

    it('returns unavailable capabilities when bundle has no root transcript', () => {
      const b = bundle([artifact('unknown.bin', 'not claude')]);
      const caps = getClaudeCodeMetricCapabilities(b);
      expect(caps.length).toBe(30);
      for (const cap of caps) {
        expect(cap.state).toBe('unavailable');
        expect(cap.reason).toContain('root transcript');
      }
    });

    it('returns mixed availability for a valid transcript', () => {
      const caps = getClaudeCodeMetricCapabilities(happyPathBundle());
      expect(caps.length).toBe(30);
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
      for (const metric of result.metricValues as readonly ClaudeMetricValue[]) {
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

  describe('claude:effort:changes:*', () => {
    it('is null with an unavailableReason (never 0) when n=0: no entry carries a recognized effort value', () => {
      const result = ClaudeCodeTransformer.transform(
        effortBundle([undefined, 'not-a-real-level']),
        defaultContext,
      );
      for (const scope of ['root_only', 'inclusive'] as const) {
        const metric = findMetric(result, `claude:effort:changes:${scope}`);
        expect(metric?.value).toBeNull();
        expect(metric?.unavailableReason).toBe(
          'no recognized effort signal observed for this session',
        );
        const reason = result.unavailableReasons.find(
          (r) => r.metricId === `claude:effort:changes:${scope}`,
        );
        expect(reason?.reason).toBe('no recognized effort signal observed for this session');
      }
    });

    it('is a measured 0 (not unavailable) when n=1: exactly one entry carries a recognized effort value', () => {
      const result = ClaudeCodeTransformer.transform(effortBundle(['high']), defaultContext);
      for (const scope of ['root_only', 'inclusive'] as const) {
        const metric = findMetric(result, `claude:effort:changes:${scope}`);
        expect(metric?.value).toBe(0);
        expect(metric?.unavailableReason).toBeUndefined();
        expect(metric?.evidenceRecordIds.length).toBe(1);
      }
    });

    it('counts exactly one transition for n=3 with values high, high, xhigh', () => {
      const result = ClaudeCodeTransformer.transform(
        effortBundle(['high', 'high', 'xhigh']),
        defaultContext,
      );
      for (const scope of ['root_only', 'inclusive'] as const) {
        const metric = findMetric(result, `claude:effort:changes:${scope}`);
        expect(metric?.value).toBe(1);
        expect(metric?.unavailableReason).toBeUndefined();
        expect(metric?.evidenceRecordIds.length).toBe(3);
      }
    });

    it('skips null/unrecognized normalizedEffort values when comparing (they neither end nor start a streak)', () => {
      // high, <unrecognized -> null>, high, xhigh: the null entry must not
      // be treated as a transition away from or back to 'high' — only
      // high -> xhigh counts, and the unrecognized entry never contributes
      // to n.
      const result = ClaudeCodeTransformer.transform(
        effortBundle(['high', 'not-a-real-level', 'high', 'xhigh']),
        defaultContext,
      );
      const metric = findMetric(result, 'claude:effort:changes:root_only');
      expect(metric?.value).toBe(1);
      expect(metric?.evidenceRecordIds.length).toBe(3);
    });

    it('root-only counts only the root session; inclusive also includes the Sub Agent session', () => {
      const result = ClaudeCodeTransformer.transform(effortBundleWithSubagent(), defaultContext);

      const rootMetric = findMetric(result, 'claude:effort:changes:root_only');
      const inclusiveMetric = findMetric(result, 'claude:effort:changes:inclusive');

      // Root session alone: high, high, xhigh -> 1 transition, n=3.
      expect(rootMetric?.value).toBe(1);
      expect(rootMetric?.evidenceRecordIds.length).toBe(3);

      // Inclusive scope sums each session's own transition count
      // independently: root contributes 1 (high -> xhigh) and the Sub
      // Agent contributes 2 (medium -> low -> medium) = 3 total. Merging
      // raw records across sessions and sorting by the shared,
      // per-session-relative requestOrder would instead interleave the
      // two sessions and fabricate a value of 5 — this pins the real
      // number so that regression ships red, not green.
      expect(inclusiveMetric?.value).toBe(3);
      expect(inclusiveMetric?.unavailableReason).toBeUndefined();
      expect(inclusiveMetric?.evidenceRecordIds.length).toBe(6);
      for (const id of rootMetric?.evidenceRecordIds ?? []) {
        expect(inclusiveMetric?.evidenceRecordIds).toContain(id);
      }
    });

    it('does not interleave root and Sub Agent sessions when their requestOrder values literally collide', () => {
      // Root (requestOrder 2, 4: high -> medium = 1 transition) and the Sub
      // Agent (requestOrder 2, 4: low -> xhigh = 1 transition) share the
      // exact same per-session requestOrder values. A merge-then-sort-by-
      // requestOrder implementation would interleave the four records by
      // insertion order at each tied requestOrder and could fabricate an
      // extra cross-session transition; grouping by sessionId before
      // walking each session's own carried-value streak must not.
      const result = ClaudeCodeTransformer.transform(
        effortBundleWithCollidingRequestOrders(),
        defaultContext,
      );

      const rootMetric = findMetric(result, 'claude:effort:changes:root_only');
      const inclusiveMetric = findMetric(result, 'claude:effort:changes:inclusive');

      expect(rootMetric?.value).toBe(1);
      expect(rootMetric?.evidenceRecordIds.length).toBe(2);

      expect(inclusiveMetric?.value).toBe(2);
      expect(inclusiveMetric?.unavailableReason).toBeUndefined();
      expect(inclusiveMetric?.evidenceRecordIds.length).toBe(4);
    });
  });
});
