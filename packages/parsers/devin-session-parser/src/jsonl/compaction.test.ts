import { describe, expect, it } from 'vitest';
import { computePrunedNodeIds, detectCompactionBoundaries } from './compaction.js';
import type { DevinMessageLine, DevinMessageNodeMetadata } from './types.js';

function node(
  nodeId: number,
  parentNodeId: number | null,
  metadata?: Partial<DevinMessageNodeMetadata>,
  createdAt: number | null = null,
): DevinMessageLine {
  const parsedMetadata: DevinMessageNodeMetadata | null = metadata
    ? {
        summarizedFrom: metadata.summarizedFrom ?? null,
        numTokensPreceding: metadata.numTokensPreceding ?? null,
        isSystemPrefix: metadata.isSystemPrefix ?? null,
        extensions: metadata.extensions,
      }
    : null;
  return {
    type: 'message',
    ts: null,
    order: nodeId,
    rowId: 80000 + nodeId,
    sessionId: 'shadow-collar',
    nodeId,
    parentNodeId,
    role: 'assistant',
    rawRole: null,
    chatMessage: { message_id: `msg-${nodeId}`, role: 'assistant', content: `node ${nodeId}` },
    createdAt,
    metadata: metadata ? JSON.stringify(metadata) : null,
    parsedMetadata,
    subagent: null,
  };
}

/**
 * Reproduces (anonymized) the real `shadow-collar` session's node 45-63
 * shape from Research Finding 2 of DS-B27 (#287): a linear pre-compaction
 * chain 45->...->49->...->55->57, a dead sibling branch (56, sharing parent
 * 55 with 57, from an earlier retried turn), and the compaction's own
 * output-node subtree (58-63): 58 is a disconnected root (the Summarizer
 * system prompt), 59/60 its children (the conversation dump and the
 * summarize instruction), 61 the generated summary (summarizedFrom: 57),
 * 62 the <available_skills> reinjection reattaching the main chain at 49,
 * and 63 the "continuing from previous thread" node (summarizedFrom: 57).
 */
function shadowCollarNodes(): DevinMessageLine[] {
  return [
    node(45, null, undefined, 1788465000),
    node(46, 45, undefined, 1788465010),
    node(47, 46, undefined, 1788465020),
    node(48, 47, undefined, 1788465030),
    node(49, 48, undefined, 1788465040),
    node(50, 49, undefined, 1788465050),
    node(51, 50, undefined, 1788465060),
    node(52, 51, undefined, 1788465070),
    node(53, 52, undefined, 1788465080),
    node(54, 53, undefined, 1788465090),
    node(55, 54, undefined, 1788465100),
    // Sibling of 57 sharing parent 55 - a dead branch from an earlier retried turn.
    node(56, 55, undefined, 1788465105),
    node(
      57,
      55,
      { summarizedFrom: null, numTokensPreceding: 17033, isSystemPrefix: null },
      1788465110,
    ),
    // Compaction output subtree, all persisted together at created_at=1788465458.
    node(
      58,
      null,
      { summarizedFrom: null, numTokensPreceding: null, isSystemPrefix: true },
      1788465458,
    ),
    node(59, 58, undefined, 1788465458),
    node(60, 59, undefined, 1788465458),
    node(
      61,
      60,
      { summarizedFrom: 57, numTokensPreceding: null, isSystemPrefix: null },
      1788465458,
    ),
    node(62, 49, undefined, 1788465458),
    node(
      63,
      62,
      { summarizedFrom: 57, numTokensPreceding: null, isSystemPrefix: null },
      1788465458,
    ),
  ];
}

