import { beforeAll, describe, expect, it } from 'vitest';
import {
  EnvironmentStore,
  FRESH_SCHEMA_SQL,
  IngestionSourceStore,
  MessageEffortStore,
  MIGRATIONS,
  MigrationRunner,
  PortfolioStore,
  ProjectStore,
  SessionStore,
  SourceProjectStore,
  type SqliteExecutor,
  TenantStore,
  WorkspaceStore,
} from '../../src/index.js';
import { getSqlite3, WasmSqliteExecutor } from '../helpers/sqlite-wasm-adapter.js';

beforeAll(async () => {
  await getSqlite3();
});

const PREFIX = 'meff';

async function createExecutor(): Promise<WasmSqliteExecutor> {
  return WasmSqliteExecutor.create();
}

/**
 * Minimal seed: tenant -> portfolio -> ingestion source -> environment ->
 * project -> source project -> workspace -> session -> generation. Mirrors
 * the seeding used by session-component-exposures-generation.test.ts, cut
 * down to what `message_effort`'s FK chain (session_id, generation_id)
 * actually requires.
 */
async function seedScenario(
  executor: WasmSqliteExecutor,
): Promise<{ sessionId: string; generationId: string }> {
  const tenantId = `${PREFIX}-tenant`;
  const portfolioId = `${PREFIX}-portfolio`;
  const ingestionSourceId = `${PREFIX}-ingestion`;
  const environmentId = `${PREFIX}-environment`;
  const projectId = `${PREFIX}-project`;
  const workspaceId = `${PREFIX}-workspace`;
  const sessionId = `${PREFIX}-session`;
  const analysisReleaseId = `${PREFIX}-release`;
  const generationId = `${PREFIX}-generation`;

  await TenantStore.insert(executor, {
    id: tenantId,
    name: 'MEFF Tenant',
    createdAt: 1,
    updatedAt: 1,
  });
  await PortfolioStore.insert(executor, {
    id: portfolioId,
    tenantId,
    name: 'MEFF',
    createdAt: 1,
    updatedAt: 1,
  });
  await IngestionSourceStore.insert(executor, {
    id: ingestionSourceId,
    portfolioId,
    nativeSourceId: 'claude-local',
    displayName: 'Claude',
    type: 'claude_code',
    authority: 'local',
    createdAt: 1,
    updatedAt: 1,
  });
  await EnvironmentStore.insert(executor, portfolioId, {
    id: environmentId,
    ingestionSourceId,
    nativeEnvironmentId: 'env-1',
    createdAt: 1,
    updatedAt: 1,
  });
  await ProjectStore.insert(executor, {
    id: projectId,
    portfolioId,
    name: 'meff-project',
    createdAt: 1,
    updatedAt: 1,
  });
  await SourceProjectStore.insert(executor, portfolioId, {
    projectId,
    ingestionSourceId,
    nativeProjectId: 'native-meff',
    createdAt: 1,
    updatedAt: 1,
  });
  await WorkspaceStore.insert(executor, portfolioId, {
    id: workspaceId,
    projectId,
    nativeWorkspaceId: 'ws-1',
    createdAt: 1,
    updatedAt: 1,
  });

  await executor.exec(
    `INSERT INTO analysis_releases (
      id, ontology_version, metric_registry_version, statistical_policy_version,
      rollup_policy_version, mapping_version, created_at, is_default
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [analysisReleaseId, '1', '1', '1', '1', '1', 1, 0],
  );

  await SessionStore.insert(executor, {
    id: sessionId,
    projectId,
    ingestionSourceId,
    environmentId,
    harness: 'claude_code',
    nativeSessionId: 'native-meff-1',
    currentGenerationId: null,
    occurrenceTime: 1,
    finality: 'open',
    mode: null,
    taskCohort: null,
    startTime: 1,
    endTime: null,
    aiTitle: null,
    slug: null,
    agentName: null,
    cwd: null,
    gitBranch: null,
    cliVersions: null,
    isSidechain: false,
    agentId: null,
    createdAt: 1,
    updatedAt: 1,
  });

  await executor.exec(
    `INSERT INTO transformation_generations (
      id, session_id, analysis_release_id, parser_version, transformer_version,
      ontology_version, metric_version, schema_version, status,
      source_availability, created_at, committed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      generationId,
      sessionId,
      analysisReleaseId,
      'p1',
      't1',
      'o1',
      'm1',
      's1',
      'committed',
      'local',
      1,
      1,
    ],
  );
  await SessionStore.update(executor, projectId, sessionId, { currentGenerationId: generationId });

  return { sessionId, generationId };
}

