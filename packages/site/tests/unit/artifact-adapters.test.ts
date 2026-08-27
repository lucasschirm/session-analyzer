import type { ArtifactReference, ResolvedArtifact } from '@lucasschirm/sal-db';
import type {
  ArtifactBlob,
  SqliteExecResult,
  SqliteExecutor,
  SqliteRow,
} from '@lucasschirm/sal-db-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createBrowserArtifactBlobStore,
  createBrowserArtifactResolver,
  createBrowserContentHasher,
  createSyncArtifactCache,
} from '../../src/db/artifact-adapters';

/**
 * Hoisted mock for the db-core `ArtifactBlobStore` static methods. The adapter
 * delegates `retain`/`read` to these statics, so they are replaced with spies
 * that record calls and return configurable results without touching SQLite.
 */
const blobStoreMock = vi.hoisted(() => ({
  insert: vi.fn(async (_exec: unknown, _input: unknown) => {}),
  getBySha256: vi.fn(async (_sha: string) => undefined as ArtifactBlob | undefined),
}));

vi.mock('@lucasschirm/sal-db-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lucasschirm/sal-db-core')>();
  return {
    ...actual,
    ArtifactBlobStore: {
      ...actual.ArtifactBlobStore,
      insert: blobStoreMock.insert,
      getBySha256: blobStoreMock.getBySha256,
    },
  };
});

/**
 * Minimal fake executor that records `exec` calls and returns a configurable
 * queued result. Only the `exec` method is exercised by the blob store adapter
 * (for `remove` and `list`); the remaining `SqliteExecutor` members are stubs
 * to satisfy the interface.
 */
interface FakeExecutor extends SqliteExecutor {
  calls: { sql: string; params: readonly unknown[] }[];
  result: SqliteExecResult;
  setNextResult(result: SqliteExecResult): void;
}

function createFakeExecutor(
  result: SqliteExecResult = { rows: [], changes: 0, lastInsertRowId: 0n },
): FakeExecutor {
  const calls: { sql: string; params: readonly unknown[] }[] = [];
  let current = result;
  return {
    backend: { name: 'fake', persistent: false, durable: false, fallback: false } as never,
    calls,
    result: current,
    setNextResult(next: SqliteExecResult) {
      current = next;
    },
    exec(sql: string, params?: readonly unknown[]) {
      calls.push({ sql, params: params ?? [] });
      return current;
    },
    transaction: vi.fn(),
    close: vi.fn(),
    isBusy: () => false,
    isClosed: () => false,
  } as unknown as FakeExecutor;
}

function resolvedArtifact(overrides: Partial<ResolvedArtifact> = {}): ResolvedArtifact {
  return {
    sha256: 'abc123',
    size: 5,
    relativePath: 'path/to/file.txt',
    mediaType: 'text/plain',
    content: 'hello',
    ...overrides,
  };
}

