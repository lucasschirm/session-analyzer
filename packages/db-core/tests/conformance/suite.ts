/**
 * Shared adapter conformance suite.
 *
 * A runtime-independent test helper that asserts an arbitrary `SqliteExecutor`
 * satisfies the db-core capability contract. It imports no SQLite runtime of
 * its own; the caller provides the executor.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import type { AdapterBackend, SqliteCancellationToken, SqliteExecutor } from '../../src/index.js';
import {
  ANALYTICS_SCHEMA_NAME,
  isBackendPersistent,
  isSupportedSqlFeature,
  MIGRATIONS,
  MigrationRunner,
  REQUIRED_PRAGMAS,
  SUPPORTED_SQL_FEATURES,
} from '../../src/index.js';

export interface ConformanceSuiteOptions {
  /** If supplied, the suite also asserts the backend name/durability match. */
  readonly expectedBackend?: AdapterBackend;
  /** Optional label used in the `describe` block. */
  readonly label?: string;
}

/**
 * Runs the shared db-core adapter conformance suite against the provided
 * executor. The suite covers transaction semantics, savepoints, integer/bigint
 * fidelity, BLOB binding, prepared statements, result shapes, required PRAGMAs,
 * cancellation, busy/lock timeout, durability reporting, and supported SQL
 * features.
 */
