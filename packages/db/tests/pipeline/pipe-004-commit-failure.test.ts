import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRESH_SCHEMA_SQL, MetricValueStore } from '@lucasschirm/sal-db-core';
import { createDefaultRegistry } from '@lucasschirm/sal-transformer-registry';
import { describe, expect, it } from 'vitest';
import { WasmSqliteExecutor } from '../../../db-core/tests/helpers/sqlite-wasm-adapter.js';
import { createAnalyticsDataSource } from '../../src/analytics.js';
import type { IngestionReceipt } from '../../src/ingestion.js';
import { createSha256ContentHasher, DefaultIngestionOrchestrator } from '../../src/ingestion.js';
import { applySessionRollupContributions } from '../../src/rollup-reconciliation.js';
import { FailureInjectionExecutor, type InjectionStage } from './harness.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, '../../../parsers/claude-session-parser/tests/fixtures');

function readFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf8');
}

/**
 * Create a corrected artifact for reprocessing: it carries the same root
 * session id as the original but a different source fingerprint, so a new
 * generation is produced and the stale partial state is not silently hidden.
 */
function addRecoveryMarker(content: string, sessionId: string): string {
  const marker = JSON.stringify({
    type: '_recovery_marker',
    sessionId,
    marker: 1,
  });
  return `${content.trimEnd()}\n${marker}\n`;
}

async function createExecutor(): Promise<WasmSqliteExecutor> {
  const executor = await WasmSqliteExecutor.create();
  await executor.exec(FRESH_SCHEMA_SQL);
  return executor;
}

async function setupIngestion(harness: FailureInjectionExecutor) {
  const hasher = createSha256ContentHasher();
  const orchestrator = new DefaultIngestionOrchestrator({
    executor: harness,
    hasher,
    registry: createDefaultRegistry(),
    resolver: { resolve: async (ref) => ({ ...ref, content: new Uint8Array(0) }) },
    analysisReleaseId: 'ar-default',
  });
  return { orchestrator, hasher };
}

async function ingestContent(
  orchestrator: DefaultIngestionOrchestrator,
  hasher: ReturnType<typeof createSha256ContentHasher>,
  content: string,
  projectId: string,
  sessionId: string,
): Promise<IngestionReceipt> {
  const sha256 = await hasher.hash(content);
  return orchestrator.ingestManual({
    artifacts: [
      {
        relativePath: 'session/transcript.jsonl',
        mediaType: 'application/jsonl',
        sha256,
        size: content.length,
        content,
        status: 'uploaded',
      },
    ],
    source: { sourceId: 'default' },
    harness: 'claude-code',
    projectId,
    sessionId,
  });
}

async function countRows(queryable: WasmSqliteExecutor | FailureInjectionExecutor, table: string) {
  const { rows } = await queryable.exec(`SELECT COUNT(*) AS c FROM ${table}`, []);
  return Number(rows[0]?.c ?? 0);
}

async function getSessionRow(
  queryable: WasmSqliteExecutor | FailureInjectionExecutor,
  sessionId: string,
) {
  const { rows } = await queryable.exec(
    'SELECT id, current_generation_id FROM sessions WHERE id = ?',
    [sessionId],
  );
  return rows[0] as { id: string; current_generation_id: string | null } | undefined;
}

async function getGenerationStatus(
  queryable: WasmSqliteExecutor | FailureInjectionExecutor,
  generationId: string,
) {
  const { rows } = await queryable.exec(
    'SELECT status FROM transformation_generations WHERE id = ?',
    [generationId],
  );
  return rows[0]?.status as string | undefined;
}

async function setupWithStage(stage: InjectionStage | undefined) {
  const inner = await createExecutor();
  const harness = new FailureInjectionExecutor(inner);
  harness.setInjection(stage);
  const { orchestrator, hasher } = await setupIngestion(harness);
  return { inner, harness, orchestrator, hasher };
}