describe('detectCompactionBoundaries', () => {
  it('detects a compaction boundary strictly from metadata.summarizedFrom !== null', () => {
    const boundaries = detectCompactionBoundaries(shadowCollarNodes());
    expect(boundaries).toHaveLength(1);
    expect(boundaries[0].anchorNodeId).toBe(57);
    expect(boundaries[0].outputNodeIds).toEqual([61, 63]);
    expect(boundaries[0].timestampMs).toBe(1788465458000);
  });

  it('does not detect a compaction when no node carries a non-null summarizedFrom', () => {
    const messages = [
      node(1, null, undefined, 100),
      node(2, 1, { summarizedFrom: null, numTokensPreceding: 500, isSystemPrefix: null }, 200),
    ];
    expect(detectCompactionBoundaries(messages)).toEqual([]);
  });

  it('never flags a node carrying only extensions["compact/prior_node_ids"] (Finding 4 false-positive shape)', () => {
    const messages = [
      node(6, null, undefined, 100),
      node(
        7,
        6,
        {
          summarizedFrom: null,
          numTokensPreceding: null,
          isSystemPrefix: null,
          extensions: { 'compact/prior_node_ids': [1, 2, 3, 4, 5] },
        },
        200,
      ),
    ];
    // 26 real-session nodes carry `prior_node_ids` bookkeeping unrelated to
    // compaction; a substring/key-name search would false-positive on all of
    // them. The detector must key strictly on summarizedFrom, so this node
    // (summarizedFrom: null) must not be detected as a compaction boundary.
    expect(detectCompactionBoundaries(messages)).toEqual([]);
  });

  it('groups multiple output nodes sharing the same anchor into one boundary', () => {
    const messages = [
      node(10, null, undefined, 0),
      node(11, 10, { summarizedFrom: 10, numTokensPreceding: null, isSystemPrefix: null }, 10),
      node(12, 11, { summarizedFrom: 10, numTokensPreceding: null, isSystemPrefix: null }, 20),
    ];
    const boundaries = detectCompactionBoundaries(messages);
    expect(boundaries).toHaveLength(1);
    expect(boundaries[0].outputNodeIds).toEqual([11, 12]);
  });
});

describe('computePrunedNodeIds', () => {
  it('recovers exactly [50,51,52,53,54,55,57] via a parent_node_id walk, excluding sibling node 56', () => {
    const result = computePrunedNodeIds(shadowCollarNodes(), 57);
    expect(result.prunedNodeIds).toEqual([50, 51, 52, 53, 54, 55, 57]);
    expect(result.prunedNodeIds).not.toContain(56);
    expect(result.reattachmentNodeId).toBe(49);
  });

  it('never uses an arithmetic node_id range: a naive BETWEEN 50 AND 57 would wrongly include 56', () => {
    const result = computePrunedNodeIds(shadowCollarNodes(), 57);
    const naiveRange = Array.from({ length: 57 - 50 + 1 }, (_, i) => 50 + i);
    expect(naiveRange).toContain(56);
    expect(result.prunedNodeIds).not.toEqual(naiveRange);
  });

  it('returns an empty pruned range (never a guess) when no reattachment point is found', () => {
    // The compaction's output node (3) is a disconnected root (parentNodeId:
    // null, e.g. the session ends immediately after the summary with no
    // further conversation reconnecting to the pre-compaction chain) - there
    // is no node whose parent points back into the anchor's ancestor chain,
    // so the reattachment point is genuinely indeterminate.
    const messages = [
      node(1, null, undefined, 0),
      node(2, 1, undefined, 10),
      node(3, null, { summarizedFrom: 2, numTokensPreceding: null, isSystemPrefix: null }, 20),
    ];
    const result = computePrunedNodeIds(messages, 2);
    expect(result.prunedNodeIds).toEqual([]);
    expect(result.reattachmentNodeId).toBeNull();
  });

  it('finds reattachment == anchor when the chain resumes immediately with no pruned segment', () => {
    const messages = [
      node(1, null, undefined, 0),
      node(2, 1, undefined, 10),
      node(3, 2, { summarizedFrom: 2, numTokensPreceding: null, isSystemPrefix: null }, 20),
    ];
    const result = computePrunedNodeIds(messages, 2);
    expect(result.reattachmentNodeId).toBe(2);
    expect(result.prunedNodeIds).toEqual([]);
  });
});
