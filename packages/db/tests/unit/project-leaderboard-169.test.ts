import {
  EnvironmentStore,
  FRESH_SCHEMA_SQL,
  IngestionSourceStore,
  ModelRequestStore,
  PortfolioStore,
  ProjectStore,
  SessionStore,
  SourceProjectStore,
  TenantStore,
} from '@lucasschirm/sal-db-core';
import { describe, expect, it } from 'vitest';
import { WasmSqliteExecutor } from '../../../db-core/tests/helpers/sqlite-wasm-adapter.js';
import { createPortfolioView } from '../../src/analytics-portfolio.js';

const TENANT_ID = 'tenant-pl-169';
const PORTFOLIO_ID = 'portfolio-pl-169';
const SOURCE_ID = 'source-pl-169';
const ENV_ID = 'env-pl-169';
const PROJECT_A = 'project-pl-a-169';
const PROJECT_B = 'project-pl-b-169';

async function createExecutor(): Promise<WasmSqliteExecutor> {
  const executor = await WasmSqliteExecutor.create();
  await executor.exec(FRESH_SCHEMA_SQL);
  return executor;
}

async function seedPortfolio(executor: WasmSqliteExecutor): Promise<void> {
  await TenantStore.insert(executor, { id: TENANT_ID, name: 'Test' });
  await PortfolioStore.insert(executor, { id: PORTFOLIO_ID, tenantId: TENANT_ID, name: 'P' });
  await IngestionSourceStore.insert(executor, {
    id: SOURCE_ID,
    portfolioId: PORTFOLIO_ID,
    nativeSourceId: 'src',
    displayName: 'Source',
    type: 'claude_code',
    authority: 'local',
  });
  await EnvironmentStore.insert(executor, PORTFOLIO_ID, {
    id: ENV_ID,
    ingestionSourceId: SOURCE_ID,
    nativeEnvironmentId: 'env-native',
  });
  for (const [id, name] of [
    [PROJECT_A, 'alpha'],
    [PROJECT_B, 'beta'],
  ] as const) {
    await ProjectStore.insert(executor, { id, portfolioId: PORTFOLIO_ID, name });
    await SourceProjectStore.insert(executor, PORTFOLIO_ID, {
      projectId: id,
      ingestionSourceId: SOURCE_ID,
      nativeProjectId: `native-${id}`,
    });
  }
}

async function insertSession(
  executor: WasmSqliteExecutor,
  id: string,
  projectId: string,
  startTime: number | null,
  endTime: number | null,
  outcome: string | null = null,
): Promise<void> {
  await SessionStore.insert(executor, {
    id,
    projectId,
    ingestionSourceId: SOURCE_ID,
    nativeSessionId: id,
    harness: 'claude-code',
    finality: 'final',
    startTime,
    endTime,
    outcome,
  } as never);
}

