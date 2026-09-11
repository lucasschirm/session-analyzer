// @vitest-environment node
/**
 * Unit tests for `WasmSqliteExecutor`'s vacuum/size/export-optimized surface
 * added for the Storage settings serialize-free download fix (see
 * `wild-popping-sundae` Phase 1a/1b/1c).
 *
 * These tests run the *real* `@sqlite.org/sqlite-wasm` module (same pattern
 * as `wasm-adapter.conformance.test.ts`) — nothing about SQLite execution is
 * mocked. In Node, `sqlite3.oo1.OpfsDb` does not exist at all (OPFS requires
 * a browser main/worker thread with `FileSystemSyncAccessHandle`), so
 * `WasmSqliteExecutor.create()` can only ever produce a `wasm-memory`
 * backend here — see `wasm-adapter.conformance.test.ts`'s own comment to the
 * same effect. That means the OPFS branch of `exportDatabaseOptimized()`
 * cannot be exercised end-to-end (real OPFS read/write) from this suite.
 *
 * To still cover that branch's routing/cleanup logic with real SQLite
 * execution, `createOpfsFlaggedExecutor()` below constructs an executor via
 * the public constructor with `backendName` forced to `'wasm-opfs'` against
 * a real (in-memory) `Database` handle. The `VACUUM INTO '...?vfs=opfs'` SQL
 * this issues is still executed for real by the wasm module — it fails with
 * a genuine `SQLITE_ERROR: no such vfs: opfs`, which is expected and asserted
 * on, since Node has no such VFS registered. Only the two OPFS *file I/O*
 * helpers (`readOpfsFileBytes`/`removeOpfsFileIfExists`, a separate already
 * -tested module) are mocked, so these tests can also assert the success
 * path's read-then-cleanup sequencing without a real OPFS directory.
 *
 * The actual `vfs=opfs` URI mechanic itself — the thing the implementation
 * plan flagged as unverified anywhere in this codebase — was separately
 * confirmed with a real, non-mocked manual repro: a dedicated Worker running
 * inside a cross-origin-isolated Chromium page (via Playwright, matching
 * this repo's `vite preview`/E2E COOP+COEP setup) opened a real
 * `new sqlite3.oo1.OpfsDb(name, 'c')` connection, inserted a row, ran
 * `VACUUM INTO 'file:<name>.vacuum-tmp?vfs=opfs'`, and re-opened the
 * resulting OPFS file as a second `OpfsDb` connection — the row round-tripped
 * and the file's header was a valid `SQLite format 3`. That confirms the
 * mechanic `exportDatabaseOptimized()` relies on is sound; a permanent
 * browser-level regression test for it belongs in the Playwright E2E suite
 * (out of scope for this file — this repo's unit suite runs under
 * Node/happy-dom, neither of which implement OPFS).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as opfsFileIo from '../../src/db/opfs-file-io';
import { getSqlite3Module, WasmSqliteExecutor } from '../../src/db/wasm-sqlite-executor';

vi.mock('../../src/db/opfs-file-io', () => ({
  readOpfsFileBytes: vi.fn(),
  removeOpfsFileIfExists: vi.fn(),
}));

const SQLITE_HEADER = 'SQLite format 3';

function sqliteHeader(bytes: Uint8Array): string {
  return String.fromCharCode(...bytes.slice(0, 15));
}

/**
 * Builds an executor that *reports* a `wasm-opfs` backend without actually
 * using OPFS — see the file header comment for why and what this does and
 * does not verify.
 */
async function createOpfsFlaggedExecutor(filename: string): Promise<WasmSqliteExecutor> {
  const sqlite3 = await getSqlite3Module();
  const db = new sqlite3.oo1.DB(':memory:', 'c');
  return new WasmSqliteExecutor(db, sqlite3, 'wasm-opfs', undefined, filename);
}

describe('WasmSqliteExecutor.vacuum', () => {
  it('reclaims space after deletes without losing remaining data', async () => {
    const executor = await WasmSqliteExecutor.create({ preferOpfs: false });
    try {
      executor.exec('CREATE TABLE t (v TEXT)');
      for (let i = 0; i < 500; i++) {
        executor.exec('INSERT INTO t (v) VALUES (?)', [`row-${i}`.padEnd(200, 'x')]);
      }
      executor.exec('DELETE FROM t WHERE rowid > 1');

      expect(() => executor.vacuum()).not.toThrow();

      const { rows } = executor.exec('SELECT v FROM t');
      expect(rows).toHaveLength(1);
      expect(rows[0].v).toBe('row-0'.padEnd(200, 'x'));
    } finally {
      await executor.close();
    }
  });

  it('throws when called on a closed executor', async () => {
    const executor = await WasmSqliteExecutor.create({ preferOpfs: false });
    await executor.close();
    expect(() => executor.vacuum()).toThrow('Executor is closed');
  });
});

describe('WasmSqliteExecutor.getSizeBytes', () => {
  it('returns page_count * page_size, matching direct PRAGMA reads', async () => {
    const executor = await WasmSqliteExecutor.create({ preferOpfs: false });
    try {
      executor.exec('CREATE TABLE t (v TEXT)');
      executor.exec('INSERT INTO t (v) VALUES (?)', ['x'.repeat(2000)]);

      const pageCount = Number(executor.exec('PRAGMA page_count').rows[0].page_count);
      const pageSize = Number(executor.exec('PRAGMA page_size').rows[0].page_size);

      expect(executor.getSizeBytes()).toBe(pageCount * pageSize);
      expect(executor.getSizeBytes()).toBeGreaterThan(0);
    } finally {
      await executor.close();
    }
  });

  it('throws when called on a closed executor', async () => {
    const executor = await WasmSqliteExecutor.create({ preferOpfs: false });
    await executor.close();
    expect(() => executor.getSizeBytes()).toThrow('Executor is closed');
  });
});

