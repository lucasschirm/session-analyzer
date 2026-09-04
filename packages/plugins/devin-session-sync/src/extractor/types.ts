/**
 * Shared row and output types for the Devin `sessions.db` extractor.
 *
 * Column shapes mirror the schema captured at refinery migration version 16
 * (devin 3000.6.7, see `schema-registry.ts`). All timestamp-shaped fields are
 * `number | null` (unix seconds) — a source row that does not populate a
 * timestamp column carries `null`, never `0` (`missing-is-never-zero`).
 */

/**
 * A row from the `sessions` table (current-state, not append-only).
 *
 * The index signature is load-bearing, not decoration: `reader.ts` reads
 * this table via `SELECT *` (#298) so a column this interface doesn't yet
 * name (e.g. `shell_last_seen_index`, confirmed real and previously
 * silently dropped by a curated `SELECT` column list) still flows through
 * to the JSONL output unfiltered — extraction never gets to decide a
 * column is irrelevant. Every other row interface below carries the same
 * signature for the same reason.
 */
export interface DevinSessionRow {
  id: string;
  working_directory: string | null;
  backend_type: string | null;
  model: string | null;
  agent_mode: string | null;
  created_at: number | null;
  last_activity_at: number | null;
  title: string | null;
  main_chain_id: string | null;
  cogs_json: string | null;
  workspace_dirs: string | null;
  hidden: number | null;
  metadata: string | null;
  [column: string]: unknown;
}

/**
 * A row from the `message_nodes` table.
 *
 * `created_at` is intentionally typed as present but MUST NOT be used for
 * ordering: it is not per-message — verified empirically, every row of a
 * session shares one value equal to `sessions.last_activity_at`, because the
 * node forest is rewritten on each persist. `row_id` (global monotonic
 * write order, `AUTOINCREMENT`) is the incremental watermark; `node_id` /
 * `parent_node_id` drive ordering (see `orderMessageNodes` in
 * `jsonl-writer.ts`).
 */
export interface DevinMessageNodeRow {
  row_id: number;
  session_id: string;
  node_id: number;
  parent_node_id: number | null;
  chat_message: string | null;
  created_at: number | null;
  metadata: string | null;
  [column: string]: unknown;
}

/** A row from the `prompt_history` table. `timestamp` is real per-prompt. */
export interface DevinPromptHistoryRow {
  id: number;
  content: string | null;
  timestamp: number | null;
  session_id: string;
  is_shell: number | null;
  [column: string]: unknown;
}

/**
 * A row from the `tool_call_state` table. There is no explicit
 * autoincrement column, so `row_id` here is SQLite's implicit `rowid`,
 * read explicitly (`SELECT rowid AS row_id, ...`).
 *
 * `row_id` is deliberately NOT this table's incremental-fetch identity
 * (see `tool-call-watermark.ts`): #298's Phase-1 investigation confirmed,
 * against a real live `sessions.db`, that this rowid is not stable across
 * a row's lifetime — Devin rewrites a session's entire `tool_call_state`
 * row set (delete+reinsert, including untouched already-completed calls)
 * on every persist, so the same `(session_id, tool_call_id)` reappears
 * under a new rowid with byte-identical content. Combined with this
 * table's composite `(session_id, tool_call_id)` primary key (no
 * `INTEGER PRIMARY KEY AUTOINCREMENT`), SQLite's implicit rowid is also
 * structurally eligible for reuse after a delete. The real identity is
 * `(session_id, tool_call_id)`; `row_id` is carried only for stable
 * tie-break ordering downstream (`jsonl-writer.ts`).
 */
export interface DevinToolCallStateRow {
  row_id: number;
  session_id: string;
  tool_call_id: string;
  tool_call_json: string | null;
  tool_call_update_json: string | null;
  [column: string]: unknown;
}

/** Raw table reads passed into the JSONL writer for one extraction pass. */
export interface DevinExtractedTables {
  sessions: DevinSessionRow[];
  messageNodes: DevinMessageNodeRow[];
  promptHistory: DevinPromptHistoryRow[];
  toolCallStates: DevinToolCallStateRow[];
}

/**
 * Incremental watermarks. Persistence is owned by the sync engine's
 * `StateStore` (`packages/sync/src/state/`) — this package only
 * accepts/emits values. Each field's shape is dictated by #298's Phase-1
 * investigation into how that table's rows actually change, not a uniform
 * default:
 *
 * - `messageNodesRowId` / `promptHistoryId`: `null` means "no prior
 *   watermark" (full extract). Both tables were confirmed live to be
 *   genuinely insert-only (never a same-`row_id`/`id` in-place update —
 *   even Devin's own "duplicate node pair" re-persist behavior always
 *   lands on a brand-new `row_id`), so a monotonic-key watermark remains
 *   correct and cheap.
 * - `toolCallStateHashes`: NOT a monotonic position — see
 *   `tool-call-watermark.ts` for why a rowid watermark is unsound for this
 *   table and what replaces it.
 * - `sessionsLastActivityAt`: NOT a watermark on read order either —
 *   `sessions` is a current-state (mutate-in-place) table with no
 *   append-only column at all; this is a cheap "did anything relevant
 *   change" skip signal, safe only because `last_activity_at` was
 *   confirmed live (#298 Phase 1) to advance on every session-affecting
 *   persist observed (ordinary tool call, subagent invocation). A session
 *   id absent from this map is always treated as changed.
 */
export interface DevinWatermarks {
  messageNodesRowId: number | null;
  toolCallStateHashes: Record<string, string>;
  promptHistoryId: number | null;
  sessionsLastActivityAt: Record<string, number>;
}

export const EMPTY_WATERMARKS: DevinWatermarks = {
  messageNodesRowId: null,
  toolCallStateHashes: {},
  promptHistoryId: null,
  sessionsLastActivityAt: {},
};

/** One line of `devin-session-jsonl/v1` output. */
export interface DevinJsonlLine {
  type: 'session' | 'message' | 'tool_call' | 'prompt';
  ts: number | null;
  order: number;
  [rawField: string]: unknown;
}

/** One applied migration from the `refinery_schema_history` ledger. */
export interface DevinRefineryMigration {
  version: number;
  name: string;
  appliedOn: string;
  checksum: string;
}

/**
 * Records which Devin CLI/schema version an extraction ran against.
 * `devinCliVersion` is supplied by the caller (this extractor never shells
 * out to `devin --version` itself) and is `null` when unknown — never a
 * placeholder string, per `missing-is-never-zero`.
 */
export interface DevinSchemaDescriptor {
  devinCliVersion: string | null;
  refineryVersion: number;
  refineryMigrations: DevinRefineryMigration[];
  /** Per-table DDL checksum (sha256 of `sqlite_master.sql`); `null` if the table is absent. */
  tableChecksums: Record<string, string | null>;
  supported: boolean;
  warnings: string[];
}