describe('PIPE-004: commit failure boundary', () => {
  it('pre-commit: injected failure leaves an empty store; retry restores a complete, consistent state', async () => {
    const { harness, orchestrator, hasher } = await setupWithStage('pre-commit');
    const content = readFixture('t2-happy-path.jsonl');

    const failed = await ingestContent(
      orchestrator,
      hasher,
      content,
      'project-pipe004-pre',
      'sess-happy-1',
    );
    expect(failed.status).toBe('failed');
    expect(harness.getThrownStage()).toBe('pre-commit');
    expect(harness.getThrownCallIndex()).toBe(1);

    // Failure is detectable: nothing was written.
    const sessionCount = await countRows(harness, 'sessions');
    expect(sessionCount).toBe(0);

    const dataSource = createAnalyticsDataSource(harness);
    const staleOverview = await dataSource.portfolio.getOverview({});
    expect(staleOverview.sessionCount).toBe(0);
    expect(staleOverview.totalTokens).toBe(0);
    const staleTrends = await dataSource.portfolio.getTrends({});
    expect(staleTrends.series.length).toBe(0);

    // Recovery: retry the same artifact now that the injection point is cleared.
    harness.setInjection(undefined);
    const recovered = await ingestContent(
      orchestrator,
      hasher,
      content,
      'project-pipe004-pre',
      'sess-happy-1',
    );
    expect(recovered.status).toBe('committed');
    expect(harness.getThrownStage()).toBeUndefined();

    // Consistent state: session is visible with rollups and tokens.
    const session = await getSessionRow(harness, recovered.sessionId);
    expect(session?.current_generation_id).toBe(recovered.generationId);

    const generationStatus = await getGenerationStatus(harness, recovered.generationId);
    expect(generationStatus).toBe('committed');

    const metricValues = await MetricValueStore.listBySession(harness, recovered.sessionId);
    expect(metricValues.length).toBeGreaterThan(0);

    const contributionCount = await countRows(harness, 'rollup_contributions');
    expect(contributionCount).toBeGreaterThan(0);

    const dailyRollupCount = await countRows(harness, 'portfolio_daily_rollups');
    expect(dailyRollupCount).toBeGreaterThan(0);

    const overview = await dataSource.portfolio.getOverview({});
    expect(overview.sessionCount).toBeGreaterThan(0);
    expect(overview.totalTokens).toBeGreaterThan(0);
    expect(overview.headlineMetrics.length).toBeGreaterThan(0);

    const trends = await dataSource.portfolio.getTrends({});
    expect(trends.series.length).toBeGreaterThan(0);
  });

  it('mid-commit: injected failure leaves a pending session; reprocess with a corrected artifact restores a complete, consistent state', async () => {
    const { harness, orchestrator, hasher } = await setupWithStage('mid-commit');
    const content = readFixture('t2-happy-path.jsonl');

    const failed = await ingestContent(
      orchestrator,
      hasher,
      content,
      'project-pipe004-mid',
      'sess-happy-1',
    );
    expect(failed.status).toBe('failed');
    expect(harness.getThrownStage()).toBe('mid-commit');
    expect(harness.getThrownCallIndex()).toBeGreaterThan(0);

    // Failure is detectable: the session row exists but has no current
    // generation, and the failed generation is pending.
    const staleSession = await getSessionRow(harness, failed.sessionId);
    expect(staleSession).toBeTruthy();
    expect(staleSession?.current_generation_id).toBeNull();

    const staleGenerationStatus = await getGenerationStatus(harness, failed.generationId);
    expect(staleGenerationStatus).toBe('pending');

    const staleMetricValues = await MetricValueStore.listBySession(harness, failed.sessionId);
    expect(staleMetricValues.length).toBe(0);

    const staleContributionCount = await countRows(harness, 'rollup_contributions');
    expect(staleContributionCount).toBe(0);

    const dataSource = createAnalyticsDataSource(harness);
    const staleOverview = await dataSource.portfolio.getOverview({});
    expect(staleOverview.sessionCount).toBeGreaterThan(0);
    expect(staleOverview.totalTokens).toBe(0);
    const staleTrends = await dataSource.portfolio.getTrends({});
    expect(staleTrends.series.length).toBe(0);

    // Recovery: reprocess with a corrected artifact (same session id, different
    // fingerprint) so a new generation can be committed and made visible.
    harness.setInjection(undefined);
    const corrected = addRecoveryMarker(content, 'sess-happy-1');
    const recovered = await ingestContent(
      orchestrator,
      hasher,
      corrected,
      'project-pipe004-mid',
      'sess-happy-1',
    );
    expect(recovered.status).toBe('committed');
    expect(recovered.generationId).not.toBe(failed.generationId);

    // The stale pending generation is still detectable but is no longer current.
    const session = await getSessionRow(harness, recovered.sessionId);
    expect(session?.current_generation_id).toBe(recovered.generationId);
    expect(session?.current_generation_id).not.toBe(failed.generationId);

    const recoveredGenerationStatus = await getGenerationStatus(harness, recovered.generationId);
    expect(recoveredGenerationStatus).toBe('committed');

    const metricValues = await MetricValueStore.listBySession(harness, recovered.sessionId);
    expect(metricValues.length).toBeGreaterThan(0);

    const contributionCount = await countRows(harness, 'rollup_contributions');
    expect(contributionCount).toBeGreaterThan(0);

    const dailyRollupCount = await countRows(harness, 'portfolio_daily_rollups');
    expect(dailyRollupCount).toBeGreaterThan(0);

    const overview = await dataSource.portfolio.getOverview({});
    expect(overview.sessionCount).toBeGreaterThan(0);
    expect(overview.totalTokens).toBeGreaterThan(0);
    expect(overview.headlineMetrics.length).toBeGreaterThan(0);

    const trends = await dataSource.portfolio.getTrends({});
    expect(trends.series.length).toBeGreaterThan(0);
  });

  it('post-ingest: injected failure leaves a committed session without rollups; reprocess rollups to restore a complete, consistent state', async () => {
    const { inner, harness, orchestrator, hasher } = await setupWithStage('post-ingest');
    const content = readFixture('t2-happy-path.jsonl');

    const failed = await ingestContent(
      orchestrator,
      hasher,
      content,
      'project-pipe004-post',
      'sess-happy-1',
    );
    expect(failed.status).toBe('failed');
    expect(harness.getThrownStage()).toBe('post-ingest');
    expect(harness.getThrownCallIndex()).toBeGreaterThan(0);

    // Failure is detectable: the generation is committed and the session is
    // current, but no rollups were materialized.
    const staleSession = await getSessionRow(harness, failed.sessionId);
    expect(staleSession?.current_generation_id).toBe(failed.generationId);

    const staleGenerationStatus = await getGenerationStatus(harness, failed.generationId);
    expect(staleGenerationStatus).toBe('committed');

    const metricValues = await MetricValueStore.listBySession(harness, failed.sessionId);
    expect(metricValues.length).toBeGreaterThan(0);

    const staleContributionCount = await countRows(harness, 'rollup_contributions');
    expect(staleContributionCount).toBe(0);

    const dataSource = createAnalyticsDataSource(harness);
    const staleOverview = await dataSource.portfolio.getOverview({});
    expect(staleOverview.sessionCount).toBeGreaterThan(0);
    expect(staleOverview.totalTokens).toBe(0);
    expect(staleOverview.token.generationId).not.toBe(failed.generationId);
    const staleTrends = await dataSource.portfolio.getTrends({});
    expect(staleTrends.series.length).toBe(0);

    // Recovery: reprocess rollups for the already-committed generation. This
    // is a defined reprocess action: it materializes the missing contribution
    // and rollup rows without re-transforming the artifact.
    await inner.transaction(async (tx) => {
      await applySessionRollupContributions(tx, {
        sessionId: failed.sessionId,
        generationId: failed.generationId,
        analysisReleaseId: 'ar-default',
        isRoot: true,
      });
    });

    // Consistent state: the same committed generation now has rollups.
    const session = await getSessionRow(inner, failed.sessionId);
    expect(session?.current_generation_id).toBe(failed.generationId);

    const recoveredContributionCount = await countRows(inner, 'rollup_contributions');
    expect(recoveredContributionCount).toBeGreaterThan(0);

    const dailyRollupCount = await countRows(inner, 'portfolio_daily_rollups');
    expect(dailyRollupCount).toBeGreaterThan(0);

    const overview = await dataSource.portfolio.getOverview({});
    expect(overview.sessionCount).toBeGreaterThan(0);
    expect(overview.totalTokens).toBeGreaterThan(0);
    expect(overview.headlineMetrics.length).toBeGreaterThan(0);

    const trends = await dataSource.portfolio.getTrends({});
    expect(trends.series.length).toBeGreaterThan(0);
  });
});