describe('WasmSqliteExecutor.exportDatabaseOptimized — memory backend', () => {
  it('falls back to exportDatabase() and returns a valid, non-empty SQLite file', async () => {
    const executor = await WasmSqliteExecutor.create({ preferOpfs: false });
    try {
      executor.exec('CREATE TABLE t (v TEXT)');
      executor.exec('INSERT INTO t (v) VALUES (?)', ['hello']);

      expect(executor.backend.backendName).toBe('wasm-memory');
      const optimized = await executor.exportDatabaseOptimized();
      const direct = executor.exportDatabase();

      expect(optimized).toBeInstanceOf(Uint8Array);
      expect(optimized.length).toBeGreaterThan(0);
      expect(sqliteHeader(optimized)).toBe(SQLITE_HEADER);
      expect(optimized).toEqual(direct);
    } finally {
      await executor.close();
    }
  });

  it('never calls the OPFS temp-file helpers on the memory backend', async () => {
    const executor = await WasmSqliteExecutor.create({ preferOpfs: false });
    try {
      await executor.exportDatabaseOptimized();
      expect(opfsFileIo.readOpfsFileBytes).not.toHaveBeenCalled();
      expect(opfsFileIo.removeOpfsFileIfExists).not.toHaveBeenCalled();
    } finally {
      await executor.close();
    }
  });

  it('throws when called on a closed executor', async () => {
    const executor = await WasmSqliteExecutor.create({ preferOpfs: false });
    await executor.close();
    await expect(executor.exportDatabaseOptimized()).rejects.toThrow('Executor is closed');
  });
});

interface RawDbHandle {
  exec(sql: string): unknown;
}

/** Reaches past the private `db` field to spy on the raw sqlite3 handle. */
function rawDbHandle(executor: WasmSqliteExecutor): RawDbHandle {
  return (executor as unknown as { db: RawDbHandle }).db;
}

describe('WasmSqliteExecutor.exportDatabaseOptimized — OPFS-flagged backend', () => {
  beforeEach(() => {
    vi.mocked(opfsFileIo.readOpfsFileBytes).mockReset();
    vi.mocked(opfsFileIo.removeOpfsFileIfExists).mockReset().mockResolvedValue(undefined);
  });

  it('issues VACUUM INTO with the fixed vacuum-tmp filename and the vfs=opfs URI param', async () => {
    const filename = '/fake-analytics.sqlite3';
    const executor = await createOpfsFlaggedExecutor(filename);
    // Spies without replacing the implementation, so this is still the real
    // sqlite3-wasm call — Node has no 'opfs' VFS registered, so it genuinely
    // fails with SQLITE_ERROR rather than being mocked away.
    const execSpy = vi.spyOn(rawDbHandle(executor), 'exec');

    await expect(executor.exportDatabaseOptimized()).rejects.toThrow(/no such vfs: opfs/i);

    expect(execSpy).toHaveBeenCalledWith(`VACUUM INTO 'file:${filename}.vacuum-tmp?vfs=opfs';`);
    // Cleanup must still run (try/finally) even though VACUUM INTO failed
    // before any temp file could have been created.
    expect(opfsFileIo.removeOpfsFileIfExists).toHaveBeenCalledWith(`${filename}.vacuum-tmp`);
    expect(opfsFileIo.readOpfsFileBytes).not.toHaveBeenCalled();

    await executor.close();
  });

  it('reads back and cleans up the temp file on a successful VACUUM INTO', async () => {
    const filename = '/fake-analytics.sqlite3';
    const executor = await createOpfsFlaggedExecutor(filename);
    const expectedBytes = new Uint8Array([1, 2, 3]);
    vi.mocked(opfsFileIo.readOpfsFileBytes).mockResolvedValue(expectedBytes);

    // Stub out the real VACUUM INTO call (which would otherwise throw in
    // Node, see the sibling test) so the success path can be exercised.
    const execSpy = vi.spyOn(rawDbHandle(executor), 'exec').mockReturnValue(undefined);

    const bytes = await executor.exportDatabaseOptimized();

    expect(execSpy).toHaveBeenCalledWith(`VACUUM INTO 'file:${filename}.vacuum-tmp?vfs=opfs';`);
    expect(opfsFileIo.readOpfsFileBytes).toHaveBeenCalledWith(`${filename}.vacuum-tmp`);
    expect(opfsFileIo.removeOpfsFileIfExists).toHaveBeenCalledWith(`${filename}.vacuum-tmp`);
    expect(bytes).toBe(expectedBytes);

    await executor.close();
  });

  it('removes the temp file even when reading it back fails', async () => {
    const filename = '/fake-analytics.sqlite3';
    const executor = await createOpfsFlaggedExecutor(filename);
    vi.mocked(opfsFileIo.readOpfsFileBytes).mockRejectedValue(new Error('temp file missing'));
    vi.spyOn(rawDbHandle(executor), 'exec').mockReturnValue(undefined);

    await expect(executor.exportDatabaseOptimized()).rejects.toThrow('temp file missing');
    expect(opfsFileIo.removeOpfsFileIfExists).toHaveBeenCalledWith(`${filename}.vacuum-tmp`);

    await executor.close();
  });
});
