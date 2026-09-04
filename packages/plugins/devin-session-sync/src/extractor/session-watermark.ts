import { createHash } from 'node:crypto';
import type { DevinSessionRow } from './types.js';

/**
 * `sessions`' incremental-fetch skip signal — a full content hash keyed by
 * `id`, deliberately NOT `last_activity_at` alone.
 *
 * #298 Phase 1 confirmed `last_activity_at` advances on ordinary tool-call
 * and subagent-invocation persists, but left two scenarios unverified
 * against that field specifically: skill-only (`cogs_json`) mutations
 * (finding 5, marked inconclusive) and effort/tier-only
 * (`metadata.response_dimensions`) mutations (finding 7, never
 * independently tested live). Relying on `last_activity_at` alone as a
 * skip signal risks silently dropping exactly the kind of mutation this
 * issue exists to stop losing (`missing-is-never-zero`) — flagged in PR
 * #301 review.
 *
 * Hashing the full row sidesteps the question entirely: any real column
 * change, whichever field carries it (including one this module was never
 * told to watch for), changes the hash. `sessions` is still always read in
 * full (`SELECT *`, every pass, every session, per reader.ts) — this
 * module only decides which already-read rows are worth re-emitting.
 */
function sessionContentHash(row: DevinSessionRow): string {
  return createHash('sha256').update(JSON.stringify(row)).digest('hex');
}

/**
 * Sessions whose content actually changed since the last sync pass. A
 * session absent from `priorHashes` (never seen before) is always
 * included.
 */
export function filterChangedSessions(
  rows: readonly DevinSessionRow[],
  priorHashes: Readonly<Record<string, string>>,
): DevinSessionRow[] {
  return rows.filter((row) => priorHashes[row.id] !== sessionContentHash(row));
}

/**
 * Folds this pass's already-filtered session rows into the watermark map
 * for the next incremental pass; never drops a previously-seen key.
 */
export function mergeSessionHashes(
  prior: Readonly<Record<string, string>>,
  changedRows: readonly DevinSessionRow[],
): Record<string, string> {
  const merged = { ...prior };
  for (const row of changedRows) {
    merged[row.id] = sessionContentHash(row);
  }
  return merged;
}
