import type { DevinMessageLine, DevinToolCallLine } from '@lucasschirm/sal-devin-session-parser';
import { describe, expect, it } from 'vitest';
import {
  buildSubagentChildSessions,
  deriveChildSessionId,
  identifySubagents,
} from '../../src/subagent-spine.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMessage(
  nodeId: number,
  parentNodeId: number | null,
  role: string,
  content: string,
  overrides?: Partial<DevinMessageLine>,
): DevinMessageLine {
  return {
    type: 'message',
    ts: null,
    order: nodeId + 1,
    rowId: nodeId,
    sessionId: 'test-session',
    nodeId,
    parentNodeId,
    role: role as DevinMessageLine['role'],
    rawRole: null,
    chatMessage: { role, content },
    createdAt: null,
    metadata: null,
    parsedMetadata: null,
    subagent: null,
    chatUsage: null,
    toolCalls: null,
    toolCallId: null,
    ...overrides,
  };
}

function makeSubagentResultMessage(
  nodeId: number,
  parentNodeId: number | null,
  agentId: string,
  chainNodeId: number | null,
  toolCallId: string,
): DevinMessageLine {
  return makeMessage(nodeId, parentNodeId, 'tool', 'Subagent result', {
    subagent: {
      agentId,
      profileName: 'Explore',
      model: 'Subagent Default',
      chainNodeId,
    },
    toolCallId,
  });
}

function makeToolCallLine(
  toolCallId: string,
  inferenceToolName: string,
  rawInput?: Record<string, unknown>,
): DevinToolCallLine {
  return {
    type: 'tool_call',
    ts: null,
    order: 0,
    rowId: 0,
    sessionId: 'test-session',
    toolCallId,
    call: {
      toolCallId,
      title: `tool call ${toolCallId}`,
      kind: 'execute',
      rawKind: null,
      content: null,
      rawInput: rawInput ?? null,
      inferenceToolName,
    },
    update: null,
  };
}

