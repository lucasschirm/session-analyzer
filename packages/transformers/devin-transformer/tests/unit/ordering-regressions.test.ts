import { describe, expect, it } from 'vitest';
import { parseDevinBundle } from '../../src/parse-bundle.js';

/**
 * DS-B28 (#294) findings #4 and #5: two live ordering-corruption bugs that
 * block #285/#290's per-message model/effort attribution, since both key
 * off `turnOrdinal`. These fixtures mirror the issue's own cited real node
 * ids so a reviewer can cross-check the shape directly against the issue.
 */

function devinJsonlLine(type: string, rest: Record<string, unknown>): string {
  return JSON.stringify({ type, ...rest });
}

function sessionLine(id: string, mainChainId: number | undefined): string {
  return devinJsonlLine('session', {
    ts: 1,
    order: 0,
    id,
    working_directory: '/repo',
    backend_type: 'devin',
    model: 'devin-default',
    agent_mode: 'auto',
    created_at: 1,
    last_activity_at: 2,
    title: 'Fixture session',
    main_chain_id: mainChainId === undefined ? undefined : String(mainChainId),
  });
}

function messageLine(
  sessionId: string,
  nodeId: number,
  parentNodeId: number | null,
  role: string,
  content: string,
  options?: { messageId?: string; metadata?: Record<string, unknown> | null },
): string {
  return devinJsonlLine('message', {
    ts: null,
    order: nodeId + 1,
    row_id: nodeId,
    session_id: sessionId,
    node_id: nodeId,
    parent_node_id: parentNodeId,
    chat_message: JSON.stringify({
      message_id: options?.messageId ?? `msg-${nodeId}`,
      role,
      content,
    }),
    created_at: null,
    metadata: options?.metadata === undefined ? null : JSON.stringify(options.metadata),
  });
}

function bundle(transcript: string) {
  return {
    artifacts: [
      { relativePath: 'transcript.jsonl', content: transcript, mediaType: 'application/jsonl' },
    ],
    sourceFingerprint: 'fp-ordering',
  };
}

