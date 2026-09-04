import { describe, expect, it } from 'vitest';
import { parseDevinBundle } from '../../src/parse-bundle.js';
import { buildDevinSubagentEvidence } from '../../src/subagent-evidence.js';

/**
 * DS-B28 (#294): Sub Agent domain evidence. These fixtures hand-construct
 * `transcript.jsonl` text exactly as `jsonl-writer.ts`'s
 * `appendSubagentLines` would emit it (reusing the real `message` line
 * shape) -- proving `parse-line.ts`'s existing parsing logic (via
 * `parseDevinBundle`) applies unmodified, per the issue's acceptance
 * criterion, without needing the SQLite extractor in this transformer-level
 * test.
 */

function devinJsonlLine(type: string, rest: Record<string, unknown>): string {
  return JSON.stringify({ type, ...rest });
}

function sessionLine(id: string): string {
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
  });
}

// A simple incrementing counter, independent of `nodeId` -- some fixture
// node ids are deliberately near `Number.MAX_SAFE_INTEGER` (mirroring
// `subagent-lines.ts`'s synthetic id scheme), where `nodeId + <offset>`
// would lose integer precision.
let nextOrder = 0;

function messageLine(
  sessionId: string,
  nodeId: number,
  parentNodeId: number | null,
  role: string,
  content: string,
  chatMessageExtensions?: Record<string, unknown>,
  rowMetadataExtensions?: Record<string, unknown>,
): string {
  return devinJsonlLine('message', {
    ts: null,
    order: nextOrder++,
    row_id: nodeId,
    session_id: sessionId,
    node_id: nodeId,
    parent_node_id: parentNodeId,
    chat_message: JSON.stringify({
      message_id: `msg-${nodeId}`,
      role,
      content,
      ...(chatMessageExtensions ? { metadata: { extensions: chatMessageExtensions } } : {}),
    }),
    created_at: null,
    // Row-level `message_nodes.metadata` is FLAT -- `extensions` is a field
    // the parser DERIVES from whatever isn't summarized_from/
    // num_tokens_preceding/is_system_prefix, never a literal key in the raw
    // JSON (see `DevinMessageNodeMetadata`'s parsing in parse-line.ts).
    metadata: rowMetadataExtensions ? JSON.stringify(rowMetadataExtensions) : null,
  });
}

/**
 * Reproduces exactly what `subagent-lines.ts`'s `buildSubagentSyntheticNodes`
 * would emit for one foreground invocation: a `user`-role prompt line and an
 * `assistant`-role result line, negative node ids, prompt<-result parent
 * link. Real `subagent/*` keys live in `chat_message.metadata.extensions`;
 * the `sal/synthetic_*` bookkeeping keys live in the row-level `metadata`
 * column -- two different namespaces, mirroring production exactly.
 */
function syntheticForegroundPair(sessionId: string, taggedNodeId: number, agentId: string) {
  // Mirrors `subagent-lines.ts`'s scheme exactly: offset from
  // Number.MAX_SAFE_INTEGER, never negative (see that module's doc comment
  // on why a negative id would be unsafe).
  const promptNodeId = Number.MAX_SAFE_INTEGER - taggedNodeId * 2;
  const resultNodeId = Number.MAX_SAFE_INTEGER - taggedNodeId * 2 - 1;
  return [
    messageLine(
      sessionId,
      promptNodeId,
      null,
      'user',
      'Explore the auth module',
      { 'subagent/agent_id': agentId },
      {
        'sal/synthetic_subagent_kind': 'prompt',
        'sal/synthetic_subagent_rawinput_profile': 'subagent_explore',
        'sal/synthetic_subagent_tool_call_id': 'functions.run_subagent:1',
      },
    ),
    messageLine(
      sessionId,
      resultNodeId,
      promptNodeId,
      'assistant',
      'full foreground report',
      {
        'subagent/agent_id': agentId,
        'subagent/profile_name': 'Explore',
        'subagent/model': 'Subagent Default',
        'subagent/chain_node_id': 176,
      },
      {
        'sal/synthetic_subagent_kind': 'result',
        'sal/synthetic_subagent_is_background': false,
        'sal/synthetic_subagent_source_node_id': taggedNodeId,
      },
    ),
  ];
}

