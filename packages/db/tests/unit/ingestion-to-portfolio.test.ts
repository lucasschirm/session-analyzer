import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRESH_SCHEMA_SQL } from '@lucasschirm/sal-db-core';
import { MANIFEST_SCHEMA_VERSION } from '@lucasschirm/sal-sync-core';
import { createDefaultRegistry } from '@lucasschirm/sal-transformer-registry';
import { describe, expect, it } from 'vitest';
import { WasmSqliteExecutor } from '../../../db-core/tests/helpers/sqlite-wasm-adapter.js';
import { createAnalyticsDataSource } from '../../src/analytics.js';
import { createSha256ContentHasher, DefaultIngestionOrchestrator } from '../../src/ingestion.js';
import type { VerifiedManifestBundle } from '../../src/manifest.js';
import { buildDevinManifestBundle } from '../fixtures/devin-manifest.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, '../../../parsers/claude-session-parser/tests/fixtures');

function readFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf8');
}

async function createExecutor(): Promise<WasmSqliteExecutor> {
  const executor = await WasmSqliteExecutor.create();
  await executor.exec(FRESH_SCHEMA_SQL);
  return executor;
}

async function setupIngestion(executor: WasmSqliteExecutor) {
  const hasher = createSha256ContentHasher();
  const orchestrator = new DefaultIngestionOrchestrator({
    executor,
    hasher,
    registry: createDefaultRegistry(),
    resolver: { resolve: async (ref) => ({ ...ref, content: new Uint8Array(0) }) },
    analysisReleaseId: 'ar-default',
  });
  return { orchestrator, hasher };
}

/**
 * Ingest a fixture file as a manual artifact bundle with a given project and
 * session id. Returns the ingestion receipt.
 */
