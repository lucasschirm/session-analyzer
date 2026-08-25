/**
 * SQLite WASM executor adapter for the db-core contract.
 *
 * Implements `SqliteExecutor`/`SqliteTransaction` using `@sqlite.org/sqlite-wasm`,
 * with OPFS persistence when available and an in-memory fallback when OPFS or
 * SharedArrayBuffer is unavailable. The adapter always reports its actual
 * backend (`wasm-opfs` or `wasm-memory`) and durability so callers do not
 * silently assume persistence.
 */

import type {
  AdapterBackend,
  MaybePromise,
  SqliteCancellationToken,
  SqliteExecResult,
  SqliteExecutionOptions,
  SqliteExecutor,
  SqliteRow,
  SqliteStatement,
  SqliteTransaction,
  SqliteValue,
} from '@lucasschirm/sal-db-core';
import {
  DEFAULT_JOURNAL_MODE,
  REQUIRED_PRAGMAS,
  SUPPORTED_SQL_FEATURES,
} from '@lucasschirm/sal-db-core';
import type {
  BindableValue,
  Database,
  PreparedStatement,
  SqlValue as WasmSqlValue,
} from '@sqlite.org/sqlite-wasm';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';

export type WasmBackendName = 'wasm-opfs' | 'wasm-memory';
export type FallbackReason = 'locked' | 'unsupported' | undefined;

interface Sqlite3Capi {
  readonly SQLITE_BUSY: number;
  readonly SQLITE_IOERR: number;
  readonly SQLITE_LOCKED: number;
  sqlite3_last_insert_rowid(db: unknown): bigint;
}

interface Sqlite3Module {
  readonly oo1: {
    readonly OpfsDb?: typeof Database;
    readonly DB: typeof Database;
  };
  readonly capi: Sqlite3Capi;
  readonly config: {
    readonly bigIntEnabled: boolean;
  };
}

let sqlite3Promise: Promise<Sqlite3Module> | null = null;

export async function getSqlite3Module(): Promise<Sqlite3Module> {
  if (!sqlite3Promise) {
    sqlite3Promise = sqlite3InitModule() as Promise<Sqlite3Module>;
  }
  return sqlite3Promise;
}

interface OpenDatabaseResult {
  readonly db: Database;
  readonly backendName: WasmBackendName;
  readonly fallbackReason: FallbackReason;
}

const LOCKED_MESSAGE_RE =
  /NoModificationAllowedError|Access Handles cannot|busy|locked|already in use/i;

function isLockedMessage(name: unknown, message: unknown): boolean {
  if (typeof message === 'string' && LOCKED_MESSAGE_RE.test(message)) {
    return true;
  }
  return name === 'NoModificationAllowedError' || name === 'InvalidStateError';
}

function isOpfsLockedError(error: unknown, capi: Sqlite3Capi): boolean {
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

function openDatabase(
  sqlite3: Sqlite3Module,
  filename: string,
  preferOpfs: boolean,
): OpenDatabaseResult {
  if (preferOpfs && sqlite3.oo1.OpfsDb) {
    try {
      const db = new sqlite3.oo1.OpfsDb(filename, 'c');
      return { db, backendName: 'wasm-opfs', fallbackReason: undefined };
    } catch (error) {
      if (isOpfsLockedError(error, sqlite3.capi)) {
        return openInMemory(sqlite3, 'locked');
      }
      throw error;
    }
  }

  return openInMemory(sqlite3, preferOpfs ? 'unsupported' : undefined);
}

function openInMemory(sqlite3: Sqlite3Module, fallbackReason?: FallbackReason): OpenDatabaseResult {
  const db = new sqlite3.oo1.DB(':memory:', 'c');
  return { db, backendName: 'wasm-memory', fallbackReason };
}

function quoteSavepointName(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Invalid savepoint name: ${name}`);
  }
  return `"${name.replace(/"/g, '""')}"`;
}

function normalizeBindValue(value: SqliteValue | undefined): BindableValue {
  return value === undefined ? null : (value as BindableValue);
}

function normalizeBindParams(params?: readonly SqliteValue[]): BindableValue[] {
  return params ? params.map(normalizeBindValue) : [];
}

let transactionCounter = 0;

export class WasmSqliteStatement implements SqliteStatement {
  private readonly db: Database;
  private readonly stmt: PreparedStatement;
  private readonly sqlite3: Sqlite3Module;

  constructor(db: Database, stmt: PreparedStatement, sqlite3: Sqlite3Module) {
    this.db = db;
    this.stmt = stmt;
    this.sqlite3 = sqlite3;
  }

  run(params?: readonly SqliteValue[]): SqliteExecResult {
    this.stmt.bind(normalizeBindParams(params));
    const rows: SqliteRow[] = [];
    while (this.stmt.step()) {
      rows.push(this.readRow());
    }
    this.stmt.reset();
    const changes = Number(this.db.changes());
    const lastInsertRowId = changes > 0 ? this.lastInsertRowId() : 0n;
    return { rows, changes, lastInsertRowId };
  }

