import { describe, expect, it } from 'vitest';
import { DevinTransformer } from '../../src/index.js';
import {
  authoritativeChainBundle,
  defaultContext,
  linearBundle,
  messageNodeReplayBundle,
  metadataTokensBundle,
  noRootBundle,
  partialTokensBundle,
  sessionReplayBundle,
  toolCallReplayBundle,
  unknownSchemaBundle,
} from '../conformance/fixtures/index.js';

function findMetric(
  result: { metricValues: readonly { metricId: string; value: unknown; exact?: boolean }[] },
  metricId: string,
) {
  return result.metricValues.find((m) => m.metricId === metricId);
}

describe('DevinTransformer.transform', () => {
  it('produces a session summary, evidence, and metric values', () => {
    const result = DevinTransformer.transform(linearBundle, defaultContext);
    expect(result.errors).toEqual([]);
    expect(result.sessionSummaries.length).toBe(1);
    expect(result.evidence.length).toBeGreaterThan(0);
    expect(result.metricValues.length).toBeGreaterThan(0);
    expect(result.capabilities.length).toBe(result.metricValues.length);
  });

  it('derives token counts from ATIF final metrics', () => {
    const result = DevinTransformer.transform(linearBundle, defaultContext);
    expect(findMetric(result, 'devin:tokens:prompt:root_only')?.value).toBe(100);
    expect(findMetric(result, 'devin:tokens:completion:root_only')?.value).toBe(50);
    expect(findMetric(result, 'devin:tokens:cached:root_only')?.value).toBe(10);
    // total = prompt + completion (#323): cached is a subset of prompt,
    // never re-added.
    expect(findMetric(result, 'devin:tokens:total:root_only')?.value).toBe(150);
  });

  it('resolves session-level state from the LAST session line, not the first (#320)', () => {
    const result = DevinTransformer.transform(sessionReplayBundle, defaultContext);
    expect(result.errors).toEqual([]);
    const sessionRecords = result.evidence.filter((r) => r.recordType === 'session');
    expect(sessionRecords.length).toBe(1);
    const payload = sessionRecords[0]?.payload as {
      title?: string;
      model?: string;
      endTime?: string;
    };
    expect(payload.title).toBe('Fresh replayed title');
    expect(payload.model).toBe('devin-updated');
    // last_activity_at from the SECOND session line (1722524500s), not the
    // first-pass value (1722520900s).
    expect(payload.endTime).toBe(new Date(1722524500 * 1000).toISOString());
  });

  it('dedupes tool_call lines replayed across sync passes by toolCallId (#321)', () => {
    const result = DevinTransformer.transform(toolCallReplayBundle, defaultContext);
    expect(result.errors).toEqual([]);
    const invocations = result.evidence.filter((r) => r.recordType === 'invocation');
    expect(invocations.length).toBe(1);
    // The update-bearing (completed) line wins, even though a regressed
    // no-update duplicate was appended after it.
    const invocationPayload = invocations[0]?.payload as { status?: string } | undefined;
    expect(invocationPayload?.status).toBe('success');
    expect(findMetric(result, 'devin:invocations:tool:root_only')?.value).toBe(1);
    // No duplicate recordIds anywhere — duplicates were a PK violation at
    // ingestion.
    const ids = result.evidence.map((r) => r.recordId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it(
    'resolves a message_nodes row replayed under the same node_id (fresh row_id, changed ' +
      'content) to exactly one message/turn record carrying the LATEST content -- no ' +
      "production transformer change needed for #341's extractor fix",
    () => {
      const result = DevinTransformer.transform(messageNodeReplayBundle, defaultContext);
      expect(result.errors).toEqual([]);

      const messages = result.evidence.filter((r) => r.recordType === 'message');
      const turns = result.evidence.filter((r) => r.recordType === 'turn');
      // Exactly one message/turn pair per real node_id (1 and 2) -- the
      // replayed duplicate of node_id 1 never produces a second record.
      expect(messages.length).toBe(2);
      expect(turns.length).toBe(2);

      const nodeOnePayload = messages.find((r) => (r.payload as { nodeId?: number }).nodeId === 1)
        ?.payload as { content?: string } | undefined;
      // The transformer's Map-based last-write-wins (parse-bundle.ts's
      // `byId`) resolves to the LATER transcript line's content, matching
      // what an in-place edit replay actually means.
      expect(nodeOnePayload?.content).toBe('Run the build (edited)');

      // No duplicate recordIds anywhere -- a replayed node_id must never
      // reach ingestion as a PK violation (mirrors the tool-call-replay
      // guard above).
      const ids = result.evidence.map((r) => r.recordId);
      expect(new Set(ids).size).toBe(ids.length);
    },
  );

  it('derives tier-3 tokens from the real response_dimensions shape (#322)', () => {
    const result = DevinTransformer.transform(metadataTokensBundle, defaultContext);
    expect(result.errors).toEqual([]);
    // prompt = input_tokens + cached_input_tokens: the uid `input_tokens`
    // excludes cache reads, while devin:tokens:prompt means total input
    // incl. cache (ATIF final_metrics semantics).
    expect(findMetric(result, 'devin:tokens:prompt:root_only')?.value).toBe(3265287 + 37556736);
    expect(findMetric(result, 'devin:tokens:completion:root_only')?.value).toBe(136906);
    expect(findMetric(result, 'devin:tokens:cached:root_only')?.value).toBe(37556736);
    // total = prompt + completion (#323); the true tokens processed, not
    // the ~2x sum the old formula produced on cache-heavy sessions.
    expect(findMetric(result, 'devin:tokens:total:root_only')?.value).toBe(
      3265287 + 37556736 + 136906,
    );
    expect(findMetric(result, 'devin:tokens:prompt:root_only')?.exact).toBe(true);
    // The non-cumulative `model` dimension is skipped, and the session-level
    // model_usage record carries the aggregate.
    const usage = result.evidence.filter((r) => r.recordType === 'model_usage');
    expect(usage.length).toBe(1);
    const usagePayload = usage[0]?.payload as { inputTokens?: number | null } | undefined;
    expect(usagePayload?.inputTokens).toBe(3265287 + 37556736);
  });

  it('anchors the main chain on the INTEGER main_chain_id, beating a larger orphan tree (#324)', () => {
    const result = DevinTransformer.transform(authoritativeChainBundle, defaultContext);
    expect(result.errors).toEqual([]);
    // Pre-#324 the parser nulled the INTEGER main_chain_id, so the
    // biggest-subtree heuristic promoted the 5-node orphan tree (#309's
    // failure case) and the real 2-turn conversation was dropped.
    expect(findMetric(result, 'devin:turns:count:root_only')?.value).toBe(2);
    const turnNodeIds = result.evidence
      .filter((r) => r.recordType === 'turn')
      .map((r) => (r.payload as { nodeId?: number }).nodeId);
    expect(turnNodeIds).toEqual([1, 2]);
  });

  it('counts turns from the message main chain', () => {
    const result = DevinTransformer.transform(linearBundle, defaultContext);
    expect(findMetric(result, 'devin:turns:count:root_only')?.value).toBe(4);
  });

  it('counts tool invocations from tool_call_state records', () => {
    const result = DevinTransformer.transform(linearBundle, defaultContext);
    expect(findMetric(result, 'devin:invocations:tool:root_only')?.value).toBe(1);
  });

  it('emits invocation records with start/result ids and payload records', () => {
    const result = DevinTransformer.transform(linearBundle, defaultContext);
    const invocations = result.evidence.filter((r) => r.recordType === 'invocation');
    expect(invocations.length).toBe(1);
    const payloads = result.evidence.filter(
      (r) =>
        r.recordType === 'payload' && (r.payload as { toolUseId?: string }).toolUseId === 'tc-1',
    );
    expect(payloads.length).toBe(2);
  });

  it('computes a positive wall duration from session timestamps', () => {
    const result = DevinTransformer.transform(linearBundle, defaultContext);
    const duration = findMetric(result, 'devin:duration:wall_ms:root_only');
    expect(typeof duration?.value).toBe('number');
    expect(duration?.value).toBeGreaterThan(0);
    expect(duration?.exact).toBe(true);
  });

  it('leaves cost unavailable with a reason', () => {
    const result = DevinTransformer.transform(linearBundle, defaultContext);
    const cost = findMetric(result, 'devin:cost:total:root_only');
    expect(cost?.value).toBeNull();
    expect(cost?.exact).toBe(false);
    expect(result.unavailableReasons.some((r) => r.metricId === 'devin:cost:total:root_only')).toBe(
      true,
    );
  });

  it('emits root and inclusive metric pairs with equal values when no subagents are present', () => {
    const result = DevinTransformer.transform(linearBundle, defaultContext);
    for (const metric of result.metricValues) {
      if (!metric.metricId.endsWith(':root_only')) continue;
      const inclusiveId = metric.metricId.replace(':root_only', ':inclusive');
      const inclusive = findMetric(result, inclusiveId);
      expect(inclusive).toBeDefined();
      if (metric.value !== null) {
        expect(inclusive?.value).toBe(metric.value);
      }
    }
  });

  it('produces distinct comparability groups for each metric', () => {
    const result = DevinTransformer.transform(linearBundle, defaultContext);
    const groups = new Set(result.metricValues.map((m) => m.comparabilityGroupId));
    expect(groups.size).toBe(result.metricValues.length);
  });

  it('reports a fatal error when no root transcript is present', () => {
    const result = DevinTransformer.transform(noRootBundle, defaultContext);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.sessionSummaries.length).toBe(0);
    expect(result.metricValues.length).toBe(0);
  });

  it('marks token metrics unavailable when token data is missing', () => {
    const result = DevinTransformer.transform(partialTokensBundle, defaultContext);
    expect(result.errors).toEqual([]);
    expect(findMetric(result, 'devin:tokens:prompt:root_only')?.value).toBeNull();
    expect(findMetric(result, 'devin:tokens:total:root_only')?.value).toBeNull();
    expect(
      result.unavailableReasons.some((r) => r.metricId === 'devin:tokens:prompt:root_only'),
    ).toBe(true);
  });

  it('continues without ATIF when the schema version is unsupported', () => {
    const result = DevinTransformer.transform(unknownSchemaBundle, defaultContext);
    expect(result.errors).toEqual([]);
    expect(findMetric(result, 'devin:tokens:prompt:root_only')?.value).toBeNull();
    expect(findMetric(result, 'devin:turns:count:root_only')?.value).toBeGreaterThan(0);
  });

  it('produces deterministic record ids across two runs of the same bundle', () => {
    const first = DevinTransformer.transform(linearBundle, defaultContext);
    const second = DevinTransformer.transform(linearBundle, defaultContext);
    expect(first.evidence.map((r) => r.recordId)).toEqual(second.evidence.map((r) => r.recordId));
    expect(first.metricValues.map((m) => m.metricId)).toEqual(
      second.metricValues.map((m) => m.metricId),
    );
    expect(first.metricValues.map((m) => m.comparabilityGroupId)).toEqual(
      second.metricValues.map((m) => m.comparabilityGroupId),
    );
  });

  it('keeps record ids stable when artifact order is reversed', () => {
    const reversed = {
      ...linearBundle,
      artifacts: [...linearBundle.artifacts].reverse(),
    };
    const normal = DevinTransformer.transform(linearBundle, defaultContext);
    const rev = DevinTransformer.transform(reversed, defaultContext);
    expect(normal.sessionSummaries.map((s) => s.sessionId)).toEqual(
      rev.sessionSummaries.map((s) => s.sessionId),
    );
    expect(normal.evidence.map((r) => r.recordId)).toEqual(rev.evidence.map((r) => r.recordId));
  });
});
