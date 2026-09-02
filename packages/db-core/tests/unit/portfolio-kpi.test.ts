import { beforeAll, describe, expect, it } from 'vitest';
import {
  EnvironmentStore,
  IngestionSourceStore,
  PortfolioStore,
  ProjectStore,
  SourceProjectStore,
  TenantStore,
} from '../../src/identity.js';
import { PortfolioKpiStore } from '../../src/portfolio-kpi.js';
import { FRESH_SCHEMA_SQL } from '../../src/schema.js';
import { SessionStore } from '../../src/session-evidence.js';
import { getSqlite3, WasmSqliteExecutor } from '../helpers/sqlite-wasm-adapter.js';

beforeAll(async () => {
  await getSqlite3();
});

async function seed(): Promise<{ executor: WasmSqliteExecutor; portfolioId: string }> {
  const executor = await WasmSqliteExecutor.create();
  await executor.exec(FRESH_SCHEMA_SQL);
  const portfolioId = 'pk-portfolio';
  await TenantStore.insert(executor, { id: 'pk-tenant', name: 'T', createdAt: 1, updatedAt: 1 });
  await PortfolioStore.insert(executor, {
    id: portfolioId,
    tenantId: 'pk-tenant',
    name: 'P',
    createdAt: 1,
    updatedAt: 1,
  });
  await IngestionSourceStore.insert(executor, {
    id: 'pk-ingestion',
    portfolioId,
    nativeSourceId: 'claude-local',
    displayName: 'Claude',
    type: 'claude_code',
    authority: 'local',
    createdAt: 1,
    updatedAt: 1,
  });
  await EnvironmentStore.insert(executor, portfolioId, {
    id: 'pk-env',
    ingestionSourceId: 'pk-ingestion',
    nativeEnvironmentId: 'env',
    createdAt: 1,
    updatedAt: 1,
  });
  await ProjectStore.insert(executor, {
    id: 'pk-project',
    portfolioId,
    name: 'pk-project',
    createdAt: 1,
    updatedAt: 1,
  });
  await SourceProjectStore.insert(executor, portfolioId, {
    projectId: 'pk-project',
    ingestionSourceId: 'pk-ingestion',
    nativeProjectId: 'native-pk',
    createdAt: 1,
    updatedAt: 1,
  });
  return { executor, portfolioId };
}

async function insertSession(
  executor: WasmSqliteExecutor,
  id: string,
  startTime: number | null,
): Promise<void> {
  await SessionStore.insert(executor, {
    id,
    projectId: 'pk-project',
    ingestionSourceId: 'pk-ingestion',
    environmentId: 'pk-env',
    harness: 'claude-code',
    nativeSessionId: id,
    currentGenerationId: null,
    occurrenceTime: null,
    finality: 'final',
    mode: null,
    taskCohort: null,
    startTime,
    endTime: null,
    aiTitle: null,
    slug: null,
    agentName: null,
    cwd: null,
    gitBranch: null,
    cliVersions: null,
    isSidechain: false,
    agentId: null,
    outcome: null,
  } as never);
}

describe('PortfolioKpiStore.countSessionsInWindow', () => {
  it('counts sessions with start_time inside [start, end)', async () => {
    const { executor, portfolioId } = await seed();
    await insertSession(executor, 's1', 1000);
    await insertSession(executor, 's2', 2000);
    await insertSession(executor, 's3', 5000);
    expect(await PortfolioKpiStore.countSessionsInWindow(executor, portfolioId, 0, 3000)).toBe(2);
  });

  it('returns 0 (a real measured zero) for an empty window, not a missing marker', async () => {
    const { executor, portfolioId } = await seed();
    await insertSession(executor, 's1', 1000);
    expect(await PortfolioKpiStore.countSessionsInWindow(executor, portfolioId, 9000, 9999)).toBe(
      0,
    );
  });

  it('excludes sessions with no start_time from the window count', async () => {
    const { executor, portfolioId } = await seed();
    await insertSession(executor, 's1', null);
    expect(await PortfolioKpiStore.countSessionsInWindow(executor, portfolioId, 0, 999999)).toBe(0);
  });

  it('resolves via indexed SEARCH, never a full table SCAN, for the window query', async () => {
    const { executor, portfolioId } = await seed();
    await insertSession(executor, 's1', 1000);
    const { rows } = await executor.exec(
      `EXPLAIN QUERY PLAN
       SELECT COUNT(*) AS c FROM sessions s JOIN projects p ON p.id = s.project_id
       WHERE p.portfolio_id = ? AND s.start_time IS NOT NULL AND s.start_time >= ? AND s.start_time < ?`,
      [portfolioId, 0, 999999],
    );
    const details = rows.map((r) => String(r.detail));
    expect(details.some((d) => /^SCAN/.test(d))).toBe(false);
    expect(details.every((d) => /^SEARCH/.test(d))).toBe(true);
  });
});
