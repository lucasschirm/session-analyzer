// @vitest-environment node
/**
 * Tests for the legacy read-only database used during the analytics cutover
 * rollback window.
 */

import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import type { Database } from '@sqlite.org/sqlite-wasm';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LegacyDatabase } from '../../src/db/legacy-database';

const FILENAME = `/tmp/sal-legacy-${randomUUID()}.sqlite3`;

let sqlite3: Awaited<ReturnType<typeof sqlite3InitModule>>;

async function seedLegacyDb(
  filename: string,
  sqlite3Ref: Awaited<ReturnType<typeof sqlite3InitModule>>,
): Promise<void> {
  const db = new sqlite3Ref.oo1.DB(filename, 'c');
  db.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT);
    INSERT INTO projects VALUES ('p1', 'Legacy Project');
  `);
  db.close();
}

describe('LegacyDatabase', () => {
  beforeAll(async () => {
    sqlite3 = await sqlite3InitModule();
  });

  beforeEach(async () => {
    await seedLegacyDb(FILENAME, sqlite3);
  });

  afterEach(async () => {
    try {
      await unlink(FILENAME);
    } catch {
      // ignore
    }
  });

  it('opens a pre-existing database in read-only mode and exports it', async () => {
    const legacy = new LegacyDatabase(sqlite3);
    const storage = await legacy.initialize(FILENAME);
    expect(storage).toBe('memory');

    const bytes = legacy.exportDatabase();
    expect(bytes.length).toBeGreaterThan(0);

    const header = new TextDecoder().decode(bytes.slice(0, 16));
    expect(header).toBe('SQLite format 3\u0000');

    const db = (legacy as unknown as { db: Database }).db;
    const row = db.selectObject('SELECT name FROM projects WHERE id = ?', ['p1']) as {
      name: string;
    };
    expect(row.name).toBe('Legacy Project');

    expect(() => db.exec("INSERT INTO projects VALUES ('p2', 'x')")).toThrow(/READONLY/);

    legacy.close();
  });
});
