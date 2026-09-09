import path from 'node:path';

import { type ReadDevinSnapshotOptions, readDevinSnapshot } from '../devin-snapshot.js';

/**
 * Summary of one row from `sessions` (current-state, not append-only — see
 * `extractor/AGENTS.md`). Used for CLI discovery (`devin-sync sync`/`list`
 * scoping) and the watcher's poll loop.
 */
export interface DevinSessionSummary {
  sessionId: string;
  workingDirectory: string | null;
  lastActivityAt: number | null;
  title: string | null;
}

/**
 * Reads every session directly from `sessions.db` (via the DS-F2 (#157)
 * extractor's read-only `node:sqlite` access) — **never** shells out to
 * `devin list`, which is verified to only return sessions whose
 * `working_directory` equals the invoking cwd (Part A2). Global sync must
 * see every session regardless of where `devin-sync` is invoked from.
 */
export async function listDevinSessions(
  options: ReadDevinSnapshotOptions = {},
): Promise<DevinSessionSummary[]> {
  const { tables } = await readDevinSnapshot(options);
  return tables.sessions.map((s) => ({
    sessionId: s.id,
    workingDirectory: s.working_directory,
    lastActivityAt: s.last_activity_at,
    title: s.title,
  }));
}

/** Filters sessions to ones whose `working_directory` matches `cwd` exactly. */
export function filterSessionsForCwd(
  sessions: readonly DevinSessionSummary[],
  cwd: string,
): DevinSessionSummary[] {
  const normalizedCwd = path.normalize(cwd).replace(/\/+$/, '');
  return sessions.filter((s) => {
    if (!s.workingDirectory) return false;
    return path.normalize(s.workingDirectory).replace(/\/+$/, '') === normalizedCwd;
  });
}
