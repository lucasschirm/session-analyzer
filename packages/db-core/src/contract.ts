/**
 * Runtime-independent SQLite capability contract.
 *
 * `sal-db-core` is SQLite-specific but runtime-agnostic. It defines the
 * shape of values, results, statements, transactions, executors, and backend
 * adapters. It contains no runtime SQLite implementation and imports no DOM,
 * Web Worker, OPFS, `node:`, or `@sqlite.org/sqlite-wasm` modules.
 */

export type MaybePromise<T> = T | Promise<T>;

/**
 * Values that can be bound to a SQLite statement or returned from a query.
 *
 * - `bigint` preserves 64-bit INTEGER fidelity.
 * - `Uint8Array` carries BLOB binding and transfer without copying when the
 *   adapter allows it.
 */
export type SqliteValue = null | string | number | bigint | boolean | Uint8Array;

/** A single result row keyed by column name. */
export interface SqliteRow {
  readonly [column: string]: SqliteValue;
}

/** Result shape for an executed SQL statement. */
export interface SqliteExecResult {
  readonly rows: readonly SqliteRow[];
  readonly changes: number;
  readonly lastInsertRowId: bigint;
}

/** A prepared statement handle obtained from a transaction or executor. */
export interface SqliteStatement {
  run(params?: readonly SqliteValue[]): MaybePromise<SqliteExecResult>;
  all(params?: readonly SqliteValue[]): MaybePromise<readonly SqliteRow[]>;
  get(params?: readonly SqliteValue[]): MaybePromise<SqliteRow | undefined>;
  finalize(): MaybePromise<void>;
}

/** Features the SQL dialect is expected to support for analytics queries. */
export type SqliteSqlFeature =
  | 'common-table-expressions'
  | 'window-functions'
  | 'json'
  | 'json1'
  | 'rtree'
  | 'fts5'
  | 'generated-columns'
  | 'strict-tables'
  | 'upsert'
  | 'returning'
  | 'transactional-ddl';

/** Limits and features of the supported SQL dialect. */
export interface SqliteSqlCapabilities {
  readonly features: readonly SqliteSqlFeature[];
  readonly maxBoundParameters: number | 'unlimited';
  readonly maxSqlLength: number | 'unlimited';
  readonly maxColumnNameLength: number;
}

/**
 * Cancellation token used by adapters that support cooperative cancellation.
 *
 * Avoids a dependency on `AbortSignal` so the contract remains isomorphic and
 * does not require DOM or Node global types.
 */
export interface SqliteCancellationToken {
  readonly isCancelled: boolean;
  onCancel(callback: () => void): void;
}

/** Options accepted by transaction and executor methods. */
export interface SqliteExecutionOptions {
  /** Cooperative cancellation token. */
  readonly cancellation?: SqliteCancellationToken;
  /** Milliseconds to wait before treating a busy/locked database as an error. */
  readonly busyTimeoutMs?: number;
  /** Whether the executor should treat unresolved foreign-key checks as fatal. */
  readonly strictForeignKeys?: boolean;
}

/**
 * A transaction-scoped handle.
 *
 * Savepoints may nest. Rolling back to a savepoint must leave outer savepoints
 * intact; releasing a savepoint removes it from the nested stack.
 */
export interface SqliteTransaction {
  readonly id: number | string;
  readonly backend: AdapterBackend;
  readonly isActive: boolean;
  readonly nestingLevel: number;

  exec(
    sql: string,
    params?: readonly SqliteValue[],
    options?: SqliteExecutionOptions,
  ): MaybePromise<SqliteExecResult>;

  prepare(sql: string): SqliteStatement;

  savepoint(name: string): MaybePromise<void>;
  releaseSavepoint(name: string): MaybePromise<void>;
  rollbackToSavepoint(name: string): MaybePromise<void>;

  commit(): MaybePromise<void>;
  rollback(): MaybePromise<void>;
}

/**
 * SQLite executor contract.
 *
 * `transaction` accepts either a synchronous or an asynchronous callback and
 * returns a `Promise` when the callback is async. The executor must keep the
 * connection and any savepoints open until the callback completes, then commit
 * or roll back atomically.
 */
