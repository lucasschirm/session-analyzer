import type { Database, PreparedStatement } from '@sqlite.org/sqlite-wasm';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';

import {
  type AdapterBackend,
  DEFAULT_JOURNAL_MODE,
  type MaybePromise,
  REQUIRED_PRAGMAS,
  type SqliteExecResult,
  type SqliteExecutionOptions,
  type SqliteExecutor,
  type SqliteRow,
  type SqliteStatement,
  type SqliteTransaction,
  SUPPORTED_SQL_FEATURES,
} from '../../src/index.js';

let sqlite3Promise: ReturnType<typeof sqlite3InitModule> | null = null;

export async function getSqlite3(): Promise<ReturnType<typeof sqlite3InitModule>> {
  if (!sqlite3Promise) {
    sqlite3Promise = sqlite3InitModule();
  }
  return sqlite3Promise;
}

export function makeWasmBackend(): AdapterBackend {
  return {
    backendName: 'wasm-memory',
    durability: 'ephemeral',
    journalMode: 'memory',
    supports: {
      integersAsBigint: false,
      blob: true,
      preparedStatements: true,
      foreignKeys: true,
      wal: false,
      nestedTransactions: true,
      concurrentTransactions: false,
      cancellation: false,
      busyTimeout: false,
      durable: false,
      sharedMemory: false,
      sql: {
        features: SUPPORTED_SQL_FEATURES,
        maxBoundParameters: 999,
        maxSqlLength: 1_000_000,
        maxColumnNameLength: 128,
      },
    },
    requiredPragmas: REQUIRED_PRAGMAS,
    defaultPragmas: { ...REQUIRED_PRAGMAS, journal_mode: DEFAULT_JOURNAL_MODE },
  };
}

function toBigInt(value: SqliteValue | undefined): bigint {
  if (value === null || value === undefined) return 0n;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(value);
  if (typeof value === 'boolean') return value ? 1n : 0n;
  if (value instanceof Uint8Array) return 0n;
  return BigInt(String(value));
}

function readRowsFromExec(result: Record<string, SqliteValue>[]): SqliteRow[] {
  return result as SqliteRow[];
}

function lastInsertRowIdFromDb(db: Database): bigint {
  const rows = db.exec({
    sql: 'SELECT last_insert_rowid() AS id',
    returnValue: 'resultRows',
    resultRows: [],
    rowMode: 'object',
  }) as Record<string, SqliteValue>[];
  if (rows.length === 0) return 0n;
  return toBigInt(rows[0].id);
}

export class WasmSqliteStatement implements SqliteStatement {
  constructor(
    private readonly db: Database,
    private readonly stmt: PreparedStatement,
  ) {}

  run(params?: readonly SqliteValue[]): SqliteExecResult {
    this.stmt.bind(params ?? []);
    const rows: SqliteRow[] = [];
    while (this.stmt.step()) {
      rows.push(this.readRow());
    }
    this.stmt.reset();
    const changes = this.db.changes();
    const lastInsertRowId = changes > 0 ? lastInsertRowIdFromDb(this.db) : 0n;
    return { rows, changes, lastInsertRowId };
  }

  all(params?: readonly SqliteValue[]): SqliteRow[] {
    this.stmt.bind(params ?? []);
    const rows: SqliteRow[] = [];
    while (this.stmt.step()) {
      rows.push(this.readRow());
    }
    this.stmt.reset();
    return rows;
  }

  get(params?: readonly SqliteValue[]): SqliteRow | undefined {
    this.stmt.bind(params ?? []);
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

  private readRow(): SqliteRow {
    const count = this.stmt.columnCount;
    const names = this.stmt.getColumnNames();
    const row: Record<string, SqliteValue> = {};
    for (let i = 0; i < count; i++) {
      row[names[i]] = this.stmt.get(i) as SqliteValue;
    }
    return row as SqliteRow;
  }
}

export class WasmSqliteTransaction implements SqliteTransaction {
  readonly id: number;
  readonly backend: AdapterBackend;
  readonly isActive = true;
  readonly nestingLevel: number;

