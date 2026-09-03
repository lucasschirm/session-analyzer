import {
  computePrunedNodeIds,
  type DevinCompactionBoundary,
  type DevinMessageLine,
  type DevinPromptLine,
  detectCompactionBoundaries,
} from '@lucasschirm/sal-devin-session-parser';
import type {
  CompactionEventPayload,
  NormalizedEvidenceRecord,
} from '@lucasschirm/sal-transformer-shared';
import { provenanceForArtifact, stableId } from './session-spine.js';

/** A `/compact` prompt row correlated with a compaction's timestamp is
 * treated as `trigger: 'manual'`; outside this window the trigger is
 * genuinely unknown (never guessed as `'auto'` — DS-B27 (#287) Finding 6:
 * only one, manual, sample has ever been observed on this harness). */
const MANUAL_TRIGGER_WINDOW_MS = 60_000;

/**
 * Devin-specific extension of the shared `CompactionEventPayload`. `prunedNodeIds`
 * is the node-id set recovered by walking `parent_node_id` from the
 * `summarized_from` anchor to the reattachment parent (never an arithmetic
 * `node_id` range — see `computePrunedNodeIds`); it has no Claude analog and
 * is intentionally NOT part of the promoted shared shape. `anchorNodeId` /
 * `anchorRowId` explicitly reference the `summarized_from` node's `node_id`
 * and `message_nodes.row_id` as the source event, per
 * `manifest-backed-classification`.
 */
export interface DevinCompactionEventPayload extends CompactionEventPayload {
  readonly anchorNodeId: number;
  readonly anchorRowId: number | undefined;
  readonly prunedNodeIds: number[];
}

function anchorMessage(
  messages: readonly DevinMessageLine[],
  anchorNodeId: number,
): DevinMessageLine | undefined {
  return messages.find((m) => m.nodeId === anchorNodeId);
}

/** References the `summarized_from` anchor node's `node_id` (and `row_id`
 * when known) — never the chat message's own uuid — so the compaction
 * record's provenance resolves to the same node identity used by
 * `computePrunedNodeIds`. */
function compactionSourceEventId(
  anchor: DevinMessageLine | undefined,
  anchorNodeId: number,
): string {
  return anchor ? `node-${anchorNodeId}-row-${anchor.rowId}` : `node-${anchorNodeId}`;
}

function boundaryTimestampMs(
  boundary: DevinCompactionBoundary,
  anchor: DevinMessageLine | undefined,
): number {
  if (boundary.timestampMs !== null) return boundary.timestampMs;
  if (anchor?.createdAt !== null && anchor?.createdAt !== undefined) return anchor.createdAt * 1000;
  return 0;
}

/** `'manual'` when a `/compact` prompt row falls within `MANUAL_TRIGGER_WINDOW_MS`
 * of the boundary timestamp; otherwise `undefined` (missing, never a guessed
 * `'auto'` default — per `missing-is-never-zero`). */
function deriveTrigger(
  prompts: readonly DevinPromptLine[],
  timestampMs: number,
): string | undefined {
  const correlated = prompts.some((p) => {
    if (p.content !== '/compact' || p.ts === null) return false;
    return Math.abs(p.ts * 1000 - timestampMs) <= MANUAL_TRIGGER_WINDOW_MS;
  });
  return correlated ? 'manual' : undefined;
}

function compactionSummary(trigger: string | undefined): string {
  return trigger ? `Context compaction (${trigger})` : 'Context compaction';
}

function buildCompactionRecord(
  sessionId: string,
  messages: readonly DevinMessageLine[],
  prompts: readonly DevinPromptLine[],
  boundary: DevinCompactionBoundary,
  rootArtifactId: string,
): NormalizedEvidenceRecord {
  const anchor = anchorMessage(messages, boundary.anchorNodeId);
  const sourceEventId = compactionSourceEventId(anchor, boundary.anchorNodeId);
  const timestampMs = boundaryTimestampMs(boundary, anchor);
  const trigger = deriveTrigger(prompts, timestampMs);
  const { prunedNodeIds } = computePrunedNodeIds(messages, boundary.anchorNodeId);
  const recordId = stableId('normalized_event', {
    session: sessionId,
    category: 'compaction',
    source: sourceEventId,
  });

  // Devin has no analog for postTokens/cumulativeDroppedTokens/compactionDurationMs
  // (DS-B27 (#287) Finding 5) - they must stay absent from the payload, never `0`.
  const payload: DevinCompactionEventPayload = {
    eventId: recordId,
    version: 1,
    category: 'compaction',
    eventType: 'compact_boundary',
    timestampMs,
    sourceEventId,
    // Devin has no JSONL-line-number concept for message_nodes; the node's
    // own `order` (its position in devin-session-jsonl/v1) is the closest
    // real analog and is used verbatim, never a fabricated 0.
    lineNumber: anchor?.order ?? 0,
    summary: compactionSummary(trigger),
    ...(trigger !== undefined ? { trigger } : {}),
    ...(anchor?.parsedMetadata?.numTokensPreceding !== null &&
    anchor?.parsedMetadata?.numTokensPreceding !== undefined
      ? { preTokens: anchor.parsedMetadata.numTokensPreceding }
      : {}),
    anchorNodeId: boundary.anchorNodeId,
    anchorRowId: anchor?.rowId,
    prunedNodeIds,
  };

  return {
    recordId,
    recordType: 'normalized_event',
    sessionId,
    sourceEventId,
    sourceField: 'metadata.summarized_from',
    provenance: provenanceForArtifact(rootArtifactId, sourceEventId, 'metadata.summarized_from'),
    payload,
  };
}

/**
 * Builds one `category: 'compaction'` `normalized_event` evidence record per
 * detected compaction boundary in the session's message set.
 */
export function buildDevinCompactionRecords(
  sessionId: string,
  messages: readonly DevinMessageLine[],
  prompts: readonly DevinPromptLine[],
  rootArtifactId: string,
): NormalizedEvidenceRecord[] {
  return detectCompactionBoundaries(messages).map((boundary) =>
    buildCompactionRecord(sessionId, messages, prompts, boundary, rootArtifactId),
  );
}