describe('createBrowserContentHasher', () => {
  it('hashes string content to the correct sha256 hex', async () => {
    const hasher = createBrowserContentHasher();
    const digest = await hasher.hash('hello');
    expect(digest).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });

  it('hashes Uint8Array content to the same digest as the equivalent string', async () => {
    const hasher = createBrowserContentHasher();
    const bytes = new TextEncoder().encode('hello');
    const digest = await hasher.hash(bytes);
    expect(digest).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });

  it('produces a 64-character lowercase hex string', async () => {
    const hasher = createBrowserContentHasher();
    const digest = await hasher.hash('any content');
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('createSyncArtifactCache', () => {
  it('returns undefined for a missing sha256', () => {
    const cache = createSyncArtifactCache();
    expect(cache.get('missing')).toBeUndefined();
  });

  it('returns undefined for a missing reacquisition key', () => {
    const cache = createSyncArtifactCache();
    expect(cache.getByKey('missing-key')).toBeUndefined();
  });

  it('stores and retrieves an artifact by sha256', () => {
    const cache = createSyncArtifactCache();
    const artifact = resolvedArtifact({ sha256: 'aaa' });
    cache.set(artifact);
    expect(cache.get('aaa')).toBe(artifact);
  });

  it('indexes an artifact by reacquisitionKey when present', () => {
    const cache = createSyncArtifactCache();
    const artifact = resolvedArtifact({
      sha256: 'bbb',
      sourceLocation: {
        reacquisitionKey: 'key-bbb',
        sourceNamespace: 'ns',
        relativePath: 'p',
        retentionClass: 'local',
      },
    });
    cache.set(artifact);
    expect(cache.getByKey('key-bbb')).toBe(artifact);
  });

  it('does not index by key when the artifact has no reacquisitionKey', () => {
    const cache = createSyncArtifactCache();
    const artifact = resolvedArtifact({ sha256: 'ccc' });
    cache.set(artifact);
    expect(cache.getByKey('any')).toBeUndefined();
  });

  it('delete removes the artifact from the sha256 map', () => {
    const cache = createSyncArtifactCache();
    const artifact = resolvedArtifact({ sha256: 'ddd' });
    cache.set(artifact);
    expect(cache.delete('ddd')).toBe(true);
    expect(cache.get('ddd')).toBeUndefined();
  });

  it('delete also removes the artifact from the key map', () => {
    const cache = createSyncArtifactCache();
    const artifact = resolvedArtifact({
      sha256: 'eee',
      sourceLocation: {
        reacquisitionKey: 'key-eee',
        sourceNamespace: 'ns',
        relativePath: 'p',
        retentionClass: 'local',
      },
    });
    cache.set(artifact);
    cache.delete('eee');
    expect(cache.getByKey('key-eee')).toBeUndefined();
  });

  it('clear empties both maps', () => {
    const cache = createSyncArtifactCache();
    const artifact = resolvedArtifact({
      sha256: 'fff',
      sourceLocation: {
        reacquisitionKey: 'key-fff',
        sourceNamespace: 'ns',
        relativePath: 'p',
        retentionClass: 'local',
      },
    });
    cache.set(artifact);
    cache.clear();
    expect(cache.get('fff')).toBeUndefined();
    expect(cache.getByKey('key-fff')).toBeUndefined();
  });
});

describe('createBrowserArtifactBlobStore', () => {
  let executor: FakeExecutor;

  beforeEach(() => {
    executor = createFakeExecutor();
    blobStoreMock.insert.mockClear();
    blobStoreMock.getBySha256.mockClear();
    blobStoreMock.getBySha256.mockResolvedValue(undefined);
    blobStoreMock.insert.mockResolvedValue(undefined);
  });

  describe('retain', () => {
    it('calls ArtifactBlobStore.insert with the blob content as bytes', async () => {
      const store = createBrowserArtifactBlobStore(executor);
      const blob = resolvedArtifact({ sha256: 'h1', content: 'hello', mediaType: 'text/plain' });
      await store.retain(blob);
      expect(blobStoreMock.insert).toHaveBeenCalledTimes(1);
      const [execArg, input] = blobStoreMock.insert.mock.calls[0] as [
        unknown,
        {
          sha256: string;
          size: number;
          mediaType: string;
          content: Uint8Array;
          retentionClass: string;
        },
      ];
      expect(execArg).toBe(executor);
      expect(input.sha256).toBe('h1');
      expect(input.size).toBe(5);
      expect(input.mediaType).toBe('text/plain');
      expect(input.content).toBeInstanceOf(Uint8Array);
      expect(Array.from(input.content)).toEqual(Array.from(new TextEncoder().encode('hello')));
    });

    it('normalizes the retention class from the source location', async () => {
      const store = createBrowserArtifactBlobStore(executor);
      const blob = resolvedArtifact({
        sha256: 'h2',
        sourceLocation: {
          reacquisitionKey: 'k',
          sourceNamespace: 'ns',
          relativePath: 'p',
          retentionClass: 'transient',
        },
      });
      await store.retain(blob);
      const input = blobStoreMock.insert.mock.calls[0][1] as { retentionClass: string };
      expect(input.retentionClass).toBe('transient');
    });

    it('maps local retention class to retained', async () => {
      const store = createBrowserArtifactBlobStore(executor);
      const blob = resolvedArtifact({
        sha256: 'h3',
        sourceLocation: {
          reacquisitionKey: 'k',
          sourceNamespace: 'ns',
          relativePath: 'p',
          retentionClass: 'local',
        },
      });
      await store.retain(blob);
      const input = blobStoreMock.insert.mock.calls[0][1] as { retentionClass: string };
      expect(input.retentionClass).toBe('retained');
    });

    it('maps archive retention class to retained', async () => {
      const store = createBrowserArtifactBlobStore(executor);
      const blob = resolvedArtifact({
        sha256: 'h4',
        sourceLocation: {
          reacquisitionKey: 'k',
          sourceNamespace: 'ns',
          relativePath: 'p',
          retentionClass: 'archive',
        },
      });
      await store.retain(blob);
      const input = blobStoreMock.insert.mock.calls[0][1] as { retentionClass: string };
      expect(input.retentionClass).toBe('retained');
    });

    it('defaults to retained when no source location is present', async () => {
      const store = createBrowserArtifactBlobStore(executor);
      const blob = resolvedArtifact({ sha256: 'h5' });
      await store.retain(blob);
      const input = blobStoreMock.insert.mock.calls[0][1] as { retentionClass: string };
      expect(input.retentionClass).toBe('retained');
    });

    it('strips content from the returned reference', async () => {
      const store = createBrowserArtifactBlobStore(executor);
      const blob = resolvedArtifact({ sha256: 'h6', content: 'hello' });
      const reference = await store.retain(blob);
      expect(reference.sha256).toBe('h6');
      expect(reference.size).toBe(5);
      expect((reference as { content?: unknown }).content).toBeUndefined();
    });

    it('accepts Uint8Array content', async () => {
      const store = createBrowserArtifactBlobStore(executor);
      const bytes = new TextEncoder().encode('world');
      const blob = resolvedArtifact({ sha256: 'h7', content: bytes, size: bytes.length });
      await store.retain(blob);
      const input = blobStoreMock.insert.mock.calls[0][1] as { content: Uint8Array };
      expect(input.content).toBe(bytes);
    });
  });

  describe('read', () => {
    it('returns a resolved artifact when the blob has content', async () => {
      const store = createBrowserArtifactBlobStore(executor);
      const blob: ArtifactBlob = {
        sha256: 'r1',
        mediaType: 'text/plain',
        retentionClass: 'retained',
        content: new TextEncoder().encode('data'),
        size: 4,
        redactionScheme: null,
        keyDomainId: null,
        sensitiveDigest: null,
        redactionChangeMarker: 0,
        isRedacted: false,
        verifiedAt: null,
        createdAt: 1,
        updatedAt: 1,
      };
      blobStoreMock.getBySha256.mockResolvedValue(blob);
      const result = await store.read('r1');
      expect(blobStoreMock.getBySha256).toHaveBeenCalledWith(executor, 'r1');
      expect(result).toEqual({
        sha256: 'r1',
        size: 4,
        relativePath: '',
        mediaType: 'text/plain',
        content: blob.content,
      });
    });

    it('returns undefined when the blob has no content', async () => {
      const store = createBrowserArtifactBlobStore(executor);
      const blob: ArtifactBlob = {
        sha256: 'r2',
        mediaType: null,
        retentionClass: 'retained',
        content: null,
        size: 0,
        redactionScheme: null,
        keyDomainId: null,
        sensitiveDigest: null,
        redactionChangeMarker: 0,
        isRedacted: false,
        verifiedAt: null,
        createdAt: 1,
        updatedAt: 1,
      };
      blobStoreMock.getBySha256.mockResolvedValue(blob);
      const result = await store.read('r2');
      expect(result).toBeUndefined();
    });

    it('returns undefined when the blob is not found', async () => {
      const store = createBrowserArtifactBlobStore(executor);
      blobStoreMock.getBySha256.mockResolvedValue(undefined);
      const result = await store.read('missing');
      expect(result).toBeUndefined();
    });

    it('defaults mediaType to application/octet-stream when null', async () => {
      const store = createBrowserArtifactBlobStore(executor);
      const blob: ArtifactBlob = {
        sha256: 'r3',
        mediaType: null,
        retentionClass: 'retained',
        content: new Uint8Array([1]),
        size: 1,
        redactionScheme: null,
        keyDomainId: null,
        sensitiveDigest: null,
        redactionChangeMarker: 0,
        isRedacted: false,
        verifiedAt: null,
        createdAt: 1,
        updatedAt: 1,
      };
      blobStoreMock.getBySha256.mockResolvedValue(blob);
      const result = await store.read('r3');
      expect(result?.mediaType).toBe('application/octet-stream');
    });
  });

  describe('remove', () => {
    it('executes a DELETE and returns true when rows were affected', async () => {
      executor.setNextResult({ rows: [], changes: 1, lastInsertRowId: 0n });
      const store = createBrowserArtifactBlobStore(executor);
      const removed = await store.remove('rm1');
      expect(removed).toBe(true);
      expect(executor.calls).toHaveLength(1);
      expect(executor.calls[0].sql).toContain('DELETE FROM artifact_blobs');
      expect(executor.calls[0].params).toEqual(['rm1']);
    });

    it('returns false when no rows were affected', async () => {
      executor.setNextResult({ rows: [], changes: 0, lastInsertRowId: 0n });
      const store = createBrowserArtifactBlobStore(executor);
      const removed = await store.remove('rm2');
      expect(removed).toBe(false);
    });
  });

  describe('list', () => {
    it('maps rows with the given prefix and orders by sha256', async () => {
      const rows: SqliteRow[] = [
        { sha256: 'pre1', media_type: 'text/plain', size: 10 },
        { sha256: 'pre2', media_type: null, size: 20 },
      ];
      executor.setNextResult({ rows, changes: 0, lastInsertRowId: 0n });
      const store = createBrowserArtifactBlobStore(executor);
      const references = await store.list('pre');
      expect(references).toEqual([
        { sha256: 'pre1', size: 10, relativePath: 'pre1', mediaType: 'text/plain' },
        { sha256: 'pre2', size: 20, relativePath: 'pre2', mediaType: 'application/octet-stream' },
      ]);
      expect(executor.calls[0].sql).toContain('SELECT sha256, media_type, size');
      expect(executor.calls[0].sql).toContain('LIKE ?');
      expect(executor.calls[0].params).toEqual(['pre%']);
    });

    it('uses an empty prefix as a wildcard match for all rows', async () => {
      executor.setNextResult({ rows: [], changes: 0, lastInsertRowId: 0n });
      const store = createBrowserArtifactBlobStore(executor);
      await store.list();
      expect(executor.calls[0].params).toEqual(['%']);
    });
  });
});

describe('createBrowserArtifactResolver', () => {
  function makeBlobStoreMock() {
    return {
      retain: vi.fn(),
      read: vi.fn(async () => undefined as ResolvedArtifact | undefined),
      remove: vi.fn(),
      list: vi.fn(),
    };
  }

  it('resolves from the blob store first', async () => {
    const blobStore = makeBlobStoreMock();
    const syncCache = createSyncArtifactCache();
    const local = resolvedArtifact({ sha256: 'a1', content: 'local' });
    blobStore.read.mockResolvedValue(local);
    const resolver = createBrowserArtifactResolver({ blobStore, syncCache });
    const result = await resolver.resolve({
      sha256: 'a1',
      size: 5,
      relativePath: 'p',
      mediaType: 'text/plain',
    });
    expect(result).toBe(local);
  });

  it('falls back to the sync cache by sha256', async () => {
    const blobStore = makeBlobStoreMock();
    blobStore.read.mockResolvedValue(undefined);
    const syncCache = createSyncArtifactCache();
    const synced = resolvedArtifact({ sha256: 'a2', content: 'synced' });
    syncCache.set(synced);
    const resolver = createBrowserArtifactResolver({ blobStore, syncCache });
    const result = await resolver.resolve({
      sha256: 'a2',
      size: 6,
      relativePath: 'p',
      mediaType: 'text/plain',
    });
    expect(result).toBe(synced);
  });

  it('falls back to the sync cache by reacquisitionKey', async () => {
    const blobStore = makeBlobStoreMock();
    blobStore.read.mockResolvedValue(undefined);
    const syncCache = createSyncArtifactCache();
    const synced = resolvedArtifact({
      sha256: 'a3',
      content: 'synced-by-key',
      sourceLocation: {
        reacquisitionKey: 'key-a3',
        sourceNamespace: 'ns',
        relativePath: 'p',
        retentionClass: 'local',
      },
    });
    syncCache.set(synced);
    const resolver = createBrowserArtifactResolver({ blobStore, syncCache });
    const result = await resolver.resolve({
      sha256: 'different-hash',
      size: 6,
      relativePath: 'p',
      mediaType: 'text/plain',
      sourceLocation: {
        reacquisitionKey: 'key-a3',
        sourceNamespace: 'ns',
        relativePath: 'p',
        retentionClass: 'local',
      },
    });
    expect(result).toBe(synced);
  });

  it('does not consult the key map when the reference has no reacquisitionKey', async () => {
    const blobStore = makeBlobStoreMock();
    blobStore.read.mockResolvedValue(undefined);
    const syncCache = createSyncArtifactCache();
    const synced = resolvedArtifact({
      sha256: 'a4',
      content: 'synced',
      sourceLocation: {
        reacquisitionKey: 'key-a4',
        sourceNamespace: 'ns',
        relativePath: 'p',
        retentionClass: 'local',
      },
    });
    syncCache.set(synced);
    const resolver = createBrowserArtifactResolver({ blobStore, syncCache });
    await expect(
      resolver.resolve({ sha256: 'no-match', size: 1, relativePath: 'p', mediaType: 'text/plain' }),
    ).rejects.toThrow(/Artifact not resolvable/);
  });

  it('throws when the artifact cannot be found anywhere', async () => {
    const blobStore = makeBlobStoreMock();
    blobStore.read.mockResolvedValue(undefined);
    const syncCache = createSyncArtifactCache();
    const resolver = createBrowserArtifactResolver({ blobStore, syncCache });
    await expect(
      resolver.resolve({
        sha256: 'missing',
        size: 1,
        relativePath: 'p',
        mediaType: 'text/plain',
        sourceLocation: {
          reacquisitionKey: 'key-missing',
          sourceNamespace: 'ns',
          relativePath: 'p',
          retentionClass: 'local',
        },
      }),
    ).rejects.toThrow(/Artifact not resolvable: sha256=missing key=key-missing/);
  });

  it('reports none in the error when no reacquisitionKey is present', async () => {
    const blobStore = makeBlobStoreMock();
    blobStore.read.mockResolvedValue(undefined);
    const syncCache = createSyncArtifactCache();
    const resolver = createBrowserArtifactResolver({ blobStore, syncCache });
    await expect(
      resolver.resolve({ sha256: 'missing', size: 1, relativePath: 'p', mediaType: 'text/plain' }),
    ).rejects.toThrow(/Artifact not resolvable: sha256=missing key=none/);
  });
});
