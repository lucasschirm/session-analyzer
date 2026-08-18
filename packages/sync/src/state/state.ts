import * as fsp from 'node:fs/promises';
import path from 'node:path';

import type { ArtifactIdentity, ArtifactScope } from '../artifact.js';
import { SYNC_ERROR_CATALOG, type SyncErrorCode } from '../errors.js';
import type { SessionData } from '../session.js';
import { FileLock, type LockOptions, SyncStateError } from './lock.js';

export const STATE_SCHEMA_VERSION = 1;

export type ArtifactStateStatus =
  | 'discovered'
  | 'sanitized'
  | 'hashed'
  | 'uploading'
  | 'uploaded'
  | 'failed';

export interface ArtifactStateRecord {
  projectId: string;
  sessionId: string;
  scope: ArtifactScope;
  relativePath: string;
  lastDiscoveredHash: string;
  lastUploadedHash?: string;
  lastUploadedAt?: string;
  lastError?: SyncErrorCode;
  attemptCount: number;
  status: ArtifactStateStatus;
}

export interface SyncState {
  version: number;
  artifacts: Record<string, ArtifactStateRecord>;
  errors?: SyncErrorCode[];
}

export interface StateStoreOptions {
  lockOptions?: LockOptions;
}

function safeSessionId(sessionId: string): string {
  if (!sessionId) {
    throw new SyncStateError('SYNC_STATE_ERROR', 'sessionId is required');
  }
  return encodeURIComponent(sessionId);
}

function isSyncState(value: unknown): value is SyncState {
  return (
    typeof value === 'object' &&
    value !== null &&
    'version' in value &&
    typeof (value as SyncState).version === 'number' &&
    'artifacts' in value &&
    typeof (value as SyncState).artifacts === 'object' &&
    (value as SyncState).artifacts !== null
  );
}

function isSessionData(value: unknown): value is SessionData {
  return (
    typeof value === 'object' &&
    value !== null &&
    'sessionId' in value &&
    typeof (value as SessionData).sessionId === 'string' &&
    'projectId' in value &&
    typeof (value as SessionData).projectId === 'string' &&
    'harness' in value &&
    typeof (value as SessionData).harness === 'string' &&
    'harnessVersion' in value &&
    typeof (value as SessionData).harnessVersion === 'string'
  );
}

/** Write data to a temp file, fsync it, then atomically rename it into place. */
export async function writeFileAtomic(filePath: string, data: string): Promise<void> {
  const dir = path.dirname(filePath);
  await fsp.mkdir(dir, { recursive: true });

  // Use a unique temp file per call so concurrent writes to the same target
  // do not clobber each other's temp file (which would cause ENOENT on rename).
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  let handle: fsp.FileHandle | undefined;
  try {
    handle = await fsp.open(tempPath, 'w', 0o644);
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle?.close();
  }

  // We fsync the temp file but do not fsync the parent directory after rename,
  // which is a known durability limitation on some filesystems.
  try {
    await fsp.rename(tempPath, filePath);
  } catch (err) {
    await fsp.unlink(tempPath).catch(() => {});
    throw new SyncStateError(
      'SYNC_STATE_ERROR',
      `Atomic rename failed for ${filePath}: ${(err as Error).message}`,
      err,
    );
  }
}

/** Build a stable key for an artifact state record from its identity. */
export function artifactStateKey(
  artifact: Pick<ArtifactIdentity, 'projectId' | 'sessionId' | 'scope' | 'relativePath'>,
): string {
  return JSON.stringify([
    artifact.projectId,
    artifact.sessionId,
    artifact.scope,
    artifact.relativePath,
  ]);
}

/** Create a fresh, empty sync state. */
export function createEmptySyncState(): SyncState {
  return { version: STATE_SCHEMA_VERSION, artifacts: {} };
}

/** Return the stored record for an artifact, or undefined if none exists. */
export function getArtifactRecord(
  state: SyncState,
  artifact: ArtifactIdentity,
): ArtifactStateRecord | undefined {
  return state.artifacts[artifactStateKey(artifact)];
}

/** Determine whether an artifact has outstanding work based on its current hash. */
export function isArtifactPending(
  record: ArtifactStateRecord | undefined,
  currentHash: string,
): boolean {
  if (!record) return true;
  if (record.lastUploadedHash === undefined) return true;
  return record.lastUploadedHash !== currentHash;
}