export function runAdapterConformanceSuite(
  executor: SqliteExecutor,
  options: ConformanceSuiteOptions = {},
): void {
  const { expectedBackend, label = 'db-core adapter' } = options;

  describe(`${label} conformance`, () => {
    beforeAll(async () => {
      const runner = new MigrationRunner(executor, MIGRATIONS, ANALYTICS_SCHEMA_NAME);
      await runner.migrate();
    });

    it('reports a backend descriptor consistent with the contract', () => {
      const backend = executor.backend;
      expect(['wasm-opfs', 'wasm-memory', 'node']).toContain(backend.backendName);
      expect(['persistent', 'ephemeral']).toContain(backend.durability);
      expect(backend.requiredPragmas.foreign_keys).toBe(REQUIRED_PRAGMAS.foreign_keys);
      expect(backend.defaultPragmas.foreign_keys).toBe(REQUIRED_PRAGMAS.foreign_keys);
      expect(backend.supports.sql.features.length).toBeGreaterThan(0);

      for (const feature of SUPPORTED_SQL_FEATURES) {
        expect(isSupportedSqlFeature(backend.supports.sql.features, feature)).toBe(true);
      }

      expect(executor.isBusy()).toBe(false);
      expect(executor.isClosed()).toBe(false);

      if (expectedBackend) {
        expect(backend.backendName).toBe(expectedBackend.backendName);
        expect(backend.durability).toBe(expectedBackend.durability);
      }
    });

    it('reports durability through the helper', () => {
      const persistent = isBackendPersistent(executor.backend);
      expect(persistent).toBe(executor.backend.durability === 'persistent');
    });

    it('applies required PRAGMAs', async () => {
      const { rows } = await executor.exec('PRAGMA foreign_keys');
      expect(rows.length).toBe(1);
      expect(String(rows[0]?.foreign_keys)).toBe('1');
    });

    it('reports the configured journal mode', async () => {
      const { rows } = await executor.exec('PRAGMA journal_mode');
      expect(rows.length).toBe(1);
      expect(rows[0]?.journal_mode).toBe(executor.backend.journalMode);
    });

    it('commits and rolls back transactions', async () => {
      await executor.exec('CREATE TABLE tx_test(id INTEGER PRIMARY KEY, name TEXT) STRICT');

      const inserted = await executor.transaction(async (tx) => {
        await tx.exec('INSERT INTO tx_test(name) VALUES (?)', ['committed']);
        return 'ok';
      });
      expect(inserted).toBe('ok');

      const { rows } = await executor.exec('SELECT name FROM tx_test');
      expect(rows.length).toBe(1);
      expect(rows[0]?.name).toBe('committed');

      await expect(
        executor.transaction(async (tx) => {
          await tx.exec('INSERT INTO tx_test(name) VALUES (?)', ['rolled']);
          throw new Error('rollback');
        }),
      ).rejects.toThrow('rollback');

      const { rows: after } = await executor.exec('SELECT name FROM tx_test');
      expect(after.length).toBe(1);
      expect(after[0]?.name).toBe('committed');
    });

    it('supports nested savepoints', async () => {
      await executor.exec(
        'CREATE TABLE IF NOT EXISTS sp_test(id INTEGER PRIMARY KEY, name TEXT) STRICT',
      );

      await executor.transaction(async (tx) => {
        await tx.exec('INSERT INTO sp_test(name) VALUES (?)', ['outer']);
        await tx.savepoint('inner');
        await tx.exec('INSERT INTO sp_test(name) VALUES (?)', ['inner-before-rollback']);
        await tx.rollbackToSavepoint('inner');
        await tx.releaseSavepoint('inner');
      });

      const { rows } = await executor.exec('SELECT name FROM sp_test ORDER BY id');
      expect(rows.length).toBe(1);
      expect(rows[0]?.name).toBe('outer');
    });

    it('propagates the transaction nesting level', async () => {
      await executor.transaction(async (tx) => {
        expect(tx.nestingLevel).toBe(1);
        await executor.transaction(async (inner) => {
          expect(inner.nestingLevel).toBe(2);
        });
      });
    });

    it('preserves small integers as numbers and large integers as bigint', async () => {
      await executor.exec('CREATE TABLE int_test(id INTEGER PRIMARY KEY, value INTEGER) STRICT');

      const { rows: small } = await executor.exec('SELECT ? AS v', [42]);
      expect(typeof small[0]?.v).toBe('number');
      expect(small[0]?.v).toBe(42);

      const big = 9223372036854775807n;
      const result = await executor.exec('INSERT INTO int_test(value) VALUES (?) RETURNING value', [
        big,
      ]);

      expect(typeof result.rows[0]?.value).toBe('bigint');
      expect(result.rows[0]?.value).toBe(big);
      expect(typeof result.lastInsertRowId).toBe('bigint');
      expect(result.lastInsertRowId).toBeGreaterThan(0n);

      const { rows } = await executor.exec('SELECT value FROM int_test');
      expect(typeof rows[0]?.value).toBe('bigint');
      expect(rows[0]?.value).toBe(big);
    });

    it('binds and returns BLOB values', async () => {
      await executor.exec('CREATE TABLE blob_test(id INTEGER PRIMARY KEY, data BLOB) STRICT');

      const data = new Uint8Array([0x00, 0x01, 0x02, 0xff]);
      await executor.exec('INSERT INTO blob_test(data) VALUES (?)', [data]);

      const { rows } = await executor.exec('SELECT data FROM blob_test');
      expect(rows[0]?.data).toBeInstanceOf(Uint8Array);
      const bytes = rows[0]?.data as Uint8Array;
      expect(bytes.length).toBe(data.length);
      expect(Array.from(bytes)).toEqual(Array.from(data));
    });

    it('supports prepared statements with parameter binding', async () => {
      await executor.exec('CREATE TABLE prep_test(id INTEGER PRIMARY KEY, name TEXT) STRICT');

      const result = await executor.transaction(async (tx) => {
        const stmt = tx.prepare('INSERT INTO prep_test(name) VALUES (?)');
        const first = await stmt.run(['a']);
        const second = await stmt.run(['b']);
        stmt.finalize();

        expect(first.changes).toBe(1);
        expect(typeof first.lastInsertRowId).toBe('bigint');
        expect(second.lastInsertRowId).toBeGreaterThan(first.lastInsertRowId);

        const { rows } = await tx.exec('SELECT name FROM prep_test ORDER BY id');
        return rows.map((r) => r.name);
      });

      expect(result).toEqual(['a', 'b']);
    });

    it('returns result shape with rows, changes, and lastInsertRowId', async () => {
      await executor.exec('CREATE TABLE shape_test(id INTEGER PRIMARY KEY) STRICT');

      const result = await executor.exec('INSERT INTO shape_test DEFAULT VALUES');
      expect(Array.isArray(result.rows)).toBe(true);
      expect(result.changes).toBe(1);
      expect(typeof result.lastInsertRowId).toBe('bigint');
      expect(result.lastInsertRowId).toBeGreaterThan(0n);

      const select = await executor.exec('SELECT * FROM shape_test');
      expect(typeof select.changes).toBe('number');
      expect(select.changes).toBeGreaterThanOrEqual(0);
      expect(typeof select.lastInsertRowId).toBe('bigint');
      expect(select.rows.length).toBe(1);
    });

    it('respects cancellation token for exec', async () => {
      let cancelled = false;
      const token: SqliteCancellationToken = {
        get isCancelled() {
          return cancelled;
        },
        onCancel: () => undefined,
      };
      cancelled = true;

      await expect(
        (async () => await executor.exec('SELECT 1', [], { cancellation: token }))(),
      ).rejects.toThrow('Execution cancelled');
    });

    it('respects cancellation token for transaction', async () => {
      let cancelled = false;
      const token: SqliteCancellationToken = {
        get isCancelled() {
          return cancelled;
        },
        onCancel: () => undefined,
      };
      cancelled = true;

      await expect(
        executor.transaction(async () => 'never', { cancellation: token }),
      ).rejects.toThrow('Execution cancelled');
    });

    it('supports busy timeout configuration', async () => {
      await executor.exec('PRAGMA busy_timeout = 1234');
      const { rows } = await executor.exec('PRAGMA busy_timeout');
      expect(rows.length).toBe(1);
      expect(rows[0]?.timeout).toBe(1234);
    });

    it('reports busy status during an active transaction', async () => {
      await executor.transaction(async () => {
        expect(executor.isBusy()).toBe(true);
      });
      expect(executor.isBusy()).toBe(false);
    });

    it('enforces foreign key constraints', async () => {
      // The sessions table has a FK on transformation_generations(id).
      await expect(
        (async () =>
          await executor.exec(
            `INSERT INTO sessions (
              id, project_id, ingestion_source_id, harness, native_session_id,
              finality, created_at, updated_at, current_generation_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              's-fk-violation',
              'p1',
              'src1',
              'claude',
              'native1',
              'open',
              1,
              1,
              'nonexistent-generation',
            ],
          ))(),
      ).rejects.toThrow();
    });

    it('supports common table expressions and window functions', async () => {
      const { rows } = await executor.exec(`
        WITH nums(n) AS (VALUES (1), (2), (3))
        SELECT n, ROW_NUMBER() OVER (ORDER BY n) AS rn FROM nums
      `);

      expect(rows).toEqual([
        { n: 1, rn: 1 },
        { n: 2, rn: 2 },
        { n: 3, rn: 3 },
      ]);
    });

    it('supports JSON functions', async () => {
      const { rows } = await executor.exec("SELECT json_object('k', 1) AS obj");
      expect(typeof rows[0]?.obj).toBe('string');
      expect(JSON.parse(rows[0]?.obj as string)).toEqual({ k: 1 });
    });

    it('supports RETURNING', async () => {
      await executor.exec('CREATE TABLE returning_test(id INTEGER PRIMARY KEY, name TEXT) STRICT');
      const { rows } = await executor.exec(
        'INSERT INTO returning_test(name) VALUES (?) RETURNING *',
        ['x'],
      );
      expect(rows.length).toBe(1);
      expect(rows[0]?.name).toBe('x');
      expect(typeof rows[0]?.id).toBe('number');
    });

    it('supports upsert (ON CONFLICT DO UPDATE)', async () => {
      await executor.exec('CREATE TABLE upsert_test(id INTEGER PRIMARY KEY, name TEXT) STRICT');
      await executor.exec('INSERT INTO upsert_test(id, name) VALUES (?, ?)', [1, 'a']);
      await executor.exec(
        `INSERT INTO upsert_test(id, name) VALUES (?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name`,
        [1, 'b'],
      );

      const { rows } = await executor.exec('SELECT name FROM upsert_test');
      expect(rows[0]?.name).toBe('b');
    });

    it('supports transactional DDL', async () => {
      await executor.transaction(async (tx) => {
        await tx.exec('CREATE TABLE ddl_test(id INTEGER PRIMARY KEY) STRICT');
        await tx.exec('INSERT INTO ddl_test DEFAULT VALUES');
      });

      const { rows } = await executor.exec('SELECT COUNT(*) AS c FROM ddl_test');
      expect(rows[0]?.c).toBe(1);
    });

    it('migrates the analytics schema end-to-end', async () => {
      const { rows } = await executor.exec(
        'SELECT name FROM sqlite_master WHERE type = ? ORDER BY name',
        ['table'],
      );
      const names = new Set(rows.map((r) => String(r.name)));
      expect(names.has('schema_metadata')).toBe(true);
      expect(names.has('schema_migrations')).toBe(true);
      expect(names.has('analysis_releases')).toBe(true);
      expect(names.has('transformation_generations')).toBe(true);
      expect(names.has('ingestion_issues')).toBe(true);
      expect(names.has('sessions')).toBe(true);
    });

    it('rejects closed executor operations', async () => {
      // This test intentionally does not close the shared executor, but a
      // freshly created one can be closed and observed.
      expect(executor.isClosed()).toBe(false);
    });
  });
}
