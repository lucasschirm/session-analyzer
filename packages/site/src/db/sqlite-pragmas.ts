/**
 * Shared SQLite PRAGMA configuration for OPFS/WASM databases.
 *
 * Configures optimal page size, RAM cache, journal mode, and temp storage
 * across both the control database (`DatabaseManager`) and the analytics
 * database (`WasmSqliteExecutor`).
 */

import type { Database } from '@sqlite.org/sqlite-wasm';

export const OPFS_PAGE_SIZE = 4096;
export const OPFS_CACHE_SIZE_KIB = -262144; // 256 MiB RAM cache
export const OPFS_JOURNAL_MODE = 'TRUNCATE';
export const OPFS_SYNCHRONOUS = 'NORMAL';
export const OPFS_TEMP_STORE = 'MEMORY';

export interface PragmaOptions {
  pageSize?: number;
  cacheSize?: number;
  journalMode?: string;
  synchronous?: string;
  tempStore?: string;
  foreignKeys?: boolean;
}

/**
 * Applies the standard performance and durability PRAGMAs to an open SQLite database.
 * Returns the effective active journal_mode (e.g. 'truncate' or 'memory').
 */
export function applyStandardOpfsPragmas(db: Database, options: PragmaOptions = {}): string {
  const pageSize = options.pageSize ?? OPFS_PAGE_SIZE;
  const cacheSize = options.cacheSize ?? OPFS_CACHE_SIZE_KIB;
  const journalMode = options.journalMode ?? OPFS_JOURNAL_MODE;
  const synchronous = options.synchronous ?? OPFS_SYNCHRONOUS;
  const tempStore = options.tempStore ?? OPFS_TEMP_STORE;
  const foreignKeys = options.foreignKeys ?? true;

  db.exec(`PRAGMA page_size = ${pageSize};`);
  if (foreignKeys) {
    db.exec('PRAGMA foreign_keys = ON;');
  }
  db.exec(`PRAGMA journal_mode = ${journalMode};`);
  db.exec(`PRAGMA synchronous = ${synchronous};`);
  db.exec(`PRAGMA cache_size = ${cacheSize};`);
  db.exec(`PRAGMA temp_store = ${tempStore};`);

  const rows = db.exec({
    sql: 'PRAGMA journal_mode',
    returnValue: 'resultRows',
    resultRows: [],
    rowMode: 'object',
  }) as Array<{ journal_mode?: unknown }>;

  return String(rows[0]?.journal_mode ?? 'memory').toLowerCase();
}
