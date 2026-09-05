import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { DatabaseSync as DevinDatabaseSync, SQLInputValue } from 'node:sqlite';
import { filterChangedMessageNodes } from './message-node-watermark.js';
import type { SchemaResolution } from './schema-registry.js';
import {
  detectUnknownColumns,
  KNOWN_TABLE_COLUMNS,
  resolveDevinSchema,
} from './schema-registry.js';
import { filterChangedSessions } from './session-watermark.js';
import { filterChangedToolCallStates } from './tool-call-watermark.js';
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
  } catch (readOnlyErr) {
    return openSnapshotCopyOrThrow(dbPath, DatabaseSync, readOnlyErr as Error);
  }
}

/** Falls back to a snapshot copy; on failure, reports both errors for diagnosis. */
function openSnapshotCopyOrThrow(
  dbPath: string,
  DatabaseSync: NodeSqliteModule['DatabaseSync'],
  readOnlyErr: Error,
): OpenDevinDatabaseResult {
  try {
    return openSnapshotCopy(dbPath, DatabaseSync);
  } catch (snapshotErr) {
    throw new Error(
      `Failed to open Devin sessions.db at ${dbPath}: read-only open failed ` +
        `(${readOnlyErr.message}), and the snapshot-copy fallback also failed ` +
        `(${(snapshotErr as Error).message}).`,
    );
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

function readTable<T>(db: DevinDatabaseSync, sql: string, params: SQLInputValue[] = []): T[] {
  return db.prepare(sql).all(...params) as T[];
}

/**
 * `sessions` is a current-state, mutate-in-place table (#298 Phase 1:
 * `model`, `cogs_json`, `metadata`, `main_chain_id` all confirmed to
 * change on the same `id` — never a new row). It's read via `SELECT *`
 * (never a curated column list — see `schema-registry.ts`) so no future
 * Devin CLI column addition can be silently dropped the way
 * `shell_last_seen_index` was. `priorHashes` is a cheap, safe skip signal
 * only (a full-row content hash, not a `last_activity_at` comparison —
 * see `session-watermark.ts` and `types.ts`'s `DevinWatermarks` doc
 * comment) — it never changes what's read from SQLite, only which
 * already-unchanged rows are dropped from the result.
 */
function readSessions(
  db: DevinDatabaseSync,
  resolution: SchemaResolution,
  priorHashes: Readonly<Record<string, string>>,
): DevinSessionRow[] {
  if (!resolution.knownTables.includes('sessions')) {
    return [];
  }
  const all = readTable<DevinSessionRow>(db, 'SELECT * FROM sessions ORDER BY id');
  return filterChangedSessions(all, priorHashes);
}

/**
 * `message_nodes` — #298 Phase 1 originally reported this table as
 * genuinely insert-only, but #341's live evidence overturned that finding
 * (Devin deletes and reinserts a session's entire node forest at fresh
 * `row_id`s on every persist, ~5.3x row churn measured live): a
 * `row_id`-watermark is unsound (see `message-node-watermark.ts`). Always
 * read in full (`SELECT *`, no `WHERE`), then reduced to genuinely
 * new/changed rows by content hash — the same shape `readToolCallStates`
 * below already uses for the analogous `tool_call_state` churn.
 */
function readMessageNodes(
  db: DevinDatabaseSync,
  resolution: SchemaResolution,
  priorHashes: Readonly<Record<string, string>>,
): DevinMessageNodeRow[] {
  if (!resolution.knownTables.includes('message_nodes')) {
    return [];
  }
  const sql = 'SELECT * FROM message_nodes ORDER BY row_id';
  return filterChangedMessageNodes(readTable<DevinMessageNodeRow>(db, sql), priorHashes);
}

/** `prompt_history` has a real per-prompt `timestamp` and an
 * `id`-watermark unchallenged by #298's investigation (append-only,
 * consistent with every observed prompt). `SELECT *` replaces the curated
 * column list. */
function readPromptHistory(
  db: DevinDatabaseSync,
  resolution: SchemaResolution,
  since: number | null,
): DevinPromptHistoryRow[] {
  if (!resolution.knownTables.includes('prompt_history')) {
    return [];
  }
  const sql = 'SELECT * FROM prompt_history WHERE id > ? ORDER BY id';
  return readTable<DevinPromptHistoryRow>(db, sql, [since ?? -1]);
}

/**
 * `tool_call_state` — see `tool-call-watermark.ts` for why this table
 * cannot use a rowid watermark. Always read in full (`SELECT *`, plus the
 * implicit `rowid` aliased for downstream tie-break ordering), then
 * reduced to genuinely new/changed rows by content hash.
 */
function readToolCallStates(
  db: DevinDatabaseSync,
  resolution: SchemaResolution,
  priorHashes: Readonly<Record<string, string>>,
): DevinToolCallStateRow[] {
  if (!resolution.knownTables.includes('tool_call_state')) {
    return [];
  }
  const sql = 'SELECT rowid AS row_id, * FROM tool_call_state ORDER BY rowid';
  return filterChangedToolCallStates(readTable<DevinToolCallStateRow>(db, sql), priorHashes);
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

/** Real column names for a table via `PRAGMA table_info`; empty for an
 * absent table (`PRAGMA table_info` returns zero rows, never throws). */
function readTableColumnNames(db: DevinDatabaseSync, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

/**
 * A warning per known table with a real column `KNOWN_TABLE_COLUMNS`
 * doesn't list yet — informational only (reads are unconditional
 * `SELECT *`, never gated on this), so a future schema drift like the
 * `sessions.shell_last_seen_index` gap this issue closes is surfaced
 * proactively instead of found by hand again.
 */
function unknownColumnWarnings(db: DevinDatabaseSync, knownTables: readonly string[]): string[] {
  const warnings: string[] = [];
  for (const table of knownTables) {
    const unknown = detectUnknownColumns(table, readTableColumnNames(db, table));
    if (unknown.length > 0) {
      warnings.push(
        `${table}: column(s) ${unknown.join(', ')} are captured (SELECT * always reads ` +
          'everything) but not yet listed in KNOWN_TABLE_COLUMNS — update it for documentation.',
      );
    }
  }
  return warnings;
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
    warnings: [...schema.warnings, ...unknownColumnWarnings(db, schema.knownTables)],
  };
}

export interface ReadDevinTablesResult {
  tables: DevinExtractedTables;
  schema: SchemaResolution;
}

/**
 * Reads all four known tables, each above its own watermark using its own
 * per-table strategy (see `types.ts`'s `DevinWatermarks` doc comment,
 * `message-node-watermark.ts`, and `tool-call-watermark.ts`) — never a
 * uniform default. Degrades per `schema-registry.ts` on an unrecognized
 * refinery version; never throws on schema mismatch.
 */
export function readDevinTables(
  db: DevinDatabaseSync,
  watermarks: DevinWatermarks,
): ReadDevinTablesResult {
  const schema = resolveDevinSchema(readRefineryVersion(db));
  const tables: DevinExtractedTables = {
    sessions: readSessions(db, schema, watermarks.sessionsContentHashes),
    messageNodes: readMessageNodes(db, schema, watermarks.messageNodesContentHashes),
    promptHistory: readPromptHistory(db, schema, watermarks.promptHistoryId),
    toolCallStates: readToolCallStates(db, schema, watermarks.toolCallStateHashes),
  };
  return { tables, schema };
}
