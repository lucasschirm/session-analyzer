import os from 'node:os';
import process from 'node:process';

import { resolveDevinCliVersion } from './devin-profile.js';
import { resolveDevinPaths } from './extractor/paths.js';
import { computeSchemaDescriptor, openDevinDatabase, readDevinTables } from './extractor/reader.js';
import type { DevinExtractedTables, DevinSchemaDescriptor } from './extractor/types.js';
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
