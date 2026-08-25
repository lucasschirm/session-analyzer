import { describe, expect, it } from 'vitest';

import {
  type AdapterBackend,
  DEFAULT_JOURNAL_MODE,
  getRequiredPragma,
  isBackendPersistent,
  isSupportedSqlFeature,
  REQUIRED_PRAGMAS,
  type SqliteExecutor,
  type SqliteTransaction,
  SUPPORTED_SQL_FEATURES,
} from '../../src/index.js';

function typeCheck<T>(_value: T) {
  return true;
}

describe('SQLite capability contract', () => {
  it('compiles SqliteExecutor, SqliteTransaction, and AdapterBackend', () => {
    const backend: AdapterBackend = {
      backendName: 'test-memory',
      durability: 'ephemeral',
      journalMode: 'memory',
      supports: {
        integersAsBigint: true,
        blob: true,
        preparedStatements: true,
        foreignKeys: true,
        wal: false,
        nestedTransactions: true,
        concurrentTransactions: false,
        cancellation: false,
        busyTimeout: false,
        durable: false,
        sql: {
          features: SUPPORTED_SQL_FEATURES,
          maxBoundParameters: 999,
          maxSqlLength: 1_000_000,
          maxColumnNameLength: 128,
        },
      },
      requiredPragmas: REQUIRED_PRAGMAS,
      defaultPragmas: { ...REQUIRED_PRAGMAS },
    };

    const tx: SqliteTransaction = {
      id: 1,
      backend,
      isActive: true,
      nestingLevel: 0,
      exec: () => ({ rows: [], changes: 0, lastInsertRowId: 0n }),
      prepare: () => ({
        run: () => ({ rows: [], changes: 0, lastInsertRowId: 0n }),
        all: () => [],
        get: () => undefined,
        finalize: () => undefined,
      }),
      savepoint: () => undefined,
      releaseSavepoint: () => undefined,
      rollbackToSavepoint: () => undefined,
      commit: () => undefined,
      rollback: () => undefined,
    };

    const executor: SqliteExecutor = {
      backend,
      exec: () => ({ rows: [], changes: 0, lastInsertRowId: 0n }),
      transaction: (_callback) => Promise.resolve(undefined as unknown as never),
      close: () => undefined,
      isBusy: () => false,
      isClosed: () => false,
    };

    expect(typeCheck<SqliteTransaction>(tx)).toBe(true);
    expect(typeCheck<SqliteExecutor>(executor)).toBe(true);
    expect(executor.backend.backendName).toBe('test-memory');
  });

  it('enforces required PRAGMAs', () => {
    expect(REQUIRED_PRAGMAS.foreign_keys).toBe('ON');
    expect(REQUIRED_PRAGMAS.journal_mode).toBe(DEFAULT_JOURNAL_MODE);
    expect(getRequiredPragma('foreign_keys')).toBe('ON');
    expect(getRequiredPragma('journal_mode')).toBe('WAL');
    expect(getRequiredPragma('missing')).toBeUndefined();
  });

  it('documents supported SQL features', () => {
    expect(SUPPORTED_SQL_FEATURES).toContain('common-table-expressions');
    expect(SUPPORTED_SQL_FEATURES).toContain('window-functions');
    expect(SUPPORTED_SQL_FEATURES).toContain('json');
    expect(SUPPORTED_SQL_FEATURES).toContain('upsert');
    expect(SUPPORTED_SQL_FEATURES).toContain('returning');
    expect(SUPPORTED_SQL_FEATURES).toContain('transactional-ddl');
  });

  it('reports backend durability and feature support', () => {
    const persistent: AdapterBackend = {
      backendName: 'wasm-opfs',
      durability: 'persistent',
      journalMode: 'wal',
      supports: {
        integersAsBigint: true,
        blob: true,
        preparedStatements: true,
        foreignKeys: true,
        wal: true,
        nestedTransactions: true,
        concurrentTransactions: false,
        cancellation: false,
        busyTimeout: true,
        durable: true,
        sql: {
          features: SUPPORTED_SQL_FEATURES,
          maxBoundParameters: 'unlimited',
          maxSqlLength: 'unlimited',
          maxColumnNameLength: 128,
        },
      },
      requiredPragmas: REQUIRED_PRAGMAS,
      defaultPragmas: { ...REQUIRED_PRAGMAS },
    };

    expect(isBackendPersistent(persistent)).toBe(true);
    expect(isSupportedSqlFeature(persistent.supports.sql.features, 'json')).toBe(true);
    expect(isSupportedSqlFeature(persistent.supports.sql.features, 'window-functions')).toBe(true);
    expect(isSupportedSqlFeature(persistent.supports.sql.features, 'rtree')).toBe(true);
  });
});