async function tableAndIndexNames(executor: SqliteExecutor): Promise<string[]> {
  const { rows } = await executor.exec(
    "SELECT name FROM sqlite_master WHERE type IN ('table', 'index') AND (name = 'message_effort' OR name LIKE 'idx_message_effort%') ORDER BY name",
  );
  return rows.map((r) => String(r.name));
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

function hasSearchUsingIndex(details: string[], table: string, index: string): boolean {
  return details.some(
    (d) =>
      (d.startsWith(`SEARCH TABLE ${table}`) || d.startsWith(`SEARCH ${table}`)) &&
      d.includes(index),
  );
}

describe('message_effort migration v81', () => {
  it('creates the table and both indexes when migrating from v80', async () => {
    const executor = await createExecutor();
    const before = MIGRATIONS.filter((m) => m.id < 81);
    await new MigrationRunner(executor, before).migrate();
    expect(await tableAndIndexNames(executor)).toEqual([]);

    await new MigrationRunner(executor, MIGRATIONS).migrate();
    const names = await tableAndIndexNames(executor);
    expect(names).toContain('message_effort');
    expect(names).toContain('idx_message_effort_session_order');
    expect(names).toContain('idx_message_effort_session');
  });

  it('enforces the normalized_effort CHECK constraint', async () => {
    const executor = await createExecutor();
    await executor.exec(FRESH_SCHEMA_SQL);
    const { sessionId, generationId } = await seedScenario(executor);

    expect(() =>
      executor.exec(
        `INSERT INTO message_effort (id, session_id, generation_id, request_order, raw_effort, normalized_effort, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ['bad-effort', sessionId, generationId, 1, 'weird', 'not-a-real-level', 1, 1],
      ),
    ).toThrow();
  });

  it('is idempotent and checksum-stable on re-run', async () => {
    const executor = await createExecutor();
    await new MigrationRunner(executor, MIGRATIONS).migrate();
    // Re-running must not throw a checksum mismatch or attempt to re-apply.
    await expect(new MigrationRunner(executor, MIGRATIONS).migrate()).resolves.not.toThrow();
  });
});

describe('message_effort fresh schema parity', () => {
  it('produces the same table and indexes as the migration path', async () => {
    const fresh = await createExecutor();
    await fresh.exec(FRESH_SCHEMA_SQL);

    const upgraded = await createExecutor();
    await new MigrationRunner(upgraded, MIGRATIONS).migrate();

    expect(await tableAndIndexNames(fresh)).toEqual(await tableAndIndexNames(upgraded));
  });
});

describe('message_effort query plans', () => {
  it('SELECT ... WHERE session_id = ? ORDER BY request_order uses idx_message_effort_session_order, not a scan', async () => {
    const executor = await createExecutor();
    await executor.exec(FRESH_SCHEMA_SQL);
    const { sessionId, generationId } = await seedScenario(executor);
    for (let i = 1; i <= 5; i++) {
      await MessageEffortStore.insert(executor, {
        sessionId,
        generationId,
        requestOrder: i,
        rawEffort: 'high',
        normalizedEffort: 'high',
        createdAt: 1,
        updatedAt: 1,
      });
    }

    const details = await getPlanDetails(
      executor,
      'SELECT id, raw_effort, normalized_effort FROM message_effort WHERE session_id = ? ORDER BY request_order',
      [sessionId],
    );
    expect(hasScanForTable(details, 'message_effort')).toBe(false);
    expect(hasSearchUsingIndex(details, 'message_effort', 'idx_message_effort_session_order')).toBe(
      true,
    );
  });
});

describe('MessageEffortStore', () => {
  it('round-trips a row with both raw and normalized effort, session-scoped', async () => {
    const executor = await createExecutor();
    await executor.exec(FRESH_SCHEMA_SQL);
    const { sessionId, generationId } = await seedScenario(executor);

    const id = await MessageEffortStore.insert(executor, {
      sessionId,
      generationId,
      requestOrder: 1,
      rawEffort: 'high',
      normalizedEffort: 'high',
      createdAt: 1,
      updatedAt: 1,
    });

    const row = await MessageEffortStore.getById(executor, sessionId, id);
    expect(row?.rawEffort).toBe('high');
    expect(row?.normalizedEffort).toBe('high');
    expect(row?.requestOrder).toBe(1);

    const listed = await MessageEffortStore.listBySession(executor, sessionId);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(id);
  });

  it('allows raw_effort and normalized_effort to be independently null (unrecognized raw value)', async () => {
    const executor = await createExecutor();
    await executor.exec(FRESH_SCHEMA_SQL);
    const { sessionId, generationId } = await seedScenario(executor);

    const id = await MessageEffortStore.insert(executor, {
      sessionId,
      generationId,
      requestOrder: 2,
      rawEffort: 'turbo-charged',
      normalizedEffort: null,
      createdAt: 1,
      updatedAt: 1,
    });

    const row = await MessageEffortStore.getById(executor, sessionId, id);
    expect(row?.rawEffort).toBe('turbo-charged');
    expect(row?.normalizedEffort).toBeNull();
  });

  it('enforces the unique (session_id, request_order) index', async () => {
    const executor = await createExecutor();
    await executor.exec(FRESH_SCHEMA_SQL);
    const { sessionId, generationId } = await seedScenario(executor);

    await MessageEffortStore.insert(executor, {
      id: 'dup-1',
      sessionId,
      generationId,
      requestOrder: 1,
      rawEffort: 'high',
      normalizedEffort: 'high',
      createdAt: 1,
      updatedAt: 1,
    });

    await expect(
      MessageEffortStore.insert(executor, {
        id: 'dup-2',
        sessionId,
        generationId,
        requestOrder: 1,
        rawEffort: 'low',
        normalizedEffort: 'low',
        createdAt: 1,
        updatedAt: 1,
      }),
    ).rejects.toThrow();
  });
});
