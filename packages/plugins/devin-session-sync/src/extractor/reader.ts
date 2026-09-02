import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { DatabaseSync as DevinDatabaseSync } from 'node:sqlite';
import {
  KNOWN_TABLE_COLUMNS,
  knownColumnsFor,
  resolveDevinSchema,
  type SchemaResolution,
} from './schema-registry.js';
import type {
  DevinExtractedTables,
  DevinMessageNodeRow,
  DevinPromptHistoryRow,
  DevinRefineryMigration,
  DevinSchemaDescriptor,
  DevinSessionRow,
  DevinToolCallStateRow,
  DevinWatermarks,
} from './types.js';

/** Thrown when `node:sqlite`'s `DatabaseSync` is not available at runtime. */
export class DevinSqliteUnavailableError extends Error {
  constructor(detail: string) {
    super(
      'devin-session-sync requires Node.js >=22.13.0 (or >=23.4.0) for the built-in ' +
        `node:sqlite module, used to read Devin CLI's sessions.db. ${detail} ` +
        'Upgrade Node.js to sync Devin sessions.',
    );
    this.name = 'DevinSqliteUnavailableError';
  }
}

type NodeSqliteModule = typeof import('node:sqlite');
type SqliteImporter = () => Promise<NodeSqliteModule>;

const defaultImporter: SqliteImporter = () => import('node:sqlite');

/**
 * Verifies `node:sqlite`'s `DatabaseSync` is usable, throwing a clear,
 * user-visible `DevinSqliteUnavailableError` otherwise. `importer` is
 * injectable so tests can simulate an unavailable runtime without needing
 * an actually-incompatible Node binary.
 */
export async function assertSqliteAvailable(
  importer: SqliteImporter = defaultImporter,
): Promise<NodeSqliteModule> {
  let mod: NodeSqliteModule;
  try {
    mod = await importer();
  } catch (err) {
    throw new DevinSqliteUnavailableError(`Failed to load node:sqlite: ${(err as Error).message}`);
  }
  if (typeof mod.DatabaseSync !== 'function') {
    throw new DevinSqliteUnavailableError('node:sqlite loaded but DatabaseSync is unavailable.');
  }
  return mod;
}

export interface OpenDevinDatabaseResult {
  db: DevinDatabaseSync;
  /** Releases the DB handle and removes any temp snapshot copy. */
  close: () => void;
}

/**
 * Opens `sessions.db` read-only against the live path when possible (WAL
 * mode tolerates a concurrent reader — verified empirically). If a
 * read-only open fails, falls back to a snapshot copy of
 * `sessions.db`(+`-wal`+`-shm`) in a temp dir, per Part A2's WAL-safety
 * requirement.
 */
export async function openDevinDatabase(
  dbPath: string,
  importer: SqliteImporter = defaultImporter,
): Promise<OpenDevinDatabaseResult> {
  const { DatabaseSync } = await assertSqliteAvailable(importer);
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    return { db, close: () => db.close() };
  } catch {
    return openSnapshotCopy(dbPath, DatabaseSync);
  }
}

function openSnapshotCopy(
  dbPath: string,
  DatabaseSync: NodeSqliteModule['DatabaseSync'],
): OpenDevinDatabaseResult {
  const snapshotDir = mkdtempSync(join(tmpdir(), 'devin-session-sync-snapshot-'));
  const snapshotPath = join(snapshotDir, basename(dbPath));
  for (const suffix of ['', '-wal', '-shm']) {
    const source = `${dbPath}${suffix}`;
    if (existsSync(source)) {
      copyFileSync(source, `${snapshotPath}${suffix}`);
    }
  }
  const db = new DatabaseSync(snapshotPath, { readOnly: true });
  return {
    db,
    close: () => {
      db.close();
      rmSync(snapshotDir, { recursive: true, force: true });
    },
  };
}

/** Reads the max applied `refinery_schema_history` version; `0` if absent. */
export function readRefineryVersion(db: DevinDatabaseSync): number {
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='refinery_schema_history'")
    .get();
  if (!table) {
    return 0;
  }
  const row = db.prepare('SELECT MAX(version) AS max_version FROM refinery_schema_history').get();
  return Number((row as { max_version: number | null } | undefined)?.max_version ?? 0);
}

function readTable<T>(db: DevinDatabaseSync, sql: string, params: unknown[] = []): T[] {
  return db.prepare(sql).all(...(params as never[])) as T[];
}

