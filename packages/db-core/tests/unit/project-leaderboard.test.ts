import { beforeAll, describe, expect, it } from 'vitest';
import {
  EnvironmentStore,
  IngestionSourceStore,
  PortfolioStore,
  ProjectStore,
  SourceProjectStore,
  TenantStore,
} from '../../src/identity.js';
import { ProjectLeaderboardStore } from '../../src/project-leaderboard.js';
import { FRESH_SCHEMA_SQL } from '../../src/schema.js';
import { ModelRequestStore, SessionStore } from '../../src/session-evidence.js';
import { getSqlite3, WasmSqliteExecutor } from '../helpers/sqlite-wasm-adapter.js';

beforeAll(async () => {
  await getSqlite3();
});

const PORTFOLIO_ID = 'pl-portfolio';
const PROJECT_A = 'pl-project-a';
const PROJECT_B = 'pl-project-b';

async function seed(): Promise<{ executor: WasmSqliteExecutor }> {
  const executor = await WasmSqliteExecutor.create();
  await executor.exec(FRESH_SCHEMA_SQL);
  await TenantStore.insert(executor, { id: 'pl-tenant', name: 'T', createdAt: 1, updatedAt: 1 });
  await PortfolioStore.insert(executor, {
    id: PORTFOLIO_ID,
    tenantId: 'pl-tenant',
    name: 'P',
    createdAt: 1,
    updatedAt: 1,
  });
  await IngestionSourceStore.insert(executor, {
    id: 'pl-ingestion',
    portfolioId: PORTFOLIO_ID,
    nativeSourceId: 'claude-local',
    displayName: 'Claude',
    type: 'claude_code',
    authority: 'local',
    createdAt: 1,
    updatedAt: 1,
  });
  await EnvironmentStore.insert(executor, PORTFOLIO_ID, {
    id: 'pl-env',
    ingestionSourceId: 'pl-ingestion',
    nativeEnvironmentId: 'env',
    createdAt: 1,
    updatedAt: 1,
  });
  for (const projectId of [PROJECT_A, PROJECT_B]) {
    await ProjectStore.insert(executor, {
      id: projectId,
      portfolioId: PORTFOLIO_ID,
      name: projectId,
      createdAt: 1,
      updatedAt: 1,
    });
    await SourceProjectStore.insert(executor, PORTFOLIO_ID, {
      projectId,
      ingestionSourceId: 'pl-ingestion',
      nativeProjectId: `native-${projectId}`,
      createdAt: 1,
      updatedAt: 1,
    });
  }
  return { executor };
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
    ingestionSourceId: 'pl-ingestion',
    environmentId: 'pl-env',
    harness: 'claude-code',
    nativeSessionId: id,
    finality: 'final',
    startTime,
    endTime,
    outcome,
  } as never);
}