describe('DS-B28 (#294) finding #4: duplicate message_nodes pairs must not double-count', () => {
  it('dedupes a plain/annotated duplicate pair (mirrors shadow-collar nodes 249/250) by message_id', () => {
    const sessionId = 's1';
    const transcript = [
      sessionLine(sessionId, undefined),
      messageLine(sessionId, 245, null, 'user', 'start'),
      messageLine(sessionId, 248, 245, 'system', 'notification'),
      // 249: "plain" copy -- metadata: null.
      messageLine(sessionId, 249, 248, 'assistant', 'duplicated content', {
        messageId: 'msg-shared-249-250',
        metadata: null,
      }),
      // 250: "annotated" copy -- same message_id/content, different node_id,
      // metadata populated (summarized_from/num_tokens_preceding/is_system_prefix).
      messageLine(sessionId, 250, 248, 'assistant', 'duplicated content', {
        messageId: 'msg-shared-249-250',
        metadata: { summarized_from: null, num_tokens_preceding: 500, is_system_prefix: null },
      }),
    ].join('\n');

    const parsed = parseDevinBundle(bundle(transcript));

    // Only ONE of the pair survives into orderedMessages -- not two.
    const nodeIds = parsed.orderedMessages.map((m) => m.nodeId);
    expect(nodeIds).toEqual([245, 248, 250]);
    expect(nodeIds).not.toContain(249);

    // The kept copy is the more-complete (metadata-carrying) one.
    const kept = parsed.orderedMessages.find((m) => m.nodeId === 250);
    expect(kept?.parsedMetadata?.numTokensPreceding).toBe(500);

    // No inflation: 3 logical messages in, 3 out -- not 4.
    expect(parsed.orderedMessages).toHaveLength(3);
  });

  it('redirects a would-be child of a dropped duplicate to the kept canonical node', () => {
    const sessionId = 's1';
    const transcript = [
      sessionLine(sessionId, undefined),
      messageLine(sessionId, 1, null, 'user', 'start'),
      messageLine(sessionId, 2, 1, 'system', 'mid'),
      messageLine(sessionId, 3, 2, 'assistant', 'dup', { messageId: 'shared', metadata: null }),
      messageLine(sessionId, 4, 2, 'assistant', 'dup', {
        messageId: 'shared',
        metadata: { summarized_from: null, num_tokens_preceding: 10, is_system_prefix: null },
      }),
      // A hypothetical child of the DROPPED duplicate (node 3).
      messageLine(sessionId, 5, 3, 'user', 'child of the dropped duplicate'),
    ].join('\n');

    const parsed = parseDevinBundle(bundle(transcript));
    const nodeIds = parsed.orderedMessages.map((m) => m.nodeId);
    expect(nodeIds).not.toContain(3);
    expect(nodeIds).toContain(5);

    const child = parsed.orderedMessages.find((m) => m.nodeId === 5);
    // Redirected to the kept canonical (node 4), not left dangling on the dropped node 3.
    expect(child?.parentNodeId).toBe(4);
  });

  it('does not affect a session with no duplicates', () => {
    const sessionId = 's1';
    const transcript = [
      sessionLine(sessionId, undefined),
      messageLine(sessionId, 1, null, 'user', 'a'),
      messageLine(sessionId, 2, 1, 'assistant', 'b'),
    ].join('\n');
    const parsed = parseDevinBundle(bundle(transcript));
    expect(parsed.orderedMessages.map((m) => m.nodeId)).toEqual([1, 2]);
  });

  it('keeps the genuinely richer copy when BOTH duplicates carry non-null parsedMetadata (PR #295 review finding #2)', () => {
    // Deliberately gives the LOWER nodeId (249) the poorer metadata (every
    // field null, but the object itself is non-null) and the HIGHER nodeId
    // (250) the richer metadata (two populated fields). A boolean
    // presence-only check can't tell these apart -- both are "non-null" --
    // so it falls through to the nodeId tie-break and would incorrectly
    // keep 249 (the poorer copy). The richness-scored comparator must keep
    // 250 instead.
    const sessionId = 's1';
    const transcript = [
      sessionLine(sessionId, undefined),
      messageLine(sessionId, 245, null, 'user', 'start'),
      messageLine(sessionId, 249, 245, 'assistant', 'duplicated content', {
        messageId: 'msg-shared-249-250',
        metadata: { summarized_from: null, num_tokens_preceding: null, is_system_prefix: null },
      }),
      messageLine(sessionId, 250, 245, 'assistant', 'duplicated content', {
        messageId: 'msg-shared-249-250',
        metadata: { summarized_from: null, num_tokens_preceding: 500, is_system_prefix: true },
      }),
    ].join('\n');

    const parsed = parseDevinBundle(bundle(transcript));
    const nodeIds = parsed.orderedMessages.map((m) => m.nodeId);
    expect(nodeIds).toEqual([245, 250]);
    expect(nodeIds).not.toContain(249);

    const kept = parsed.orderedMessages.find((m) => m.nodeId === 250);
    expect(kept?.parsedMetadata?.numTokensPreceding).toBe(500);
    expect(kept?.parsedMetadata?.isSystemPrefix).toBe(true);
  });
});

