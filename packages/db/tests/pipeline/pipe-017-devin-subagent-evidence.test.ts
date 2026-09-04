import { FRESH_SCHEMA_SQL, NormalizedEventStore } from '@lucasschirm/sal-db-core';
import { createDefaultRegistry } from '@lucasschirm/sal-transformer-registry';
import { describe, expect, it } from 'vitest';
import { WasmSqliteExecutor } from '../../../db-core/tests/helpers/sqlite-wasm-adapter.js';
import { createAnalyticsDataSource } from '../../src/analytics.js';
import { createSha256ContentHasher, DefaultIngestionOrchestrator } from '../../src/ingestion.js';
import { buildDevinManifestBundle } from '../fixtures/devin-manifest.js';
import { FailureInjectionExecutor } from './harness.js';

/**
 * PIPE-017 (DS-B28 (#294)): the Devin sub-agent evidence capture and the
 * two ordering-corruption fixes (findings #4/#5), verified end-to-end
 * through real ingestion -- not just the transformer's own unit/conformance
 * tests. Uses the `subagentBundle` conformance fixture (a foreground and a
 * background `run_subagent` invocation, a duplicate `message_nodes` pair,
 * and an orphaned sub-agent tree) via `buildDevinManifestBundle({
 * useSubagentBundle: true })`.
 */

async function setupPipeline() {
  const inner = await WasmSqliteExecutor.create();
  await inner.exec(FRESH_SCHEMA_SQL);
  const harness = new FailureInjectionExecutor(inner);
  harness.setInjection(undefined);
  const orchestrator = new DefaultIngestionOrchestrator({
    executor: harness,
    hasher: createSha256ContentHasher(),
    registry: createDefaultRegistry(),
    resolver: { resolve: async (ref) => ({ ...ref, content: new Uint8Array(0) }) },
    analysisReleaseId: 'ar-pipe017',
  });
  return { harness, orchestrator };
}

interface NormalizedEventPayload {
  category?: string;
  agentId?: string;
  kind?: string;
  content?: string;
  isBackground?: boolean;
  rootNodeId?: number;
  [key: string]: unknown;
}

function payloadOf(rawDetails: string | null): NormalizedEventPayload {
  if (!rawDetails) return {};
  const parsed = JSON.parse(rawDetails) as { payload?: NormalizedEventPayload };
  return parsed.payload ?? {};
}

describe('PIPE-017: Devin sub-agent evidence and ordering-corruption fixes', () => {
  it('reaches normalized_events with correct foreground/background subagent_turn evidence and no fabricated fields', async () => {
    const { harness, orchestrator } = await setupPipeline();
    const { bundle } = await buildDevinManifestBundle({ useSubagentBundle: true });

    const receipt = await orchestrator.ingestManifest(bundle);
    expect(receipt.status).toBe('committed');
    expect(receipt.issueIds).toEqual([]);

    const events = await NormalizedEventStore.listBySession(harness, receipt.sessionId);
    const normalizedEvents = events.filter((e) => e.eventType === 'normalized_event');

    const subagentTurns = normalizedEvents
      .map((e) => payloadOf(e.rawDetails))
      .filter((p) => p.category === 'subagent_turn');
    expect(subagentTurns).toHaveLength(4); // 2 prompts + 2 results (foreground + background)

    const foreground = subagentTurns.filter((p) => p.agentId === '44472e00');
    const background = subagentTurns.filter((p) => p.agentId === '55c47591');
    expect(foreground).toHaveLength(2);
    expect(background).toHaveLength(2);

    const backgroundResult = background.find((p) => p.kind === 'result');
    // Sourced from the untagged <subagent_completion_notification> node, not
    // the tagged "started" pointer -- finding #3's foreground/background
    // asymmetry, verified through real ingestion.
    expect(backgroundResult?.content).toBe(
      '<subagent_completion_notification>\n[Background subagent with agent_id=55c47591 completed]\n\nfull background report',
    );
    expect(backgroundResult?.isBackground).toBe(true);

    // missing-is-never-zero: no token/cache/cost/resolved-model-id fields
    // anywhere in the ingested payloads.
    for (const payload of subagentTurns) {
      expect(payload).not.toHaveProperty('tokens');
      expect(payload).not.toHaveProperty('cost');
      expect(payload).not.toHaveProperty('cachedTokens');
    }
    const foregroundResult = foreground.find((p) => p.kind === 'result');
    expect(foregroundResult?.model).toBe('Subagent Default');

    // Finding #5: the orphaned sub-agent tree is captured (not dropped) but
    // never claims a subagent correlation it can't back up.
    const detached = normalizedEvents
      .map((e) => payloadOf(e.rawDetails))
      .filter((p) => p.category === 'detached_conversation');
    expect(detached).toHaveLength(1);
    expect(detached[0]?.rootNodeId).toBe(317);
  });

  it('does not inflate devin:turns:count from the duplicate message_nodes pair or the orphaned tree (findings #4/#5)', async () => {
    const { harness, orchestrator } = await setupPipeline();
    const { bundle } = await buildDevinManifestBundle({ useSubagentBundle: true });

    const receipt = await orchestrator.ingestManifest(bundle);
    expect(receipt.status).toBe('committed');

    const dataSource = createAnalyticsDataSource(harness);
    const sessionSummary = await dataSource.session.getSummary(receipt.sessionId, {});
    const turnsMetric = sessionSummary.headlineMetrics.find(
      (m) => m.metricId === 'devin:turns:count:root_only',
    );

    // Real main-chain node ids (see subagentBundle's fixture, sessionLine's
    // main_chain_id: 250): 90, 177, 178, 226, 227, 228, 246, 247, 248, 250
    // (node 249 is the dropped duplicate of 250; the orphan tree 317/318/
    // 320/322 and the synthetic subagent lines are never in the main chain).
    expect(turnsMetric?.value).toBe(10);
  });
});
