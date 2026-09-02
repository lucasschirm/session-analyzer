import { beforeAll, describe, expect, it } from 'vitest';
import type { SessionOutcome } from '../../src/index.js';
import {
  EnvironmentStore,
  FRESH_SCHEMA_SQL,
  IngestionSourceStore,
  MIGRATIONS,
  MigrationRunner,
  PortfolioStore,
  ProjectStore,
  SessionOutcomeStore,
  SessionStore,
  SourceProjectStore,
  TenantStore,
} from '../../src/index.js';
import { getSqlite3, WasmSqliteExecutor } from '../helpers/sqlite-wasm-adapter.js';

beforeAll(async () => {
  await getSqlite3();
});

const PREFIX = 'so';

async function createExecutor(): Promise<WasmSqliteExecutor> {
  return WasmSqliteExecutor.create();
}

async function seedIdentity(executor: WasmSqliteExecutor): Promise<{
  portfolioId: string;
  ingestionSourceId: string;
  environmentId: string;
  projectId: string;
}> {
  const tenantId = `${PREFIX}-tenant`;
  const portfolioId = `${PREFIX}-portfolio`;
  await TenantStore.insert(executor, {
    id: tenantId,
    name: 'SO Tenant',
    createdAt: 1,
    updatedAt: 1,
  });
  await PortfolioStore.insert(executor, {
    id: portfolioId,
    tenantId,
    name: 'SO Portfolio',
    createdAt: 1,
    updatedAt: 1,
  });
  const ingestionSourceId = `${PREFIX}-ingestion`;
  await IngestionSourceStore.insert(executor, {
    id: ingestionSourceId,
    portfolioId,
    nativeSourceId: 'claude-local',
    displayName: 'Claude',
    type: 'claude_code',
    authority: 'local',
    supportsCursor: true,
    supportsCheckpoint: false,
    createdAt: 1,
    updatedAt: 1,
  });
  const environmentId = `${PREFIX}-environment`;
  await EnvironmentStore.insert(executor, portfolioId, {
    id: environmentId,
    ingestionSourceId,
    nativeEnvironmentId: 'env-1',
    createdAt: 1,
    updatedAt: 1,
  });
  const projectId = `${PREFIX}-project`;
  await ProjectStore.insert(executor, {
    id: projectId,
    portfolioId,
    name: 'so-project',
    createdAt: 1,
    updatedAt: 1,
  });
  await SourceProjectStore.insert(executor, portfolioId, {
    id: `${PREFIX}-source-project`,
    projectId,
    ingestionSourceId,
    nativeProjectId: 'native-so',
    createdAt: 1,
    updatedAt: 1,
  });
  return { portfolioId, ingestionSourceId, environmentId, projectId };
}

async function insertSession(
  executor: WasmSqliteExecutor,
  identity: Awaited<ReturnType<typeof seedIdentity>>,
  sessionId: string,
  overrides: { finality?: string; outcome?: SessionOutcome | null } = {},
): Promise<void> {
  await SessionStore.insert(executor, {
    id: sessionId,
    projectId: identity.projectId,
    ingestionSourceId: identity.ingestionSourceId,
    environmentId: identity.environmentId,
    harness: 'claude-code',
    nativeSessionId: sessionId,
    currentGenerationId: null,
    occurrenceTime: null,
    finality: overrides.finality ?? 'final',
    mode: null,
    taskCohort: null,
    startTime: null,
    endTime: null,
    aiTitle: null,
    slug: null,
    agentName: null,
    cwd: null,
    gitBranch: null,
    cliVersions: null,
    isSidechain: false,
    agentId: null,
    outcome: overrides.outcome ?? null,
  });
}

async function getOutcomeIndexSql(
  executor: WasmSqliteExecutor,
  name: string,
): Promise<string | null> {
  const { rows } = await executor.exec(
    "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?",
    [name],
  );
  if (rows.length === 0) return null;
  return String(rows[0].sql);
}

async function getPlanDetails(
  executor: WasmSqliteExecutor,
  sql: string,
  params: (string | number | null)[],
): Promise<string[]> {
  const { rows } = await executor.exec(`EXPLAIN QUERY PLAN ${sql}`, params);
  return rows.map((row) => String(row.detail));
}

function hasScanForTable(details: string[], table: string): boolean {
  return details.some((d) => d.startsWith(`SCAN TABLE ${table}`) || d.startsWith(`SCAN ${table}`));
}

function hasSearchForTable(details: string[], table: string): boolean {
  return details.some(
    (d) => d.startsWith(`SEARCH TABLE ${table}`) || d.startsWith(`SEARCH ${table}`),
  );
}

// ---------------------------------------------------------------------------
// 1. Migration test
// ---------------------------------------------------------------------------

