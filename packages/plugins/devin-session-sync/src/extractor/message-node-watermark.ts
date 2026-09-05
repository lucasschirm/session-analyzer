import { createHash } from 'node:crypto';
import type { DevinMessageNodeRow } from './types.js';

/**
 * `message_nodes`' incremental-fetch strategy — a content-hash watermark
 * keyed by the table's real identity `(session_id, node_id)`, NOT `row_id`.
 *
 * #298 Phase 1 originally reported `message_nodes` as "confirmed
 * insert-only" (never a same-`row_id` in-place update observed). #341's
 * live-store evidence overturns that finding: `sqlite_sequence` for
 * `message_nodes` measured 86,082 vs 16,350 live rows (~5.3x churn) across
 * every one of 28 real sessions, with each session's rows sitting in one
 * contiguous final block — Devin deletes and reinserts a session's ENTIRE
 * node forest, at fresh `row_id`s, on every persist. This is the exact same
 * "rewritten on each persist" behavior `tool-call-watermark.ts` already
 * documents and fixes for `tool_call_state` — `message_nodes` was never
 * actually different, just not yet caught live.
 *
 * A `row_id > watermark` filter (the pre-#341 strategy) is therefore
 * unsound: real, unchanged content reliably reappears at a brand-new
 * `row_id` on every single persist, so the old strategy re-emitted a
 * session's entire message history on every sync pass — O(nodes x passes)
 * transcript growth, confirmed live at the 5.3x factor above. Separately, a
 * genuine in-place edit to an existing node's content was invisible
 * forever, since nothing compared content across passes at all.
 *
 * `(session_id, node_id)` — not `row_id` — is the table's stable
 * application-level identity: `node_id`/`parent_node_id` drive tree
 * ordering (`orderMessageNodes` in `jsonl-writer.ts`) and
 * `sessions.main_chain_id` references a specific `node_id` directly. If
 * `node_id` churned the way `row_id` does, Devin's own conversation-resume
 * feature would break on every persist, which live sessions plainly
 * contradict. `row_id` is purely the storage-layer `AUTOINCREMENT` write
 * order, carried through only for downstream tie-break ordering
 * (`jsonl-writer.ts`) — directly analogous to `tool_call_state`'s
 * `(session_id, tool_call_id)` identity vs. its own churned `rowid`.
 *
 * The fix mirrors `tool-call-watermark.ts` with one deliberate, necessary
 * deviation: the content hash excludes BOTH `row_id` (as tool_call_state's
 * does) AND `created_at`. `DevinMessageNodeRow`'s own doc comment confirms
 * `created_at` is not per-message — every row of a session shares one value
 * equal to `sessions.last_activity_at`, stamped fresh on every wholesale
 * rewrite. Including it in the hash would make every node "change" on
 * every persist purely because the shared timestamp ticked forward —
 * silently reproducing the exact churn bug this module exists to fix.
 * `tool_call_state` has no such column at all, so its own hash needed no
 * equivalent exclusion — this is a genuinely necessary divergence from a
 * pure copy-paste, not an inconsistency.
 */

function messageNodeKey(row: DevinMessageNodeRow): string {
  return `${row.session_id}\0${row.node_id}`;
}

/**
 * Hashes every column except `row_id` and `created_at` — see the module
 * doc comment above for why both, specifically, must be excluded. Hashing
 * either would make every row look "changed" on every pass, defeating the
 * whole point of this module.
 */
function messageNodeContentHash(row: DevinMessageNodeRow): string {
  const { row_id: _rowId, created_at: _createdAt, ...content } = row;
  return createHash('sha256').update(JSON.stringify(content)).digest('hex');
}

/**
 * New or genuinely-changed message node rows only — a row whose content
 * hash matches the prior sync's hash for the same `(session_id, node_id)`
 * is dropped, no matter what its current `row_id` is.
 *
 * Short-circuits without hashing anything when `priorHashes` is empty: an
 * empty map means "nothing has ever been seen for any key", so every row
 * is unconditionally included regardless of its content — hashing first
 * would produce the exact same result at a real, non-trivial CPU cost.
 * This is not a hypothetical case: `reader.ts`'s `readMessageNodes` is
 * production-called with `EMPTY_WATERMARKS` on EVERY invocation (via
 * `devin-snapshot.ts`'s `readDevinSnapshot`, the only real call site —
 * `watcher.ts`'s poll loop alone calls this every
 * `DEFAULT_WATCHER_POLL_INTERVAL_MS` (15s), forever). Without this guard,
 * every poll would hash every `message_nodes` row across every session's
 * entire history — unbounded, ever-growing, wasted work with a
 * guaranteed-always-pass outcome (PR #374 review finding). The real
 * incremental gate, fed genuine non-empty prior hashes from the
 * transcript file's own tail, is `session-sync.ts`'s `filterNewRows` —
 * that path is untouched by this guard and continues to hash and filter
 * normally.
 */
export function filterChangedMessageNodes(
  rows: readonly DevinMessageNodeRow[],
  priorHashes: Readonly<Record<string, string>>,
): DevinMessageNodeRow[] {
  if (Object.keys(priorHashes).length === 0) {
    return [...rows];
  }
  return rows.filter((row) => priorHashes[messageNodeKey(row)] !== messageNodeContentHash(row));
}

/** Folds this pass's already-filtered rows into the watermark map for the
 * next incremental pass; never drops a previously-seen key. */
export function mergeMessageNodeHashes(
  prior: Readonly<Record<string, string>>,
  changedRows: readonly DevinMessageNodeRow[],
): Record<string, string> {
  const merged = { ...prior };
  for (const row of changedRows) {
    merged[messageNodeKey(row)] = messageNodeContentHash(row);
  }
  return merged;
}
