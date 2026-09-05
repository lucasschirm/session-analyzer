import {
  FRESH_SCHEMA_SQL,
  getCurrentGenerationId,
  NormalizedEventStore,
} from '@lucasschirm/sal-db-core';
import { createDefaultRegistry } from '@lucasschirm/sal-transformer-registry';
import type { ScalarMetricValue } from '@lucasschirm/sal-transformer-shared';
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

/**
 * PR #295 review finding #3: no test proved that bumping
 * `DEVIN_TRANSFORMER_VERSION`/`DEVIN_METRIC_DEFINITION_VERSION`
 * (`.agents/rules/metric-meaning-versioning.md`) actually gives a session
 * reprocessed after the bump a clean, non-mixed generation -- i.e. that
 * `devin:turns:count` reflects ONLY the new (fixed) logic, never blended
 * with a prior pre-fix generation's value.
 */
describe('PR #295 review finding #3: version bump forces a clean, non-mixed generation on reprocess', () => {
  it('reprocessing a session ingested under the pre-fix versions replaces devin:turns:count with ONLY the new value -- no mixing with the prior generation', async () => {
    const { harness, orchestrator } = await setupPipeline();
    const hasher = createSha256ContentHasher();
    const registry = createDefaultRegistry();
    const { bundle, resolvedArtifacts, sourceIdentity } = await buildDevinManifestBundle({
      useSubagentBundle: true,
    });

    // --- Generation 1: simulate ingestion under the PRE-FIX transformer
    // (DEVIN_TRANSFORMER_VERSION 0.2.0 / DEVIN_METRIC_DEFINITION_VERSION
    // 0.1.0), which neither deduped the duplicate message_nodes pair nor
    // excluded the orphaned sub-agent tree from turnOrdinal. The old code
    // no longer exists to literally re-run, so this takes the transformer's
    // REAL current output (structurally correct) and overrides only the
    // version stamps plus the turns:count value to the documented pre-fix
    // (inflated) count: 10 real fixed-generation nodes + 1 undeduped
    // duplicate (node 249) + 4 orphan-tree nodes spliced in by node_id
    // magnitude (317/318/320/322) = 15.
    const transformer = registry.resolve('devin');
    const sourceFingerprint = await hasher.hash(
      `transcript.jsonl:${resolvedArtifacts[0]?.sha256 ?? ''}`,
    );
    const artifactBundle = {
      artifacts: resolvedArtifacts.map((a) => ({ ...a, status: 'uploaded' as const })),
      sourceIdentity,
      sourceFingerprint,
    };
    const currentResult = transformer.transform(artifactBundle, {
      analysisReleaseId: 'ar-pipe017',
      parserId: transformer.id,
      parserVersion: '0.1.0',
      sourceFingerprint,
      sourceEnvironmentId: sourceIdentity.environmentId,
      sourceProjectId: sourceIdentity.projectId,
      sourceSessionId: sourceIdentity.sessionId,
    });
    const rootSession = currentResult.sessionSummaries[0];
    expect(rootSession).toBeTruthy();

    const OLD_BUGGY_TURNS_COUNT = 15;
    const isTurnsCount = (v: ScalarMetricValue) =>
      v.metricId === 'devin:turns:count:root_only' || v.metricId === 'devin:turns:count:inclusive';
    const oldResult = {
      ...currentResult,
      transformerVersion: '0.2.0',
      metricDefinitionVersion: '0.1.0',
      metricValues: currentResult.metricValues.map((v) =>
        isTurnsCount(v) ? { ...v, value: OLD_BUGGY_TURNS_COUNT, definitionVersion: '0.1.0' } : v,
      ),
    };

    const OLD_GENERATION_ID = 'gen-devin-pre-fix-simulated';
    const gen1 = await orchestrator.commitAtomic({
      generationId: OLD_GENERATION_ID,
      sessionId: rootSession?.sessionId as string,
      rootSessionId: rootSession?.rootSessionId as string,
      affectedProjectIds: ['devin-project'],
      candidateRecords: [],
      analysisReleaseId: 'ar-pipe017',
      result: oldResult as typeof currentResult,
      manifest: bundle.manifest,
      source: sourceIdentity,
    });
    expect(gen1.status).toBe('committed');
    expect(await getCurrentGenerationId(harness, gen1.sessionId)).toBe(OLD_GENERATION_ID);

    const dataSource = createAnalyticsDataSource(harness);
    const beforeSummary = await dataSource.session.getSummary(gen1.sessionId, {});
    const beforeTurns = beforeSummary.headlineMetrics.find(
      (m) => m.metricId === 'devin:turns:count:root_only',
    );
    // Sanity check: the simulated pre-fix generation is genuinely current
    // and shows the inflated, buggy value before reprocessing.
    expect(beforeTurns?.value).toBe(OLD_BUGGY_TURNS_COUNT);

    // --- Generation 2: reprocess the SAME session/content through the
    // REAL, current (post-fix) transformer via the normal ingestion path.
    const gen2 = await orchestrator.ingestManifest(bundle);
    expect(gen2.status).toBe('committed');
    expect(gen2.generationId).not.toBe(OLD_GENERATION_ID);
    expect(await getCurrentGenerationId(harness, gen2.sessionId)).toBe(gen2.generationId);

    const afterSummary = await dataSource.session.getSummary(gen2.sessionId, {});
    const afterTurns = afterSummary.headlineMetrics.find(
      (m) => m.metricId === 'devin:turns:count:root_only',
    );
    // ONLY the new (correct, deduped + orphan-excluded) value -- 10, per the
    // sibling PIPE-017 test above -- never the old inflated value (15) and
    // never a blend/sum of the two generations (e.g. 25).
    expect(afterTurns?.value).toBe(10);

    // The pre-fix generation's own row is left historically intact, but is
    // no longer the session's current generation, so it never contributes
    // to any current-generation read -- reprocessing replaces, it doesn't mix.
    const { rows: oldGenRows } = await harness.exec(
      `SELECT mv.integer_value, mv.numeric_value FROM metric_values mv
       JOIN metric_definitions md ON md.id = mv.metric_definition_id
       WHERE md.metric_id = 'devin:turns:count:root_only' AND mv.generation_id = ?`,
      [OLD_GENERATION_ID],
    );
    const storedOldValue = Number(oldGenRows[0]?.integer_value ?? oldGenRows[0]?.numeric_value);
    expect(storedOldValue).toBe(OLD_BUGGY_TURNS_COUNT);

    // The new generation's own recorded metric_version must be the CURRENT
    // comparability-group version (0.2.0, `comparability.ts`'s
    // `DEVIN_METRIC_DEFINITION_VERSION`) -- not the stale 0.1.0 the
    // transformer used to report. `devin-transformer.ts` previously
    // declared its OWN separate, never-bumped `DEVIN_METRIC_DEFINITION_VERSION`
    // constant that fed `TransformResult.metricDefinitionVersion` (and this
    // column) while `comparability.ts`'s copy -- the one the metric values'
    // own `comparabilityGroupId`s actually use -- had already moved to
    // 0.2.0. Left unfixed, a generation's own version stamp would silently
    // under-report which comparability version it was actually computed
    // under.
    const { rows: genRows } = await harness.exec(
      'SELECT metric_version FROM transformation_generations WHERE id = ?',
      [gen2.generationId],
    );
    // 0.3.0 since #323 (devin:tokens:total formula fix) — this literal
    // deliberately pins comparability.ts's DEVIN_METRIC_DEFINITION_VERSION
    // so an unpropagated bump is caught here.
    expect(genRows[0]?.metric_version).toBe('0.3.0');
  });
});
