import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  beginGeneration,
  commitGeneration,
  FRESH_SCHEMA_SQL,
  getCurrentGenerationId,
} from '@lucasschirm/sal-db-core';
import { createDefaultRegistry } from '@lucasschirm/sal-transformer-registry';
import { describe, expect, it } from 'vitest';
import { WasmSqliteExecutor } from '../../../db-core/tests/helpers/sqlite-wasm-adapter.js';
import { createAnalyticsDataSource } from '../../src/analytics.js';
import { createSha256ContentHasher, DefaultIngestionOrchestrator } from '../../src/ingestion.js';

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

describe('PIPE-002: generation/freshness token detects stale rollups', () => {
  it('distinguishes stale rollup with real data from no data via the DTO generation token', async () => {
    const executor = await createExecutor();
    const hasher = createSha256ContentHasher();
    const orchestrator = new DefaultIngestionOrchestrator({
      executor,
      hasher,
      registry: createDefaultRegistry(),
      resolver: { resolve: async (ref) => ({ ...ref, content: new Uint8Array(0) }) },
      analysisReleaseId: 'ar-default',
    });

    const projectId = 'project-pipe002';
    const requestedSessionId = 'sess-pipe002';
    const content = readFixture('t2-happy-path.jsonl');
    const sha256 = await hasher.hash(content);

    const receipt = await orchestrator.ingestManual({
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
      sessionId: requestedSessionId,
    });

    expect(receipt.status).toBe('committed');
    const sessionId = receipt.sessionId;
    const staleGenerationId = receipt.generationId;

    // Force the rollup to become stale by committing a newer, empty generation
    // for the same session. The existing rollups and distributions still carry
    // the first generation, but the session's current generation has moved on.
    const freshGenerationId = 'gen-stale-pipe002';
    await executor.transaction(async (tx) => {
      await beginGeneration(tx, freshGenerationId, {
        sessionId,
        analysisReleaseId: receipt.analysisReleaseId,
        parserVersion: '0.1.0',
        transformerVersion: '0.1.0',
        ontologyVersion: '0.1.0',
        metricVersion: '0.1.0',
        schemaVersion: '0.1.0',
      });
      await commitGeneration(tx, sessionId, freshGenerationId);
    });

    const currentGenerationId = await getCurrentGenerationId(executor, sessionId);
    expect(currentGenerationId).toBe(freshGenerationId);

    const dataSource = createAnalyticsDataSource(executor);

    // Portfolio trends are built directly from portfolio_daily_rollups, so the
    // series token's generationId is the rollup's generation/freshness token.
    const trends = await dataSource.portfolio.getTrends({});

    // Real rollup data still exists, so the stale state must not be reported as
    // a measured zero. A no-data query would return an empty series and token
    // generationId 'unknown'.
    expect(trends.series.length).toBeGreaterThan(0);
    const nonNullPoints = trends.series.filter((s) => s.value !== null);
    expect(nonNullPoints.length).toBeGreaterThan(0);
    expect(nonNullPoints.some((s) => s.value && s.value > 0)).toBe(true);

    // The DTO token carries the stale generation, making the stale state
    // detectable and distinct from the empty "no data" state.
    expect(trends.token.generationId).toBe(staleGenerationId);
    expect(trends.token.generationId).not.toBe(currentGenerationId);

    const overview = await dataSource.portfolio.getOverview({});
    expect(overview.sessionCount).toBeGreaterThan(0);
    expect(overview.totalTokens).toBeGreaterThan(0);

    // Baseline: an unknown portfolio returns the empty-state token 'unknown'
    // with zero counts and no series, so the stale state above cannot be
    // mistaken for missing data.
    const emptyTrends = await dataSource.portfolio.getTrends({ portfolioId: 'does-not-exist' });
    expect(emptyTrends.token.generationId).toBe('unknown');
    expect(emptyTrends.series.length).toBe(0);

    const emptyOverview = await dataSource.portfolio.getOverview({ portfolioId: 'does-not-exist' });
    expect(emptyOverview.token.generationId).toBe('unknown');
    expect(emptyOverview.totalTokens).toBe(0);
    expect(emptyOverview.sessionCount).toBe(0);
  });
});
