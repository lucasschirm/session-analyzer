import { beforeAll, describe, expect, it } from 'vitest';
import {
  ComponentIdentityStore,
  EnvironmentStore,
  FRESH_SCHEMA_SQL,
  IngestionSourceStore,
  MIGRATIONS,
  MigrationRunner,
  PortfolioStore,
  ProjectStore,
  SessionComponentExposureStore,
  SourceProjectStore,
  TenantStore,
  WorkspaceStore,
} from '../../src/index.js';
import { getSqlite3, WasmSqliteExecutor } from '../helpers/sqlite-wasm-adapter.js';

beforeAll(async () => {
  await getSqlite3();
});

const PREFIX = 'sceg';

async function createExecutor(): Promise<WasmSqliteExecutor> {
  return WasmSqliteExecutor.create();
}

async function seedTenantAndPortfolio(executor: WasmSqliteExecutor): Promise<{
  tenantId: string;
  portfolioId: string;
}> {
  const tenantId = `${PREFIX}-tenant`;
  const portfolioId = `${PREFIX}-portfolio`;
  await TenantStore.insert(executor, {
    id: tenantId,
    name: 'SCEG Tenant',
    createdAt: 1,
    updatedAt: 1,
  });
  await PortfolioStore.insert(executor, {
    id: portfolioId,
    tenantId,
    name: 'SCEG',
    createdAt: 1,
    updatedAt: 1,
  });
  return { tenantId, portfolioId };
}

