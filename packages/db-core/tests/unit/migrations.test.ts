import { beforeAll, describe, expect, it } from 'vitest';

import { MIGRATIONS, type Migration, MigrationRunner } from '../../src/index.js';
import { getSqlite3, WasmSqliteExecutor } from '../helpers/sqlite-wasm-adapter.js';

beforeAll(async () => {
  await getSqlite3();
});

async function createExecutor(): Promise<WasmSqliteExecutor> {
  return WasmSqliteExecutor.create();
}

describe('MigrationRunner', () => {
  it('creates schema control tables on initialize', async () => {
    const executor = await createExecutor();
    const runner = new MigrationRunner(executor, MIGRATIONS);
    await runner.initialize();

    const { rows } = await executor.exec(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    );
    const names = rows.map((row) => row.name);

    expect(names).toContain('schema_metadata');
    expect(names).toContain('schema_migrations');
  });

  it('applies all migrations sequentially and records them', async () => {
    const executor = await createExecutor();
    const runner = new MigrationRunner(executor, MIGRATIONS);
    await runner.migrate();

    const { rows } = await executor.exec(
      'SELECT id, name, checksum FROM schema_migrations ORDER BY id',
    );
    expect(rows).toHaveLength(MIGRATIONS.length);

    const sortedMigrations = [...MIGRATIONS].sort((a, b) => a.id - b.id);
    for (let i = 0; i < sortedMigrations.length; i++) {
      const migration = sortedMigrations[i];
      expect(Number(rows[i].id)).toBe(migration.id);
      expect(rows[i].name).toBe(migration.name);
      expect(rows[i].checksum).toBe(migration.checksum);
    }

    const { rows: meta } = await executor.exec(
      'SELECT schema_version FROM schema_metadata WHERE schema_name = ?',
      ['sal-analytics'],
    );
    expect(Number(meta[0].schema_version)).toBe(sortedMigrations[sortedMigrations.length - 1].id);
  });

  it('is idempotent on re-run after all migrations are applied', async () => {
    const executor = await createExecutor();
    const runner = new MigrationRunner(executor, MIGRATIONS);
    await runner.migrate();
    await runner.migrate();

    const { rows } = await executor.exec('SELECT COUNT(*) as n FROM schema_migrations');
    expect(Number(rows[0].n)).toBe(MIGRATIONS.length);
  });

  it('detects a checksum mismatch for an already-applied migration', async () => {
    const executor = await createExecutor();
    const runner = new MigrationRunner(executor, MIGRATIONS);
    await runner.migrate();

    const tampered: Migration = {
      ...MIGRATIONS[0],
      sql: `${MIGRATIONS[0].sql} -- altered`,
      checksum: 'deadbeef',
    };
    const tamperedRunner = new MigrationRunner(executor, [tampered, ...MIGRATIONS.slice(1)]);
    await expect(tamperedRunner.migrate()).rejects.toThrow(/checksum mismatch/);
  });

  it('rolls back a failed migration and leaves the schema at the previous version', async () => {
    const executor = await createExecutor();
    const badMigration: Migration = {
      id: MIGRATIONS.length + 1,
      name: 'bad-migration',
      sql: 'CREATE TABLE bad_table (a INTEGER PRIMARY KEY); NOT VALID SQL;',
      checksum: 'deadbeef',
    };

    const runner = new MigrationRunner(executor, [...MIGRATIONS, badMigration]);
    await expect(runner.migrate()).rejects.toThrow();

    const { rows: meta } = await executor.exec(
      'SELECT schema_version FROM schema_metadata WHERE schema_name = ?',
      ['sal-analytics'],
    );
    expect(Number(meta[0].schema_version)).toBe(MIGRATIONS.length);

    const { rows } = await executor.exec('SELECT id FROM schema_migrations WHERE id = ?', [
      badMigration.id,
    ]);
    expect(rows).toHaveLength(0);

    const { rows: tables } = await executor.exec(
      "SELECT name FROM sqlite_master WHERE type='table' AND name = 'bad_table'",
    );
    expect(tables).toHaveLength(0);
  });

  it('throws when a migration with id <= current is missing from history', async () => {
    const executor = await createExecutor();
    const runner = new MigrationRunner(executor, MIGRATIONS);
    await runner.migrate();

    // Delete migration 2 from history and advance the schema version to 3.
    await executor.exec('DELETE FROM schema_migrations WHERE id = ?', [2]);
    await executor.exec('UPDATE schema_metadata SET schema_version = ? WHERE schema_name = ?', [
      3,
      'sal-analytics',
    ]);

    const nextRunner = new MigrationRunner(executor, MIGRATIONS);
    await expect(nextRunner.migrate()).rejects.toThrow(/missing/);
  });

  it('returns applied migration records by id', async () => {
    const executor = await createExecutor();
    const runner = new MigrationRunner(executor, MIGRATIONS);
    await runner.migrate();

    const first = await runner.getAppliedMigration(MIGRATIONS[0].id);
    expect(first).toBeDefined();
    expect(first?.name).toBe(MIGRATIONS[0].name);
    expect(first?.checksum).toBe(MIGRATIONS[0].checksum);
    expect(first?.sql).toBe(MIGRATIONS[0].sql);

    const missing = await runner.getAppliedMigration(999);
    expect(missing).toBeUndefined();
  });

  it('exports MIGRATIONS in strict ascending id order', () => {
    for (let i = 1; i < MIGRATIONS.length; i++) {
      expect(MIGRATIONS[i].id).toBeGreaterThan(MIGRATIONS[i - 1].id);
    }
  });
});
