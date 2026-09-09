import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FRESH_SCHEMA_SQL,
  MetricValueStore,
  RollupContributionStore,
} from '@lucasschirm/sal-db-core';
import { createDefaultRegistry } from '@lucasschirm/sal-transformer-registry';
import { describe, expect, it } from 'vitest';
import { WasmSqliteExecutor } from '../../../db-core/tests/helpers/sqlite-wasm-adapter.js';
import { createAnalyticsDataSource } from '../../src/analytics.js';
import type { IngestionReceipt } from '../../src/ingestion.js';
import { createSha256ContentHasher, DefaultIngestionOrchestrator } from '../../src/ingestion.js';
import { FailureInjectionExecutor, InjectionError, type InjectionStage } from './harness.js';

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

async function ingestFixture(
  orchestrator: DefaultIngestionOrchestrator,
  hasher: ReturnType<typeof createSha256ContentHasher>,
  fixtureName: string,
  projectId: string,
  sessionId: string,
): Promise<IngestionReceipt> {
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

async function getSessionRow(harness: FailureInjectionExecutor, sessionId: string) {
  const { rows } = await harness.exec(
    'SELECT project_id, current_generation_id FROM sessions WHERE id = ?',
    [sessionId],
  );
  return rows[0] as { project_id: string; current_generation_id: string | null } | undefined;
}

async function getGenerationStatus(harness: FailureInjectionExecutor, generationId: string) {
  const { rows } = await harness.exec(
    'SELECT status FROM transformation_generations WHERE id = ?',
    [generationId],
  );
  return rows[0]?.status as string | undefined;
}

async function countRows(harness: FailureInjectionExecutor, table: string) {
  const { rows } = await harness.exec(`SELECT COUNT(*) AS c FROM ${table}`, []);
  return Number(rows[0]?.c ?? 0);
}

async function setupWithStage(stage: InjectionStage | undefined) {
  const inner = await createExecutor();
  const harness = new FailureInjectionExecutor(inner);
  harness.setInjection(stage);
  const { orchestrator, hasher } = await setupIngestion(harness);
  return { harness, orchestrator, hasher, inner };
}

describe('pipeline failure-injection harness', () => {
  it('pre-commit: throws before any write, leaving an empty store', async () => {
    const { harness, orchestrator, hasher } = await setupWithStage('pre-commit');

    const receipt = await ingestFixture(
      orchestrator,
      hasher,
      't2-happy-path.jsonl',
      'project-precommit',
      'sess-happy-1',
    );

    expect(receipt.status).toBe('failed');
    expect(harness.getThrownStage()).toBe('pre-commit');
    expect(harness.getThrownCallIndex()).toBe(1);

    const sessionCount = await countRows(harness, 'sessions');
    expect(sessionCount).toBe(0);
  });

  it('mid-commit: throws after the root session is written, leaving a pending generation', async () => {
    const { harness, orchestrator, hasher } = await setupWithStage('mid-commit');

    const receipt = await ingestFixture(
      orchestrator,
      hasher,
      't2-happy-path.jsonl',
      'project-midcommit',
      'sess-happy-1',
    );

    expect(receipt.status).toBe('failed');
    expect(harness.getThrownStage()).toBe('mid-commit');
    expect(harness.getThrownCallIndex()).toBeGreaterThan(0);

    const session = await getSessionRow(harness, receipt.sessionId);
    expect(session).toBeTruthy();
    expect(session?.current_generation_id).toBeNull();

    const status = await getGenerationStatus(harness, receipt.generationId);
    expect(status).toBe('pending');

    const metricValues = await MetricValueStore.listBySession(harness, receipt.sessionId);
    expect(metricValues.length).toBe(0);
  });

  it('post-ingest: throws after the session is committed but before rollups', async () => {
    const { harness, orchestrator, hasher } = await setupWithStage('post-ingest');

    const receipt = await ingestFixture(
      orchestrator,
      hasher,
      't2-happy-path.jsonl',
      'project-postingest',
      'sess-happy-1',
    );

    expect(receipt.status).toBe('failed');
    expect(harness.getThrownStage()).toBe('post-ingest');
    expect(harness.getThrownCallIndex()).toBeGreaterThan(0);

    const session = await getSessionRow(harness, receipt.sessionId);
    expect(session?.current_generation_id).toBe(receipt.generationId);

    const status = await getGenerationStatus(harness, receipt.generationId);
    expect(status).toBe('committed');

    const metricValues = await MetricValueStore.listBySession(harness, receipt.sessionId);
    expect(metricValues.length).toBeGreaterThan(0);

    const contributionCount = await countRows(harness, 'rollup_contributions');
    expect(contributionCount).toBe(0);

    const dataSource = createAnalyticsDataSource(harness);
    const overview = await dataSource.portfolio.getOverview({});
    expect(overview.sessionCount).toBeGreaterThan(0);
    expect(overview.totalTokens).toBe(0);
    expect(overview.token.generationId).not.toBe(receipt.generationId);
  });

  it('mid-rollup: throws after the first rollup contribution, leaving partial rollups', async () => {
    const { harness, orchestrator, hasher } = await setupWithStage('mid-rollup');

    const receipt = await ingestFixture(
      orchestrator,
      hasher,
      't2-happy-path.jsonl',
      'project-midrollup',
      'sess-happy-1',
    );

    expect(receipt.status).toBe('failed');
    expect(harness.getThrownStage()).toBe('mid-rollup');
    expect(harness.getThrownCallIndex()).toBeGreaterThan(0);

    const session = await getSessionRow(harness, receipt.sessionId);
    expect(session?.current_generation_id).toBe(receipt.generationId);

    const metricValues = await MetricValueStore.listBySession(harness, receipt.sessionId);
    expect(metricValues.length).toBeGreaterThan(0);

    const contributions = await RollupContributionStore.listBySession(harness, receipt.sessionId);
    expect(contributions.length).toBeGreaterThan(0);

    const dailyRollupCount = await countRows(harness, 'project_daily_rollups');
    expect(dailyRollupCount).toBe(0);
  });

  it('query: throws on the first query after a normal ingestion', async () => {
    const inner = await createExecutor();
    const harness = new FailureInjectionExecutor(inner);
    const { orchestrator, hasher } = await setupIngestion(harness);

    const receipt = await ingestFixture(
      orchestrator,
      hasher,
      't2-happy-path.jsonl',
      'project-query',
      'sess-happy-1',
    );
    expect(receipt.status).toBe('committed');

    harness.setInjection('query');

    const dataSource = createAnalyticsDataSource(harness);
    await expect(dataSource.portfolio.getOverview({})).rejects.toBeInstanceOf(InjectionError);
    expect(harness.getThrownStage()).toBe('query');
  });

  it('normal (non-injected) runs are unaffected', async () => {
    const { harness, orchestrator, hasher } = await setupWithStage(undefined);

    const receipt = await ingestFixture(
      orchestrator,
      hasher,
      't2-happy-path.jsonl',
      'project-normal',
      'sess-happy-1',
    );

    expect(receipt.status).toBe('committed');
    expect(harness.getThrownStage()).toBeUndefined();

    const dataSource = createAnalyticsDataSource(harness);
    const overview = await dataSource.portfolio.getOverview({});
    expect(overview.sessionCount).toBeGreaterThan(0);
    expect(overview.headlineMetrics.length).toBeGreaterThan(0);

    const dailyRollupCount = await countRows(harness, 'project_daily_rollups');
    expect(dailyRollupCount).toBeGreaterThan(0);
  });
});