describe('sessions outcome column migration v81', () => {
  it('adds a nullable, checked outcome column and its indexes on upgrade', async () => {
    const executor = await createExecutor();
    const before = MIGRATIONS.filter((m) => m.id < 81);
    await new MigrationRunner(executor, before).migrate();

    const identity = await seedIdentity(executor);
    // Before migration 81, `outcome` does not exist yet — sessions insert
    // via raw SQL matching the pre-81 column set to prove the table is
    // usable without it, then the migration adds the column non-destructively.
    await executor.exec(
      `INSERT INTO sessions (id, project_id, ingestion_source_id, environment_id, harness,
        native_session_id, finality, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        `${PREFIX}-pre-session`,
        identity.projectId,
        identity.ingestionSourceId,
        identity.environmentId,
        'claude-code',
        `${PREFIX}-pre-session`,
        'final',
        1,
        1,
      ],
    );

    await new MigrationRunner(executor, MIGRATIONS).migrate();

    // Pre-existing row survives the migration with a NULL (missing) outcome.
    const preRow = await SessionStore.getById(
      executor,
      identity.projectId,
      `${PREFIX}-pre-session`,
    );
    expect(preRow?.outcome).toBeNull();

    // Post-migration inserts can set a real outcome value.
    await insertSession(executor, identity, `${PREFIX}-clean-session`, { outcome: 'clean' });
    const cleanRow = await SessionStore.getById(
      executor,
      identity.projectId,
      `${PREFIX}-clean-session`,
    );
    expect(cleanRow?.outcome).toBe('clean');

    // The CHECK constraint rejects values outside the real outcome enum.
    expect(() =>
      executor.exec(`UPDATE sessions SET outcome = ? WHERE id = ?`, [
        'not-a-real-outcome',
        `${PREFIX}-clean-session`,
      ]),
    ).toThrow();

    const indexSql = await getOutcomeIndexSql(executor, 'idx_sessions_project_finality_outcome');
    expect(indexSql).toContain('project_id');
    expect(indexSql).toContain('finality');
    expect(indexSql).toContain('outcome');
  });
});

// ---------------------------------------------------------------------------
// 2. Fresh-schema parity test
// ---------------------------------------------------------------------------

describe('sessions outcome column fresh schema parity', () => {
  it('produces the same outcome column, check constraint, and indexes as the migration path', async () => {
    const fresh = await createExecutor();
    await fresh.exec(FRESH_SCHEMA_SQL);

    const upgraded = await createExecutor();
    await new MigrationRunner(upgraded, MIGRATIONS).migrate();

    for (const name of ['idx_sessions_outcome', 'idx_sessions_project_finality_outcome']) {
      const freshSql = await getOutcomeIndexSql(fresh, name);
      const upgradedSql = await getOutcomeIndexSql(upgraded, name);
      expect(freshSql).not.toBeNull();
      expect(freshSql).toBe(upgradedSql);
    }

    const identity = await seedIdentity(fresh);
    await insertSession(fresh, identity, `${PREFIX}-fresh-session`, { outcome: 'ended_on_error' });
    const row = await SessionStore.getById(fresh, identity.projectId, `${PREFIX}-fresh-session`);
    expect(row?.outcome).toBe('ended_on_error');

    expect(() =>
      fresh.exec(`UPDATE sessions SET outcome = ? WHERE id = ?`, [
        'bogus',
        `${PREFIX}-fresh-session`,
      ]),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 3. Query-plan test — the outcome rollup query
// ---------------------------------------------------------------------------

describe('session outcome rollup query plan', () => {
  async function seededExecutor(): Promise<{ executor: WasmSqliteExecutor; projectId: string }> {
    const executor = await createExecutor();
    await executor.exec(FRESH_SCHEMA_SQL);
    const identity = await seedIdentity(executor);
    await insertSession(executor, identity, `${PREFIX}-r1`, { outcome: 'clean' });
    await insertSession(executor, identity, `${PREFIX}-r2`, { outcome: 'interrupted_by_user' });
    await insertSession(executor, identity, `${PREFIX}-r3`, { outcome: 'ended_on_error' });
    await insertSession(executor, identity, `${PREFIX}-r4`, { outcome: null });
    await insertSession(executor, identity, `${PREFIX}-r5`, { finality: 'open', outcome: null });
    return { executor, projectId: identity.projectId };
  }

  it('groups final sessions by outcome using the project/finality/outcome index', async () => {
    const { executor, projectId } = await seededExecutor();
    const details = await getPlanDetails(
      executor,
      `SELECT outcome, COUNT(*) as count FROM sessions
       WHERE project_id = ? AND finality = 'final'
       GROUP BY outcome`,
      [projectId],
    );
    expect(hasScanForTable(details, 'sessions')).toBe(false);
    expect(hasSearchForTable(details, 'sessions')).toBe(true);
  });

  it('SessionOutcomeStore.rollupByProject reports every bucket including the missing one', async () => {
    const { executor, projectId } = await seededExecutor();
    const rows = await SessionOutcomeStore.rollupByProject(executor, projectId);

    const byOutcome = new Map(rows.map((r) => [r.outcome, r.count]));
    expect(byOutcome.get('clean')).toBe(1);
    expect(byOutcome.get('interrupted_by_user')).toBe(1);
    expect(byOutcome.get('ended_on_error')).toBe(1);
    // Only the one `final` session with outcome=null counts here — the
    // `open` session is outside the finality='final' population entirely.
    expect(byOutcome.get(null)).toBe(1);

    const eligibleN = rows.reduce((sum, r) => sum + r.count, 0);
    expect(eligibleN).toBe(4);
  });
});
