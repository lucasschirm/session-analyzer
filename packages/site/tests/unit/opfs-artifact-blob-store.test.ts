/**
 * Unit tests for the OPFS-backed `ArtifactBlobStore`
 * (`opfs-artifact-blob-store.ts`).
 *
 * OPFS is unavailable in both Node and happy-dom (see
 * `wasm-sqlite-executor.test.ts`'s header for the same constraint on Phase
 * 1's `readOpfsFileBytes`/`removeOpfsFileIfExists`). This store's own OPFS
 * primitives are inlined directly in `opfs-artifact-blob-store.ts` (not a
 * separately importable I/O module), so rather than `vi.mock`-ing an
 * imported module, `navigator.storage.getDirectory` is stubbed directly
 * with a fake `FileSystemDirectoryHandle` double that keeps an in-memory
 * map of file contents.
 *
 * The store's SQL-metadata interactions are exercised for real against a
 * real in-memory `WasmSqliteExecutor` (same pattern as
 * `packages/db/tests/unit/artifact-diff.test.ts` and
 * `packages/db-core/tests/unit/manifest.test.ts`) — only the browser-only
 * OPFS file I/O is doubled.
 */
import {
  ArtifactBlobStore as DbArtifactBlobStore,
  FRESH_SCHEMA_SQL,
} from '@lucasschirm/sal-db-core';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getSqlite3,
  WasmSqliteExecutor,
} from '../../../db-core/tests/helpers/sqlite-wasm-adapter.js';
import {
  createOpfsArtifactBlobStore,
  resetOpfsArtifactBlobsDirectoryCacheForTests,
  writeArtifactBlobFile,
} from '../../src/db/opfs-artifact-blob-store';

function notFound(): DOMException {
  return new DOMException('Entry not found', 'NotFoundError');
}

/** A fake `FileSystemFileHandle` backed by an in-memory byte map. */
function createFakeFileHandle(name: string, files: Map<string, Uint8Array>): FileSystemFileHandle {
  return {
    createWritable: vi.fn(async () => ({
      write: vi.fn(async (data: Uint8Array) => {
        files.set(name, data);
      }),
      close: vi.fn(async () => undefined),
    })),
    getFile: vi.fn(async () => {
      const bytes = files.get(name);
      if (!bytes) throw notFound();
      return { arrayBuffer: async () => bytes.buffer };
    }),
  } as unknown as FileSystemFileHandle;
}

/** A fake `FileSystemDirectoryHandle` backed by an in-memory byte map. */
function createFakeDirectoryHandle(files: Map<string, Uint8Array>): FileSystemDirectoryHandle {
  return {
    getFileHandle: vi.fn(async (name: string, options?: { create?: boolean }) => {
      if (!files.has(name) && !options?.create) throw notFound();
      if (!files.has(name)) files.set(name, new Uint8Array());
      return createFakeFileHandle(name, files);
    }),
    removeEntry: vi.fn(async (name: string) => {
      if (!files.has(name)) throw notFound();
      files.delete(name);
    }),
  } as unknown as FileSystemDirectoryHandle;
}

interface OpfsFixture {
  files: Map<string, Uint8Array>;
  dirHandle: FileSystemDirectoryHandle;
  getDirectory: ReturnType<typeof vi.fn>;
  getDirectoryHandle: ReturnType<typeof vi.fn>;
}

function stubOpfs(): OpfsFixture {
  // The store memoizes its `/artifact-blobs/` directory handle across calls
  // for performance; clear that cache before installing a fresh fake root
  // so this test doesn't inherit a handle cached by an earlier test.
  resetOpfsArtifactBlobsDirectoryCacheForTests();
  const files = new Map<string, Uint8Array>();
  const dirHandle = createFakeDirectoryHandle(files);
  const getDirectoryHandle = vi.fn(
    async (_name: string, _opts?: { create?: boolean }) => dirHandle,
  );
  const rootHandle = { getDirectoryHandle } as unknown as FileSystemDirectoryHandle;
  const getDirectory = vi.fn(async () => rootHandle);
  Object.defineProperty(globalThis, 'navigator', {
    value: { storage: { getDirectory } },
    configurable: true,
    writable: true,
  });
  return { files, dirHandle, getDirectory, getDirectoryHandle };
}