  all(params?: readonly SqliteValue[]): SqliteRow[] {
    this.stmt.bind(normalizeBindParams(params));
    const rows: SqliteRow[] = [];
    while (this.stmt.step()) {
      rows.push(this.readRow());
    }
    this.stmt.reset();
    return rows;
  }

  get(params?: readonly SqliteValue[]): SqliteRow | undefined {
    this.stmt.bind(normalizeBindParams(params));
    if (!this.stmt.step()) {
      this.stmt.reset();
      return undefined;
    }
    const row = this.readRow();
    this.stmt.reset();
    return row;
  }

  finalize(): void {
    this.stmt.finalize();
  }

  private lastInsertRowId(): bigint {
    if (!this.db.pointer) return 0n;
    return this.sqlite3.capi.sqlite3_last_insert_rowid(this.db.pointer);
  }

  private readRow(): SqliteRow {
    const count = this.stmt.columnCount;
    const names = this.stmt.getColumnNames();
    const row: Record<string, WasmSqlValue> = {};
    for (let i = 0; i < count; i++) {
      row[names[i]] = this.stmt.get(i) as WasmSqlValue;
    }
    return row as SqliteRow;
  }
}

export class WasmSqliteTransaction implements SqliteTransaction {
  readonly id: number;
  readonly backend: AdapterBackend;
  readonly isActive = true;
  readonly nestingLevel: number;

  private readonly executor: WasmSqliteExecutor;
  private readonly db: Database;

  constructor(
    executor: WasmSqliteExecutor,
    db: Database,
    id: number,
    nestingLevel: number,
    backend: AdapterBackend,
  ) {
    this.executor = executor;
    this.db = db;
    this.id = id;
    this.backend = backend;
    this.nestingLevel = nestingLevel;
  }

  exec(
    sql: string,
    params?: readonly SqliteValue[],
    options?: SqliteExecutionOptions,
  ): MaybePromise<SqliteExecResult> {
    return this.executor.exec(sql, params, options);
  }

  prepare(sql: string): SqliteStatement {
    return this.executor.prepare(sql);
  }

  savepoint(name: string): MaybePromise<void> {
    this.db.exec(`SAVEPOINT ${quoteSavepointName(name)}`);
  }

  releaseSavepoint(name: string): MaybePromise<void> {
    this.db.exec(`RELEASE SAVEPOINT ${quoteSavepointName(name)}`);
  }

  rollbackToSavepoint(name: string): MaybePromise<void> {
    this.db.exec(`ROLLBACK TO SAVEPOINT ${quoteSavepointName(name)}`);
  }

  commit(): MaybePromise<void> {
    throw new Error('Use the transaction callback return value to commit; do not call tx.commit()');
  }

  rollback(): MaybePromise<void> {
    throw new Error('Throw from the transaction callback to roll back; do not call tx.rollback()');
  }
}

export interface WasmSqliteExecutorOptions {
  filename?: string;
  preferOpfs?: boolean;
}

export class WasmSqliteExecutor implements SqliteExecutor {
  readonly backend: AdapterBackend;
  readonly fallbackReason: FallbackReason;

  private readonly db: Database;
  private readonly sqlite3: Sqlite3Module;
  private readonly filename: string;
  private closed = false;
  private busy = false;
  private nestingLevel = 0;
  private savepointCounter = 0;
  private journalMode = 'memory';
  private lastBusyTimeoutMs?: number;

  constructor(
    db: Database,
    sqlite3: Sqlite3Module,
    backendName: WasmBackendName,
    fallbackReason: FallbackReason,
    filename: string,
  ) {
    this.db = db;
    this.sqlite3 = sqlite3;
    this.fallbackReason = fallbackReason;
    this.filename = filename;
    this.applyPragmas();
    this.backend = buildBackend(sqlite3, backendName, fallbackReason, this.journalMode);
  }

  static async create(options: WasmSqliteExecutorOptions = {}): Promise<WasmSqliteExecutor> {
    const sqlite3 = await getSqlite3Module();
    const filename = options.filename ?? '/session-analytics.sqlite3';
    const preferOpfs = options.preferOpfs !== false;
    const { db, backendName, fallbackReason } = openDatabase(sqlite3, filename, preferOpfs);
    return new WasmSqliteExecutor(db, sqlite3, backendName, fallbackReason, filename);
  }

  exec(
    sql: string,
    params?: readonly SqliteValue[],
    options?: SqliteExecutionOptions,
  ): SqliteExecResult {
    this.guardOpen();
    this.checkCancellation(options?.cancellation);
    this.applyBusyTimeout(options?.busyTimeoutMs);

    const rows = this.db.exec({
      sql,
      bind: normalizeBindParams(params),
      returnValue: 'resultRows',
      resultRows: [],
      rowMode: 'object',
    }) as Record<string, WasmSqlValue>[];

    const changes = Number(this.db.changes());
    const lastInsertRowId = changes > 0 ? this.lastInsertRowId() : 0n;
    return { rows: rows as SqliteRow[], changes, lastInsertRowId };
  }

