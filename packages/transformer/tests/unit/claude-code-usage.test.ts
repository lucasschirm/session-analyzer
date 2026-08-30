import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ClaudeCodeSession } from '@lucasschirm/sal-claude-session-parser';
import {
  parseSession,
  parseSessionTranscript,
  parseSubagentMeta,
} from '@lucasschirm/sal-claude-session-parser';
import { describe, expect, it } from 'vitest';
import type { TransformContext, UnknownArtifactBundle } from '../../src/index.js';
import type {
  HookExecutionPayload,
  InvocationPayload,
  InvocationPayloadPayload,
  ModeEventPayload,
  ModelCapabilityPayload,
  ModelUsagePayload,
  PayloadRecordPayload,
  PermissionEventPayload,
  PricingVersionPayload,
} from '../../src/plugin/claude-code-usage.js';
import {
  normalizeHookExecutions,
  normalizeInvocationPayloads,
  normalizeInvocations,
  normalizeModeEvents,
  normalizeModelCapabilities,
  normalizeModelUsage,
  normalizePayloads,
  normalizePermissionEvents,
  normalizePricingVersions,
} from '../../src/plugin/claude-code-usage.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const parserFixtures = join(__dirname, '../../../parsers/claude-session-parser/tests/fixtures');

function fixture(name: string): string {
  return readFileSync(join(parserFixtures, name), 'utf8');
}

function bundle(
  artifacts: { relativePath: string; content: string; mediaType?: string }[],
): UnknownArtifactBundle {
  return {
    artifacts: artifacts.map((a) => ({
      relativePath: a.relativePath,
      mediaType: a.mediaType ?? 'text/plain',
      content: a.content,
    })),
    sourceIdentity: {
      sourceId: 'test-source',
      environmentId: 'test-env',
      projectId: 'test-proj',
      sessionId: 'test-sess',
    },
    sourceFingerprint: 'fp-test',
  };
}

const defaultContext: TransformContext = {
  analysisReleaseId: 'r1',
  parserId: '@lucasschirm/sal-claude-session-parser',
  parserVersion: '0.1.0',
  sourceFingerprint: 'fp-test',
  sourceEnvironmentId: 'env-1',
  sourceProjectId: 'proj-1',
  sourceSessionId: 'sess-1',
};

const artifactId = 'transcript.jsonl';

function mainWithSubagent(): ClaudeCodeSession {
  const builder = parseSession(fixture('e2e-main-session.jsonl'));
  const sub = parseSessionTranscript(fixture('e2e-subagent-transcript.jsonl'));
  const meta = parseSubagentMeta(fixture('e2e-subagent-meta.json'));
  return builder.appendSubAgent('e2e-agent-0001', sub, meta).toSession();
}

function knownModelSession(): ClaudeCodeSession {
  return knownModelSessionWithId('synth-1');
}

function knownModelSessionWithId(
  sessionId: string,
  model = 'claude-3-5-sonnet-20241022',
): ClaudeCodeSession {
  const jsonl = [
    JSON.stringify({ type: 'permission-mode', permissionMode: 'normal', sessionId }),
    JSON.stringify({
      parentUuid: null,
      type: 'user',
      uuid: `u-${sessionId}`,
      timestamp: '2026-08-01T10:00:00.000Z',
      timestampMs: 1_722_506_400_000,
      sessionId,
      lineNumber: 2,
      message: { role: 'user', content: 'Hello' },
    }),
    JSON.stringify({
      parentUuid: `u-${sessionId}`,
      type: 'assistant',
      uuid: `a-${sessionId}`,
      timestamp: '2026-08-01T10:00:01.000Z',
      timestampMs: 1_722_506_401_000,
      sessionId,
      lineNumber: 3,
      requestId: `req-${sessionId}`,
      message: {
        model,
        role: 'assistant',
        content: [{ type: 'text', text: 'Hi' }],
        usage: {
          input_tokens: 1_000,
          output_tokens: 200,
          cache_creation_input_tokens: 150,
          cache_read_input_tokens: 50,
          output_tokens_details: { thinking_tokens: 10 },
        },
      },
    }),
  ].join('\n');
  return parseSessionTranscript(jsonl);
}

