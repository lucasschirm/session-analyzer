import fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import path from 'node:path';

import { SYNC_ERROR_CATALOG, type SyncErrorCode } from '@lucasschirm/sal-sync-core';
import { uniqueSuffix } from './unique-id.js';

export class SyncStateError extends Error {
  constructor(
    public readonly code: SyncErrorCode,
    message?: string,
    cause?: unknown,
  ) {
    super(message ?? SYNC_ERROR_CATALOG[code].description);
    if (cause !== undefined) {
      (this as { cause?: unknown }).cause = cause;
    }
  }
}

export interface LockOptions {
  pollIntervalMs?: number;
  acquireTimeoutMs?: number;
  staleMtimeThresholdMs?: number;
}

interface LockFileContent {
  pid: number;
  startedAt: number;
}

/** A staleness judgment made from a single read of the lock file's state. */
interface LockSnapshot {
  content?: LockFileContent;
  mtimeMs?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 50;
const DEFAULT_ACQUIRE_TIMEOUT_MS = 30_000;
const DEFAULT_STALE_MTIME_THRESHOLD_MS = 5_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Whether a freshly re-read lock's content is the exact same lock generation
 * a prior snapshot observed — used to confirm a stale-lock takeover claimed
 * the file this contender actually judged stale, not one a different holder
 * created in the meantime (see `tryReclaimStaleLock`).
 */
function sameLockIdentity(
  claimed: LockFileContent | undefined,
  observed: LockFileContent | undefined,
): boolean {
  if (!observed) return claimed === undefined;
  return claimed?.pid === observed.pid && claimed?.startedAt === observed.startedAt;
}

/**
 * File-based advisory lock using atomic create-with-exclusivity (O_EXCL).
 *
 * The lock file contains the holder's PID and a timestamp. A crashed process
 * is detected via `process.kill(pid, 0)`, and its lock is reclaimed so a
 * subsequent hook or watcher is never deadlocked. Reclaiming a stale lock is
 * atomic (#327): the stale file is renamed aside to a unique name — a single
 * winner among any number of concurrent contenders, since `rename` fails for
 * everyone else once the source path is gone — and its content is
 * re-verified against what was originally judged stale before being
 * discarded, so a takeover can never silently clobber a lock a different
 * contender created in the meantime (see `tryReclaimStaleLock`).
 *
 * The same lock file can be waited on from multiple calls in the same process
 * thanks to an in-process promise queue keyed by lock path.
 */
export class FileLock {
  private static readonly localQueues = new Map<string, Promise<void>>();

  private readonly lockFilePath: string;
  private readonly options: Required<LockOptions>;
  private fd?: fsp.FileHandle;
  private held = false;
  private ownContent?: LockFileContent;

  constructor(lockFilePath: string, options?: LockOptions) {
    this.lockFilePath = lockFilePath;
    this.options = {
      pollIntervalMs: options?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      acquireTimeoutMs: options?.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS,
      staleMtimeThresholdMs: options?.staleMtimeThresholdMs ?? DEFAULT_STALE_MTIME_THRESHOLD_MS,
    };
  }

  /**
   * Acquire the lock, run the callback, and release the lock afterwards.
   * The lock is released even if the callback throws.
   */
  async withLock<T>(fn: () => Promise<T> | T): Promise<T> {
    const releaseTurn = await this.waitTurn();
    try {
      await this.acquire();
      try {
        const result = await fn();
        return result;
      } finally {
        await this.release();
      }
    } finally {
      releaseTurn();
    }
  }

  /** Attempt to acquire the lock, polling until the timeout is reached. */
  async acquire(): Promise<void> {
    if (this.held) {
      throw new SyncStateError(
        'SYNC_STATE_ERROR',
        `Lock already held by this instance: ${this.lockFilePath}`,
      );
    }

    await fsp.mkdir(path.dirname(this.lockFilePath), { recursive: true });
    const deadline = Date.now() + this.options.acquireTimeoutMs;

    let fd = await this.tryCreateLockFile();
    while (!fd) {
      await this.handleCreateContention(deadline);
      fd = await this.tryCreateLockFile();
    }

    this.fd = fd;
    await this.writeLockContent(fd);
    this.held = true;
  }