/** Filter a list of artifacts to only those whose hash differs from lastUploadedHash. */
export function getPendingArtifacts(
  state: SyncState,
  artifacts: ArtifactIdentity[],
): ArtifactIdentity[] {
  return artifacts.filter((artifact) =>
    isArtifactPending(getArtifactRecord(state, artifact), artifact.sha256),
  );
}

function updateArtifactRecord(
  state: SyncState,
  artifact: ArtifactIdentity,
  patch: Partial<ArtifactStateRecord> & { status: ArtifactStateStatus },
): ArtifactStateRecord {
  const key = artifactStateKey(artifact);
  const existing = state.artifacts[key];
  const isNewVersion = !existing || existing.lastDiscoveredHash !== artifact.sha256;

  const record: ArtifactStateRecord = {
    projectId: artifact.projectId,
    sessionId: artifact.sessionId,
    scope: artifact.scope,
    relativePath: artifact.relativePath,
    lastDiscoveredHash: artifact.sha256,
    lastUploadedHash: existing?.lastUploadedHash,
    lastUploadedAt: existing?.lastUploadedAt,
    lastError: isNewVersion ? undefined : existing.lastError,
    attemptCount: isNewVersion ? 0 : (existing.attemptCount ?? 0),
    ...patch,
  };

  state.artifacts[key] = record;
  return record;
}

export function recordArtifactState(
  state: SyncState,
  artifact: ArtifactIdentity,
  status: ArtifactStateStatus,
): ArtifactStateRecord {
  return updateArtifactRecord(state, artifact, { status });
}

export function recordArtifactDiscovered(
  state: SyncState,
  artifact: ArtifactIdentity,
): ArtifactStateRecord {
  return recordArtifactState(state, artifact, 'discovered');
}

export function recordArtifactSanitized(
  state: SyncState,
  artifact: ArtifactIdentity,
): ArtifactStateRecord {
  return recordArtifactState(state, artifact, 'sanitized');
}

export function recordArtifactHashed(
  state: SyncState,
  artifact: ArtifactIdentity,
): ArtifactStateRecord {
  return recordArtifactState(state, artifact, 'hashed');
}

export function recordArtifactUploading(
  state: SyncState,
  artifact: ArtifactIdentity,
): ArtifactStateRecord {
  return recordArtifactState(state, artifact, 'uploading');
}

/** Mark an artifact as successfully uploaded and advance lastUploadedHash. */
export function recordArtifactUploaded(
  state: SyncState,
  artifact: ArtifactIdentity,
  hash?: string,
  uploadedAt?: string,
): ArtifactStateRecord {
  const uploadedHash = hash ?? artifact.sha256;
  const uploadedAtTime = uploadedAt ?? new Date().toISOString();
  return updateArtifactRecord(state, artifact, {
    status: 'uploaded',
    lastUploadedHash: uploadedHash,
    lastUploadedAt: uploadedAtTime,
    lastError: undefined,
    attemptCount: 0,
  });
}

/** Convenience alias for advancing lastUploadedHash after a confirmed upload. */
export function advanceLastUploadedHash(
  state: SyncState,
  artifact: ArtifactIdentity,
  hash?: string,
  uploadedAt?: string,
): ArtifactStateRecord {
  return recordArtifactUploaded(state, artifact, hash, uploadedAt);
}

/** Record a failed upload, incrementing attemptCount and storing the error code. */
export function recordArtifactFailure(
  state: SyncState,
  artifact: ArtifactIdentity,
  error: SyncErrorCode,
): ArtifactStateRecord {
  const existing = getArtifactRecord(state, artifact);
  const isNewVersion = !existing || existing.lastDiscoveredHash !== artifact.sha256;
  const nextAttempt = isNewVersion ? 1 : existing.attemptCount + 1;
  return updateArtifactRecord(state, artifact, {
    status: 'failed',
    lastError: error,
    attemptCount: nextAttempt,
  });
}

/**
 * Durable state store for the sync engine.
 *
 * The store owns the directory tree under a persistent data directory and
 * coordinates concurrent access to `state/state.json` via a global file lock.
 * Per-session records are stored under `sessions/<session-id>/session.json` and
 * protected by per-session file locks.
 */
export class StateStore {
  private readonly dataDir: string;
  private readonly stateLock: FileLock;
  private readonly lockOptions: LockOptions;
  private readonly sessionLockCache = new Map<string, FileLock>();
  private directoriesEnsured = false;

