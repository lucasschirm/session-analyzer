/**
 * OPFS-backed `ArtifactBlobStore` (Phase 2 of the "Move Artifact Blob
 * Storage Out of SQLite" effort — Feature #396, this file is sub-issue
 * #397). Blob bytes are stored as flat files at `/artifact-blobs/<sha256>`
 * — this app's first *nested* OPFS directory (see `opfs-file-io.ts`'s
 * header comment for why that file's root-relative helpers aren't reused
 * here). "No directory sharding" means one flat directory under
 * `artifact-blobs/`, not `sha256[0:2]/sha256[2:4]/...` shard nesting.
 *
 * Metadata (sha256, size, media type, retention class, redaction
 * bookkeeping) continues to live in the `artifact_blobs` SQL table via
 * `db-core`'s `ArtifactBlobStore` static class — only the raw bytes move to
 * OPFS. `retain()` always writes `content: null` for new rows going
 * forward; it never migrates pre-existing rows (that is a later sub-issue's
 * one-time backfill).
 *
 * Migration-window read correctness: a pre-existing row's `content` column
 * keeps its historical bytes until the backfill explicitly nulls it, so
 * `read()` prefers the SQL `content` column when non-null and only consults
 * OPFS when it is null. This keeps every read correct for rows ingested
 * both before and after this store existed, without waiting on the
 * backfill.
 */

import type { ArtifactBlobStore, ArtifactReference, ResolvedArtifact } from '@lucasschirm/sal-db';
import type { ArtifactBlob, SqliteExecutor } from '@lucasschirm/sal-db-core';
import { ArtifactBlobStore as DbArtifactBlobStore } from '@lucasschirm/sal-db-core';
import { asBytes, normalizeRetentionClass } from './artifact-adapters';

const ARTIFACT_BLOBS_DIR = 'artifact-blobs';

let artifactBlobsDirectoryPromise: Promise<FileSystemDirectoryHandle> | null = null;

/**
 * Resolves (and memoizes) the `/artifact-blobs/` OPFS directory handle.
 * The handle is stable for the life of the origin's storage, so
 * re-resolving `navigator.storage.getDirectory()` on every read/write/
 * remove would add a fixed extra round-trip per call with no correctness
 * benefit. A failed resolution clears the cache so a transient error
 * doesn't permanently poison later calls.
 */
async function getArtifactBlobsDirectory(): Promise<FileSystemDirectoryHandle> {
  if (!artifactBlobsDirectoryPromise) {
    artifactBlobsDirectoryPromise = navigator.storage
      .getDirectory()
      .then((root) => root.getDirectoryHandle(ARTIFACT_BLOBS_DIR, { create: true }))
      .catch((error) => {
        artifactBlobsDirectoryPromise = null;
        throw error;
      });
  }
  return artifactBlobsDirectoryPromise;
}

/**
 * Test-only: clears the memoized `/artifact-blobs/` directory handle so a
 * test that installs a fresh fake OPFS root doesn't inherit a stale handle
 * cached by an earlier test in the same module instance.
 */
export function resetOpfsArtifactBlobsDirectoryCacheForTests(): void {
  artifactBlobsDirectoryPromise = null;
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'NotFoundError';
}

/**
 * Writes `bytes` to `/artifact-blobs/<sha256>`, creating the file if absent
 * and overwriting if present — `retain()` and content-addressed writes are
 * idempotent by design. This is a narrow primitive with no metadata-row
 * side effect, so a later backfill routine can reuse it directly without
 * triggering `retain()`'s metadata upsert (which would clobber a
 * pre-existing row's real retention/redaction fields with defaults).
 */