describe('claude-code-usage normalizers', () => {
  it('produce deterministic record ids for the same session and context', () => {
    const session = parseSessionTranscript(fixture('t2-happy-path.jsonl'));
    const first = normalizeModelUsage(session, bundle([]), defaultContext, artifactId);
    const second = normalizeModelUsage(session, bundle([]), defaultContext, artifactId);
    expect(first.map((r) => r.recordId)).toEqual(second.map((r) => r.recordId));
  });

  describe('model_usage', () => {
    it('normalizes token classes from parser usage', () => {
      const session = parseSessionTranscript(fixture('t2-happy-path.jsonl'));
      const records = normalizeModelUsage(session, bundle([]), defaultContext, artifactId);

      expect(records.length).toBeGreaterThan(0);
      const record = records.find((r) => r.recordType === 'model_usage');
      expect(record).toBeDefined();
      const payload = record!.payload as ModelUsagePayload;
      expect(payload.inputTokens).toBe(5);
      expect(payload.outputTokens).toBe(40);
      expect(payload.cacheCreationTokens).toBe(100);
      expect(payload.cacheReadTokens).toBe(20);
      expect(payload.tokenValuesExact).toBe(true);
    });

    it('computes cost and pricing version for a known model', () => {
      const session = knownModelSession();
      const records = normalizeModelUsage(session, bundle([]), defaultContext, artifactId);

      expect(records.length).toBe(1);
      const payload = records[0].payload as ModelUsagePayload;
      expect(payload.model).toBe('claude-3-5-sonnet-20241022');
      expect(payload.provider).toBe('anthropic');
      expect(payload.tokenValuesExact).toBe(true);
      expect(typeof payload.cost).toBe('number');
      expect(payload.cost).toBeGreaterThan(0);
      expect(payload.costExact).toBe(false);
      expect(payload.pricingVersionId).toBeDefined();
      expect(payload.currency).toBe('USD');
    });

    it('leaves cost undefined for unknown models', () => {
      const session = parseSessionTranscript(fixture('t2-happy-path.jsonl'));
      const records = normalizeModelUsage(session, bundle([]), defaultContext, artifactId);
      const payload = records[0].payload as ModelUsagePayload;
      expect(payload.model).toBe('model-a');
      expect(payload.cost).toBeUndefined();
      expect(payload.pricingVersionId).toBeUndefined();
    });
  });

  describe('model_capabilities and pricing_versions', () => {
    it('emits exact capability and pricing records for known models', () => {
      const session = knownModelSession();
      const caps = normalizeModelCapabilities(session, bundle([]), defaultContext, artifactId);
      const prices = normalizePricingVersions(session, bundle([]), defaultContext, artifactId);

      expect(caps.length).toBe(1);
      const capPayload = caps[0].payload as ModelCapabilityPayload;
      expect(capPayload.model).toBe('claude-3-5-sonnet-20241022');
      expect(capPayload.provider).toBe('anthropic');
      expect(capPayload.contextWindow).toBe(200_000);
      expect(capPayload.contextWindowExact).toBe(true);

      expect(prices.length).toBe(1);
      const pricePayload = prices[0].payload as PricingVersionPayload;
      expect(pricePayload.model).toBe('claude-3-5-sonnet-20241022');
      expect(pricePayload.inputTokenPrice).toBeGreaterThan(0);
    });

    it('scopes pricing_version ids by session and links them to model_usage', () => {
      const sessionA = knownModelSessionWithId('synth-2a');
      const sessionB = knownModelSessionWithId('synth-2b');

      const usageA = normalizeModelUsage(sessionA, bundle([]), defaultContext, artifactId);
      const pricingA = normalizePricingVersions(sessionA, bundle([]), defaultContext, artifactId);
      const usageB = normalizeModelUsage(sessionB, bundle([]), defaultContext, artifactId);
      const pricingB = normalizePricingVersions(sessionB, bundle([]), defaultContext, artifactId);

      expect(pricingA.length).toBe(1);
      expect(pricingB.length).toBe(1);
      expect(pricingA[0].recordId).not.toBe(pricingB[0].recordId);

      const usagePayloadA = usageA[0].payload as ModelUsagePayload;
      const usagePayloadB = usageB[0].payload as ModelUsagePayload;
      expect(usagePayloadA.pricingVersionId).toBe(pricingA[0].recordId);
      expect(usagePayloadB.pricingVersionId).toBe(pricingB[0].recordId);
      expect(usagePayloadA.pricingVersionId).not.toBe(usagePayloadB.pricingVersionId);
    });

    it('emits inexact capabilities and no pricing for unknown models', () => {
      const session = parseSessionTranscript(fixture('t2-happy-path.jsonl'));
      const caps = normalizeModelCapabilities(session, bundle([]), defaultContext, artifactId);
      const prices = normalizePricingVersions(session, bundle([]), defaultContext, artifactId);

      expect(caps.length).toBe(1);
      const capPayload = caps[0].payload as ModelCapabilityPayload;
      expect(capPayload.model).toBe('model-a');
      expect(capPayload.contextWindow).toBeUndefined();
      expect(capPayload.contextWindowExact).toBe(false);
      expect(prices.length).toBe(0);
    });
  });

  describe('invocations', () => {
    it('keeps Tool, Skill, and Agent as distinct kinds', () => {
      const session = parseSessionTranscript(fixture('e2e-main-session.jsonl'));
      const records = normalizeInvocations(session, bundle([]), defaultContext, artifactId);

      const byKind = new Map<string, number>();
      for (const record of records) {
        const payload = record.payload as InvocationPayload;
        byKind.set(payload.kind, (byKind.get(payload.kind) ?? 0) + 1);
      }

      expect(byKind.get('tool')).toBeGreaterThan(0);
      expect(byKind.get('skill')).toBe(1);
      expect(byKind.get('agent')).toBe(1);

      const skill = records.find((r) => {
        const p = r.payload as InvocationPayload;
        return p.kind === 'skill';
      });
      expect(skill).toBeDefined();
      const skillPayload = skill!.payload as InvocationPayload;
      expect(skillPayload.name).toBe('csv-wrangler');
      expect(skillPayload.skillName).toBe('csv-wrangler');

      const agent = records.find((r) => {
        const p = r.payload as InvocationPayload;
        return p.kind === 'agent';
      });
      expect(agent).toBeDefined();
      const agentPayload = agent!.payload as InvocationPayload;
      expect(agentPayload.name).toBe('docs-drafter');
      expect(agentPayload.agentType).toBe('docs-drafter');
    });

    it('marks mcp tool invocations with server and tool names', () => {
      const session = parseSessionTranscript(fixture('e2e-main-session.jsonl'));
      const records = normalizeInvocations(session, bundle([]), defaultContext, artifactId);

      const mcp = records.find((r) => {
        const p = r.payload as InvocationPayload;
        return p.kind === 'tool' && p.name.startsWith('mcp__');
      });
      expect(mcp).toBeDefined();
      const p = mcp!.payload as InvocationPayload;
      expect(p.mcpServer).toBe('zephyr_tools');
      expect(p.mcpToolName).toBe('forecast');
    });

    it('links agent invocations to child session ids when a subagent transcript is present', () => {
      const session = mainWithSubagent();
      const records = normalizeInvocations(session, bundle([]), defaultContext, artifactId);

      const agent = records.find((r) => {
        const p = r.payload as InvocationPayload;
        return p.kind === 'agent';
      });
      expect(agent).toBeDefined();
      const p = agent!.payload as InvocationPayload;
      expect(p.childSessionId).toBeDefined();
      expect(p.origin).toBe('root');
      expect(p.parentSessionId).toBeUndefined();
    });

    it('marks subagent tool invocations with origin subagent', () => {
      const session = mainWithSubagent();
      const records = normalizeInvocations(session, bundle([]), defaultContext, artifactId);

      const childTool = records.find((r) => {
        const p = r.payload as InvocationPayload;
        return p.kind === 'tool' && p.name === 'Write' && p.origin === 'subagent';
      });
      expect(childTool).toBeDefined();
      const p = childTool!.payload as InvocationPayload;
      expect(p.parentSessionId).toBeDefined();
      expect(p.rootSessionId).toBeDefined();
    });
  });

  describe('payloads and invocation_payloads', () => {
    it('emits input and result payloads with estimated token separation', () => {
      const session = parseSessionTranscript(fixture('e2e-main-session.jsonl'));
      const records = normalizePayloads(session, bundle([]), defaultContext, artifactId);

      const inputs = records.filter((r) => {
        const p = r.payload as PayloadRecordPayload;
        return p.payloadType === 'input';
      });
      const results = records.filter((r) => {
        const p = r.payload as PayloadRecordPayload;
        return p.payloadType === 'result';
      });
      const injections = records.filter((r) => {
        const p = r.payload as PayloadRecordPayload;
        return p.payloadType === 'injection';
      });

      expect(inputs.length).toBeGreaterThan(0);
      expect(results.length).toBeGreaterThan(0);
      expect(injections.length).toBeGreaterThan(0);

      for (const record of records) {
        const p = record.payload as PayloadRecordPayload;
        expect(p.bytes).toBeGreaterThanOrEqual(0);
        expect(p.tokens).toBeGreaterThanOrEqual(0);
        expect(p.tokenSource).toBe('estimated');
      }
    });

    it('correlates invocations with payloads', () => {
      const session = parseSessionTranscript(fixture('e2e-main-session.jsonl'));
      const links = normalizeInvocationPayloads(session, bundle([]), defaultContext, artifactId);
      const invocations = normalizeInvocations(session, bundle([]), defaultContext, artifactId);

      expect(links.length).toBeGreaterThanOrEqual(invocations.length);

      const attributionTypes = new Set(
        links.map((r) => {
          const p = r.payload as InvocationPayloadPayload;
          return p.attributionType;
        }),
      );
      expect(attributionTypes.has('input')).toBe(true);
      expect(attributionTypes.has('result')).toBe(true);
      expect(attributionTypes.has('context')).toBe(true);

      for (const record of links) {
        const p = record.payload as InvocationPayloadPayload;
        expect(p.additive).toBe(false);
        expect(p.tokenSource).toBe('estimated');
        expect(p.invocationId).toBeDefined();
        expect(p.payloadId).toBeDefined();
      }
    });
  });

  describe('permission_events', () => {
    it('normalizes command_permissions as approvals', () => {
      const session = parseSessionTranscript(fixture('e2e-main-session.jsonl'));
      const records = normalizePermissionEvents(session, bundle([]), defaultContext, artifactId);

      expect(records.length).toBeGreaterThan(0);
      const payload = records[0].payload as PermissionEventPayload;
      expect(payload.decision).toBe('approval');
      expect(payload.mode).toBe('default');
      expect(payload.toolPatterns?.length).toBeGreaterThan(0);
    });

    it('normalizes tool denials', () => {
      const jsonl = [
        JSON.stringify({
          type: 'permission-mode',
          permissionMode: 'normal',
          sessionId: 'denial-sess',
        }),
        JSON.stringify({
          parentUuid: null,
          type: 'assistant',
          uuid: 'a-deny',
          timestamp: '2026-08-01T10:00:00.000Z',
          timestampMs: 1_722_506_400_000,
          sessionId: 'denial-sess',
          lineNumber: 2,
          message: {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'tool-deny', name: 'Bash', input: { command: 'rm -rf /' } },
            ],
          },
        }),
        JSON.stringify({
          parentUuid: 'a-deny',
          type: 'user',
          uuid: 'u-deny',
          timestamp: '2026-08-01T10:00:01.000Z',
          timestampMs: 1_722_506_401_000,
          sessionId: 'denial-sess',
          lineNumber: 3,
          sourceToolUseID: 'tool-deny',
          toolDenialKind: 'denied',
          permissionMode: 'normal',
          message: { role: 'user', content: 'No, do not run that.' },
        }),
      ].join('\n');
      const session = parseSessionTranscript(jsonl);
      const records = normalizePermissionEvents(session, bundle([]), defaultContext, artifactId);

      const denial = records.find((r) => {
        const p = r.payload as PermissionEventPayload;
        return p.decision === 'denial';
      });
      expect(denial).toBeDefined();
      const p = denial!.payload as PermissionEventPayload;
      expect(p.toolUseId).toBe('tool-deny');
      expect(p.prompt).toBeDefined();
      expect(p.promptLength).toBeGreaterThan(0);
    });
  });

  describe('mode_events', () => {
    it('normalizes mode transitions and effective intervals', () => {
      const session = parseSessionTranscript(fixture('e2e-main-session.jsonl'));
      const records = normalizeModeEvents(session, bundle([]), defaultContext, artifactId);

      expect(records.length).toBeGreaterThan(0);
      const first = records[0].payload as ModeEventPayload;
      const last = records[records.length - 1].payload as ModeEventPayload;

      expect(first.previousMode).toBeDefined();
      expect(first.effectiveFromLine).toBeGreaterThan(0);
      expect(last.nextMode).toBeUndefined();
      expect(last.effectiveToLine).toBeUndefined();
    });

    it('distinguishes session and permission mode types', () => {
      const session = parseSessionTranscript(fixture('t2-happy-path.jsonl'));
      const records = normalizeModeEvents(session, bundle([]), defaultContext, artifactId);

      const types = new Set(
        records.map((r) => {
          const p = r.payload as ModeEventPayload;
          return p.modeType;
        }),
      );
      expect(types.has('session')).toBe(true);
      expect(types.has('permission')).toBe(true);
    });
  });

  describe('hook_executions', () => {
    it('normalizes hook outcomes and context-bearing metadata', () => {
      const session = parseSessionTranscript(fixture('e2e-main-session.jsonl'));
      const records = normalizeHookExecutions(session, bundle([]), defaultContext, artifactId);

      const statuses = new Set(
        records.map((r) => {
          const p = r.payload as HookExecutionPayload;
          return p.status;
        }),
      );
      expect(statuses.has('success')).toBe(true);
      expect(statuses.has('error')).toBe(true);
      expect(statuses.has('message')).toBe(true);
      expect(statuses.has('context')).toBe(true);

      const contextHook = records.find((r) => {
        const p = r.payload as HookExecutionPayload;
        return p.hookName === 'context-hook';
      });
      expect(contextHook).toBeDefined();
      const p = contextHook!.payload as HookExecutionPayload;
      expect(p.injectedContextCount).toBeGreaterThan(0);
      expect(p.injectedContextLengths?.length).toBeGreaterThan(0);
    });
  });
});