  /** Attempt the O_EXCL create; `undefined` on EEXIST, throws on any other error. */
  private async tryCreateLockFile(): Promise<fsp.FileHandle | undefined> {
    try {
      return await fsp.open(
        this.lockFilePath,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
        0o644,
      );
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        return undefined;
      }
      throw new SyncStateError(
        'SYNC_STATE_ERROR',
        `Failed to create lock ${this.lockFilePath}: ${(err as Error).message}`,
        err,
      );
    }
  }

  /**
   * Handle a failed O_EXCL create: try a stale reclaim, else respect the
   * poll interval / deadline. A contender that keeps losing takeover races
   * against other contenders still respects the deadline here, same as one
   * that just finds a live lock — neither path spins.
   */
  private async handleCreateContention(deadline: number): Promise<void> {
    const snapshot = await this.readLockSnapshot();
    if (this.isSnapshotStale(snapshot) && (await this.tryReclaimStaleLock(snapshot))) {
      return;
    }

    if (Date.now() >= deadline) {
      throw new SyncStateError(
        'SYNC_STATE_ERROR',
        `Failed to acquire lock ${this.lockFilePath} within ${this.options.acquireTimeoutMs}ms`,
      );
    }

    await sleep(this.options.pollIntervalMs);
  }

  /**
   * Atomically take over a lock file judged stale (#327).
   *
   * A blind unlink would race: a second contender that also judged the (old)
   * lock stale could delete a fresh lock a first contender just created, and
   * both would then hold the lock. `rename` is atomic and single-winner —
   * every contender but one gets `ENOENT` — so only one contender ever
   * proceeds past this point for a given lock generation. That alone is not
   * enough: the winner must also confirm the file it renamed away is really
   * the same stale generation it judged (not a live lock some other,
   * newer-arriving contender created between this contender's read and its
   * rename); on a mismatch the claim is restored rather than discarded.
   * Returns `true` only when this call may proceed to create a fresh lock.
   */
  private async tryReclaimStaleLock(snapshot: LockSnapshot): Promise<boolean> {
    const claimPath = `${this.lockFilePath}.stale-${uniqueSuffix()}`;
    if (!(await this.renameAside(claimPath))) {
      return false;
    }

    const claimed = await this.readLockFile(claimPath);
    if (!sameLockIdentity(claimed, snapshot.content)) {
      await this.restoreClaim(claimPath);
      return false;
    }

    await fsp.unlink(claimPath).catch(() => {});
    return true;
  }

