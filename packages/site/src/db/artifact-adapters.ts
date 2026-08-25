/**
 * Browser-side adapters for the `sal-db` artifact ports.
 *
 * - `ContentHasher` uses the sync-core SHA-256 helper so the site and sync
 *   worker agree on content hashes.
 * - `ArtifactBlobStore` retains resolved artifacts in the analytics SQLite
 *   `artifact_blobs` table.
 * - `ArtifactResolver` resolves by sha256 from the local blob store first, then
 *   falls back to the in-memory sync cache that the sync worker can populate.
 */

import type {
  ArtifactBlobStore,
  ArtifactContent,
  ArtifactResolver,
  ContentHasher,
  ResolvedArtifact,
} from '@lucasschirm/sal-db';
import type { SqliteExecutor } from '@lucasschirm/sal-db-core';
import {
  type ArtifactBlob,
  type ArtifactRetentionClass,
  ArtifactBlobStore as DbArtifactBlobStore,
} from '@lucasschirm/sal-db-core';
import { sha256Hex } from '@lucasschirm/sal-sync-core';

const RETENTION_CLASS_MAP: Record<string, ArtifactRetentionClass> = {
  transient: 'transient',
  local: 'retained',
  archive: 'retained',
};

function normalizeRetentionClass(sourceClass: string | undefined): ArtifactRetentionClass {
  return RETENTION_CLASS_MAP[sourceClass ?? ''] ?? 'retained';
}

function asBytes(content: ArtifactContent): Uint8Array {
  if (typeof content === 'string') {
    return new TextEncoder().encode(content);
  }
  return content;
}

function blobToResolvedArtifact(blob: ArtifactBlob): ResolvedArtifact | undefined {
  if (!blob.content) return undefined;
  return {
    sha256: blob.sha256,
    size: blob.size,
    relativePath: '',
    mediaType: blob.mediaType ?? 'application/octet-stream',
    content: blob.content,
  };
}

export function createBrowserContentHasher(): ContentHasher {
  return {
    hash: async (content) => {
      const bytes = asBytes(content) as Uint8Array<ArrayBuffer>;
      return sha256Hex(bytes);
    },
  };
}

/**
 * In-memory cache for artifacts downloaded by the sync worker. The cache is
 * keyed by both sha256 and the source reacquisition key so the resolver can
 * find a sync artifact from either its hash or its source location.
 */
export interface SyncArtifactCache {
  get(sha256: string): ResolvedArtifact | undefined;
  getByKey(key: string): ResolvedArtifact | undefined;
  set(artifact: ResolvedArtifact): void;
  delete(sha256: string): boolean;
  clear(): void;
}

export function createSyncArtifactCache(): SyncArtifactCache {
  const bySha256 = new Map<string, ResolvedArtifact>();
  const byKey = new Map<string, ResolvedArtifact>();

  return {
    get: (sha256) => bySha256.get(sha256),
    getByKey: (key) => byKey.get(key),
    set: (artifact) => {
      bySha256.set(artifact.sha256, artifact);
      if (artifact.sourceLocation?.reacquisitionKey) {
        byKey.set(artifact.sourceLocation.reacquisitionKey, artifact);
      }
    },
    delete: (sha256) => {
      const artifact = bySha256.get(sha256);
      bySha256.delete(sha256);
      if (artifact?.sourceLocation?.reacquisitionKey) {
        byKey.delete(artifact.sourceLocation.reacquisitionKey);
      }
      return true;
    },
    clear: () => {
      bySha256.clear();
      byKey.clear();
    },
  };
}

export function createBrowserArtifactBlobStore(executor: SqliteExecutor): ArtifactBlobStore {
  return {
    retain: async (blob) => {
      const bytes = asBytes(blob.content);
      const retentionClass = normalizeRetentionClass(blob.sourceLocation?.retentionClass);
      await DbArtifactBlobStore.insert(executor, {
        sha256: blob.sha256,
        size: blob.size,
        mediaType: blob.mediaType,
        retentionClass,
        content: bytes,
      });
      const { content: _content, ...reference } = blob;
      return reference;
    },

    read: async (sha256) => {
      const blob = await DbArtifactBlobStore.getBySha256(executor, sha256);
      if (!blob) return undefined;
      return blobToResolvedArtifact(blob);
    },

    remove: async (sha256) => {
      const { changes } = await executor.exec('DELETE FROM artifact_blobs WHERE sha256 = ?', [
        sha256,
      ]);
      return changes > 0;
    },

    list: async (prefix) => {
      const like = `${prefix ?? ''}%`;
      const { rows } = await executor.exec(
        `SELECT sha256, media_type, size
         FROM artifact_blobs
         WHERE sha256 LIKE ?
         ORDER BY sha256`,
        [like],
      );
      return rows.map((row) => ({
        sha256: String(row.sha256),
        size: Number(row.size),
        relativePath: String(row.sha256),
        mediaType: row.media_type ? String(row.media_type) : 'application/octet-stream',
      }));
    },
  };
}

export interface BrowserArtifactResolverOptions {
  readonly blobStore: ArtifactBlobStore;
  readonly syncCache: SyncArtifactCache;
}

export function createBrowserArtifactResolver({
  blobStore,
  syncCache,
}: BrowserArtifactResolverOptions): ArtifactResolver {
  return {
    resolve: async (reference) => {
      const local = await blobStore.read(reference.sha256);
      if (local) return local;

      const sync =
        syncCache.get(reference.sha256) ??
        (reference.sourceLocation?.reacquisitionKey
          ? syncCache.getByKey(reference.sourceLocation.reacquisitionKey)
          : undefined);
      if (sync) return sync;

      throw new Error(
        `Artifact not resolvable: sha256=${reference.sha256} ` +
          `key=${reference.sourceLocation?.reacquisitionKey ?? 'none'}`,
      );
    },
  };
}