function makeAssistantWithToolCalls(
  nodeId: number,
  parentNodeId: number | null,
  toolCalls: { id: string; name: string; arguments: Record<string, unknown> }[],
): DevinMessageLine {
  return makeMessage(nodeId, parentNodeId, 'assistant', 'Using tools', {
    toolCalls: toolCalls.map((tc, i) => ({
      id: tc.id,
      name: tc.name,
      arguments: tc.arguments,
      index: i,
      kind: 'function',
    })),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('deriveChildSessionId', () => {
  it('produces a deterministic stable id', () => {
    const id1 = deriveChildSessionId('root-1', 'src', 'env', 'proj', 'agent-01');
    const id2 = deriveChildSessionId('root-1', 'src', 'env', 'proj', 'agent-01');
    expect(id1).toBe(id2);
    expect(id1).toContain('subagent:');
    expect(id1.length).toBeGreaterThan(10);
  });

  it('varies with different agent ids', () => {
    const id1 = deriveChildSessionId('root-1', 'src', 'env', 'proj', 'agent-01');
    const id2 = deriveChildSessionId('root-1', 'src', 'env', 'proj', 'agent-02');
    expect(id1).not.toBe(id2);
  });
});

describe('identifySubagents', () => {
  it('finds subagents from main-chain tool results', () => {
    const orderedMessages = [
      makeMessage(1, null, 'user', 'Hello'),
      makeMessage(2, 1, 'assistant', 'On it'),
      makeSubagentResultMessage(3, 2, 'agent-01', 41, 'tc-agent-1'),
    ];
    const toolCalls = [
      makeToolCallLine('tc-agent-1', 'run_subagent', {
        profile: 'subagent_explore',
        task: 'Find files',
      }),
    ];

    const result = identifySubagents(orderedMessages, toolCalls);

    expect(result).toHaveLength(1);
    expect(result[0].agentId).toBe('agent-01');
    expect(result[0].profileName).toBe('Explore');
    expect(result[0].model).toBe('Subagent Default');
    expect(result[0].chainNodeId).toBe(41);
    expect(result[0].toolCallId).toBe('tc-agent-1');
    expect(result[0].rawInputProfile).toBe('subagent_explore');
    expect(result[0].taskDescription).toBe('Find files');
  });

  it('returns empty array when no subagent results exist', () => {
    const orderedMessages = [
      makeMessage(1, null, 'user', 'Hello'),
      makeMessage(2, 1, 'assistant', 'Hi'),
    ];
    const result = identifySubagents(orderedMessages, []);
    expect(result).toEqual([]);
  });

  it('deduplicates subagents by agentId preferring entry with non-null chainNodeId', () => {
    const orderedMessages = [
      makeMessage(1, null, 'user', 'Hello'),
      makeSubagentResultMessage(2, 1, 'agent-01', null, 'tc-agent-1'), // chainNodeId: null
      makeMessage(3, 2, 'tool', 'Subagent result 2', {
        subagent: {
          agentId: 'agent-01',
          profileName: 'Explore',
          model: 'Subagent Default',
          chainNodeId: 43,
        },
        toolCallId: 'tc-agent-1',
      }),
    ];
    const toolCalls = [
      makeToolCallLine('tc-agent-1', 'run_subagent', {
        profile: 'subagent_explore',
        task: 'Find files',
      }),
    ];

    const result = identifySubagents(orderedMessages, toolCalls);
    expect(result).toHaveLength(1);
    expect(result[0].agentId).toBe('agent-01');
    expect(result[0].chainNodeId).toBe(43);
  });
});

describe('buildSubagentChildSessions', () => {
  const rootSessionId = 'root-session-id';
  const sourceId = 'src';
  const envId = 'env';
  const projectId = 'proj';
  const rootArtifactId = 'transcript.jsonl';

  it('produces a child session with session, session_relation, turns, messages, and invocations', () => {
    const subagents = [
      {
        agentId: 'agent-01',
        profileName: 'Explore',
        model: 'Subagent Default',
        chainNodeId: 43,
        toolCallId: 'tc-agent-1',
        rawInputProfile: 'subagent_explore',
        taskDescription: 'Search for files',
      },
    ];

    const detachedMessages = [
      makeMessage(40, null, 'system', 'You are an explore subagent'),
      makeAssistantWithToolCalls(41, 40, [
        { id: 'func.find:0', name: 'find_file_by_name', arguments: { pattern: 'test' } },
      ]),
      makeMessage(42, 41, 'tool', 'Found: test.ts', { toolCallId: 'func.find:0' }),
      makeMessage(43, 42, 'assistant', 'I found the file'),
    ];

    const result = buildSubagentChildSessions(
      rootSessionId,
      sourceId,
      envId,
      projectId,
      subagents,
      detachedMessages,
      rootArtifactId,
    );

    // Should produce one child summary
    expect(result.summaries).toHaveLength(1);
    const summary = result.summaries[0];
    expect(summary.rootSessionId).toBe(rootSessionId);
    expect(summary.parentSessionId).toBe(rootSessionId);
    expect(summary.harness).toBe('devin');
    expect(summary.finality).toBe('partial');
    expect(summary.sessionId).toBe(
      deriveChildSessionId(rootSessionId, sourceId, envId, projectId, 'agent-01'),
    );

    // Should consume all detached nodes
    expect(result.consumedNodeIds.size).toBe(4);
    expect(result.consumedNodeIds.has(40)).toBe(true);
    expect(result.consumedNodeIds.has(43)).toBe(true);

    // Check record types
    const recordTypes = result.records.map((r) => r.recordType);
    expect(recordTypes).toContain('session');
    expect(recordTypes).toContain('session_relation');
    expect(recordTypes).toContain('turn');
    expect(recordTypes).toContain('message');
    expect(recordTypes).toContain('invocation');
    expect(recordTypes).toContain('payload');

    // All records should be scoped to the child session id
    const childId = summary.sessionId;
    for (const record of result.records) {
      expect(record.sessionId).toBe(childId);
    }

    // session_relation should link to root
    const relation = result.records.find((r) => r.recordType === 'session_relation');
    expect(relation).toBeDefined();
    expect((relation?.payload as Record<string, unknown> | undefined)?.rootSessionId).toBe(
      rootSessionId,
    );
    expect((relation?.payload as Record<string, unknown> | undefined)?.parentSessionId).toBe(
      rootSessionId,
    );
    expect(
      (relation?.payload as Record<string, unknown> | undefined)?.nativeInclusionSemantics,
    ).toBe('subagent');
    expect((relation?.payload as Record<string, unknown> | undefined)?.depth).toBe(1);

    // Should have 4 turns (one per message in the subtree)
    const turns = result.records.filter((r) => r.recordType === 'turn');
    expect(turns).toHaveLength(4);

    // Should have 4 messages
    const messages = result.records.filter((r) => r.recordType === 'message');
    expect(messages).toHaveLength(4);

    // Should have 1 invocation (the embedded tool call)
    const invocations = result.records.filter((r) => r.recordType === 'invocation');
    expect(invocations).toHaveLength(1);
    expect((invocations[0].payload as Record<string, unknown>).name).toBe('find_file_by_name');
    expect((invocations[0].payload as Record<string, unknown>).kind).toBe('tool');
    expect((invocations[0].payload as Record<string, unknown>).origin).toBe('subagent');
    expect((invocations[0].payload as Record<string, unknown>).resultId).toBe('func.find:0');
    expect((invocations[0].payload as Record<string, unknown>).status).toBe('success');

    // Should have both input and result payloads for correlated tool call
    const payloads = result.records.filter((r) => r.recordType === 'payload');
    expect(payloads).toHaveLength(2);
    const inputPayload = payloads.find(
      (p) => (p.payload as Record<string, unknown>).payloadType === 'input',
    );
    const resultPayload = payloads.find(
      (p) => (p.payload as Record<string, unknown>).payloadType === 'result',
    );
    expect(inputPayload).toBeDefined();
    expect(resultPayload).toBeDefined();
    expect((inputPayload?.payload as Record<string, unknown> | undefined)?.toolUseId).toBe(
      'func.find:0',
    );
    expect((resultPayload?.payload as Record<string, unknown> | undefined)?.toolUseId).toBe(
      'func.find:0',
    );
  });

  it('returns empty result when no subagents are identified', () => {
    const result = buildSubagentChildSessions(
      rootSessionId,
      sourceId,
      envId,
      projectId,
      [],
      [],
      rootArtifactId,
    );
    expect(result.summaries).toEqual([]);
    expect(result.records).toEqual([]);
    expect(result.consumedNodeIds.size).toBe(0);
  });

  it('returns empty child messages when chainNodeId is not in detached tree', () => {
    const subagents = [
      {
        agentId: 'agent-01',
        profileName: 'Explore',
        model: null,
        chainNodeId: 999, // Not in the detached messages
        toolCallId: 'tc-1',
        rawInputProfile: null,
        taskDescription: null,
      },
    ];

    const result = buildSubagentChildSessions(
      rootSessionId,
      sourceId,
      envId,
      projectId,
      subagents,
      [makeMessage(40, null, 'user', 'Unrelated detached')],
      rootArtifactId,
    );

    // Still produces a summary but with no messages
    expect(result.summaries).toHaveLength(1);
    // No nodes consumed since chainNodeId 999 doesn't match
    expect(result.consumedNodeIds.size).toBe(0);
  });

  it('deduplicates embedded tool calls with the same id', () => {
    const subagents = [
      {
        agentId: 'agent-01',
        profileName: null,
        model: null,
        chainNodeId: 42,
        toolCallId: 'tc-1',
        rawInputProfile: null,
        taskDescription: null,
      },
    ];

    // Two assistant messages with the same tool call id (branching scenario)
    const detachedMessages = [
      makeAssistantWithToolCalls(40, null, [
        { id: 'func.read:0', name: 'read', arguments: { file: 'a.ts' } },
      ]),
      makeAssistantWithToolCalls(41, 40, [
        { id: 'func.read:0', name: 'read', arguments: { file: 'a.ts' } }, // duplicate
      ]),
      makeMessage(42, 41, 'assistant', 'Done'),
    ];

    const result = buildSubagentChildSessions(
      rootSessionId,
      sourceId,
      envId,
      projectId,
      subagents,
      detachedMessages,
      rootArtifactId,
    );

    // Should deduplicate: only 1 invocation
    const invocations = result.records.filter((r) => r.recordType === 'invocation');
    expect(invocations).toHaveLength(1);
  });

  it('handles multiple subagents in the same session', () => {
    const subagents = [
      {
        agentId: 'agent-01',
        profileName: 'Explore',
        model: null,
        chainNodeId: 42,
        toolCallId: 'tc-1',
        rawInputProfile: null,
        taskDescription: 'Task 1',
      },
      {
        agentId: 'agent-02',
        profileName: 'Code',
        model: null,
        chainNodeId: 52,
        toolCallId: 'tc-2',
        rawInputProfile: null,
        taskDescription: 'Task 2',
      },
    ];

    const detachedMessages = [
      // Subtree 1: nodes 40-42
      makeMessage(40, null, 'user', 'Task 1 prompt'),
      makeMessage(41, 40, 'assistant', 'Working'),
      makeMessage(42, 41, 'assistant', 'Done'),
      // Subtree 2: nodes 50-52
      makeMessage(50, null, 'user', 'Task 2 prompt'),
      makeMessage(51, 50, 'assistant', 'Working'),
      makeMessage(52, 51, 'assistant', 'Done'),
    ];

    const result = buildSubagentChildSessions(
      rootSessionId,
      sourceId,
      envId,
      projectId,
      subagents,
      detachedMessages,
      rootArtifactId,
    );

    expect(result.summaries).toHaveLength(2);
    expect(result.consumedNodeIds.size).toBe(6);
    expect(result.summaries[0].sessionId).not.toBe(result.summaries[1].sessionId);
  });

  it('handles tool calls without matching tool results with status unknown and no result payload', () => {
    const subagents = [
      {
        agentId: 'agent-01',
        profileName: 'Explore',
        model: null,
        chainNodeId: 41,
        toolCallId: 'tc-1',
        rawInputProfile: null,
        taskDescription: 'Task',
      },
    ];

    const detachedMessages = [
      makeMessage(40, null, 'user', 'Task prompt'),
      // Assistant calls tool, but no tool result message follows
      makeAssistantWithToolCalls(41, 40, [
        { id: 'func.pending:0', name: 'pending_tool', arguments: {} },
      ]),
    ];

    const result = buildSubagentChildSessions(
      rootSessionId,
      sourceId,
      envId,
      projectId,
      subagents,
      detachedMessages,
      rootArtifactId,
    );

    const invocations = result.records.filter((r) => r.recordType === 'invocation');
    expect(invocations).toHaveLength(1);
    expect((invocations[0].payload as Record<string, unknown>).resultId).toBeUndefined();
    expect((invocations[0].payload as Record<string, unknown>).status).toBe('unknown');

    const payloads = result.records.filter((r) => r.recordType === 'payload');
    expect(payloads).toHaveLength(1);
    expect((payloads[0].payload as Record<string, unknown>).payloadType).toBe('input');
  });

  it('carries timestamp in message payload when createdAt is present', () => {
    const subagents = [
      {
        agentId: 'agent-01',
        profileName: 'Explore',
        model: null,
        chainNodeId: 40,
        toolCallId: 'tc-1',
        rawInputProfile: null,
        taskDescription: 'Task',
      },
    ];

    const detachedMessages = [makeMessage(40, null, 'user', 'Prompt', { createdAt: 1722520800 })];

    const result = buildSubagentChildSessions(
      rootSessionId,
      sourceId,
      envId,
      projectId,
      subagents,
      detachedMessages,
      rootArtifactId,
    );

    const messageRecord = result.records.find((r) => r.recordType === 'message');
    expect(messageRecord).toBeDefined();
    expect((messageRecord?.payload as Record<string, unknown> | undefined)?.timestamp).toBe(
      new Date(1722520800 * 1000).toISOString(),
    );
  });

  it('terminates gracefully when detached message tree contains a cycle', () => {
    const subagents = [
      {
        agentId: 'agent-01',
        profileName: 'Explore',
        model: null,
        chainNodeId: 41,
        toolCallId: 'tc-1',
        rawInputProfile: null,
        taskDescription: 'Task',
      },
    ];

    // Cycle: 40 -> 41 -> 40
    const detachedMessages = [
      makeMessage(40, 41, 'user', 'Prompt 40'),
      makeMessage(41, 40, 'assistant', 'Response 41'),
    ];

    const result = buildSubagentChildSessions(
      rootSessionId,
      sourceId,
      envId,
      projectId,
      subagents,
      detachedMessages,
      rootArtifactId,
    );

    expect(result.summaries).toHaveLength(1);
    expect(result.consumedNodeIds.size).toBe(2);
  });

  it('populates startTime, endTime, aiTitle, and fallbackTitle on child session', () => {
    const subagents = [
      {
        agentId: 'agent-timing-12345678',
        profileName: 'Explore',
        model: null,
        chainNodeId: 10,
        toolCallId: 'tc-timing',
        rawInputProfile: null,
        taskDescription: null,
      },
    ];

    const detachedMessages = [
      makeMessage(10, null, 'user', 'Prompt 10', { createdAt: 1722520800 }),
      makeMessage(11, 10, 'assistant', 'Response 11', { createdAt: 1722520860 }),
    ];

    const result = buildSubagentChildSessions(
      rootSessionId,
      sourceId,
      envId,
      projectId,
      subagents,
      detachedMessages,
      rootArtifactId,
    );

    const startIso = new Date(1722520800 * 1000).toISOString();
    const endIso = new Date(1722520860 * 1000).toISOString();

    expect(result.summaries[0]?.startTime).toBe(startIso);
    expect(result.summaries[0]?.endTime).toBe(endIso);

    const sessionRec = result.records.find((r) => r.recordType === 'session');
    expect(sessionRec).toBeDefined();
    const payload = sessionRec?.payload as Record<string, unknown>;
    expect(payload.startTime).toBe(startIso);
    expect(payload.endTime).toBe(endIso);
    expect(payload.aiTitle).toBeUndefined();
    expect(payload.fallbackTitle).toBe('Subagent Explore');
  });

  it('classifies embedded tool calls into skill, agent, and tool kinds', () => {
    const subagents = [
      {
        agentId: 'agent-kinds',
        profileName: 'Generalist',
        model: null,
        chainNodeId: 20,
        toolCallId: 'tc-kinds',
        rawInputProfile: null,
        taskDescription: 'Testing tool classification',
      },
    ];

    const detachedMessages = [
      makeMessage(20, null, 'assistant', 'Invoking tools', {
        toolCalls: [
          {
            id: 'tc-embed-1',
            name: 'read_file',
            arguments: { file_path: 'src/main.ts' },
            index: 0,
            kind: 'function',
          },
          {
            id: 'tc-embed-2',
            name: 'Skill',
            arguments: { skill: 'lint-check' },
            index: 1,
            kind: 'skill',
          },
          {
            id: 'tc-embed-3',
            name: 'run_subagent',
            arguments: { profile: 'deep-search', task: 'find error' },
            index: 2,
            kind: 'agent',
          },
        ],
      }),
      makeMessage(21, 20, 'tool', 'file content', { toolCallId: 'tc-embed-1' }),
    ];

    const result = buildSubagentChildSessions(
      rootSessionId,
      sourceId,
      envId,
      projectId,
      subagents,
      detachedMessages,
      rootArtifactId,
    );

    const invocations = result.records.filter((r) => r.recordType === 'invocation');
    expect(invocations).toHaveLength(3);

    const toolInv = invocations.find((i) => i.sourceEventId === 'tc-embed-1');
    expect(toolInv?.payload).toMatchObject({
      kind: 'tool',
      name: 'read_file',
      target: 'src/main.ts',
      status: 'success',
    });

    const skillInv = invocations.find((i) => i.sourceEventId === 'tc-embed-2');
    expect(skillInv?.payload).toMatchObject({
      kind: 'skill',
      name: 'lint-check',
      status: 'unknown',
    });

    const agentInv = invocations.find((i) => i.sourceEventId === 'tc-embed-3');
    expect(agentInv?.payload).toMatchObject({
      kind: 'agent',
      name: 'deep-search',
      target: 'find error',
      status: 'unknown',
    });
  });
});