describe('DS-B28 (#294) finding #5: orphaned sub-agent trees must not corrupt main turnOrdinal', () => {
  it('excludes an orphaned parent_node_id:null tree (mirrors foremost-hide nodes 316-322) from orderedMessages, and surfaces it as detachedMessages instead', () => {
    const sessionId = 's1';
    const mainMessages = [
      messageLine(sessionId, 1, null, 'user', 'start the pr-review subagent'),
      messageLine(sessionId, 2, 1, 'assistant', 'calling run_subagent'),
      messageLine(sessionId, 3, 2, 'tool', 'Background subagent started with agent_id=8d591a24'),
    ];
    // The orphaned tree: a completely separate, disconnected persona/conversation
    // (a pr-review sub-agent whose own turns got flushed to message_nodes,
    // never linking back to node 2, the run_subagent call site).
    const orphanTree = [
      messageLine(
        sessionId,
        317,
        null,
        'system',
        'You are a senior engineer performing thorough pull request reviews...',
      ),
      messageLine(sessionId, 318, 317, 'user', 'Review PR #264'),
      messageLine(sessionId, 320, 318, 'assistant', 'Looking at the diff'),
      messageLine(sessionId, 322, 320, 'assistant', 'Posted the review'),
    ];
    const transcript = [sessionLine(sessionId, 3), ...mainMessages, ...orphanTree].join('\n');

    const parsed = parseDevinBundle(bundle(transcript));

    // Main turnOrdinal sequencing is clean: only the real main-chain nodes,
    // never spliced with the orphan tree by node_id magnitude.
    expect(parsed.orderedMessages.map((m) => m.nodeId)).toEqual([1, 2, 3]);

    // The orphan tree is not dropped -- it is surfaced separately.
    expect(parsed.detachedMessages.map((m) => m.nodeId)).toEqual([317, 318, 320, 322]);
  });

  it('a background sub-agent completion that IS cleanly parent-linked (no orphan) stays in the main sequence', () => {
    // Contrast case from the issue: shadow-collar's background chain
    // (226->227->228->246->247->248->249/250) has no orphan -- it must NOT
    // be excluded from orderedMessages.
    const sessionId = 's1';
    const transcript = [
      sessionLine(sessionId, 228),
      messageLine(sessionId, 226, null, 'assistant', 'run it bg'),
      messageLine(
        sessionId,
        227,
        226,
        'tool',
        'Background subagent started with agent_id=55c47591',
      ),
      messageLine(sessionId, 228, 227, 'assistant', 'ok, later'),
    ].join('\n');

    const parsed = parseDevinBundle(bundle(transcript));
    expect(parsed.orderedMessages.map((m) => m.nodeId)).toEqual([226, 227, 228]);
    expect(parsed.detachedMessages).toHaveLength(0);
  });

  it('handles multiple distinct orphaned trees deterministically, ordered by ascending root nodeId', () => {
    const sessionId = 's1';
    const transcript = [
      sessionLine(sessionId, 1),
      messageLine(sessionId, 1, null, 'user', 'main'),
      messageLine(sessionId, 50, null, 'system', 'orphan B root'),
      messageLine(sessionId, 51, 50, 'user', 'orphan B child'),
      messageLine(sessionId, 10, null, 'system', 'orphan A root'),
    ].join('\n');

    const parsed = parseDevinBundle(bundle(transcript));
    expect(parsed.orderedMessages.map((m) => m.nodeId)).toEqual([1]);
    // Trees ordered by ascending root nodeId: orphan A (root 10) before orphan B (root 50).
    expect(parsed.detachedMessages.map((m) => m.nodeId)).toEqual([10, 50, 51]);
  });
});

describe('PR #295 review finding #1: defaultLeaf() root selection must not be hijacked by a REAL orphan tree with a lower root node_id', () => {
  it('selects the true (larger) main conversation over a real, non-synthetic orphan tree whose root node_id is LOWER, when mainChainId is absent', () => {
    const sessionId = 's1';
    // A REAL orphan tree (no `sal/synthetic_subagent_kind` tag -- this is
    // NOT one of this PR's own synthesized subagent lines, it's the "real
    // pre-existing orphan tree" class finding #1 is about) whose root
    // node_id (5) is LOWER than the true conversation's root (100). Small:
    // 2 nodes.
    const orphanTree = [
      messageLine(sessionId, 5, null, 'system', 'You are a sub-agent persona...'),
      messageLine(sessionId, 6, 5, 'user', 'orphan turn'),
    ];
    // The true main conversation: root node_id 100 (HIGHER than the
    // orphan's root), but with far more descendants -- 6 nodes.
    const mainConversation = [
      messageLine(sessionId, 100, null, 'user', 'start the real session'),
      messageLine(sessionId, 101, 100, 'assistant', 'ok'),
      messageLine(sessionId, 102, 101, 'user', 'continue'),
      messageLine(sessionId, 103, 102, 'assistant', 'continuing'),
      messageLine(sessionId, 104, 103, 'user', 'more'),
      messageLine(sessionId, 105, 104, 'assistant', 'done'),
    ];
    // No mainChainId: this is the exact fallback path the review flagged.
    const transcript = [sessionLine(sessionId, undefined), ...orphanTree, ...mainConversation].join(
      '\n',
    );

    const parsed = parseDevinBundle(bundle(transcript));

    // The true, larger conversation must be `ordered` -- never excluded
    // from turnOrdinal just because a smaller real orphan tree happened to
    // have a lower root node_id.
    expect(parsed.orderedMessages.map((m) => m.nodeId)).toEqual([100, 101, 102, 103, 104, 105]);
    // The real orphan tree is correctly excluded from the main sequence
    // (surfaced separately, never dropped).
    expect(parsed.detachedMessages.map((m) => m.nodeId)).toEqual([5, 6]);
  });
});
