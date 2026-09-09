import { FRESH_SCHEMA_SQL } from '@lucasschirm/sal-db-core';
import { createDefaultRegistry } from '@lucasschirm/sal-transformer-registry';
import { describe, expect, it } from 'vitest';
import { WasmSqliteExecutor } from '../../../db-core/tests/helpers/sqlite-wasm-adapter.js';
import { createAnalyticsDataSource } from '../../src/analytics.js';
import { createSha256ContentHasher, DefaultIngestionOrchestrator } from '../../src/ingestion.js';
import { buildDevinManifestBundle } from '../fixtures/devin-manifest.js';

/**
 * PIPE-018 (DS-B31 (#290)): the Devin-side counterpart to PIPE-016 —
 * catalog-`label`-derived effort tier extraction (never `model_uid` alone,
 * per finding 3b), `message_effort` backfill via the SAME, unmodified #289
 * shared writer (`packages/db/src/ingestion.ts`'s `upsertMessageEffort`,
 * which reads any `model_request` OR `model_usage` evidence record), and
 * `devin:effort:changes:*` reconciliation — verified end-to-end through
 * real ingestion, not just the transformer's own unit/conformance tests.
 */

const ANALYSIS_RELEASE = 'ar-pipe018';
const EFFORT_METRIC_ROOT = 'devin:effort:changes:root_only';

async function setup() {
  const executor = await WasmSqliteExecutor.create();
  await executor.exec(FRESH_SCHEMA_SQL);
  const hasher = createSha256ContentHasher();
  const orchestrator = new DefaultIngestionOrchestrator({
    executor,
    hasher,
    registry: createDefaultRegistry(),
    resolver: { resolve: async (ref) => ({ ...ref, content: new Uint8Array(0) }) },
    analysisReleaseId: ANALYSIS_RELEASE,
  });
  const dataSource = createAnalyticsDataSource(executor);
  return { executor, orchestrator, dataSource };
}

describe('PIPE-018: Devin effort-change metric — catalog-label tier extraction, message_effort backfill, rollup reconciliation', () => {
  it('counts exactly one transition for a mid-session model switch (glm-5-2 High -> swe-1-7 Max)', async () => {
    const { executor, orchestrator } = await setup();
    const { bundle } = await buildDevinManifestBundle({
      sessionId: 'sess-pipe018-multi',
      useModelSwitchBundle: true,
    });

    const receipt = await orchestrator.ingestManifest(bundle);
    expect(receipt.status).toBe('committed');

    const { rows } = await executor.exec(
      'SELECT request_order, raw_effort, normalized_effort FROM message_effort WHERE session_id = ? ORDER BY request_order',
      [receipt.sessionId],
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.raw_effort)).toEqual(['High', 'Max']);
    expect(rows.map((r) => r.normalized_effort)).toEqual(['high', 'max']);

    const { rows: metricRows } = await executor.exec(
      `SELECT mv.integer_value, mv.is_unavailable
       FROM metric_values mv
       JOIN metric_definitions md ON md.id = mv.metric_definition_id
       WHERE md.metric_id = ? AND mv.generation_id = ?`,
      [EFFORT_METRIC_ROOT, receipt.generationId],
    );
    expect(metricRows).toHaveLength(1);
    expect(metricRows[0]?.integer_value).toBe(1);
    expect(metricRows[0]?.is_unavailable).toBe(0);
  });

  it('reports a measured-zero (n=1, never unavailable) transition count for a single-tier session', async () => {
    const { executor, orchestrator } = await setup();
    const { bundle } = await buildDevinManifestBundle({
      sessionId: 'sess-pipe018-single',
      useSingleTierBundle: true,
    });

    const receipt = await orchestrator.ingestManifest(bundle);
    expect(receipt.status).toBe('committed');

    const { rows } = await executor.exec(
      'SELECT raw_effort, normalized_effort FROM message_effort WHERE session_id = ?',
      [receipt.sessionId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.raw_effort).toBe('Low');
    expect(rows[0]?.normalized_effort).toBe('low');

    const { rows: metricRows } = await executor.exec(
      `SELECT mv.integer_value, mv.is_unavailable, mv.unavailable_reason
       FROM metric_values mv
       JOIN metric_definitions md ON md.id = mv.metric_definition_id
       WHERE md.metric_id = ? AND mv.generation_id = ?`,
      [EFFORT_METRIC_ROOT, receipt.generationId],
    );
    expect(metricRows).toHaveLength(1);
    // n=1 -> a measured 0, never unavailable (missing-is-never-zero.md).
    expect(metricRows[0]?.integer_value).toBe(0);
    expect(metricRows[0]?.is_unavailable).toBe(0);
    expect(metricRows[0]?.unavailable_reason).toBeNull();
  });

  it('is unavailable (never a fabricated 0) when no model_usage record resolves a recognized effort tier', async () => {
    const { executor, orchestrator } = await setup();
    // The plain `linearBundle` fixture: its session-level fallback model
    // ("Devin Default") has no tier phrase in its catalog label, so zero
    // message_effort rows are written (absence of a row is the signal).
    const { bundle } = await buildDevinManifestBundle({ sessionId: 'sess-pipe018-none' });

    const receipt = await orchestrator.ingestManifest(bundle);
    expect(receipt.status).toBe('committed');

    const { rows } = await executor.exec('SELECT * FROM message_effort WHERE session_id = ?', [
      receipt.sessionId,
    ]);
    expect(rows).toHaveLength(0);

    const { rows: metricRows } = await executor.exec(
      `SELECT mv.integer_value, mv.is_unavailable, mv.unavailable_reason
       FROM metric_values mv
       JOIN metric_definitions md ON md.id = mv.metric_definition_id
       WHERE md.metric_id = ? AND mv.generation_id = ?`,
      [EFFORT_METRIC_ROOT, receipt.generationId],
    );
    expect(metricRows).toHaveLength(1);
    expect(metricRows[0]?.integer_value).toBeNull();
    expect(metricRows[0]?.is_unavailable).toBe(1);
    expect(metricRows[0]?.unavailable_reason).toBe(
      'no recognized effort signal observed for this session',
    );
  });

  it('reconciles project-level rollup contributions as the sum of session contributions (generic aggregation:sum path)', async () => {
    const { executor, orchestrator } = await setup();
    const single = await orchestrator.ingestManifest(
      (
        await buildDevinManifestBundle({
          sessionId: 'sess-pipe018-rollup-a',
          useSingleTierBundle: true,
        })
      ).bundle,
    );
    const multi = await orchestrator.ingestManifest(
      (
        await buildDevinManifestBundle({
          sessionId: 'sess-pipe018-rollup-b',
          useModelSwitchBundle: true,
        })
      ).bundle,
    );
    expect(single.status).toBe('committed');
    expect(multi.status).toBe('committed');

    // #290 ships no dashboard consumer for this metric (same posture as
    // #289) — asserts the metric reconciles through the generic
    // rollup_contributions path directly rather than a headline/trend query
    // that doesn't exist yet.
    const { rows } = await executor.exec(
      `SELECT SUM(rc.additive_value) AS total
       FROM rollup_contributions rc
       JOIN metric_definitions md ON md.id = rc.metric_definition_id
       WHERE md.metric_id = ? AND rc.contribution_scope = 'root_only' AND rc.bucket_type = 'daily'
         AND rc.session_id IN (?, ?)`,
      [EFFORT_METRIC_ROOT, single.sessionId, multi.sessionId],
    );
    // Session A (single tier) contributes 0 (measured zero), session B
    // (model switch) contributes 1.
    expect(Number(rows[0]?.total)).toBe(1);
  });
});
