import fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import path from 'node:path';

import { SYNC_ERROR_CATALOG, type SyncErrorCode } from '@lucasschirm/sal-sync-core';

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

const DEFAULT_POLL_INTERVAL_MS = 50;
const DEFAULT_ACQUIRE_TIMEOUT_MS = 30_000;
const DEFAULT_STALE_MTIME_THRESHOLD_MS = 5_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * File-based advisory lock using atomic create-with-exclusivity (O_EXCL).
 *
 * The lock file contains the holder's PID and a timestamp. A crashed process
 * is detected via `process.kill(pid, 0)`, and its lock is reclaimed so a
 * subsequent hook or watcher is never deadlocked.
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
    while (true) {
      try {
        this.fd = await fsp.open(
          this.lockFilePath,
          fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
          0o644,
        );
        break;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'EEXIST') {
          if (await this.isStale()) {
            await fsp.unlink(this.lockFilePath).catch(() => {});
            continue;
          }

          if (Date.now() >= deadline) {
            throw new SyncStateError(
              'SYNC_STATE_ERROR',
              `Failed to acquire lock ${this.lockFilePath} within ${this.options.acquireTimeoutMs}ms`,
            );
          }

          await sleep(this.options.pollIntervalMs);
          continue;
        }

        throw new SyncStateError(
          'SYNC_STATE_ERROR',
          `Failed to create lock ${this.lockFilePath}: ${(err as Error).message}`,
          err,
        );
      }
    }

    const content: LockFileContent = { pid: process.pid, startedAt: Date.now() };
    await this.fd.writeFile(JSON.stringify(content));
    await this.fd.sync();
    this.held = true;
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

    try {
      await fsp.unlink(this.lockFilePath);
    } catch {
      // Best effort: another process may have already removed it.
    }
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

  private async isStale(): Promise<boolean> {
    const content = await this.readLockFile();
    if (content) {
      return !this.isProcessAlive(content.pid);
    }

    // The lock file exists but has no parseable content; a process may have
    // crashed before finishing the write. Use the mtime as a safety threshold.
    try {
      const stats = await fsp.stat(this.lockFilePath);
      return Date.now() - stats.mtimeMs > this.options.staleMtimeThresholdMs;
    } catch {
      return false;
    }
  }

  private async readLockFile(): Promise<LockFileContent | undefined> {
    try {
      const raw = await fsp.readFile(this.lockFilePath, 'utf8');
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
