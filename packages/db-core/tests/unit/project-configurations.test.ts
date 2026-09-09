import { beforeAll, describe, expect, it } from 'vitest';
import {
  FRESH_SCHEMA_SQL,
  MIGRATIONS,
  MigrationRunner,
  PortfolioStore,
  PROJECT_CONFIGURATION_SPECS,
  ProjectConfigurationStore,
  ProjectStore,
  parseConfigurationValue,
  type SqliteExecutor,
  TenantStore,
} from '../../src/index.js';
import { getSqlite3, WasmSqliteExecutor } from '../helpers/sqlite-wasm-adapter.js';

beforeAll(async () => {
  await getSqlite3();
});

async function createExecutor(): Promise<WasmSqliteExecutor> {
  return WasmSqliteExecutor.create();
}

async function tableAndIndexNames(executor: SqliteExecutor): Promise<string[]> {
  const { rows } = await executor.exec(
    "SELECT name FROM sqlite_master WHERE type IN ('table', 'index') AND (name = 'project_configurations' OR name LIKE 'idx_project_configurations%') ORDER BY name",
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

describe('project_configurations migration v82', () => {
  it('creates the table and indexes when migrating from v81', async () => {
    const executor = await createExecutor();
    const before = MIGRATIONS.filter((m) => m.id < 82);
    await new MigrationRunner(executor, before).migrate();
    expect(await tableAndIndexNames(executor)).toEqual([]);

    await new MigrationRunner(executor, MIGRATIONS).migrate();
    const names = await tableAndIndexNames(executor);
    expect(names).toContain('project_configurations');
    expect(names).toContain('idx_project_configurations_key');
    expect(names).toContain('idx_project_configurations_project');
  });

  it('produces identical schema in fresh schema and migrated schema', async () => {
    const migratedExecutor = await createExecutor();
    await new MigrationRunner(migratedExecutor, MIGRATIONS).migrate();

    const freshExecutor = await createExecutor();
    await freshExecutor.exec(FRESH_SCHEMA_SQL);

    const migratedNames = await tableAndIndexNames(migratedExecutor);
    const freshNames = await tableAndIndexNames(freshExecutor);
    expect(freshNames).toEqual(migratedNames);

    const { rows: migratedCols } = await migratedExecutor.exec(
      'PRAGMA table_info(project_configurations)',
    );
    const { rows: freshCols } = await freshExecutor.exec(
      'PRAGMA table_info(project_configurations)',
    );
    expect(freshCols).toEqual(migratedCols);
  });

  it('is idempotent on re-run', async () => {
    const executor = await createExecutor();
    await new MigrationRunner(executor, MIGRATIONS).migrate();
    await new MigrationRunner(executor, MIGRATIONS).migrate();

    const { rows } = await executor.exec(
      "SELECT COUNT(*) as n FROM schema_migrations WHERE name = 'create-project-configurations'",
    );
    expect(Number(rows[0].n)).toBe(1);
  });
});

describe('project_configurations query plans', () => {
  it('getByKey uses idx_project_configurations_key index', async () => {
    const executor = await createExecutor();
    await executor.exec(FRESH_SCHEMA_SQL);

    const details = await getPlanDetails(
      executor,
      'SELECT id, project_id, key, value, created_at, updated_at FROM project_configurations WHERE project_id = ? AND key = ?',
      ['proj-1', 'utilization_min_session_sample_size'],
    );
    expect(hasScanForTable(details, 'project_configurations')).toBe(false);
    expect(
      hasSearchUsingIndex(details, 'project_configurations', 'idx_project_configurations_key'),
    ).toBe(true);
  });

  it('listByProject uses index without full table scan', async () => {
    const executor = await createExecutor();
    await executor.exec(FRESH_SCHEMA_SQL);

    const details = await getPlanDetails(
      executor,
      'SELECT id, project_id, key, value, created_at, updated_at FROM project_configurations WHERE project_id = ? ORDER BY key',
      ['proj-1'],
    );
    expect(hasScanForTable(details, 'project_configurations')).toBe(false);
  });
});

describe('ProjectConfigurationStore', () => {
  async function seedProject(executor: WasmSqliteExecutor, projectId: string) {
    await TenantStore.insert(executor, {
      id: 'tenant-1',
      name: 'Tenant 1',
      createdAt: 1,
      updatedAt: 1,
    });
    await PortfolioStore.insert(executor, {
      id: 'portfolio-1',
      tenantId: 'tenant-1',
      name: 'Portfolio 1',
      createdAt: 1,
      updatedAt: 1,
    });
    await ProjectStore.insert(executor, {
      id: projectId,
      portfolioId: 'portfolio-1',
      name: 'Project 1',
      createdAt: 1,
      updatedAt: 1,
    });
  }

  it('auto-seeds default configurations on ProjectStore.insert', async () => {
    const executor = await createExecutor();
    await executor.exec(FRESH_SCHEMA_SQL);
    await seedProject(executor, 'proj-auto');

    const configs = await ProjectConfigurationStore.listByProject(executor, 'proj-auto');
    expect(configs.length).toBe(Object.keys(PROJECT_CONFIGURATION_SPECS).length);

    const minSample = await ProjectConfigurationStore.getByKey(
      executor,
      'proj-auto',
      'utilization_min_session_sample_size',
    );
    expect(minSample?.value).toBe('5');
  });

  it('supports insert, getByKey, upsert, and delete', async () => {
    const executor = await createExecutor();
    await executor.exec(FRESH_SCHEMA_SQL);
    await seedProject(executor, 'proj-crud');

    // custom key
    await ProjectConfigurationStore.insert(executor, {
      projectId: 'proj-crud',
      key: 'custom_flag',
      value: 'true',
    });

    const config = await ProjectConfigurationStore.getByKey(executor, 'proj-crud', 'custom_flag');
    expect(config?.value).toBe('true');

    // upsert
    await ProjectConfigurationStore.upsert(executor, {
      projectId: 'proj-crud',
      key: 'custom_flag',
      value: 'false',
    });
    const updated = await ProjectConfigurationStore.getByKey(executor, 'proj-crud', 'custom_flag');
    expect(updated?.value).toBe('false');

    // delete
    await ProjectConfigurationStore.delete(executor, 'proj-crud', 'custom_flag');
    expect(
      await ProjectConfigurationStore.getByKey(executor, 'proj-crud', 'custom_flag'),
    ).toBeUndefined();
  });

  it('cascades delete when project is deleted', async () => {
    const executor = await createExecutor();
    await executor.exec(FRESH_SCHEMA_SQL);
    await seedProject(executor, 'proj-cascade');

    const before = await ProjectConfigurationStore.listByProject(executor, 'proj-cascade');
    expect(before.length).toBeGreaterThan(0);

    await ProjectStore.delete(executor, 'portfolio-1', 'proj-cascade');
    const after = await ProjectConfigurationStore.listByProject(executor, 'proj-cascade');
    expect(after).toHaveLength(0);
  });

  it('parseConfigurationValue parses types properly', () => {
    expect(parseConfigurationValue('42', 'number')).toBe(42);
    expect(parseConfigurationValue('true', 'boolean')).toBe(true);
    expect(parseConfigurationValue('false', 'boolean')).toBe(false);
    expect(parseConfigurationValue('{"a":1}', 'json')).toEqual({ a: 1 });
    expect(parseConfigurationValue('hello', 'string')).toBe('hello');
  });
});