  constructor(dataDir: string, options?: StateStoreOptions) {
    this.dataDir = dataDir;
    this.lockOptions = options?.lockOptions ?? {};
    this.stateLock = new FileLock(path.join(dataDir, 'locks', 'state.lock'), this.lockOptions);
  }

  /** Create the persistent directory tree if it does not already exist. */
  async ensureDirectories(): Promise<void> {
    await this.ensureDirs();
  }

  /**
   * Read durable state. Corrupt state is moved aside and an empty state is returned.
   * This is a best-effort unlocked read; callers needing consistency should use withState.
   */
  async readState(): Promise<SyncState> {
    await this.ensureDirs();
    return this.loadState();
  }

  /**
   * Run a callback under the global state lock.
   *
   * The callback receives the current in-memory state, may mutate it, and the
   * store atomically persists the state after the callback completes. If the
   * callback throws, no state is written.
   */
  async withState<T>(updater: (state: SyncState) => Promise<T> | T): Promise<T> {
    return this.stateLock.withLock(async () => {
      const state = await this.loadState();
      const result = await updater(state);
      await this.saveState(state);
      return result;
    });
  }

  /** Write or overwrite the session record for a session, protected by a per-session lock. */
  async setSession(sessionId: string, data: SessionData): Promise<void> {
    await this.getSessionLock(sessionId).withLock(async () => {
      await writeFileAtomic(this.sessionPath(sessionId), JSON.stringify(data, null, 2));
    });
  }

  /** Read the session record for a session, or undefined if none exists. */
  async getSession(sessionId: string): Promise<SessionData | undefined> {
    const filePath = this.sessionPath(sessionId);
    try {
      const raw = await fsp.readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (!isSessionData(parsed)) {
        throw new Error('Invalid session shape');
      }
      return parsed;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return undefined;
      }
      throw new SyncStateError(
        'SYNC_STATE_ERROR',
        `Failed to read session ${sessionId}: ${(err as Error).message}`,
        err,
      );
    }
  }

  private statePath(): string {
    return path.join(this.dataDir, 'state', 'state.json');
  }

  private sessionPath(sessionId: string): string {
    return path.join(this.dataDir, 'sessions', safeSessionId(sessionId), 'session.json');
  }

  private getSessionLock(sessionId: string): FileLock {
    const safe = safeSessionId(sessionId);
    let lock = this.sessionLockCache.get(safe);
    if (!lock) {
      lock = new FileLock(path.join(this.dataDir, 'locks', `${safe}.lock`), this.lockOptions);
      this.sessionLockCache.set(safe, lock);
    }
    return lock;
  }

  private async ensureDirs(): Promise<void> {
    if (this.directoriesEnsured) return;

    await fsp.mkdir(path.join(this.dataDir, 'state'), { recursive: true });
    await fsp.mkdir(path.join(this.dataDir, 'sessions'), { recursive: true });
    await fsp.mkdir(path.join(this.dataDir, 'locks'), { recursive: true });
    await fsp.mkdir(path.join(this.dataDir, 'watcher'), { recursive: true });
    await fsp.mkdir(path.join(this.dataDir, 'logs'), { recursive: true });

    this.directoriesEnsured = true;
  }

  private async loadState(): Promise<SyncState> {
    const filePath = this.statePath();

    try {
      const raw = await fsp.readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (!isSyncState(parsed)) {
        throw new Error('Invalid state shape');
      }
      if (parsed.errors === undefined) {
        parsed.errors = [];
      }
      return parsed;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return createEmptySyncState();
      }

      if (
        err instanceof SyntaxError ||
        (err instanceof Error && err.message === 'Invalid state shape')
      ) {
        const corruptPath = `${filePath}.corrupt-${Date.now()}`;
        try {
          await fsp.rename(filePath, corruptPath);
        } catch {
          // Best effort: if we cannot preserve the corrupt file, continue.
        }

        const empty = createEmptySyncState();
        empty.errors = [SYNC_ERROR_CATALOG.SYNC_STATE_CORRUPT.code];
        return empty;
      }

      throw new SyncStateError(
        'SYNC_STATE_ERROR',
        `Failed to read state: ${(err as Error).message}`,
        err,
      );
    }
  }

  private async saveState(state: SyncState): Promise<void> {
    const persistable = {
      version: state.version,
      artifacts: state.artifacts,
      errors: state.errors,
    };
    await writeFileAtomic(this.statePath(), JSON.stringify(persistable, null, 2));
  }
}
