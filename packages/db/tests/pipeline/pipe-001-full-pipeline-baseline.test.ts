import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRESH_SCHEMA_SQL, getCurrentGenerationId } from '@lucasschirm/sal-db-core';
import { createDefaultRegistry } from '@lucasschirm/sal-transformer';
import { describe, expect, it } from 'vitest';
import { WasmSqliteExecutor } from '../../../db-core/tests/helpers/sqlite-wasm-adapter.js';
import type { AnalyticsDataSource } from '../../src/analytics.js';
import { createAnalyticsDataSource } from '../../src/analytics.js';
import type { IngestionReceipt } from '../../src/ingestion.js';
import { createSha256ContentHasher, DefaultIngestionOrchestrator } from '../../src/ingestion.js';
import type { ContentHasher } from '../../src/ports.js';
import { FailureInjectionExecutor } from './harness.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, '../../../parsers/claude-session-parser/tests/fixtures');

function readFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf8');
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
    analysisReleaseId: 'ar-pipe001',
  });
  const hasher = createSha256ContentHasher();
  return { harness, orchestrator, hasher };
}

function transcriptArtifact(content: string, sha256: string) {
  return {
    relativePath: 'session/transcript.jsonl',
    mediaType: 'application/jsonl',
    sha256,
    size: content.length,
    content,
    status: 'uploaded' as const,
  };
}

async function ingestFixture(
  orchestrator: DefaultIngestionOrchestrator,
  hasher: ContentHasher,
  fixtureName: string,
  projectId: string,
  sessionId: string,
): Promise<IngestionReceipt> {
  const content = readFixture(fixtureName);
  const sha256 = await hasher.hash(content);
  return orchestrator.ingestManual({
    artifacts: [transcriptArtifact(content, sha256)],
    source: { sourceId: 'default' },
    harness: 'claude-code',
    projectId,
    sessionId,
  });
}

async function assertPortfolioResults(dataSource: AnalyticsDataSource, generationId: string) {
  const overview = await dataSource.portfolio.getOverview({});
  expect(overview.sessionCount).toBeGreaterThan(0);
  expect(overview.headlineMetrics.length).toBeGreaterThan(0);
  expect(overview.totalTokens).toBeGreaterThan(0);

  const trends = await dataSource.portfolio.getTrends({});
  expect(trends.series.length).toBeGreaterThan(0);
  expect(trends.token.generationId).toBe(generationId);
}

async function assertProjectResults(
  harness: FailureInjectionExecutor,
  dataSource: AnalyticsDataSource,
  sessionId: string,
  generationId: string,
) {
  const { rows } = await harness.exec('SELECT project_id FROM sessions WHERE id = ?', [sessionId]);
  const projectId = String(rows[0]?.project_id ?? '');
  const trends = await dataSource.project.getSessionTrendSeries(projectId, {});
  expect(trends.series.length).toBeGreaterThan(0);
  expect(trends.token.generationId).toBe(generationId);
}

async function assertSessionFresh(
  dataSource: AnalyticsDataSource,
  sessionId: string,
  generationId: string,
) {
  const summary = await dataSource.session.getSummary(sessionId);
  expect(summary.headlineMetrics.length).toBeGreaterThan(0);
  expect(summary.token.generationId).toBe(generationId);
}

describe('PIPE-001: full-pipeline baseline with freshness token', () => {
  it('returns non-empty DTOs and a fresh token immediately after a full run', async () => {
    const { harness, orchestrator, hasher } = await setupPipeline();
    const projectId = 'project-pipe001';
    const sessionId = 'sess-pipe001';
    const receipt = await ingestFixture(
      orchestrator,
      hasher,
      't2-happy-path.jsonl',
      projectId,
      sessionId,
    );
    expect(receipt.status).toBe('committed');
    const currentGenerationId = await getCurrentGenerationId(harness, receipt.sessionId);
    expect(currentGenerationId).toBe(receipt.generationId);
    const dataSource = createAnalyticsDataSource(harness);
    await assertPortfolioResults(dataSource, currentGenerationId);
    await assertProjectResults(harness, dataSource, receipt.sessionId, currentGenerationId);
    await assertSessionFresh(dataSource, receipt.sessionId, currentGenerationId);
  });
});