async function seedGeneration(executor: WasmSqliteExecutor, sessionId: string): Promise<string> {
  const analysisReleaseId = `ar-${sessionId}`;
  await executor.exec(
    `INSERT INTO analysis_releases (
      id, ontology_version, metric_registry_version, statistical_policy_version,
      rollup_policy_version, mapping_version, created_at, is_default
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [analysisReleaseId, '1', '1', '1', '1', '1', 1, 0],
  );
  const generationId = `gen-${sessionId}`;
  await executor.exec(
    `INSERT INTO transformation_generations (
      id, session_id, analysis_release_id, parser_version, transformer_version,
      ontology_version, metric_version, schema_version, status, source_availability, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [generationId, sessionId, analysisReleaseId, '1', '1', '1', '1', '1', 'committed', 'local', 1],
  );
  return generationId;
}

describe('PortfolioView.getProjectLeaderboard (issue #169)', () => {
  it('includes every project with sessions/tokens/clean-rate/last-active/trend', async () => {
    const executor = await createExecutor();
    await seedPortfolio(executor);
    const now = Date.now();
    await insertSession(executor, 's-a1', PROJECT_A, now - 1000, now, 'clean');
    await insertSession(executor, 's-a2', PROJECT_A, now - 500, now, 'ended_on_error');
    const generationId = await seedGeneration(executor, 's-a1');
    await ModelRequestStore.insert(executor, {
      sessionId: 's-a1',
      generationId,
      requestOrder: 0,
      model: 'claude-sonnet',
      provider: 'anthropic',
      inputTokens: 100,
      outputTokens: 50,
      status: 'success',
    } as never);

    const view = createPortfolioView(executor);
    const board = await view.getProjectLeaderboard({ portfolioId: PORTFOLIO_ID });
    const alpha = board.rows.find((r) => r.projectId === PROJECT_A);
    expect(alpha).toBeDefined();
    expect(alpha?.sessionCount).toBe(2);
    expect(alpha?.tokens).toEqual({
      inputTokens: 100,
      inputKnownN: 1,
      outputTokens: 50,
      outputKnownN: 1,
    });
    expect(alpha?.cleanRate).toEqual({ value: 0.5, eligibleN: 2, knownN: 2 });
    expect(alpha?.lastActiveAt).toBeDefined();
    expect(alpha?.trend).toHaveLength(30);
  });

  it('reports n=0 (not an omitted row) for a project with zero sessions', async () => {
    const executor = await createExecutor();
    await seedPortfolio(executor);
    await insertSession(executor, 's-a1', PROJECT_A, Date.now(), Date.now());

    const view = createPortfolioView(executor);
    const board = await view.getProjectLeaderboard({ portfolioId: PORTFOLIO_ID });
    const beta = board.rows.find((r) => r.projectId === PROJECT_B);
    expect(beta).toBeDefined();
    expect(beta?.sessionCount).toBe(0);
    expect(beta?.cleanRate).toEqual({ value: null, eligibleN: 0, knownN: 0 });
    expect(beta?.lastActiveAt).toBeUndefined();
    expect(beta?.trend.every((point) => point.sessionCount === 0)).toBe(true);
  });

  it('excludes unclassified-outcome sessions from the clean-rate denominator', async () => {
    const executor = await createExecutor();
    await seedPortfolio(executor);
    const now = Date.now();
    await insertSession(executor, 's-a1', PROJECT_A, now, now, 'clean');
    await insertSession(executor, 's-a2', PROJECT_A, now, now, null); // unclassified

    const view = createPortfolioView(executor);
    const board = await view.getProjectLeaderboard({ portfolioId: PORTFOLIO_ID });
    const alpha = board.rows.find((r) => r.projectId === PROJECT_A);
    // denominator is knownN (1), not sessionCount (2) — a clean rate of 1.0,
    // never diluted by the unclassified session.
    expect(alpha?.cleanRate.value).toBe(1);
    expect(alpha?.cleanRate.knownN).toBe(1);
    expect(alpha?.cleanRate.eligibleN).toBe(2);
  });

  it('reports the most recent session as last-active, not the first', async () => {
    const executor = await createExecutor();
    await seedPortfolio(executor);
    await insertSession(executor, 's-a1', PROJECT_A, 1000, 1500);
    await insertSession(executor, 's-a2', PROJECT_A, 5000, 5500);

    const view = createPortfolioView(executor);
    const board = await view.getProjectLeaderboard({ portfolioId: PORTFOLIO_ID });
    const alpha = board.rows.find((r) => r.projectId === PROJECT_A);
    expect(alpha?.lastActiveAt).toBe(new Date(5000).toISOString());
  });

  it('returns an empty leaderboard for a portfolio with no projects yet', async () => {
    const executor = await createExecutor();
    const view = createPortfolioView(executor);
    const board = await view.getProjectLeaderboard({ portfolioId: 'no-such-portfolio' });
    expect(board.rows).toEqual([]);
    expect(board.token.eligibleN).toBe(0);
  });

  it('reports sample size on the token (eligibleN === rows.length)', async () => {
    const executor = await createExecutor();
    await seedPortfolio(executor);
    const view = createPortfolioView(executor);
    const board = await view.getProjectLeaderboard({ portfolioId: PORTFOLIO_ID });
    expect(board.token.eligibleN).toBe(board.rows.length);
    expect(board.token.eligibleN).toBe(2);
  });
});