  /** Rename the lock file aside; `false` (lost the race) on ENOENT. */
  private async renameAside(claimPath: string): Promise<boolean> {
    try {
      await fsp.rename(this.lockFilePath, claimPath);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return false;
      }
      throw new SyncStateError(
        'SYNC_STATE_ERROR',
        `Failed to reclaim stale lock ${this.lockFilePath}: ${(err as Error).message}`,
        err,
      );
    }
  }

  /**
   * Put back a claimed file that turned out not to match the staleness
   * judgment that triggered the claim (a different, newer holder's lock).
   *
   * Uses `link`, not `rename`, deliberately: `rename` to an existing
   * destination silently *replaces* it (standard POSIX semantics), which
   * would let a restore clobber a legitimate new holder's lock if one was
   * created at this path while the mismatch was being resolved. `link`
   * fails with `EEXIST` instead of replacing, so a re-occupied path is
   * correctly left alone — the claim file is dropped, which is the only
   * case that error code can mean here.
   *
   * Any *other* failure is deliberately NOT swallowed the same way: it
   * means the restore could not complete for an unrelated reason (a
   * permission or I/O error), not that a legitimate new holder already
   * occupies the path. Silently dropping the claim file in that case would
   * discard the only remaining copy of a live holder's lock content and
   * leave the path empty for the next contender to (incorrectly) claim
   * clean — recreating the exact mutual-exclusion violation this method
   * exists to prevent. The claim file is left in place and the failure
   * propagates, failing this whole `acquire()` attempt loudly instead.
   */
  private async restoreClaim(claimPath: string): Promise<void> {
    try {
      await fsp.link(claimPath, this.lockFilePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        await fsp.unlink(claimPath).catch(() => {});
        return;
      }
      throw new SyncStateError(
        'SYNC_STATE_ERROR',
        `Failed to restore lock ${this.lockFilePath} after a takeover mismatch: ${(err as Error).message}`,
        err,
      );
    }
    await fsp.unlink(claimPath).catch(() => {});
  }

  private async writeLockContent(fd: fsp.FileHandle): Promise<void> {
    const content: LockFileContent = { pid: process.pid, startedAt: Date.now() };
    await fd.writeFile(JSON.stringify(content));
    await fd.sync();
    this.ownContent = content;
  }

  /** Release the lock by closing the file handle and removing the lock file. */
  async release(): Promise<void> {
    if (!this.held) {
      return;
    }

    this.held = false;

    try {
      await this.fd?.close();
    } catch {
      // Best effort: the process is releasing the lock.
    }
    this.fd = undefined;

    await this.unlinkOwnLockFile();
    this.ownContent = undefined;
  }

  /**
   * Remove the lock file, but only if it still holds the content this
   * instance itself wrote. In a rare adversarial interleaving, a
   * stale-takeover elsewhere (`tryReclaimStaleLock`/`restoreClaim`) can
   * leave a different holder's fresh lock occupying this path by the time
   * `release()` runs; unlinking unconditionally would destroy that
   * unrelated holder's lock rather than this instance's own. Best effort,
   * like the rest of `release()`: a failure to read or remove is not
   * surfaced to the caller.
   */
  private async unlinkOwnLockFile(): Promise<void> {
    const current = await this.readLockFile();
    if (current && !sameLockIdentity(current, this.ownContent)) {
      return;
    }
    await fsp.unlink(this.lockFilePath).catch(() => {});
  }

  private async waitTurn(): Promise<() => void> {
    const previous = FileLock.localQueues.get(this.lockFilePath) ?? Promise.resolve();
    let resolveThis: () => void;
    const thisPromise = new Promise<void>((resolve) => {
      resolveThis = resolve;
    });
    FileLock.localQueues.set(
      this.lockFilePath,
      previous.then(() => thisPromise),
    );
    await previous;
    return () => resolveThis();
  }

  /**
   * Read the lock's current content (and mtime, as a fallback signal) in a
   * single pass — kept separate from the staleness judgment itself so a
   * reclaim can re-verify against exactly what this snapshot observed.
   */
  private async readLockSnapshot(): Promise<LockSnapshot> {
    const content = await this.readLockFile();
    if (content) {
      return { content };
    }

    // The lock file exists but has no parseable content; a process may have
    // crashed before finishing the write. Use the mtime as a fallback signal.
    try {
      const stats = await fsp.stat(this.lockFilePath);
      return { mtimeMs: stats.mtimeMs };
    } catch {
      return {};
    }
  }

  /** Pure judgment over an already-read snapshot; no I/O. */
  private isSnapshotStale(snapshot: LockSnapshot): boolean {
    if (snapshot.content) {
      return !this.isProcessAlive(snapshot.content.pid);
    }
    if (snapshot.mtimeMs === undefined) {
      return false;
    }
    return Date.now() - snapshot.mtimeMs > this.options.staleMtimeThresholdMs;
  }

  private async readLockFile(
    filePath: string = this.lockFilePath,
  ): Promise<LockFileContent | undefined> {
    try {
      const raw = await fsp.readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        'pid' in parsed &&
        'startedAt' in parsed
      ) {
        return parsed as LockFileContent;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  private isProcessAlive(pid: number): boolean {
    try {
      return process.kill(pid, 0);
    } catch (err) {
      // EPERM means the process exists but the signal could not be delivered.
      return (err as NodeJS.ErrnoException).code === 'EPERM';
    }
  }
}
