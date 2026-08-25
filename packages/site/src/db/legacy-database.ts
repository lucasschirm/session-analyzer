/**
 * Legacy database accessor.
 *
 * Opens the pre-split `session-analyzer.sqlite3` in a separate read-only
 * connection so its OPFS lock is independent from the new split databases.
 * It is only used during the bounded rollback window while the analytics
 * cutover can still be reversed.
 */

import type { Database } from '@sqlite.org/sqlite-wasm';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import type { FallbackReason, StorageBackend } from './database';

export class LegacyDatabase {
  private db: Database | null = null;
  private sqlite3: Awaited<ReturnType<typeof sqlite3InitModule>> | null = null;
  storage: StorageBackend = 'memory';
  fallbackReason?: FallbackReason;

  constructor(sqlite3?: Awaited<ReturnType<typeof sqlite3InitModule>> | null) {
    this.sqlite3 = sqlite3 ?? null;
  }

  /**
   * Opens the legacy database in read-only mode.
   *
   * When OPFS is available the file is opened with the `r` flag so the VFS
   * does not create a new database if the legacy file is missing. If OPFS is
   * unavailable the default VFS is used (a real file in Node, or a
   * browser-specific fallback); a missing file is reported as an error rather
   * than silently creating an empty database.
   */
  async initialize(filename = '/session-analyzer.sqlite3'): Promise<StorageBackend> {
    if (this.db) return this.storage;

    if (!this.sqlite3) {
      this.sqlite3 = await sqlite3InitModule();
    }
    const sqlite3 = this.sqlite3;

    if (sqlite3.oo1.OpfsDb) {
      try {
        this.db = new sqlite3.oo1.OpfsDb(filename, 'r');
        this.storage = 'opfs';
      } catch (error) {
        if (isOpfsLockedError(error, sqlite3.capi)) {
          this.fallbackReason = 'locked';
          this.db = new sqlite3.oo1.DB(':memory:', 'c');
          this.storage = 'memory';
        } else {
          throw error;
        }
      }
    } else {
      this.db = new sqlite3.oo1.DB(filename, 'r');
      this.storage = 'memory';
      this.fallbackReason = 'unsupported';
    }

    this.db.exec('PRAGMA foreign_keys = ON;');
    return this.storage;
  }

  /** Serializes the legacy database as bytes. */
  exportDatabase(): Uint8Array {
    const db = this.db;
    const sqlite3 = this.sqlite3;
    if (!db || !sqlite3 || !db.pointer) throw new Error('Legacy database not initialized');
    return sqlite3.capi.sqlite3_js_db_export(db.pointer);
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

interface CapiLike {
  readonly SQLITE_BUSY: number;
  readonly SQLITE_IOERR: number;
  readonly SQLITE_LOCKED: number;
}

const LOCKED_MESSAGE_RE =
  /NoModificationAllowedError|Access Handles cannot|busy|locked|already in use/i;

function isLockedMessage(name: unknown, message: unknown): boolean {
  if (typeof message === 'string' && LOCKED_MESSAGE_RE.test(message)) {
    return true;
  }
  return name === 'NoModificationAllowedError' || name === 'InvalidStateError';
}

function isOpfsLockedError(error: unknown, capi: CapiLike): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { resultCode?: unknown; name?: unknown; message?: unknown; cause?: unknown };
  const resultCode = typeof e.resultCode === 'number' ? e.resultCode : undefined;
  if (resultCode !== undefined) {
    const primary = resultCode & 0xff;
    if (
      primary === capi.SQLITE_BUSY ||
      primary === capi.SQLITE_LOCKED ||
      primary === capi.SQLITE_IOERR
    ) {
      return true;
    }
  }
  if (isLockedMessage(e.name, e.message)) return true;
  const cause = e.cause;
  if (cause && typeof cause === 'object') {
    const c = cause as { name?: unknown; message?: unknown };
    if (isLockedMessage(c.name, c.message)) return true;
  }
  return false;
}