function bundle(transcript: string) {
  return {
    artifacts: [
      { relativePath: 'transcript.jsonl', content: transcript, mediaType: 'application/jsonl' },
    ],
    sourceFingerprint: 'fp-subagent',
  };
}

describe('buildDevinSubagentEvidence', () => {
  it('builds a subagent_turn record pair for a synthetic prompt/result pair, with no fabricated token/cost/model-id fields', () => {
    const sessionId = 's1';
    const transcript = [
      sessionLine(sessionId),
      messageLine(sessionId, 177, null, 'assistant', 'calling run_subagent'),
      messageLine(
        sessionId,
        178,
        177,
        'tool',
        'Subagent agent_id=44472e00 completed successfully: report',
        {
          'subagent/agent_id': '44472e00',
          'subagent/profile_name': 'Explore',
          'subagent/model': 'Subagent Default',
          'subagent/chain_node_id': 176,
        },
      ),
      ...syntheticForegroundPair(sessionId, 178, '44472e00'),
    ].join('\n');

    const parsed = parseDevinBundle(bundle(transcript));
    const records = buildDevinSubagentEvidence(sessionId, parsed.detachedMessages, 'artifact-1');

    expect(records).toHaveLength(2);
    const [promptRecord, resultRecord] = records;
    expect(promptRecord.recordType).toBe('normalized_event');
    const promptPayload = promptRecord.payload as Record<string, unknown>;
    expect(promptPayload).toMatchObject({
      category: 'subagent_turn',
      kind: 'prompt',
      agentId: '44472e00',
      content: 'Explore the auth module',
      rawInputProfile: 'subagent_explore',
    });

    const resultPayload = resultRecord.payload as Record<string, unknown>;
    expect(resultPayload).toMatchObject({
      category: 'subagent_turn',
      kind: 'result',
      agentId: '44472e00',
      profileName: 'Explore',
      model: 'Subagent Default',
      chainNodeId: 176,
      content: 'full foreground report',
      isBackground: false,
      sourceNodeId: 178,
    });

    // missing-is-never-zero: no token/cache/cost fields anywhere in the payload.
    for (const payload of [promptPayload, resultPayload]) {
      expect(payload).not.toHaveProperty('tokens');
      expect(payload).not.toHaveProperty('cost');
      expect(payload).not.toHaveProperty('cachedTokens');
      expect(payload).not.toHaveProperty('promptTokens');
      expect(payload).not.toHaveProperty('completionTokens');
    }
  });

  it('never upgrades subagent/model from its raw coarse label to a fabricated resolved model id', () => {
    const sessionId = 's1';
    const transcript = [
      sessionLine(sessionId),
      messageLine(sessionId, 178, null, 'tool', 'Subagent agent_id=x completed successfully: r', {
        'subagent/agent_id': 'x',
        'subagent/model': 'Subagent Default',
      }),
      ...syntheticForegroundPair(sessionId, 178, 'x'),
    ].join('\n');
    const parsed = parseDevinBundle(bundle(transcript));
    const records = buildDevinSubagentEvidence(sessionId, parsed.detachedMessages, 'artifact-1');
    const resultPayload = records.find((r) => (r.payload as { kind?: string }).kind === 'result')
      ?.payload as Record<string, unknown>;
    expect(resultPayload.model).toBe('Subagent Default');
  });

  it('emits a generic detached_conversation record for a genuine unattributed orphan tree, without claiming a subagent correlation', () => {
    const sessionId = 's1';
    const transcript = [
      sessionLine(sessionId),
      messageLine(sessionId, 1, null, 'user', 'main'),
      messageLine(sessionId, 317, null, 'system', 'orphan persona'),
      messageLine(sessionId, 318, 317, 'user', 'orphan turn'),
    ].join('\n');
    const parsed = parseDevinBundle(bundle(transcript));
    const records = buildDevinSubagentEvidence(sessionId, parsed.detachedMessages, 'artifact-1');

    expect(records).toHaveLength(1);
    const payload = records[0].payload as Record<string, unknown>;
    expect(payload.category).toBe('detached_conversation');
    expect(payload.rootNodeId).toBe(317);
    expect(payload.nodeCount).toBe(2);
    expect(payload).not.toHaveProperty('agentId');
  });

  it('returns no records for a session with nothing detached', () => {
    expect(buildDevinSubagentEvidence('s1', [], 'artifact-1')).toEqual([]);
  });
});
