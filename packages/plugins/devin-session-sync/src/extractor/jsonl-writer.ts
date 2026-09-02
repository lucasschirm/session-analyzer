import type {
  DevinExtractedTables,
  DevinJsonlLine,
  DevinMessageNodeRow,
  DevinPromptHistoryRow,
  DevinSessionRow,
  DevinToolCallStateRow,
  DevinWatermarks,
} from './types.js';
import { EMPTY_WATERMARKS } from './types.js';

/**
 * Emits `devin-session-jsonl/v1` lines from a set of raw table reads.
 *
 * Determinism contract: identical `tables` + `options` input always
 * produces byte-identical output — no `Date.now()`/random values, every
 * sort is over a stable, fully-specified key (session id, then node_id via
 * `orderMessageNodes`, then rowid/id), and JSON field order is fixed
 * (`type`, `ts`, `order`, then the raw row's columns in their SQL SELECT
 * order — see `schema-registry.ts`'s `KNOWN_TABLE_COLUMNS`).
 */

export interface BuildDevinJsonlOptions {
  /** Starting value for the monotonic `order` counter (continues a prior run). */
  orderOffset?: number;
  /** Watermarks from the prior run, merged (never regressed) into the result. */
  priorWatermarks?: DevinWatermarks;
}

export interface BuildDevinJsonlResult {
  lines: DevinJsonlLine[];
  /** One JSON object per line, newline-terminated; empty string if no lines. */
  text: string;
  watermarks: DevinWatermarks;
}

export function buildDevinJsonl(
  tables: DevinExtractedTables,
  options: BuildDevinJsonlOptions = {},
): BuildDevinJsonlResult {
  const sessionsById = new Map(tables.sessions.map((s) => [s.id, s]));
  const nodesBySession = groupBy(tables.messageNodes, (m) => m.session_id);
  const promptsBySession = groupBy(tables.promptHistory, (p) => p.session_id);
  const toolCallsBySession = groupBy(tables.toolCallStates, (t) => t.session_id);

  let order = options.orderOffset ?? 0;
  const lines: DevinJsonlLine[] = [];
  for (const sessionId of collectSessionIds(tables)) {
    order = appendSessionLines(lines, order, sessionsById.get(sessionId), {
      nodes: nodesBySession.get(sessionId) ?? [],
      prompts: promptsBySession.get(sessionId) ?? [],
      toolCalls: toolCallsBySession.get(sessionId) ?? [],
    });
  }
  const prior = options.priorWatermarks ?? EMPTY_WATERMARKS;
  return { lines, text: serializeLines(lines), watermarks: computeWatermarks(tables, prior) };
}

function collectSessionIds(tables: DevinExtractedTables): string[] {
  const ids = new Set<string>();
  for (const s of tables.sessions) ids.add(s.id);
  for (const m of tables.messageNodes) ids.add(m.session_id);
  for (const p of tables.promptHistory) ids.add(p.session_id);
  for (const t of tables.toolCallStates) ids.add(t.session_id);
  return [...ids].sort();
}

interface SessionBuckets {
  nodes: DevinMessageNodeRow[];
  prompts: DevinPromptHistoryRow[];
  toolCalls: DevinToolCallStateRow[];
}

function appendSessionLines(
  lines: DevinJsonlLine[],
  order: number,
  session: DevinSessionRow | undefined,
  buckets: SessionBuckets,
): number {
  let next = order;
  if (session) {
    lines.push(sessionLine(session, next));
    next += 1;
  }
  next = appendMessageAndToolCallLines(lines, next, buckets.nodes, buckets.toolCalls);
  next = appendPromptLines(lines, next, buckets.prompts);
  return next;
}

/**
 * Builds the deterministic topological order of a session's `message_nodes`
 * tree: root(s) first, then children, tie-broken by ascending `node_id`.
 * `created_at` is never used — verified empirically to be shared across all
 * rows of a session (equal to `sessions.last_activity_at`), because the
 * node forest is rewritten on each persist rather than timestamped
 * per-message. A node whose parent isn't present in this batch (already
 * emitted in a prior incremental run) is treated as immediately ready.
 */
export function orderMessageNodes(nodes: DevinMessageNodeRow[]): DevinMessageNodeRow[] {
  const idsInBatch = new Set(nodes.map((n) => n.node_id));
  const childrenByParent = new Map<number, DevinMessageNodeRow[]>();
  for (const n of nodes) {
    if (n.parent_node_id === null) continue;
    const bucket = childrenByParent.get(n.parent_node_id);
    bucket ? bucket.push(n) : childrenByParent.set(n.parent_node_id, [n]);
  }
  const ready = nodes.filter((n) => n.parent_node_id === null || !idsInBatch.has(n.parent_node_id));
  const ordered: DevinMessageNodeRow[] = [];
  while (ready.length > 0) {
    ready.sort((a, b) => a.node_id - b.node_id);
    const next = ready.shift() as DevinMessageNodeRow;
    ordered.push(next);
    ready.push(...(childrenByParent.get(next.node_id) ?? []));
  }
  return ordered;
}