  prepare(sql: string): SqliteStatement {
    this.guardOpen();
    return new WasmSqliteStatement(this.db, this.db.prepare(sql), this.sqlite3);
  }

  transaction<T>(
    callback: (tx: SqliteTransaction) => MaybePromise<T>,
    options?: SqliteExecutionOptions,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      this.guardOpen();
      this.checkCancellation(options?.cancellation);
      this.applyBusyTimeout(options?.busyTimeoutMs);

      const isNested = this.nestingLevel > 0;
      const savepointName = isNested
        ? `sp_${this.nestingLevel}_${++this.savepointCounter}`
        : undefined;
      const quotedSavepoint = savepointName ? quoteSavepointName(savepointName) : undefined;
      const beginSql = isNested ? `SAVEPOINT ${quotedSavepoint as string}` : 'BEGIN';

      try {
        this.db.exec(beginSql);
      } catch (error) {
        reject(error);
        return;
      }

      this.nestingLevel++;
      this.busy = true;
      const tx = new WasmSqliteTransaction(
        this,
        this.db,
        ++transactionCounter,
        this.nestingLevel,
        this.backend,
      );

      const endTransaction = (value: T) => {
        this.nestingLevel--;
        this.busy = this.nestingLevel > 0;
        const endSql = quotedSavepoint ? `RELEASE SAVEPOINT ${quotedSavepoint}` : 'COMMIT';
        try {
          this.db.exec(endSql);
          resolve(value);
        } catch (error) {
          reject(error);
        }
      };

      const failTransaction = (error: unknown) => {
        this.nestingLevel--;
        this.busy = this.nestingLevel > 0;
        const rollbackSql = quotedSavepoint
          ? `ROLLBACK TO SAVEPOINT ${quotedSavepoint}`
          : 'ROLLBACK';
        try {
          this.db.exec(rollbackSql);
        } catch {
          // Best-effort rollback after an already-failed callback.
        }
        reject(error);
      };

      try {
        const result = callback(tx);
        if (result && typeof result === 'object' && 'then' in result) {
          (result as Promise<T>).then(endTransaction, failTransaction);
        } else {
          endTransaction(result as T);
        }
      } catch (error) {
        failTransaction(error);
      }
    });
  }

  close(): MaybePromise<void> {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
      this.busy = false;
    }
  }

  isBusy(): boolean {
    return this.busy;
  }

  isClosed(): boolean {
    return this.closed;
  }

  private applyPragmas(): void {
    this.db.exec(`PRAGMA foreign_keys = ${REQUIRED_PRAGMAS.foreign_keys};`);
    this.db.exec(`PRAGMA journal_mode = ${DEFAULT_JOURNAL_MODE};`);
    const rows = this.db.exec({
      sql: 'PRAGMA journal_mode',
      returnValue: 'resultRows',
      resultRows: [],
      rowMode: 'object',
    }) as Array<{ journal_mode: WasmSqlValue }>;
    this.journalMode = String(rows[0]?.journal_mode ?? 'memory').toLowerCase();
  }

  private guardOpen(): void {
    if (this.closed) {
      throw new Error('Executor is closed');
    }
  }

  private checkCancellation(cancellation?: SqliteCancellationToken): void {
    if (cancellation?.isCancelled) {
      throw new Error('Execution cancelled');
    }
  }

  private applyBusyTimeout(ms?: number): void {
    if (ms === undefined) return;
    if (ms === this.lastBusyTimeoutMs) return;
    this.lastBusyTimeoutMs = ms;
    const safeMs = Math.max(0, Math.floor(ms));
    this.db.exec(`PRAGMA busy_timeout = ${safeMs};`);
  }

  private lastInsertRowId(): bigint {
    if (!this.db.pointer) return 0n;
    return this.sqlite3.capi.sqlite3_last_insert_rowid(this.db.pointer);
  }
}

function buildBackend(
  sqlite3: Sqlite3Module,
  backendName: WasmBackendName,
  fallbackReason: FallbackReason,
  journalMode: string,
): AdapterBackend {
  const durability = backendName === 'wasm-opfs' && !fallbackReason ? 'persistent' : 'ephemeral';
  const bigIntEnabled = sqlite3.config.bigIntEnabled;

  const sql = {
    features: SUPPORTED_SQL_FEATURES,
    maxBoundParameters: 999,
    maxSqlLength: 1_000_000,
    maxColumnNameLength: 128,
  };

  const supports = {
    integersAsBigint: bigIntEnabled,
    blob: true,
    preparedStatements: true,
    foreignKeys: true,
    wal: journalMode === 'wal',
    nestedTransactions: true,
    concurrentTransactions: false,
    cancellation: true,
    busyTimeout: true,
    durable: durability === 'persistent',
    sharedMemory: backendName === 'wasm-opfs',
    sql,
  };

  return {
    backendName,
    durability,
    journalMode,
    supports,
    requiredPragmas: REQUIRED_PRAGMAS,
    defaultPragmas: { ...REQUIRED_PRAGMAS, journal_mode: journalMode },
  };
}
