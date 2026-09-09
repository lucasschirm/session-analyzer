import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRESH_SCHEMA_SQL } from '@lucasschirm/sal-db-core';
import { MANIFEST_SCHEMA_VERSION, type SyncManifest } from '@lucasschirm/sal-sync-core';
import { createDefaultRegistry } from '@lucasschirm/sal-transformer-registry';
import { describe, expect, it } from 'vitest';
import { WasmSqliteExecutor } from '../../../db-core/tests/helpers/sqlite-wasm-adapter.js';
import type { AnalyticsDataSource } from '../../src/analytics.js';
import { createAnalyticsDataSource } from '../../src/analytics.js';
import type { IngestionReceipt } from '../../src/ingestion.js';
import { createSha256ContentHasher, DefaultIngestionOrchestrator } from '../../src/ingestion.js';
import type { VerifiedManifestBundle } from '../../src/manifest.js';
import type { ResolvedArtifact } from '../../src/ports.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, '../../../parsers/claude-session-parser/tests/fixtures');
const RELATIVE_PATH = 'session/transcript.jsonl';
const ANALYSIS_RELEASE = 'ar-pipe006';
const PROJECT = 'project-pipe006';
const SESSION = 'sess-pipe006';

interface AggregateSnapshot {
  readonly portfolioTokenGenerationId: string;
  readonly sessionCount: number;
  readonly totalTokens: number;
  readonly portfolioTrendsLength: number;
  readonly projectTrendsLength: number;
  readonly projectTrendsSum: number;
  readonly rollupContributions: number;
  readonly projectDailyRollups: number;
  readonly portfolioDailyRollups: number;
  readonly metricValues: number;
}

function readFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf8');
}

function makeResolver() {
  return { resolve: async (ref: { sha256: string }) => ({ ...ref, content: new Uint8Array(0) }) };
}

function makeOrchestrator(executor: WasmSqliteExecutor) {
  return new DefaultIngestionOrchestrator({
    executor,
    hasher: createSha256ContentHasher(),
    registry: createDefaultRegistry(),
    resolver: makeResolver(),
    analysisReleaseId: ANALYSIS_RELEASE,
  });
}

function makeResolvedArtifact(content: string, sha256: string): ResolvedArtifact {
  return {
    relativePath: RELATIVE_PATH,
    mediaType: 'application/jsonl',
    sha256,
    size: content.length,
    content,
  };
}

function makeManifest(content: string, sha256: string): SyncManifest {
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    projectId: PROJECT,
    sessionId: SESSION,
    environmentId: 'default',
    harness: 'claude-code',
    harnessVersion: '0.1.0',
    syncVersion: '0.1.0',
    pluginVersion: '0.1.0',
    transcriptsCaptured: true,
    mainTranscriptRelativePath: RELATIVE_PATH,
    artifacts: [
      {
        projectId: PROJECT,
        sessionId: SESSION,
        scope: 'session',
        relativePath: RELATIVE_PATH,
        mediaType: 'application/jsonl',
        sha256,
        size: content.length,
        status: 'uploaded',
      },
    ],
    syncRuns: [],
  };
}

function makeBundle(content: string, sha256: string): VerifiedManifestBundle {
  return {
    manifest: makeManifest(content, sha256),
    source: { sourceId: 'default', environmentId: 'dev', projectId: PROJECT, sessionId: SESSION },
    resolvedArtifacts: [makeResolvedArtifact(content, sha256)],
    integrityVerified: false,
  };
}

async function findProjectId(executor: WasmSqliteExecutor, sessionId: string): Promise<string> {
  const { rows } = await executor.exec('SELECT project_id FROM sessions WHERE id = ?', [sessionId]);
  return String(rows[0]?.project_id ?? '');
}

async function countTableRows(executor: WasmSqliteExecutor, table: string): Promise<number> {
  const { rows } = await executor.exec(`SELECT COUNT(*) AS c FROM ${table}`);
  return Number(rows[0]?.c ?? 0);
}

async function ingestFixture(
  orchestrator: DefaultIngestionOrchestrator,
  bundle: VerifiedManifestBundle,
): Promise<IngestionReceipt> {
  return orchestrator.ingestManifest(bundle);
}

function sumSeriesValues(values: readonly { value: number | null }[]): number {
  return values.reduce((sum, point) => sum + (point.value ?? 0), 0);
}

async function getAggregateSnapshot(
  executor: WasmSqliteExecutor,
  dataSource: AnalyticsDataSource,
  projectId: string,
): Promise<AggregateSnapshot> {
  const overview = await dataSource.portfolio.getOverview({});
  const portfolioTrends = await dataSource.portfolio.getTrends({});
  const projectTrends = await dataSource.project.getSessionTrendSeries(projectId, {});

  return {
    portfolioTokenGenerationId: overview.token.generationId,
    sessionCount: overview.sessionCount,
    totalTokens: overview.totalTokens,
    portfolioTrendsLength: portfolioTrends.series.length,
    projectTrendsLength: projectTrends.series.length,
    projectTrendsSum: sumSeriesValues(projectTrends.series),
    rollupContributions: await countTableRows(executor, 'rollup_contributions'),
    projectDailyRollups: await countTableRows(executor, 'project_daily_rollups'),
    portfolioDailyRollups: await countTableRows(executor, 'portfolio_daily_rollups'),
    metricValues: await countTableRows(executor, 'metric_values'),
  };
}

function assertCountsUnchanged(before: AggregateSnapshot, after: AggregateSnapshot) {
  expect(after).toEqual(before);
}

describe('PIPE-006: re-sync same session — no duplicate contributions', () => {
  it('re-ingesting the identical manifest leaves all aggregate counts unchanged', async () => {
    const executor = await WasmSqliteExecutor.create();
    await executor.exec(FRESH_SCHEMA_SQL);
    const orchestrator = makeOrchestrator(executor);

    const content = readFixture('t2-happy-path.jsonl');
    const sha256 = await createSha256ContentHasher().hash(content);
    const bundle = makeBundle(content, sha256);

    const first = await ingestFixture(orchestrator, bundle);
    expect(first.status).toBe('committed');

    const canonicalProjectId = await findProjectId(executor, first.sessionId);
    const dataSource = createAnalyticsDataSource(executor);
    const before = await getAggregateSnapshot(executor, dataSource, canonicalProjectId);

    const second = await ingestFixture(orchestrator, bundle);
    expect(second.status).toBe('committed');
    expect(second.generationId).toBe(first.generationId);

    const after = await getAggregateSnapshot(executor, dataSource, canonicalProjectId);
    assertCountsUnchanged(before, after);
  });
});