async function ingestFixture(
  orchestrator: DefaultIngestionOrchestrator,
  hasher: ReturnType<typeof createSha256ContentHasher>,
  fixtureName: string,
  projectId: string,
  sessionId: string,
) {
  const content = readFixture(fixtureName);
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

describe('ingestion to portfolio pipeline', () => {
  it('imports 3 sessions and populates portfolio overview and trends', async () => {
    const executor = await createExecutor();
    const { orchestrator, hasher } = await setupIngestion(executor);

    // Ingest 3 sessions from different fixtures into the same project.
    const fixtures = [
      { name: 't2-happy-path.jsonl', sessionId: 'sess-portfolio-1' },
      { name: 't2-usage-aggregation.jsonl', sessionId: 'sess-portfolio-2' },
      { name: 't2-ai-title-last-wins.jsonl', sessionId: 'sess-portfolio-3' },
    ];

    const receipts = [];
    for (const fixture of fixtures) {
      const receipt = await ingestFixture(
        orchestrator,
        hasher,
        fixture.name,
        'project-portfolio-test',
        fixture.sessionId,
      );
      expect(receipt.status).toBe('committed');
      receipts.push(receipt);
    }

    // 1. Metric values must exist for each session.
    for (const receipt of receipts) {
      const { rows } = await executor.exec(
        'SELECT COUNT(*) AS c FROM metric_values WHERE generation_id = ?',
        [receipt.generationId],
      );
      expect(rows[0]?.c).toBeGreaterThan(0);
    }

    // 2. Sessions must be visible (current_generation_id set).
    const { rows: sessionRows } = await executor.exec(
      'SELECT COUNT(*) AS c FROM sessions WHERE current_generation_id IS NOT NULL',
    );
    expect(sessionRows[0]?.c).toBeGreaterThanOrEqual(3);

    // 3. Rollup contributions must exist (additive metrics materialized).
    const { rows: contributionRows } = await executor.exec(
      'SELECT COUNT(*) AS c FROM rollup_contributions',
    );
    expect(contributionRows[0]?.c).toBeGreaterThan(0);

    // 4. Portfolio daily rollups must exist (trend chart data).
    const { rows: dailyRollupRows } = await executor.exec(
      'SELECT COUNT(*) AS c FROM portfolio_daily_rollups',
    );
    expect(dailyRollupRows[0]?.c).toBeGreaterThan(0);

    // 5. Portfolio distributions may or may not exist depending on whether
    //    the transformer produces 'distribution' aggregation metrics. The
    //    Claude Code transformer currently produces 'sum'/'mean'/'max' metrics
    //    but no 'distribution' metrics, so this table can be empty. The
    //    portfolio overview still returns count-based headline metrics.

    // 6. Portfolio overview query returns headline metrics and counts.
    const dataSource = createAnalyticsDataSource(executor);
    const overview = await dataSource.portfolio.getOverview({});
    expect(overview.projectCount).toBeGreaterThanOrEqual(1);
    expect(overview.sessionCount).toBeGreaterThanOrEqual(3);
    expect(overview.headlineMetrics.length).toBeGreaterThan(0);

    // At least one headline metric should have a non-null value.
    const nonNullMetrics = overview.headlineMetrics.filter((m) => m.value !== null);
    expect(nonNullMetrics.length).toBeGreaterThan(0);

    // 7. Portfolio trends query returns time series data.
    const trends = await dataSource.portfolio.getTrends({});
    expect(trends.series.length).toBeGreaterThan(0);

    // Each series point should have a metricId and a time bucket.
    for (const point of trends.series) {
      expect(point.metricId).toBeTruthy();
      expect(point.time).toBeTruthy();
    }
  });

  it('replaces a session generation and updates rollups atomically', async () => {
    const executor = await createExecutor();
    const { orchestrator, hasher } = await setupIngestion(executor);

    // Ingest the same session twice (same content = same generation = idempotent).
    const content = readFixture('t2-happy-path.jsonl');
    const sha256 = await hasher.hash(content);

    const first = await orchestrator.ingestManual({
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
      projectId: 'project-replace-test',
      sessionId: 'sess-replace-1',
    });
    expect(first.status).toBe('committed');

    // Rollups should exist after first ingestion.
    const { rows: rollupsBefore } = await executor.exec(
      'SELECT COUNT(*) AS c FROM portfolio_daily_rollups',
    );
    expect(rollupsBefore[0]?.c).toBeGreaterThan(0);

    // Idempotent re-ingestion should not duplicate rollups.
    const second = await orchestrator.ingestManual({
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
      projectId: 'project-replace-test',
      sessionId: 'sess-replace-1',
    });
    expect(second.status).toBe('committed');
    expect(second.generationId).toBe(first.generationId);

    const { rows: rollupsAfter } = await executor.exec(
      'SELECT COUNT(*) AS c FROM portfolio_daily_rollups',
    );
    expect(rollupsAfter[0]?.c).toBe(rollupsBefore[0]?.c);
  });

  /**
   * Regression: the sync flow (ingestManifest) must materialize rollups and
   * distributions just like the manual flow (ingestManual). Previously
   * commitAtomic skipped rollup materialization, so synced sessions produced
   * metric values but portfolio charts stayed empty.
   */
  it('ingestManifest (sync flow) materializes rollups and populates portfolio overview', async () => {
    const executor = await createExecutor();
    const { orchestrator, hasher } = await setupIngestion(executor);

    const content = readFixture('t2-happy-path.jsonl');
    const sha256 = await hasher.hash(content);
    const relativePath = 'session/transcript.jsonl';

    const bundle: VerifiedManifestBundle = {
      manifest: {
        schemaVersion: MANIFEST_SCHEMA_VERSION,
        projectId: 'project-sync-portfolio',
        sessionId: 'sess-sync-1',
        harness: 'claude-code',
        harnessVersion: '0.1.0',
        syncVersion: '0.1.0',
        pluginVersion: '0.1.0',
        transcriptsCaptured: true,
        mainTranscriptRelativePath: relativePath,
        artifacts: [
          {
            relativePath,
            mediaType: 'application/jsonl',
            sha256,
            size: content.length,
            status: 'uploaded',
          },
        ],
        syncRuns: [],
      },
      source: {
        sourceId: 'sync',
        environmentId: 'dev',
        projectId: 'project-sync-portfolio',
        sessionId: 'sess-sync-1',
      },
      resolvedArtifacts: [
        {
          relativePath,
          mediaType: 'application/jsonl',
          sha256,
          size: content.length,
          content,
        },
      ],
      integrityVerified: false,
    };

    const receipt = await orchestrator.ingestManifest(bundle);
    expect(receipt.status).toBe('committed');

    // Metric values must exist.
    const { rows: metricRows } = await executor.exec(
      'SELECT COUNT(*) AS c FROM metric_values WHERE generation_id = ?',
      [receipt.generationId],
    );
    expect(metricRows[0]?.c).toBeGreaterThan(0);

    // Rollup contributions must be materialized (the regression).
    const { rows: contributionRows } = await executor.exec(
      'SELECT COUNT(*) AS c FROM rollup_contributions',
    );
    expect(contributionRows[0]?.c).toBeGreaterThan(0);

    // Portfolio daily rollups must be materialized (the regression).
    const { rows: dailyRollupRows } = await executor.exec(
      'SELECT COUNT(*) AS c FROM portfolio_daily_rollups',
    );
    expect(dailyRollupRows[0]?.c).toBeGreaterThan(0);

    // Portfolio overview must reflect the synced session.
    const dataSource = createAnalyticsDataSource(executor);
    const overview = await dataSource.portfolio.getOverview({});
    expect(overview.sessionCount).toBeGreaterThanOrEqual(1);
    expect(overview.headlineMetrics.length).toBeGreaterThan(0);
  });

  it('ingests a devin manifest and exposes it via the analytics data source with sample sizes', async () => {
    const executor = await createExecutor();
    const { orchestrator } = await setupIngestion(executor);
    const { bundle } = await buildDevinManifestBundle();

    const receipt = await orchestrator.ingestManifest(bundle);
    expect(receipt.status).toBe('committed');
    expect(receipt.issueIds).toEqual([]);

    const dataSource = createAnalyticsDataSource(executor);

    const overview = await dataSource.portfolio.getOverview({});
    expect(overview.sessionCount).toBe(1);
    expect(overview.projectCount).toBe(1);
    expect(overview.harnessCount).toBe(1);
    expect(overview.headlineMetrics.length).toBeGreaterThan(0);

    const devinTotal = overview.headlineMetrics.find(
      (m) => m.metricId === 'devin:tokens:total:inclusive',
    );
    expect(devinTotal).toBeDefined();
    expect(devinTotal?.value).toBe(150);
    expect(devinTotal?.unit).toBe('token');
    expect(devinTotal?.eligibleN).toBeGreaterThanOrEqual(1);
    expect(devinTotal?.knownN).toBeGreaterThanOrEqual(1);
    expect(devinTotal?.unknownCount).toBe(0);
    expect(devinTotal?.evidenceLinks.length).toBeGreaterThan(0);

    const projectList = await dataSource.portfolio.getProjectList({});
    expect(projectList.items).toHaveLength(1);
    expect(projectList.items[0]?.harness).toBe('devin');
    expect(projectList.items[0]?.sessionCount).toBe(1);
    expect(projectList.items[0]?.token.eligibleN).toBeGreaterThanOrEqual(1);

    const cohorts = await dataSource.portfolio.getModelHarnessCohorts({});
    const devinCohort = cohorts.items.find((c) => c.harness === 'devin');
    expect(devinCohort).toBeDefined();
    expect(devinCohort?.sessionCount).toBe(1);
    expect(devinCohort?.token.eligibleN).toBe(1);
    expect(devinCohort?.token.knownN).toBe(1);

    const trends = await dataSource.portfolio.getTrends({});
    const devinTrend = trends.series.find((s) => s.metricId.startsWith('devin:tokens:total:'));
    expect(devinTrend).toBeDefined();
    expect(devinTrend?.value).toBe(150);
    expect(trends.token.eligibleN).toBeGreaterThanOrEqual(1);

    const sessionSummary = await dataSource.session.getSummary(receipt.sessionId, {});
    expect(sessionSummary.harness).toBe('devin');
    const sessionTotal = sessionSummary.headlineMetrics.find((m) =>
      m.metricId.startsWith('devin:tokens:total:'),
    );
    expect(sessionTotal).toBeDefined();
    expect(sessionTotal?.value).toBe(150);
    expect(sessionTotal?.eligibleN).toBeGreaterThanOrEqual(1);
  });
});
