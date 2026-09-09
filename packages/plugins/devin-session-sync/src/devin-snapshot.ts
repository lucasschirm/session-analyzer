import os from 'node:os';
import process from 'node:process';

import { resolveDevinCliVersion } from './devin-profile.js';
import { resolveDevinPaths } from './extractor/paths.js';
import {
  computeSchemaDescriptor,
  openDevinDatabase,
  readAllSessions,
  readDevinTables,
  readDevinTablesForSession,
  resolveSchema,
} from './extractor/reader.js';
import type {
  DevinExtractedTables,
  DevinSchemaDescriptor,
  DevinSessionRow,
} from './extractor/types.js';
import { EMPTY_WATERMARKS } from './extractor/types.js';

/**
 * A single full read of `sessions.db` — every known table (no watermark
 * filtering; see `session-sync.ts`'s doc comment on the "full extraction per
 * sync" scoping decision) plus the schema descriptor DS-F3 writes into every
 * session's manifest. Centralizes the *only* place outside `extractor/`
 * this package opens `sessions.db`, per
 * `.agents/rules/transformers-never-write-sqlite.md` /
 * `src/AGENTS.md`'s "confined to the extractor module" invariant — callers
 * (`cli/project.ts`, `session-sync.ts`, `watcher.ts`) consume this snapshot
 * rather than calling `openDevinDatabase` themselves.
 */
export interface DevinSnapshot {
  tables: DevinExtractedTables;
  schemaDescriptor: DevinSchemaDescriptor;
}

export interface ReadDevinSnapshotOptions {
  /** Overrides `sessions.db`'s resolved path; primarily for tests. */
  sessionsDbPath?: string;
  home?: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** Live `devin --version` output; resolved automatically when omitted. */
  devinCliVersion?: string;
}

function resolveSnapshotDbPath(options: ReadDevinSnapshotOptions): string {
  if (options.sessionsDbPath) return options.sessionsDbPath;
  const env = options.env ?? process.env;
  const home = options.home ?? os.homedir();
  const cwd = options.cwd ?? process.cwd();
  return resolveDevinPaths({ xdgDataHome: env.XDG_DATA_HOME, home, cwd }).sessionsDbPath;
}

export async function readDevinSnapshot(
  options: ReadDevinSnapshotOptions = {},
): Promise<DevinSnapshot> {
  const dbPath = resolveSnapshotDbPath(options);
  const devinCliVersion = options.devinCliVersion ?? resolveDevinCliVersion();

  const { db, close } = await openDevinDatabase(dbPath);
  try {
    const { tables } = readDevinTables(db, EMPTY_WATERMARKS);
    const schemaDescriptor = computeSchemaDescriptor(db, devinCliVersion);
    return { tables, schemaDescriptor };
  } finally {
    close();
  }
}

// ---------------------------------------------------------------------------
// Per-session snapshot reader (memory-bounded for large session stores)
// ---------------------------------------------------------------------------

/**
 * A handle that keeps `sessions.db` open so the sync command can read one
 * session's tables at a time (via {@link readSessionTables}) instead of
 * loading all sessions' rows into memory at once. The `sessions` list and
 * `schemaDescriptor` are read up front (lightweight); heavy per-session
 * tables are read on demand and discarded after processing, so only one
 * session's data is in JS memory at a time.
 *
 * Always call {@link close} when done (typically in a `finally` block).
 */
export interface DevinSnapshotHandle {
  /** All session rows (lightweight — one row per session). */
  sessions: DevinSessionRow[];
  schemaDescriptor: DevinSchemaDescriptor;
  /** Reads one session's tables (paginated, memory-bounded). */
  readSessionTables: (sessionId: string) => DevinExtractedTables;
  /** Closes the database handle and releases any temp snapshot copy. */
  close: () => void;
}

/**
 * Opens `sessions.db`, reads the lightweight `sessions` list and schema
 * descriptor up front, and returns a handle for per-session table reads.
 * Use this instead of {@link readDevinSnapshot} when processing many
 * sessions sequentially (e.g. `devin-sync sync`) to avoid loading all
 * sessions' `message_nodes`/`tool_call_state`/`prompt_history` into memory
 * at once.
 */
export async function openDevinSnapshotHandle(
  options: ReadDevinSnapshotOptions = {},
): Promise<DevinSnapshotHandle> {
  const dbPath = resolveSnapshotDbPath(options);
  const devinCliVersion = options.devinCliVersion ?? resolveDevinCliVersion();

  const { db, close } = await openDevinDatabase(dbPath);
  try {
    const resolution = resolveSchema(db);
    const sessions = readAllSessions(db, resolution);
    const schemaDescriptor = computeSchemaDescriptor(db, devinCliVersion);
    return {
      sessions,
      schemaDescriptor,
      readSessionTables: (sessionId: string) =>
        readDevinTablesForSession(db, sessionId, EMPTY_WATERMARKS, resolution),
      close,
    };
  } catch (err) {
    close();
    throw err;
  }
}