  constructor(
    private readonly executor: WasmSqliteExecutor,
    private readonly db: Database,
    id: number,
    nestingLevel: number,
  ) {
    this.id = id;
    this.backend = executor.backend;
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
    this.db.exec(`SAVEPOINT ${quoteSavepoint(name)}`);
  }

  releaseSavepoint(name: string): MaybePromise<void> {
    this.db.exec(`RELEASE SAVEPOINT ${quoteSavepoint(name)}`);
  }

  rollbackToSavepoint(name: string): MaybePromise<void> {
    this.db.exec(`ROLLBACK TO SAVEPOINT ${quoteSavepoint(name)}`);
  }

  commit(): MaybePromise<void> {
    throw new Error('Use the transaction callback return value to commit; do not call tx.commit()');
  }

  rollback(): MaybePromise<void> {
    throw new Error('Throw from the transaction callback to roll back; do not call tx.rollback()');
  }
}

function quoteSavepoint(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Invalid savepoint name: ${name}`);
  }
  return `"${name.replace(/"/g, '""')}"`;
}

let transactionCounter = 0;

export class WasmSqliteExecutor implements SqliteExecutor {
  readonly backend: AdapterBackend;
  private db: Database;
  private closed = false;
  private nestingLevel = 0;
  private savepointCounter = 0;

  constructor(db: Database) {
    this.db = db;
    this.backend = makeWasmBackend();
    this.applyPragmas();
  }

  static async create(): Promise<WasmSqliteExecutor> {
    const sqlite3 = await getSqlite3();
    const db = new sqlite3.oo1.DB(':memory:', 'c');
    return new WasmSqliteExecutor(db);
  }

  exec(
    sql: string,
    params?: readonly SqliteValue[],
    _options?: SqliteExecutionOptions,
  ): SqliteExecResult {
    this.guardOpen();
    const rows = this.db.exec({
      sql,
      bind: params,
      returnValue: 'resultRows',
      resultRows: [],
      rowMode: 'object',
    }) as Record<string, SqliteValue>[];
    const changes = this.db.changes();
    const lastInsertRowId = changes > 0 ? lastInsertRowIdFromDb(this.db) : 0n;
    return { rows: readRowsFromExec(rows), changes, lastInsertRowId };
  }

  prepare(sql: string): SqliteStatement {
    return new WasmSqliteStatement(this.db, this.db.prepare(sql));
  }

  transaction<T>(
    callback: (tx: SqliteTransaction) => MaybePromise<T>,
    _options?: SqliteExecutionOptions,
  ): MaybePromise<T> {
    return new Promise((resolve, reject) => {
      this.guardOpen();
      const isNested = this.nestingLevel > 0;
      let savepointName: string | undefined;
      let beginSql: string;
      if (isNested) {
        savepointName = `sp_${this.nestingLevel}_${++this.savepointCounter}`;
        beginSql = `SAVEPOINT ${quoteSavepoint(savepointName)}`;
      } else {
        beginSql = 'BEGIN';
      }

      try {
        this.db.exec(beginSql);
      } catch (error) {
        reject(error);
        return;
      }

      this.nestingLevel++;
      const tx = new WasmSqliteTransaction(this, this.db, ++transactionCounter, this.nestingLevel);

      const endTransaction = (value: T) => {
        this.nestingLevel--;
        const endSql = savepointName
          ? `RELEASE SAVEPOINT ${quoteSavepoint(savepointName)}`
          : 'COMMIT';
        try {
          this.db.exec(endSql);
          resolve(value);
        } catch (error) {
          reject(error);
        }
      };

      const failTransaction = (error: unknown) => {
        this.nestingLevel--;
        const rollbackSql = savepointName
          ? `ROLLBACK TO SAVEPOINT ${quoteSavepoint(savepointName)}`
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
    this.db.close();
    this.closed = true;
  }

  isBusy(): boolean {
    return false;
  }

  isClosed(): boolean {
    return this.closed;
  }

  private applyPragmas(): void {
    for (const [name, value] of Object.entries(REQUIRED_PRAGMAS)) {
      this.db.exec(`PRAGMA ${name} = ${value};`);
    }
  }

  private guardOpen(): void {
    if (this.closed) {
      throw new Error('Executor is closed');
    }
  }
}