export interface SqliteExecutor {
  readonly backend: AdapterBackend;

  exec(
    sql: string,
    params?: readonly SqliteValue[],
    options?: SqliteExecutionOptions,
  ): MaybePromise<SqliteExecResult>;

  transaction<T>(
    callback: (tx: SqliteTransaction) => MaybePromise<T>,
    options?: SqliteExecutionOptions,
  ): MaybePromise<T>;

  close(): MaybePromise<void>;
  isBusy(): boolean;
  isClosed(): boolean;
}

/** Capability flags reported by an adapter. */
export interface AdapterCapabilities {
  /** The adapter preserves 64-bit SQLite integers as `bigint`. */
  readonly integersAsBigint: boolean;
  /** The adapter supports `Uint8Array` BLOB bind and transfer. */
  readonly blob: boolean;
  /** The adapter supports prepared statements and parameter binding. */
  readonly preparedStatements: boolean;
  /** `PRAGMA foreign_keys` can be enforced. */
  readonly foreignKeys: boolean;
  /** The adapter can set `PRAGMA journal_mode=WAL`. */
  readonly wal: boolean;
  /** Nested savepoints are supported. */
  readonly nestedTransactions: boolean;
  /** Multiple independent transactions can run without manual serialization. */
  readonly concurrentTransactions: boolean;
  /** Cooperative cancellation is implemented. */
  readonly cancellation: boolean;
  /** Busy/lock timeout can be configured. */
  readonly busyTimeout: boolean;
  /** `SharedArrayBuffer` or equivalent cross-context buffer is available. */
  readonly sharedMemory?: boolean;
  /** The adapter reports its durability level. */
  readonly durable: boolean;
  /** Supported SQL dialect features and limits. */
  readonly sql: SqliteSqlCapabilities;
}

/**
 * Backend descriptor.
 *
 * Concrete adapters report a name such as `wasm-opfs`, `wasm-memory`, or
 * `node`, plus their durability level and capability flags. Consumers use this
 * to decide which persistence shortcuts and performance assumptions are safe.
 */
export interface AdapterBackend {
  readonly backendName: 'wasm-opfs' | 'wasm-memory' | 'node' | (string & Record<never, never>);
  readonly durability: 'persistent' | 'ephemeral';
  readonly journalMode: 'wal' | 'delete' | 'truncate' | 'memory' | 'off' | string;
  readonly supports: AdapterCapabilities;
  readonly requiredPragmas: Readonly<Record<string, string>>;
  readonly defaultPragmas: Readonly<Record<string, string>>;
}

/** Default journal mode for new analytics databases. */
export const DEFAULT_JOURNAL_MODE = 'WAL' as const;

/**
 * PRAGMAs that every adapter must apply before executing analytics DDL/DML.
 *
 * `foreign_keys=ON` is mandatory. `journal_mode` is configurable per adapter
 * but defaults to WAL for analytics workloads.
 */
export const REQUIRED_PRAGMAS: Readonly<Record<string, string>> = Object.freeze({
  foreign_keys: 'ON',
  journal_mode: DEFAULT_JOURNAL_MODE,
});

/** SQL features every analytics adapter is expected to support. */
export const SUPPORTED_SQL_FEATURES: readonly SqliteSqlFeature[] = Object.freeze([
  'common-table-expressions',
  'window-functions',
  'json',
  'json1',
  'rtree',
  'fts5',
  'generated-columns',
  'strict-tables',
  'upsert',
  'returning',
  'transactional-ddl',
]);

/** Returns whether a backend advertises persistent durability. */
export function isBackendPersistent(backend: AdapterBackend): boolean {
  return backend.durability === 'persistent';
}

/** Returns whether a feature is present in a capability list. */
export function isSupportedSqlFeature(
  features: readonly SqliteSqlFeature[],
  feature: SqliteSqlFeature,
): boolean {
  return features.includes(feature);
}

/** Returns a required PRAGMA value by name, or `undefined` if none is recorded. */
export function getRequiredPragma(name: string): string | undefined {
  return REQUIRED_PRAGMAS[name];
}
