/**
 * Devin CLI context-compaction (`/compact`) boundary detection and pruned
 * node-range recovery.
 *
 * A compaction boundary is detected strictly by `metadata.summarizedFrom !==
 * null` (see `DevinMessageNodeMetadata`) — never by a substring/key-name
 * search over `metadata` JSON. `extensions['compact/prior_node_ids']` is a
 * confirmed false-positive shape (unrelated node-forest-rewrite bookkeeping
 * present on ordinary turns throughout a session) and must not be treated as
 * a compaction signal.
 */

import type { DevinMessageLine } from './types.js';

/** One detected compaction event: an anchor (last pre-compaction node) plus
 * the compaction's own output nodes (the ones carrying `summarizedFrom ===
 * anchorNodeId`). */
export interface DevinCompactionBoundary {
  /** `node_id` of the last pre-compaction node — `metadata.summarized_from`. */
  readonly anchorNodeId: number;
  /** `node_id`s of the compaction's own output nodes, ascending. */
  readonly outputNodeIds: number[];
  /** Earliest `createdAt` (ms) among the output nodes; `null` if none is populated. */
  readonly timestampMs: number | null;
}

function earliestCreatedAtMs(messages: readonly DevinMessageLine[]): number | null {
  let earliest: number | null = null;
  for (const m of messages) {
    if (m.createdAt === null) continue;
    const ms = m.createdAt * 1000;
    if (earliest === null || ms < earliest) earliest = ms;
  }
  return earliest;
}

/**
 * Detects every compaction boundary in a message set, grouped by anchor node
 * id (a single compaction event may produce multiple output nodes sharing
 * the same `summarizedFrom` anchor — e.g. the generated summary node and the
 * "continuing from previous thread" node).
 */
export function detectCompactionBoundaries(
  messages: readonly DevinMessageLine[],
): DevinCompactionBoundary[] {
  const byAnchor = new Map<number, DevinMessageLine[]>();
  for (const message of messages) {
    const anchor = message.parsedMetadata?.summarizedFrom;
    if (anchor === null || anchor === undefined) continue;
    const list = byAnchor.get(anchor) ?? [];
    list.push(message);
    byAnchor.set(anchor, list);
  }
  return [...byAnchor.entries()]
    .sort(([a], [b]) => a - b)
    .map(([anchorNodeId, outputs]) => ({
      anchorNodeId,
      outputNodeIds: outputs.map((o) => o.nodeId).sort((a, b) => a - b),
      timestampMs: earliestCreatedAtMs(outputs),
    }));
}

export interface DevinPrunedRange {
  /** Pruned `node_id`s, ascending. Empty when no reattachment point is found
   * (indeterminate — never a guessed range). */
  readonly prunedNodeIds: number[];
  /** The `node_id` the main chain reattaches to after the compaction, or
   * `null` if it could not be determined from this message set. */
  readonly reattachmentNodeId: number | null;
}

function buildAncestorChain(
  anchorNodeId: number,
  parentOf: ReadonlyMap<number, number | null>,
): number[] {
  const chain: number[] = [];
  const seen = new Set<number>();
  let current: number | null = anchorNodeId;
  while (current !== null && parentOf.has(current) && !seen.has(current)) {
    chain.push(current);
    seen.add(current);
    current = parentOf.get(current) ?? null;
  }
  return chain;
}

function findReattachmentNodeId(
  messages: readonly DevinMessageLine[],
  anchorNodeId: number,
  ancestorSet: ReadonlySet<number>,
): number | null {
  let reattachmentNodeId: number | null = null;
  let earliestCandidateNodeId = Number.POSITIVE_INFINITY;
  for (const message of messages) {
    if (message.nodeId <= anchorNodeId) continue;
    if (message.parentNodeId === null || !ancestorSet.has(message.parentNodeId)) continue;
    if (message.nodeId < earliestCandidateNodeId) {
      earliestCandidateNodeId = message.nodeId;
      reattachmentNodeId = message.parentNodeId;
    }
  }
  return reattachmentNodeId;
}

/**
 * Recovers the pruned node-id range for a compaction anchored at
 * `anchorNodeId`, by walking `parent_node_id` from the anchor toward the
 * session root — **never** an arithmetic `node_id` range, which would wrongly
 * include a sibling node from a dead retried-turn branch (a session's turn
 * tree can branch repeatedly; a sibling sharing a parent with an
 * on-chain node is not itself on the chain).
 *
 * The walk terminates at the "reattachment parent": the parent of the
 * earliest (by `node_id`) node whose own `node_id` is greater than the
 * anchor and whose `parent_node_id` points back into the anchor's ancestor
 * chain. That reattachment node is where the main chain resumes after the
 * compaction; its parent is kept (not pruned), and everything strictly
 * between it and the anchor (inclusive of the anchor) is the pruned set.
 *
 * Returns an empty `prunedNodeIds` (never a best-effort guess) when no
 * reattachment point can be found in this message set.
 */
export function computePrunedNodeIds(
  messages: readonly DevinMessageLine[],
  anchorNodeId: number,
): DevinPrunedRange {
  const parentOf = new Map<number, number | null>();
  for (const message of messages) parentOf.set(message.nodeId, message.parentNodeId);

  const ancestorChain = buildAncestorChain(anchorNodeId, parentOf);
  const ancestorSet = new Set(ancestorChain);
  const reattachmentNodeId = findReattachmentNodeId(messages, anchorNodeId, ancestorSet);

  if (reattachmentNodeId === null) {
    return { prunedNodeIds: [], reattachmentNodeId: null };
  }
  const cutIndex = ancestorChain.indexOf(reattachmentNodeId);
  const pruned = cutIndex === -1 ? ancestorChain : ancestorChain.slice(0, cutIndex);
  return { prunedNodeIds: [...pruned].sort((a, b) => a - b), reattachmentNodeId };
}
