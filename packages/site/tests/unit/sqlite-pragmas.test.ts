// @vitest-environment node
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  applyStandardOpfsPragmas,
  OPFS_CACHE_SIZE_KIB,
  OPFS_JOURNAL_MODE,
  OPFS_PAGE_SIZE,
  OPFS_SYNCHRONOUS,
  OPFS_TEMP_STORE,
} from '../../src/db/sqlite-pragmas';

describe('sqlite-pragmas', () => {
  let sqlite3: Awaited<ReturnType<typeof sqlite3InitModule>>;

  beforeAll(async () => {
    sqlite3 = await sqlite3InitModule();
  });

  it('exports standard OPFS tuning constants', () => {
    expect(OPFS_PAGE_SIZE).toBe(4096);
    expect(OPFS_CACHE_SIZE_KIB).toBe(-262144);
    expect(OPFS_JOURNAL_MODE).toBe('TRUNCATE');
    expect(OPFS_SYNCHRONOUS).toBe('NORMAL');
    expect(OPFS_TEMP_STORE).toBe('MEMORY');
  });

  it('applies default performance and durability pragmas to a database', () => {
    const db = new sqlite3.oo1.DB(':memory:', 'c');
    try {
      const mode = applyStandardOpfsPragmas(db);
      // On an in-memory DB in Node, SQLite automatically reports 'memory' for journal_mode
      expect(mode).toBe('memory');

      const pageSize = Number(db.selectValue('PRAGMA page_size'));
      expect(pageSize).toBe(4096);

      const cacheSize = Number(db.selectValue('PRAGMA cache_size'));
      expect(cacheSize).toBe(-262144);

      const tempStore = Number(db.selectValue('PRAGMA temp_store'));
      // PRAGMA temp_store = MEMORY maps to 2
      expect(tempStore).toBe(2);

      const foreignKeys = Number(db.selectValue('PRAGMA foreign_keys'));
      expect(foreignKeys).toBe(1);

      const sync = Number(db.selectValue('PRAGMA synchronous'));
      // PRAGMA synchronous = NORMAL maps to 1
      expect(sync).toBe(1);
    } finally {
      db.close();
    }
  });

  it('supports custom options override', () => {
    const db = new sqlite3.oo1.DB(':memory:', 'c');
    try {
      applyStandardOpfsPragmas(db, {
        cacheSize: -524288,
        foreignKeys: false,
      });

      const cacheSize = Number(db.selectValue('PRAGMA cache_size'));
      expect(cacheSize).toBe(-524288);

      const foreignKeys = Number(db.selectValue('PRAGMA foreign_keys'));
      expect(foreignKeys).toBe(0);
    } finally {
      db.close();
    }
  });
});
