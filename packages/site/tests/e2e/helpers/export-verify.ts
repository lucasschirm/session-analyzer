import { readFile } from 'node:fs/promises';
import type { Sqlite3Static } from '@sqlite.org/sqlite-wasm';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';

/**
 * Control database tables whose row counts are relevant to E2E export
 * assertions. The order matches the schema created by `DatabaseManager`.
 */
export const EXPORT_TABLES = [
  'projects',
  'sessions',
  'session_files',
  'connections',
  'connection_s3_credentials',
  'passkey_state',
  'source_checkpoints',
  'ui_preferences',
] as const;

export type ExportTableName = (typeof EXPORT_TABLES)[number];

/**
 * Row counts for the control database tables exported by the app.
 */
export interface ExportRowCounts {
  projects: number;
  sessions: number;
  session_files: number;
  connections: number;
  connection_s3_credentials: number;
  passkey_state: number;
  source_checkpoints: number;
  ui_preferences: number;
}

const SQLITE_MAGIC = new TextEncoder().encode('SQLite format 3\0');
const HEADER_LENGTH = 16;

let sqlite3Promise: Promise<Sqlite3Static> | null = null;

function getSqlite3(): Promise<Sqlite3Static> {
  if (!sqlite3Promise) {
    sqlite3Promise = sqlite3InitModule();
  }
  return sqlite3Promise;
}

function assertHeader(bytes: Uint8Array): void {
  if (bytes.length < HEADER_LENGTH) {
    throw new Error(
      `Export file is too small to be a valid SQLite database (${bytes.length} bytes).`,
    );
  }
  for (let i = 0; i < HEADER_LENGTH; i++) {
    if (bytes[i] !== SQLITE_MAGIC[i]) {
      const header = new TextDecoder().decode(bytes.subarray(0, HEADER_LENGTH));
      throw new Error(
        `Export file does not have a valid SQLite header: expected "SQLite format 3", got ${JSON.stringify(header)}.`,
      );
    }
  }
}

async function resolveBytes(input: string | Uint8Array): Promise<Uint8Array> {
  if (typeof input === 'string') {
    const buffer = await readFile(input);
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  }
  if (input instanceof Uint8Array) {
    return input;
  }
  throw new Error(
    'verifyExportContents input must be a file path (string) or a Uint8Array/Buffer.',
  );
}

/**
 * Opens a downloaded `.sqlite` export in the same SQLite WASM runtime used by
 * the site, reads the row count for every relevant control database table, and
 * returns the counts.
 *
 * @param input A Playwright download path (string) or the raw `Uint8Array`
 *   bytes of the export.
 * @returns A typed map of row counts per control database table.
 * @throws If the input is not a valid SQLite database. The error is propagated
 *   loudly so E2E tests can distinguish a corrupt export from an empty one.
 */
export async function verifyExportContents(input: string | Uint8Array): Promise<ExportRowCounts> {
  const bytes = await resolveBytes(input);
  assertHeader(bytes);

  const sqlite3 = await getSqlite3();
  const db = new sqlite3.oo1.DB(':memory:', 'c');
  try {
    const capi = sqlite3.capi;
    const pMem = sqlite3.wasm.allocFromTypedArray(bytes);
    const rc = capi.sqlite3_deserialize(
      db,
      'main',
      pMem,
      bytes.length,
      bytes.length,
      capi.SQLITE_DESERIALIZE_FREEONCLOSE | capi.SQLITE_DESERIALIZE_RESIZEABLE,
    );

    if (rc !== capi.SQLITE_OK) {
      throw new Error(
        `Unable to open export as a SQLite database (result code ${rc}). The file may be corrupt or truncated.`,
      );
    }

    // Probe sqlite_master. If the bytes are not a real SQLite file this throws
    // SQLITE_NOTADB, which we convert into a clear "corrupt file" error.
    try {
      db.selectValues("SELECT name FROM sqlite_master WHERE type='table' LIMIT 1");
    } catch (error) {
      throw new Error(`Export file is not a valid SQLite database: ${(error as Error).message}`);
    }

    const counts = {} as Record<ExportTableName, number>;
    for (const table of EXPORT_TABLES) {
      const exists = db.selectValues(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?",
        [table],
      )[0];
      if (exists) {
        const [count] = db.selectValues(`SELECT COUNT(*) FROM "${table}"`);
        counts[table] = Number(count ?? 0);
      } else {
        counts[table] = 0;
      }
    }

    return counts as ExportRowCounts;
  } finally {
    db.close();
  }
}