function readSessions(db: DevinDatabaseSync, resolution: SchemaResolution): DevinSessionRow[] {
  const columns = knownColumnsFor('sessions', resolution);
  if (columns.length === 0) {
    return [];
  }
  return readTable<DevinSessionRow>(db, `SELECT ${columns.join(', ')} FROM sessions ORDER BY id`);
}

function readMessageNodes(
  db: DevinDatabaseSync,
  resolution: SchemaResolution,
  since: number | null,
): DevinMessageNodeRow[] {
  const columns = knownColumnsFor('message_nodes', resolution);
  if (columns.length === 0) {
    return [];
  }
  const sql = `SELECT ${columns.join(', ')} FROM message_nodes WHERE row_id > ? ORDER BY row_id`;
  return readTable<DevinMessageNodeRow>(db, sql, [since ?? -1]);
}

function readPromptHistory(
  db: DevinDatabaseSync,
  resolution: SchemaResolution,
  since: number | null,
): DevinPromptHistoryRow[] {
  const columns = knownColumnsFor('prompt_history', resolution);
  if (columns.length === 0) {
    return [];
  }
  const sql = `SELECT ${columns.join(', ')} FROM prompt_history WHERE id > ? ORDER BY id`;
  return readTable<DevinPromptHistoryRow>(db, sql, [since ?? -1]);
}

function readToolCallStates(
  db: DevinDatabaseSync,
  resolution: SchemaResolution,
  since: number | null,
): DevinToolCallStateRow[] {
  const columns = knownColumnsFor('tool_call_state', resolution).filter((c) => c !== 'row_id');
  if (columns.length === 0 || !resolution.knownTables.includes('tool_call_state')) {
    return [];
  }
  const select = ['rowid AS row_id', ...columns].join(', ');
  const sql = `SELECT ${select} FROM tool_call_state WHERE rowid > ? ORDER BY rowid`;
  return readTable<DevinToolCallStateRow>(db, sql, [since ?? -1]);
}

function readRefineryMigrations(db: DevinDatabaseSync): DevinRefineryMigration[] {
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='refinery_schema_history'")
    .get();
  if (!table) {
    return [];
  }
  const rows = db
    .prepare(
      'SELECT version, name, applied_on, checksum FROM refinery_schema_history ORDER BY version',
    )
    .all() as Array<{ version: number; name: string; applied_on: string; checksum: string }>;
  return rows.map((r) => ({
    version: r.version,
    name: r.name,
    appliedOn: r.applied_on,
    checksum: r.checksum,
  }));
}

/** Sha256 of the table's `CREATE TABLE` DDL; `null` when the table is absent. */
function readTableChecksum(db: DevinDatabaseSync, table: string): string | null {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
    .get(table) as { sql: string } | undefined;
  if (!row) {
    return null;
  }
  return createHash('sha256').update(row.sql).digest('hex');
}

/**
 * Computes `native/schema-descriptor.json` content: Devin CLI version (as
 * supplied by the caller — this extractor never shells out itself), the
 * refinery migration ledger, and a DDL checksum per known table. DS-F3
 * (#158) writes this into the plugin's artifact set.
 */
export function computeSchemaDescriptor(
  db: DevinDatabaseSync,
  devinCliVersion: string | null = null,
): DevinSchemaDescriptor {
  const schema = resolveDevinSchema(readRefineryVersion(db));
  const tableChecksums: Record<string, string | null> = {};
  for (const table of Object.keys(KNOWN_TABLE_COLUMNS)) {
    tableChecksums[table] = readTableChecksum(db, table);
  }
  return {
    devinCliVersion,
    refineryVersion: schema.observedVersion,
    refineryMigrations: readRefineryMigrations(db),
    tableChecksums,
    supported: schema.supported,
    warnings: schema.warnings,
  };
}

export interface ReadDevinTablesResult {
  tables: DevinExtractedTables;
  schema: SchemaResolution;
}

/**
 * Reads all four known tables, filtered above their respective watermarks
 * (`sessions` has no watermark — it is current-state, not append-only, and
 * is always read in full). Degrades per `schema-registry.ts` on an
 * unrecognized refinery version; never throws on schema mismatch.
 */
export function readDevinTables(
  db: DevinDatabaseSync,
  watermarks: DevinWatermarks,
): ReadDevinTablesResult {
  const schema = resolveDevinSchema(readRefineryVersion(db));
  const tables: DevinExtractedTables = {
    sessions: readSessions(db, schema),
    messageNodes: readMessageNodes(db, schema, watermarks.messageNodesRowId),
    promptHistory: readPromptHistory(db, schema, watermarks.promptHistoryId),
    toolCallStates: readToolCallStates(db, schema, watermarks.toolCallStateRowId),
  };
  return { tables, schema };
}