export async function writeArtifactBlobFile(sha256: string, bytes: Uint8Array): Promise<void> {
  const dir = await getArtifactBlobsDirectory();
  const fileHandle = await dir.getFileHandle(sha256, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(bytes as Uint8Array<ArrayBuffer>);
  await writable.close();
}

/**
 * Reads `/artifact-blobs/<sha256>`'s bytes, or `undefined` if the file does
 * not exist. Any other failure (permission, quota, I/O) is rethrown rather
 * than swallowed — collapsing a real failure into "missing" would make a
 * data-integrity anomaly indistinguishable from a genuinely absent blob.
 */
async function readArtifactBlobFile(sha256: string): Promise<Uint8Array | undefined> {
  const dir = await getArtifactBlobsDirectory();
  try {
    const fileHandle = await dir.getFileHandle(sha256);
    const file = await fileHandle.getFile();
    return new Uint8Array(await file.arrayBuffer());
  } catch (error) {
    if (isNotFoundError(error)) return undefined;
    throw error;
  }
}

/** Best-effort removal of `/artifact-blobs/<sha256>`; never throws. */
async function removeArtifactBlobFileIfExists(sha256: string): Promise<void> {
  const dir = await getArtifactBlobsDirectory();
  await dir.removeEntry(sha256).catch(() => undefined);
}

function toResolvedArtifact(row: ArtifactBlob, content: Uint8Array): ResolvedArtifact {
  return {
    sha256: row.sha256,
    size: row.size,
    relativePath: '',
    mediaType: row.mediaType ?? 'application/octet-stream',
    content,
  };
}

function toArtifactReference(blob: ArtifactBlob): ArtifactReference {
  return {
    sha256: blob.sha256,
    size: blob.size,
    relativePath: blob.sha256,
    mediaType: blob.mediaType ?? 'application/octet-stream',
  };
}

function insertBlobMetadata(executor: SqliteExecutor, blob: ResolvedArtifact): Promise<void> {
  return DbArtifactBlobStore.insert(executor, {
    sha256: blob.sha256,
    size: blob.size,
    mediaType: blob.mediaType,
    retentionClass: normalizeRetentionClass(blob.sourceLocation?.retentionClass),
    content: null,
  });
}

const retainLocks = new Map<string, Promise<void>>();

/**
 * Serializes `retain()` calls for the same sha256. Without this, two
 * overlapping retains for the same *new* sha256 could each observe "no
 * existing row" before either has inserted one, so a transient failure in
 * one could still delete the OPFS file the other's successful insert now
 * depends on — the same data-loss shape `retain()`'s rollback guards
 * against, reintroduced by a check-then-act race instead of a rollback
 * bug. Different sha256s never contend, so this never serializes unrelated
 * writes. The map entry is removed once its chain settles and nothing newer
 * has queued behind it, so it never grows unboundedly across a session.
 */
async function withRetainLock<T>(sha256: string, fn: () => Promise<T>): Promise<T> {
  const prior = retainLocks.get(sha256) ?? Promise.resolve();
  const run = prior.then(fn, fn);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  retainLocks.set(sha256, settled);
  settled.then(() => {
    if (retainLocks.get(sha256) === settled) retainLocks.delete(sha256);
  });
  return run;
}

async function retainLocked(
  executor: SqliteExecutor,
  blob: ResolvedArtifact,
): Promise<ArtifactReference> {
  // Checked before writing so a failed insert's rollback can tell a
  // genuinely new blob apart from a re-retain of an already-known sha256
  // (routine under content-addressed dedup — the same skill/rule/config
  // file gets retained again across many sessions). `withRetainLock`
  // ensures this check and the insert below execute atomically with
  // respect to other retains of this same sha256.
  const existedBefore =
    (await DbArtifactBlobStore.getBySha256(executor, blob.sha256)) !== undefined;
  await writeArtifactBlobFile(blob.sha256, asBytes(blob.content));
  try {
    await insertBlobMetadata(executor, blob);
  } catch (error) {
    // Only roll back the OPFS write for a genuinely new blob: an orphaned
    // file with no row at all is unreachable dead weight. For a re-retain,
    // the pre-existing row (and any other reference to this sha256) may
    // still depend on the file already there — a transient insert failure
    // must not delete still-referenced, previously-persisted content.
    if (!existedBefore) {
      await removeArtifactBlobFileIfExists(blob.sha256);
    }
    throw error;
  }
  const { content: _content, ...reference } = blob;
  return reference;
}

export function createOpfsArtifactBlobStore(executor: SqliteExecutor): ArtifactBlobStore {
  return {
    retain: async (blob) => withRetainLock(blob.sha256, () => retainLocked(executor, blob)),

    read: async (sha256) => {
      const row = await DbArtifactBlobStore.getBySha256(executor, sha256);
      if (!row) return undefined;
      if (row.content !== null) return toResolvedArtifact(row, row.content);

      const bytes = await readArtifactBlobFile(sha256);
      return bytes ? toResolvedArtifact(row, bytes) : undefined;
    },

    remove: async (sha256) => {
      const existed = await DbArtifactBlobStore.delete(executor, sha256);
      await removeArtifactBlobFileIfExists(sha256);
      return existed;
    },

    list: async (prefix) => {
      const blobs = await DbArtifactBlobStore.listBySha256Prefix(executor, prefix);
      return blobs.map(toArtifactReference);
    },
  };
}