function encodeText(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

const MANIFEST_DDL = FRESH_SCHEMA_SQL;

async function createExecutor(): Promise<WasmSqliteExecutor> {
  const executor = await WasmSqliteExecutor.create();
  await executor.exec(MANIFEST_DDL);
  return executor;
}

beforeAll(async () => {
  await getSqlite3();
});

describe('createOpfsArtifactBlobStore', () => {
  let opfs: OpfsFixture;
  let executor: WasmSqliteExecutor;

  beforeEach(async () => {
    opfs = stubOpfs();
    executor = await createExecutor();
  });

  describe('retain', () => {
    it('writes the OPFS file and a metadata row with content: null', async () => {
      const store = createOpfsArtifactBlobStore(executor);
      const bytes = encodeText('hello world');
      const reference = await store.retain({
        sha256: 'sha-1',
        size: bytes.length,
        relativePath: 'p',
        mediaType: 'text/plain',
        content: bytes,
      });

      expect(reference).toEqual({
        sha256: 'sha-1',
        size: bytes.length,
        relativePath: 'p',
        mediaType: 'text/plain',
      });
      expect(opfs.files.get('sha-1')).toEqual(bytes);

      const row = await DbArtifactBlobStore.getBySha256(executor, 'sha-1');
      expect(row?.content).toBeNull();
      expect(row?.size).toBe(bytes.length);
      expect(row?.mediaType).toBe('text/plain');
      expect(row?.retentionClass).toBe('retained');
    });

    it('normalizes the retention class from the source location', async () => {
      const store = createOpfsArtifactBlobStore(executor);
      await store.retain({
        sha256: 'sha-2',
        size: 1,
        relativePath: 'p',
        mediaType: 'text/plain',
        content: encodeText('x'),
        sourceLocation: {
          reacquisitionKey: 'k',
          sourceNamespace: 'ns',
          relativePath: 'p',
          retentionClass: 'transient',
        },
      });
      const row = await DbArtifactBlobStore.getBySha256(executor, 'sha-2');
      expect(row?.retentionClass).toBe('transient');
    });

    it('is idempotent: retaining the same sha256 twice overwrites the OPFS file', async () => {
      const store = createOpfsArtifactBlobStore(executor);
      await store.retain({
        sha256: 'sha-3',
        size: 5,
        relativePath: 'p',
        mediaType: 'text/plain',
        content: encodeText('first'),
      });
      await store.retain({
        sha256: 'sha-3',
        size: 6,
        relativePath: 'p',
        mediaType: 'text/plain',
        content: encodeText('second'),
      });
      expect(opfs.files.get('sha-3')).toEqual(encodeText('second'));
    });

    it('rolls back the OPFS write if the metadata insert fails for a genuinely new blob', async () => {
      const store = createOpfsArtifactBlobStore(executor);
      // Target the insert specifically (not the whole executor) so the new
      // pre-check `getBySha256` call this fix added still succeeds and
      // correctly reports "no prior row" for this sha256.
      const insertSpy = vi
        .spyOn(DbArtifactBlobStore, 'insert')
        .mockRejectedValueOnce(new Error('insert failed'));

      await expect(
        store.retain({
          sha256: 'sha-rollback',
          size: 1,
          relativePath: 'p',
          mediaType: 'text/plain',
          content: encodeText('x'),
        }),
      ).rejects.toThrow('insert failed');

      expect(opfs.files.has('sha-rollback')).toBe(false);
      expect(opfs.dirHandle.removeEntry).toHaveBeenCalledWith('sha-rollback');

      insertSpy.mockRestore();
    });

    it('does not roll back the OPFS write when a re-retain of an already-known sha256 fails', async () => {
      // Content-addressed dedup means the same sha256 gets retained again
      // across many sessions. A transient insert failure on a re-retain
      // must not delete the pre-existing, still-referenced file -- only a
      // genuinely new blob's orphaned write should be rolled back.
      const store = createOpfsArtifactBlobStore(executor);
      const bytes = encodeText('already there');
      await store.retain({
        sha256: 'sha-reretain',
        size: bytes.length,
        relativePath: 'p',
        mediaType: 'text/plain',
        content: bytes,
      });
      expect(opfs.files.get('sha-reretain')).toEqual(bytes);

      const insertSpy = vi
        .spyOn(DbArtifactBlobStore, 'insert')
        .mockRejectedValueOnce(new Error('transient insert failure'));

      await expect(
        store.retain({
          sha256: 'sha-reretain',
          size: bytes.length,
          relativePath: 'p',
          mediaType: 'text/plain',
          content: bytes,
        }),
      ).rejects.toThrow('transient insert failure');

      expect(opfs.files.has('sha-reretain')).toBe(true);
      expect(opfs.dirHandle.removeEntry).not.toHaveBeenCalledWith('sha-reretain');

      insertSpy.mockRestore();
    });

    it('serializes overlapping retains of the same new sha256, so a failing call never rolls back a concurrent successful one', async () => {
      // Without serialization, two overlapping retains of the same *new*
      // sha256 could each observe "no existing row" before either inserts
      // one -- so the failing call's rollback (correct in isolation) could
      // delete the file the other call's successful insert now depends on.
      const store = createOpfsArtifactBlobStore(executor);
      const insertSpy = vi
        .spyOn(DbArtifactBlobStore, 'insert')
        .mockRejectedValueOnce(new Error('first attempt fails'));

      const failing = store.retain({
        sha256: 'sha-race',
        size: 5,
        relativePath: 'p',
        mediaType: 'text/plain',
        content: encodeText('first'),
      });
      const succeeding = store.retain({
        sha256: 'sha-race',
        size: 6,
        relativePath: 'p',
        mediaType: 'text/plain',
        content: encodeText('second'),
      });

      await expect(failing).rejects.toThrow('first attempt fails');
      await succeeding;

      expect(opfs.files.get('sha-race')).toEqual(encodeText('second'));
      const row = await DbArtifactBlobStore.getBySha256(executor, 'sha-race');
      expect(row).toBeDefined();

      insertSpy.mockRestore();
    });

    it('serializes retain() and remove() for the same sha256, so their critical sections never overlap', async () => {
      // A remove() racing an in-flight retain() for the same new sha256 has
      // the same shape as the retain/retain race above: the file could
      // vanish (deleted by remove) after retain's metadata insert commits,
      // leaving a content: null row pointing at nothing. Natural promise
      // scheduling in this fake-OPFS harness doesn't reliably manifest that
      // interleaving on its own (remove's path has too few await points to
      // consistently land mid-retain), so this test forces the race: each
      // db-core call the two methods depend on is wrapped with a shared
      // "in critical section" flag and an artificial delay, widening the
      // window so any actual overlap is deterministically caught rather
      // than depending on incidental timing.
      const store = createOpfsArtifactBlobStore(executor);
      const originalInsert = DbArtifactBlobStore.insert.bind(DbArtifactBlobStore);
      const originalDelete = DbArtifactBlobStore.delete.bind(DbArtifactBlobStore);
      let inCriticalSection = false;
      let overlapDetected = false;

      async function guarded<T>(fn: () => Promise<T>): Promise<T> {
        if (inCriticalSection) overlapDetected = true;
        inCriticalSection = true;
        await new Promise((resolve) => setTimeout(resolve, 5));
        try {
          return await fn();
        } finally {
          inCriticalSection = false;
        }
      }

      const insertSpy = vi
        .spyOn(DbArtifactBlobStore, 'insert')
        .mockImplementation((exec, input) => guarded(() => originalInsert(exec, input)));
      const deleteSpy = vi
        .spyOn(DbArtifactBlobStore, 'delete')
        .mockImplementation((exec, sha) => guarded(() => originalDelete(exec, sha)));

      await Promise.all([
        store.retain({
          sha256: 'sha-retain-remove-race',
          size: 5,
          relativePath: 'p',
          mediaType: 'text/plain',
          content: encodeText('data!'),
        }),
        store.remove('sha-retain-remove-race'),
      ]);

      expect(overlapDetected).toBe(false);

      insertSpy.mockRestore();
      deleteSpy.mockRestore();
    });
  });

  describe('read', () => {
    it('reads bytes from OPFS when the SQL content column is null', async () => {
      const store = createOpfsArtifactBlobStore(executor);
      const bytes = encodeText('from opfs');
      await store.retain({
        sha256: 'sha-4',
        size: bytes.length,
        relativePath: 'p',
        mediaType: 'text/plain',
        content: bytes,
      });

      const result = await store.read('sha-4');
      expect(result).toEqual({
        sha256: 'sha-4',
        size: bytes.length,
        relativePath: '',
        mediaType: 'text/plain',
        content: bytes,
      });
    });

    it('prefers non-null legacy SQL content and never touches OPFS', async () => {
      const bytes = encodeText('legacy sql content');
      await DbArtifactBlobStore.insert(executor, {
        sha256: 'sha-legacy',
        mediaType: 'text/plain',
        retentionClass: 'retained',
        content: bytes,
        size: bytes.length,
      });

      const store = createOpfsArtifactBlobStore(executor);
      const result = await store.read('sha-legacy');

      expect(result).toEqual({
        sha256: 'sha-legacy',
        size: bytes.length,
        relativePath: '',
        mediaType: 'text/plain',
        content: bytes,
      });
      expect(opfs.getDirectory).not.toHaveBeenCalled();
    });

    it('returns undefined for a nonexistent sha256', async () => {
      const store = createOpfsArtifactBlobStore(executor);
      const result = await store.read('missing-sha');
      expect(result).toBeUndefined();
    });

    it('returns undefined (not a fabricated empty artifact) when content is null and the OPFS file is missing', async () => {
      await DbArtifactBlobStore.insert(executor, {
        sha256: 'sha-orphan',
        mediaType: 'text/plain',
        retentionClass: 'retained',
        content: null,
        size: 10,
      });

      const store = createOpfsArtifactBlobStore(executor);
      const result = await store.read('sha-orphan');
      expect(result).toBeUndefined();
    });

    it('defaults mediaType to application/octet-stream when the OPFS-resolved row has none', async () => {
      const bytes = encodeText('no media type');
      await DbArtifactBlobStore.insert(executor, {
        sha256: 'sha-no-media',
        mediaType: null,
        retentionClass: 'retained',
        content: null,
        size: bytes.length,
      });
      await writeArtifactBlobFile('sha-no-media', bytes);

      const store = createOpfsArtifactBlobStore(executor);
      const result = await store.read('sha-no-media');
      expect(result?.mediaType).toBe('application/octet-stream');
    });

    it('rethrows a non-NotFound OPFS error rather than treating it as missing', async () => {
      await DbArtifactBlobStore.insert(executor, {
        sha256: 'sha-corrupt',
        mediaType: 'text/plain',
        retentionClass: 'retained',
        content: null,
        size: 10,
      });
      vi.mocked(opfs.dirHandle.getFileHandle).mockRejectedValueOnce(
        new DOMException('permission denied', 'NotReadableError'),
      );

      const store = createOpfsArtifactBlobStore(executor);
      await expect(store.read('sha-corrupt')).rejects.toThrow('permission denied');
    });
  });

  describe('remove', () => {
    it('deletes the metadata row and the OPFS file for an existing sha256', async () => {
      const store = createOpfsArtifactBlobStore(executor);
      await store.retain({
        sha256: 'sha-rm',
        size: 1,
        relativePath: 'p',
        mediaType: 'text/plain',
        content: encodeText('x'),
      });

      const removed = await store.remove('sha-rm');
      expect(removed).toBe(true);
      expect(await DbArtifactBlobStore.getBySha256(executor, 'sha-rm')).toBeUndefined();
      expect(opfs.files.has('sha-rm')).toBe(false);
      expect(opfs.dirHandle.removeEntry).toHaveBeenCalledWith('sha-rm');
    });

    it('returns false for a nonexistent sha256 without throwing on the best-effort OPFS removal', async () => {
      const store = createOpfsArtifactBlobStore(executor);
      const removed = await store.remove('sha-never-existed');
      expect(removed).toBe(false);
      expect(opfs.dirHandle.removeEntry).toHaveBeenCalledWith('sha-never-existed');
    });

    it('never throws even when OPFS directory resolution itself fails', async () => {
      // Not just removeEntry() -- getArtifactBlobsDirectory() itself can
      // reject (e.g. the very first OPFS call on this store instance,
      // before any handle is cached). A caller here (removeLocked) has
      // already deleted the metadata row by this point, so a thrown error
      // can no longer be undone -- the best-effort contract must hold even
      // for this failure mode, not just a failing removeEntry().
      resetOpfsArtifactBlobsDirectoryCacheForTests();
      await DbArtifactBlobStore.insert(executor, {
        sha256: 'sha-dir-fail',
        size: 1,
        mediaType: 'text/plain',
        retentionClass: 'retained',
        content: null,
      });
      Object.defineProperty(globalThis, 'navigator', {
        value: {
          storage: {
            getDirectory: vi.fn(async () => {
              throw new Error('directory unavailable');
            }),
          },
        },
        configurable: true,
        writable: true,
      });

      const store = createOpfsArtifactBlobStore(executor);
      await expect(store.remove('sha-dir-fail')).resolves.toBe(true);
    });
  });

  describe('list', () => {
    it('lists all blobs with no prefix', async () => {
      const store = createOpfsArtifactBlobStore(executor);
      await store.retain({
        sha256: 'aaa',
        size: 1,
        relativePath: 'p',
        mediaType: 'text/plain',
        content: encodeText('a'),
      });
      await store.retain({
        sha256: 'bbb',
        size: 1,
        relativePath: 'p',
        mediaType: 'text/plain',
        content: encodeText('b'),
      });

      const references = await store.list();
      expect(references).toEqual([
        { sha256: 'aaa', size: 1, relativePath: 'aaa', mediaType: 'text/plain' },
        { sha256: 'bbb', size: 1, relativePath: 'bbb', mediaType: 'text/plain' },
      ]);
    });

    it('lists only blobs matching the given prefix', async () => {
      const store = createOpfsArtifactBlobStore(executor);
      await store.retain({
        sha256: 'pre-one',
        size: 1,
        relativePath: 'p',
        mediaType: 'text/plain',
        content: encodeText('a'),
      });
      await store.retain({
        sha256: 'other',
        size: 1,
        relativePath: 'p',
        mediaType: 'text/plain',
        content: encodeText('b'),
      });

      const references = await store.list('pre');
      expect(references).toEqual([
        { sha256: 'pre-one', size: 1, relativePath: 'pre-one', mediaType: 'text/plain' },
      ]);
    });

    it('defaults mediaType to application/octet-stream for rows with none', async () => {
      await DbArtifactBlobStore.insert(executor, {
        sha256: 'sha-list-no-media',
        mediaType: null,
        retentionClass: 'retained',
        content: encodeText('x'),
        size: 1,
      });

      const store = createOpfsArtifactBlobStore(executor);
      const references = await store.list('sha-list-no-media');
      expect(references).toEqual([
        {
          sha256: 'sha-list-no-media',
          size: 1,
          relativePath: 'sha-list-no-media',
          mediaType: 'application/octet-stream',
        },
      ]);
    });
  });
});

describe('getArtifactBlobsDirectory caching', () => {
  it('resets the cache on a resolution failure so a later call retries instead of staying poisoned', async () => {
    const opfs = stubOpfs();
    opfs.getDirectory.mockRejectedValueOnce(new Error('storage unavailable'));

    await expect(writeArtifactBlobFile('sha-retry', encodeText('x'))).rejects.toThrow(
      'storage unavailable',
    );
    expect(opfs.getDirectory).toHaveBeenCalledTimes(1);

    await writeArtifactBlobFile('sha-retry', encodeText('x'));
    expect(opfs.getDirectory).toHaveBeenCalledTimes(2);
    expect(opfs.files.get('sha-retry')).toEqual(encodeText('x'));
  });
});

describe('writeArtifactBlobFile', () => {
  it('writes the OPFS file directly without any SQL calls', async () => {
    const opfs = stubOpfs();
    const bytes = encodeText('backfill payload');

    await writeArtifactBlobFile('sha-backfill', bytes);

    expect(opfs.files.get('sha-backfill')).toEqual(bytes);
    expect(opfs.getDirectoryHandle).toHaveBeenCalledWith('artifact-blobs', { create: true });
  });
});