/**
 * Finds the `tool_call_state` rows referenced by a message node: a row is
 * "resolvable" to a node when its `tool_call_id` appears in that node's raw
 * `chat_message` JSON text (the ACP tool-call reference). Already-resolved
 * ids are skipped; matches are returned in `row_id` order for determinism.
 */
function resolveToolCallsForNode(
  node: DevinMessageNodeRow,
  toolCalls: DevinToolCallStateRow[],
  resolved: Set<string>,
): DevinToolCallStateRow[] {
  if (!node.chat_message) {
    return [];
  }
  const matches = toolCalls
    .filter((t) => !resolved.has(t.tool_call_id) && node.chat_message?.includes(t.tool_call_id))
    .sort((a, b) => a.row_id - b.row_id);
  for (const m of matches) resolved.add(m.tool_call_id);
  return matches;
}

function appendMessageAndToolCallLines(
  lines: DevinJsonlLine[],
  order: number,
  nodes: DevinMessageNodeRow[],
  toolCalls: DevinToolCallStateRow[],
): number {
  let next = order;
  const resolved = new Set<string>();
  for (const node of orderMessageNodes(nodes)) {
    lines.push(messageLine(node, next));
    next += 1;
    for (const call of resolveToolCallsForNode(node, toolCalls, resolved)) {
      lines.push(toolCallLine(call, next));
      next += 1;
    }
  }
  next = appendUnresolvedToolCalls(lines, next, toolCalls, resolved);
  return next;
}

/** Tool calls that couldn't be matched to a message node: appended last, in `row_id` order. */
function appendUnresolvedToolCalls(
  lines: DevinJsonlLine[],
  order: number,
  toolCalls: DevinToolCallStateRow[],
  resolved: Set<string>,
): number {
  let next = order;
  const unresolved = toolCalls
    .filter((t) => !resolved.has(t.tool_call_id))
    .sort((a, b) => a.row_id - b.row_id);
  for (const call of unresolved) {
    lines.push(toolCallLine(call, next));
    next += 1;
  }
  return next;
}

function appendPromptLines(
  lines: DevinJsonlLine[],
  order: number,
  prompts: DevinPromptHistoryRow[],
): number {
  let next = order;
  for (const p of [...prompts].sort((a, b) => a.id - b.id)) {
    lines.push(promptLine(p, next));
    next += 1;
  }
  return next;
}

function sessionLine(row: DevinSessionRow, order: number): DevinJsonlLine {
  return { type: 'session', ts: row.last_activity_at ?? null, order, ...row };
}

// `created_at` is deliberately not surfaced as `ts` here: it is not a
// reliable per-message timestamp (see `orderMessageNodes` above and
// `types.ts`'s `DevinMessageNodeRow`). It is still present as a raw field.
function messageLine(row: DevinMessageNodeRow, order: number): DevinJsonlLine {
  return { type: 'message', ts: null, order, ...row };
}

// `tool_call_state` has no timestamp column at all.
function toolCallLine(row: DevinToolCallStateRow, order: number): DevinJsonlLine {
  return { type: 'tool_call', ts: null, order, ...row };
}

function promptLine(row: DevinPromptHistoryRow, order: number): DevinJsonlLine {
  return { type: 'prompt', ts: row.timestamp ?? null, order, ...row };
}

function groupBy<T>(rows: T[], keyFn: (row: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const key = keyFn(row);
    const bucket = map.get(key);
    bucket ? bucket.push(row) : map.set(key, [row]);
  }
  return map;
}

function computeWatermarks(tables: DevinExtractedTables, prior: DevinWatermarks): DevinWatermarks {
  return {
    messageNodesRowId: mergeWatermark(
      prior.messageNodesRowId,
      tables.messageNodes.map((m) => m.row_id),
    ),
    toolCallStateRowId: mergeWatermark(
      prior.toolCallStateRowId,
      tables.toolCallStates.map((t) => t.row_id),
    ),
    promptHistoryId: mergeWatermark(
      prior.promptHistoryId,
      tables.promptHistory.map((p) => p.id),
    ),
  };
}

/** Merges a prior watermark with a batch's row ids; never regresses. */
function mergeWatermark(prior: number | null, batchIds: number[]): number | null {
  const batchMax = batchIds.length === 0 ? null : Math.max(...batchIds);
  if (prior === null) return batchMax;
  if (batchMax === null) return prior;
  return Math.max(prior, batchMax);
}

function serializeLines(lines: DevinJsonlLine[]): string {
  if (lines.length === 0) {
    return '';
  }
  return `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`;
}
