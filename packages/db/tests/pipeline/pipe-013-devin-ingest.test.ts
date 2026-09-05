import { FRESH_SCHEMA_SQL } from '@lucasschirm/sal-db-core';
import { createDefaultRegistry } from '@lucasschirm/sal-transformer-registry';
import { describe, expect, it } from 'vitest';
import { WasmSqliteExecutor } from '../../../db-core/tests/helpers/sqlite-wasm-adapter.js';
import { createAnalyticsDataSource } from '../../src/analytics.js';
import { createSha256ContentHasher, DefaultIngestionOrchestrator } from '../../src/ingestion.js';
import { buildDevinManifestBundle } from '../fixtures/devin-manifest.js';
import { FailureInjectionExecutor, InjectionError } from './harness.js';

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
    analysisReleaseId: 'ar-pipe013',
  });
  return { harness, orchestrator };
}

describe('PIPE-013: devin manifest end-to-end ingestion', () => {
  it('ingests a golden devin manifest and exposes devin metrics with sample sizes', async () => {
    const { harness, orchestrator } = await setupPipeline();
    const { bundle } = await buildDevinManifestBundle();

    const receipt = await orchestrator.ingestManifest(bundle);
    expect(receipt.status).toBe('committed');
    expect(receipt.issueIds).toEqual([]);

    const dataSource = createAnalyticsDataSource(harness);

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
    expect(devinCohort?.token.unknownCount).toBe(0);

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

  it('fails a malformed devin bundle with an explicit ingestion issue', async () => {
    const { orchestrator } = await setupPipeline();
    const { bundle } = await buildDevinManifestBundle({ corruptRootTranscript: true });

    const receipt = await orchestrator.ingestManifest(bundle);

    expect(receipt.status).toBe('failed');
    expect(receipt.issueIds.length).toBeGreaterThan(0);
    expect(receipt.issueIds).toContain('missing_root_transcript');
  });

  it('distinguishes a zero-devin-sessions query from a query failure', async () => {
    const emptyExecutor = await WasmSqliteExecutor.create();
    await emptyExecutor.exec(FRESH_SCHEMA_SQL);
    const emptyDataSource = createAnalyticsDataSource(emptyExecutor);

    const emptyOverview = await emptyDataSource.portfolio.getOverview({});
    expect(emptyOverview.sessionCount).toBe(0);
    expect(emptyOverview.headlineMetrics).toEqual([]);
    expect(emptyOverview.token.eligibleN).toBe(0);
    expect(emptyOverview.token.knownN).toBe(0);
    expect(emptyOverview.token.unknownCount).toBe(0);

    const { harness, orchestrator } = await setupPipeline();
    const { bundle } = await buildDevinManifestBundle();
    const receipt = await orchestrator.ingestManifest(bundle);
    expect(receipt.status).toBe('committed');

    harness.setInjection('query');
    const dataSource = createAnalyticsDataSource(harness);
    await expect(dataSource.portfolio.getOverview({})).rejects.toThrow(InjectionError);
  });
});