async function insertGeneration(
  executor: WasmSqliteExecutor,
  sessionId: string,
  generationId: string,
): Promise<void> {
  const { rows } = await executor.exec('SELECT id FROM analysis_releases WHERE id = ?', ['pl-ar']);
  if (rows.length === 0) {
    await executor.exec(
      `INSERT INTO analysis_releases
       (id, ontology_version, metric_registry_version, statistical_policy_version,
        rollup_policy_version, mapping_version, created_at, is_default)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['pl-ar', '0.1.0', '0.1.0', '0.1.0', '0.1.0', '0.1.0', 1, 0],
    );
  }
  await executor.exec(
    `INSERT INTO transformation_generations
     (id, session_id, analysis_release_id, parser_version, transformer_version,
      ontology_version, metric_version, schema_version, status, source_availability, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      generationId,
      sessionId,
      'pl-ar',
      '0.1.0',
      '0.1.0',
      '0.1.0',
      '0.1.0',
      '0.1.0',
      'committed',
      'local',
      1,
    ],
  );
}

describe('ProjectLeaderboardStore.getSessionCountsByProjectInWindow', () => {
  it('groups session counts by project, within the window', async () => {
    const { executor } = await seed();
    await insertSession(executor, 's1', PROJECT_A, 1000, null);
    await insertSession(executor, 's2', PROJECT_A, 2000, null);
    await insertSession(executor, 's3', PROJECT_B, 1500, null);
    await insertSession(executor, 's4', PROJECT_A, 9999, null); // outside window

    const rows = await ProjectLeaderboardStore.getSessionCountsByProjectInWindow(
      executor,
      PORTFOLIO_ID,
      0,
      3000,
    );
    expect(rows).toEqual(
      expect.arrayContaining([
        { projectId: PROJECT_A, sessionCount: 2 },
        { projectId: PROJECT_B, sessionCount: 1 },
      ]),
    );
  });

  it('is absent (not a zero row) for a project with no sessions in the window', async () => {
    const { executor } = await seed();
    await insertSession(executor, 's1', PROJECT_A, 1000, null);
    const rows = await ProjectLeaderboardStore.getSessionCountsByProjectInWindow(
      executor,
      PORTFOLIO_ID,
      0,
      3000,
    );
    expect(rows.some((r) => r.projectId === PROJECT_B)).toBe(false);
  });

  it('resolves via indexed SEARCH, never a full table SCAN', async () => {
    const { executor } = await seed();
    await insertSession(executor, 's1', PROJECT_A, 1000, null);
    const { rows } = await executor.exec(
      `EXPLAIN QUERY PLAN
       SELECT s.project_id AS project_id, COUNT(*) AS c FROM sessions s
       JOIN projects p ON p.id = s.project_id
       WHERE p.portfolio_id = ? AND s.start_time IS NOT NULL AND s.start_time >= ? AND s.start_time < ?
       GROUP BY s.project_id`,
      [PORTFOLIO_ID, 0, 999999],
    );
    const details = rows.map((r) => String(r.detail));
    expect(details.some((d) => /^SCAN/.test(d))).toBe(false);
  });
});

describe('ProjectLeaderboardStore.getTokenTotalsByProjectInWindow', () => {
  it('sums tokens per project, tracking known counts independently per side', async () => {
    const { executor } = await seed();
    await insertSession(executor, 's1', PROJECT_A, 1000, null);
    await insertGeneration(executor, 's1', 'gen-1');
    await ModelRequestStore.insert(executor, {
      sessionId: 's1',
      generationId: 'gen-1',
      requestOrder: 0,
      model: 'claude-sonnet',
      provider: 'anthropic',
      inputTokens: 100,
      outputTokens: null,
      status: 'success',
    } as never);

    const rows = await ProjectLeaderboardStore.getTokenTotalsByProjectInWindow(
      executor,
      PORTFOLIO_ID,
      0,
      5000,
    );
    expect(rows).toEqual([
      { projectId: PROJECT_A, inputSum: 100, inputKnownN: 1, outputSum: 0, outputKnownN: 0 },
    ]);
  });
});

describe('ProjectLeaderboardStore.getCleanCompletionByProjectInWindow', () => {
  it('scopes the clean-rate denominator to the classified-outcome subset per project', async () => {
    const { executor } = await seed();
    await insertSession(executor, 's1', PROJECT_A, 1000, null, 'clean');
    await insertSession(executor, 's2', PROJECT_A, 1100, null, 'ended_on_error');
    await insertSession(executor, 's3', PROJECT_A, 1200, null, null); // unclassified

    const rows = await ProjectLeaderboardStore.getCleanCompletionByProjectInWindow(
      executor,
      PORTFOLIO_ID,
      0,
      5000,
    );
    expect(rows).toEqual([{ projectId: PROJECT_A, cleanN: 1, knownN: 2, eligibleN: 3 }]);
  });
});

describe('ProjectLeaderboardStore.getLastActiveByProject', () => {
  it('reports the most recent start/end per project, unwindowed', async () => {
    const { executor } = await seed();
    await insertSession(executor, 's1', PROJECT_A, 1000, 1500);
    await insertSession(executor, 's2', PROJECT_A, 5000, 5500);

    const rows = await ProjectLeaderboardStore.getLastActiveByProject(executor, PORTFOLIO_ID);
    expect(rows).toEqual([{ projectId: PROJECT_A, lastStart: 5000, lastEnd: 5500 }]);
  });

  it('is absent for a project with zero sessions ever (missing, not a 0 row)', async () => {
    const { executor } = await seed();
    const rows = await ProjectLeaderboardStore.getLastActiveByProject(executor, PORTFOLIO_ID);
    expect(rows).toEqual([]);
  });
});

describe('ProjectLeaderboardStore.getSessionStartsByProjectInWindow', () => {
  it('returns one row per session, for day-bucketing in the db facade', async () => {
    const { executor } = await seed();
    await insertSession(executor, 's1', PROJECT_A, 1000, null);
    await insertSession(executor, 's2', PROJECT_A, 2000, null);
    const rows = await ProjectLeaderboardStore.getSessionStartsByProjectInWindow(
      executor,
      PORTFOLIO_ID,
      0,
      5000,
    );
    expect(rows).toEqual(
      expect.arrayContaining([
        { projectId: PROJECT_A, startTime: 1000 },
        { projectId: PROJECT_A, startTime: 2000 },
      ]),
    );
  });
});