async function seedIngestionSource(
  executor: WasmSqliteExecutor,
  portfolioId: string,
): Promise<string> {
  const id = `${PREFIX}-ingestion`;
  await IngestionSourceStore.insert(executor, {
    id,
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
  return id;
}

async function seedEnvironment(
  executor: WasmSqliteExecutor,
  portfolioId: string,
  ingestionSourceId: string,
): Promise<string> {
  const id = `${PREFIX}-environment`;
  await EnvironmentStore.insert(executor, portfolioId, {
    id,
    ingestionSourceId,
    nativeEnvironmentId: 'env-1',
    createdAt: 1,
    updatedAt: 1,
  });
  return id;
}

async function seedProject(executor: WasmSqliteExecutor, portfolioId: string): Promise<string> {
  const id = `${PREFIX}-project`;
  await ProjectStore.insert(executor, {
    id,
    portfolioId,
    name: 'sceg-project',
    createdAt: 1,
    updatedAt: 1,
  });
  return id;
}

async function seedSourceProject(
  executor: WasmSqliteExecutor,
  portfolioId: string,
  projectId: string,
  ingestionSourceId: string,
): Promise<string> {
  const id = `${PREFIX}-source-project`;
  await SourceProjectStore.insert(executor, portfolioId, {
    id,
    projectId,
    ingestionSourceId,
    nativeProjectId: 'native-sceg',
    createdAt: 1,
    updatedAt: 1,
  });
  return id;
}

async function seedWorkspace(
  executor: WasmSqliteExecutor,
  portfolioId: string,
  projectId: string,
): Promise<string> {
  const id = `${PREFIX}-workspace`;
  await WorkspaceStore.insert(executor, portfolioId, {
    id,
    projectId,
    nativeWorkspaceId: 'ws-1',
    scopeChain: JSON.stringify(['/home/sceg']),
    path: '/home/sceg',
    createdAt: 1,
    updatedAt: 1,
  });
  return id;
}

async function seedIdentity(executor: WasmSqliteExecutor): Promise<{
  portfolioId: string;
  ingestionSourceId: string;
  environmentId: string;
  projectId: string;
  sourceProjectId: string;
  workspaceId: string;
}> {
  const { portfolioId } = await seedTenantAndPortfolio(executor);
  const ingestionSourceId = await seedIngestionSource(executor, portfolioId);
  const environmentId = await seedEnvironment(executor, portfolioId, ingestionSourceId);
  const projectId = await seedProject(executor, portfolioId);
  const sourceProjectId = await seedSourceProject(
    executor,
    portfolioId,
    projectId,
    ingestionSourceId,
  );
  const workspaceId = await seedWorkspace(executor, portfolioId, projectId);
  return { portfolioId, ingestionSourceId, environmentId, projectId, sourceProjectId, workspaceId };
}

async function seedSessionAndComponent(
  executor: WasmSqliteExecutor,
  identity: Awaited<ReturnType<typeof seedIdentity>>,
): Promise<{ sessionId: string; componentId: string; environmentId: string; portfolioId: string }> {
  const { portfolioId, ingestionSourceId, environmentId, projectId } = identity;
  const sessionId = `${PREFIX}-session`;

  await executor.exec(
    `INSERT INTO sessions (
      id, project_id, ingestion_source_id, environment_id, harness,
      native_session_id, finality, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [sessionId, projectId, ingestionSourceId, environmentId, 'claude', sessionId, 'open', 1, 1],
  );

  const componentId = await ComponentIdentityStore.insert(executor, {
    portfolioId,
    kind: 'tool',
    owner: 'anthropic',
    integration: 'claude_code',
    nativeId: 'tool-1',
    canonicalSourceIdentity: 'claude://tools/tool-1',
    displayName: 'Tool One',
    createdAt: 1,
    updatedAt: 1,
  });

  return { sessionId, componentId, environmentId, portfolioId };
}

async function insertAnalysisRelease(executor: WasmSqliteExecutor): Promise<string> {
  const id = `${PREFIX}-analysis-release`;
  await executor.exec(
    `INSERT INTO analysis_releases (
      id, ontology_version, metric_registry_version, statistical_policy_version,
      rollup_policy_version, mapping_version, created_at, is_default
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, '1', '1', '1', '1', '1', 1, 1],
  );
  return id;
}

async function insertGeneration(
  executor: WasmSqliteExecutor,
  sessionId: string,
  id: string,
): Promise<string> {
  const analysisReleaseId = `${PREFIX}-analysis-release`;
  await executor.exec(
    `INSERT INTO transformation_generations (
      id, session_id, analysis_release_id, parser_version, transformer_version,
      ontology_version, metric_version, schema_version, status, source_availability,
      created_at, committed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, sessionId, analysisReleaseId, '1', '1', '1', '1', '1', 'committed', 'local', 1, 1],
  );
  return id;
}

async function seedAnalysisReleaseAndGenerations(
  executor: WasmSqliteExecutor,
  sessionId: string,
): Promise<{ analysisReleaseId: string; generationAId: string; generationBId: string }> {
  const analysisReleaseId = await insertAnalysisRelease(executor);
  const generationAId = `${PREFIX}-generation-a`;
  const generationBId = `${PREFIX}-generation-b`;
  await insertGeneration(executor, sessionId, generationAId);
  await insertGeneration(executor, sessionId, generationBId);
  return { analysisReleaseId, generationAId, generationBId };
}

async function seedScenario(executor: WasmSqliteExecutor) {
  const identity = await seedIdentity(executor);
  const { sessionId, componentId, environmentId } = await seedSessionAndComponent(
    executor,
    identity,
  );
  const { generationAId, generationBId } = await seedAnalysisReleaseAndGenerations(
    executor,
    sessionId,
  );
  return { ...identity, sessionId, componentId, environmentId, generationAId, generationBId };
}

async function insertExposure(
  executor: WasmSqliteExecutor,
  input: {
    sessionId: string;
    componentId: string;
    environmentId: string;
    generationId: string;
    startSequence?: number;
    startTime?: number;
  },
): Promise<string> {
  return SessionComponentExposureStore.insert(executor, {
    sessionId: input.sessionId,
    componentId: input.componentId,
    environmentId: input.environmentId,
    status: 'loaded',
    startSequence: input.startSequence ?? 1,
    startTime: input.startTime ?? input.startSequence ?? 1,
    generationId: input.generationId,
    createdAt: 1,
    updatedAt: 1,
  });
}

async function assertIndependentExposures(
  executor: WasmSqliteExecutor,
  sessionId: string,
  exposureA: string,
  exposureB: string,
  generationAId: string,
  generationBId: string,
): Promise<void> {
  const byA = await SessionComponentExposureStore.getById(executor, sessionId, exposureA);
  const byB = await SessionComponentExposureStore.getById(executor, sessionId, exposureB);
  expect(byA?.generationId).toBe(generationAId);
  expect(byB?.generationId).toBe(generationBId);
  const all = await SessionComponentExposureStore.listBySession(executor, sessionId);
  expect(all).toHaveLength(2);
  expect(all.map((e) => e.id).sort()).toEqual([exposureA, exposureB].sort());
}

async function getUniqueIndexSql(executor: WasmSqliteExecutor): Promise<string | null> {
  const { rows } = await executor.exec(
    "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_session_component_exposures_unique'",
  );
  if (rows.length === 0) return null;
  return String(rows[0].sql);
}

function indexIncludesGeneration(sql: string | null): boolean {
  return sql?.toLowerCase().includes('coalesce(generation_id,') ?? false;
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

describe('session_component_exposures migration v80', () => {
  it('upgrades from the old unique index to one scoped by generation_id', async () => {
    const executor = await createExecutor();
    const before = MIGRATIONS.filter((m) => m.id < 80);
    await new MigrationRunner(executor, before).migrate();

    const { sessionId, componentId, environmentId, generationAId, generationBId } =
      await seedScenario(executor);
    expect(indexIncludesGeneration(await getUniqueIndexSql(executor))).toBe(false);

    const exposureA = await insertExposure(executor, {
      sessionId,
      componentId,
      environmentId,
      generationId: generationAId,
    });

    await new MigrationRunner(executor, MIGRATIONS).migrate();
    expect(indexIncludesGeneration(await getUniqueIndexSql(executor))).toBe(true);

    const exposureB = await insertExposure(executor, {
      sessionId,
      componentId,
      environmentId,
      generationId: generationBId,
      startTime: 2,
    });

    expect(exposureA).not.toBe(exposureB);
    await assertIndependentExposures(
      executor,
      sessionId,
      exposureA,
      exposureB,
      generationAId,
      generationBId,
    );
  });
});

describe('session_component_exposures fresh schema parity', () => {
  it('produces the same generation-scoped unique index as the migration path', async () => {
    const fresh = await createExecutor();
    await fresh.exec(FRESH_SCHEMA_SQL);

    const upgraded = await createExecutor();
    await new MigrationRunner(upgraded, MIGRATIONS).migrate();

    const freshSql = await getUniqueIndexSql(fresh);
    const upgradedSql = await getUniqueIndexSql(upgraded);
    expect(freshSql).toBe(upgradedSql);
    expect(indexIncludesGeneration(freshSql)).toBe(true);
  });
});

describe('session_component_exposures query plans', () => {
  async function seedExposures(
    executor: WasmSqliteExecutor,
    sessionId: string,
    componentId: string,
    environmentId: string,
    generationAId: string,
    generationBId: string,
  ): Promise<void> {
    for (let i = 0; i < 10; i++) {
      await insertExposure(executor, {
        sessionId,
        componentId,
        environmentId,
        generationId: i % 2 === 0 ? generationAId : generationBId,
        startSequence: i + 1,
        startTime: i + 1,
      });
    }
  }

  async function seededExecutor(): Promise<{
    executor: WasmSqliteExecutor;
    sessionId: string;
    componentId: string;
    generationAId: string;
    generationBId: string;
  }> {
    const executor = await createExecutor();
    await executor.exec(FRESH_SCHEMA_SQL);
    const scenario = await seedScenario(executor);
    await seedExposures(
      executor,
      scenario.sessionId,
      scenario.componentId,
      scenario.environmentId,
      scenario.generationAId,
      scenario.generationBId,
    );
    return {
      executor,
      sessionId: scenario.sessionId,
      componentId: scenario.componentId,
      generationAId: scenario.generationAId,
      generationBId: scenario.generationBId,
    };
  }

  it('findOpenExposure-style query uses an index on session_component_exposures', async () => {
    const { executor, sessionId, componentId, generationAId } = await seededExecutor();
    const details = await getPlanDetails(
      executor,
      `SELECT id FROM session_component_exposures
       WHERE session_id = ? AND component_id = ? AND end_time IS NULL
         AND COALESCE(generation_id, '') = ?
       ORDER BY start_time DESC LIMIT 1`,
      [sessionId, componentId, generationAId],
    );
    expect(hasScanForTable(details, 'session_component_exposures')).toBe(false);
    expect(hasSearchForTable(details, 'session_component_exposures')).toBe(true);
  });

  it('reconcileExposures-style query uses an index on session_component_exposures', async () => {
    const { executor, sessionId, generationAId } = await seededExecutor();
    const details = await getPlanDetails(
      executor,
      `SELECT id, component_id FROM session_component_exposures
       WHERE session_id = ? AND end_time IS NULL AND COALESCE(generation_id, '') = ?`,
      [sessionId, generationAId],
    );
    expect(hasScanForTable(details, 'session_component_exposures')).toBe(false);
    expect(hasSearchForTable(details, 'session_component_exposures')).toBe(true);
  });

  it('listBySession query uses an index on session_component_exposures', async () => {
    const { executor, sessionId } = await seededExecutor();
    const details = await getPlanDetails(
      executor,
      `SELECT id, session_id, component_id, environment_id, status, start_sequence, end_sequence,
              start_time, end_time, snapshot_id, generation_id, safe_metadata, created_at, updated_at
       FROM session_component_exposures
       WHERE session_id = ?
       ORDER BY start_sequence`,
      [sessionId],
    );
    expect(hasScanForTable(details, 'session_component_exposures')).toBe(false);
    expect(hasSearchForTable(details, 'session_component_exposures')).toBe(true);
  });

  it('listByComponent query uses an index on session_component_exposures', async () => {
    const { executor, componentId } = await seededExecutor();
    const details = await getPlanDetails(
      executor,
      `SELECT id, session_id, component_id, environment_id, status, start_sequence, end_sequence,
              start_time, end_time, snapshot_id, generation_id, safe_metadata, created_at, updated_at
       FROM session_component_exposures
       WHERE component_id = ?
       ORDER BY start_time`,
      [componentId],
    );
    expect(hasScanForTable(details, 'session_component_exposures')).toBe(false);
    expect(hasSearchForTable(details, 'session_component_exposures')).toBe(true);
  });
});

describe('session_component_exposures generation regression', () => {
  it('allows the same component to be exposed identically across two generations', async () => {
    const executor = await createExecutor();
    await executor.exec(FRESH_SCHEMA_SQL);

    const { sessionId, componentId, environmentId, generationAId, generationBId } =
      await seedScenario(executor);

    const exposureA = await insertExposure(executor, {
      sessionId,
      componentId,
      environmentId,
      generationId: generationAId,
    });
    const exposureB = await insertExposure(executor, {
      sessionId,
      componentId,
      environmentId,
      generationId: generationBId,
      startTime: 2,
    });

    expect(exposureA).not.toBe(exposureB);
    await assertIndependentExposures(
      executor,
      sessionId,
      exposureA,
      exposureB,
      generationAId,
      generationBId,
    );
  });
});
