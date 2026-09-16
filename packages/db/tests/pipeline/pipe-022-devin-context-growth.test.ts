import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRESH_SCHEMA_SQL, NormalizedEventStore } from '@lucasschirm/sal-db-core';
import { createDefaultRegistry } from '@lucasschirm/sal-transformer-registry';
import { describe, expect, it } from 'vitest';
import { WasmSqliteExecutor } from '../../../db-core/tests/helpers/sqlite-wasm-adapter.js';
import { createAnalyticsDataSource } from '../../src/analytics.js';
import { createSha256ContentHasher, DefaultIngestionOrchestrator } from '../../src/ingestion.js';
import { buildDevinManifestBundle } from '../fixtures/devin-manifest.js';
import { FailureInjectionExecutor } from './harness.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(__dirname, '../fixtures/devin-context-growth.jsonl');

/**
 * PIPE-022: a real transcript-only Devin session (anonymized `lucky-squid` —
 * no ATIF transcript, null `sessions.metadata.response_dimensions`) must
 * still produce a non-flat context-growth series and emit every compaction
 * boundary, including the ones whose `summarized_from` output nodes live in
 * detached continuation trees.
 *
 * Regression coverage for two transformer-seam bugs found on this session:
 *  1. `buildSessionSpine` dropped `num_tokens_preceding`, so the only
 *     `model_usage` record (tier-3 aggregate, all token fields null) left
 *     every ContextTimingPoint.contextTokens null — the chart rendered 0
 *     for all 591 messages.
 *  2. `buildDevinCompactionRecords` scanned `orderedMessages` only; Devin
 *     restarted the node forest under new `parent_node_id: null` roots for
 *     two of five compactions, landing their output nodes in
 *     `detachedMessages` — silently dropping those boundaries.
 */
function loadFixtureBundle() {
  const content = readFileSync(fixturePath, 'utf8');
  return buildDevinManifestBundle({
    sessionId: 'devin-context-growth',
    sourceBundle: {
      artifacts: [
        {
          relativePath: 'transcript.jsonl',
          content,
          mediaType: 'application/jsonl',
        },
      ],
    },
  });
}

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
    analysisReleaseId: 'ar-pipe022',
  });
  return { harness, orchestrator };
}

describe('PIPE-022: devin transcript-only context growth + detached-tree compactions', () => {
  it('materializes a non-flat context series from numTokensPreceding checkpoints', async () => {
    const { harness, orchestrator } = await setupPipeline();
    const { bundle } = await loadFixtureBundle();

    const receipt = await orchestrator.ingestManifest(bundle);
    expect(receipt.status).toBe('committed');

    const dataSource = createAnalyticsDataSource(harness);
    const series = await dataSource.session.getContextTimingSeries(receipt.sessionId);

    // The fixture's main chain carries 591 message points (previously every
    // one of them had contextTokens: null — the all-zero chart).
    expect(series.points.length).toBe(591);

    const withContext = series.points.filter((p) => p.contextTokens !== null);
    // Carry-forward fill covers every point; the chart must never be the
    // all-null/flat-zero shape this session produced before the fix.
    expect(withContext.length).toBe(series.points.length);

    // Non-flat: the real checkpoints range from ~19k up past 150k.
    const contextValues = new Set(withContext.map((p) => p.contextTokens));
    expect(contextValues.size).toBeGreaterThan(10);
    // The first populated assistant checkpoint in the transcript (node 24).
    expect(contextValues.has(18_997)).toBe(true);
    const maxContext = Math.max(...withContext.map((p) => p.contextTokens ?? 0));
    expect(maxContext).toBeGreaterThanOrEqual(150_000);
  });

  it('emits compaction evidence for all 5 boundaries, including detached-tree outputs', async () => {
    const { harness, orchestrator } = await setupPipeline();
    const { bundle } = await loadFixtureBundle();

    const receipt = await orchestrator.ingestManifest(bundle);
    expect(receipt.status).toBe('committed');

    // All 5 detected boundaries (parser-level ground truth) reach
    // normalized_events — including anchors 777/1075 whose summarized_from
    // outputs live in detached continuation trees.
    const events = await NormalizedEventStore.listBySession(harness, receipt.sessionId);
    const compactions = events.filter((e) => {
      const details = e.rawDetails ? JSON.parse(e.rawDetails) : {};
      return details.payload?.category === 'compaction';
    });
    expect(compactions).toHaveLength(5);

    // And the context series marks compaction positions for the chart.
    const dataSource = createAnalyticsDataSource(harness);
    const series = await dataSource.session.getContextTimingSeries(receipt.sessionId);
    const compacted = series.points.filter(
      (p) => p.compactedTokens !== undefined && p.compactedTokens > 0,
    );
    expect(compacted.length).toBeGreaterThan(0);
  });

  it('keeps devin token metrics missing — context growth never fabricates token metrics', async () => {
    const { harness, orchestrator } = await setupPipeline();
    const { bundle } = await loadFixtureBundle();

    const receipt = await orchestrator.ingestManifest(bundle);
    expect(receipt.status).toBe('committed');

    const dataSource = createAnalyticsDataSource(harness);
    const summary = await dataSource.session.getSummary(receipt.sessionId, {});
    const tokenMetric = summary.headlineMetrics.find((m) =>
      m.metricId.startsWith('devin:tokens:total:'),
    );
    // missing-is-never-zero: numTokensPreceding feeds the chart only; the
    // session-level token metrics stay genuinely absent without ATIF or
    // response_dimensions.
    expect(tokenMetric).toBeDefined();
    expect(tokenMetric?.value).toBeNull();
  });
});
