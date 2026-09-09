import { describe, expect, it } from 'vitest';
import { buildSubagentSyntheticNodes } from '../../src/extractor/subagent-lines.js';
import type { DevinMessageNodeRow, DevinToolCallStateRow } from '../../src/extractor/types.js';

function node(
  nodeId: number,
  parentNodeId: number | null,
  chatMessage: Record<string, unknown> | null,
): DevinMessageNodeRow {
  return {
    row_id: nodeId,
    session_id: 'shadow-collar',
    node_id: nodeId,
    parent_node_id: parentNodeId,
    chat_message: chatMessage ? JSON.stringify(chatMessage) : null,
    created_at: 1_700_000_000,
    metadata: null,
  };
}

function runSubagentCall(toolCallId: string, task: string, profile: string): DevinToolCallStateRow {
  return {
    row_id: 1,
    session_id: 'shadow-collar',
    tool_call_id: toolCallId,
    tool_call_json: JSON.stringify({
      toolCallId,
      kind: 'execute',
      title: `Ran ${profile} subagent`,
      rawInput: { profile, task, title: 'Explore the repo' },
      _meta: { 'cognition.ai/inferenceToolName': 'run_subagent' },
    }),
    tool_call_update_json: null,
  };
}

describe('buildSubagentSyntheticNodes — foreground/background asymmetry (DS-B28/#294 finding #3)', () => {
  it('foreground: sources the result from the tagged node itself', () => {
    // Reproduces shadow-collar nodes 177 (run_subagent call site) / 178
    // (foreground result, tagged with subagent/agent_id).
    const callSite = node(177, 90, {
      message_id: 'msg-177',
      role: 'assistant',
      content: 'calling run_subagent',
      tool_calls: [{ toolCallId: 'functions.run_subagent:1' }],
    });
    const taggedResult = node(178, 177, {
      message_id: 'msg-178',
      role: 'tool',
      content: 'Subagent agent_id=44472e00 completed successfully:\n\nfull foreground report',
      tool_call_id: 'functions.run_subagent:1',
      metadata: {
        extensions: {
          'subagent/profile_name': 'Explore',
          'subagent/agent_id': '44472e00',
          'subagent/model': 'Subagent Default',
          'subagent/chain_node_id': 176,
        },
      },
    });
    const nodes = [callSite, taggedResult];
    const toolCalls = [
      runSubagentCall('functions.run_subagent:1', 'Explore the auth module', 'subagent_explore'),
    ];

    const synthetic = buildSubagentSyntheticNodes(nodes, toolCalls);
    expect(synthetic).toHaveLength(2);

    const [promptRow, resultRow] = synthetic;
    const prompt = JSON.parse(promptRow.chat_message as string);
    expect(prompt).toMatchObject({ role: 'user', content: 'Explore the auth module' });
    // Real subagent/* keys live in chat_message.metadata.extensions.
    const promptSubagentExt = prompt.metadata.extensions;
    expect(promptSubagentExt).toEqual({ 'subagent/agent_id': '44472e00' });
    // Our own bookkeeping (never real Devin data) lives in the row-level
    // metadata column instead -- a different namespace, never conflated.
    const promptBookkeeping = JSON.parse(promptRow.metadata as string);
    expect(promptBookkeeping['sal/synthetic_subagent_kind']).toBe('prompt');
    expect(promptBookkeeping['sal/synthetic_subagent_rawinput_profile']).toBe('subagent_explore');

    const result = JSON.parse(resultRow.chat_message as string);
    // Verbatim tagged-node content, never stripped/reworded (real data only).
    expect(result).toMatchObject({
      role: 'assistant',
      content: 'Subagent agent_id=44472e00 completed successfully:\n\nfull foreground report',
    });
    const resultSubagentExt = result.metadata.extensions;
    expect(resultSubagentExt['subagent/agent_id']).toBe('44472e00');
    expect(resultSubagentExt['subagent/profile_name']).toBe('Explore');
    expect(resultSubagentExt['subagent/model']).toBe('Subagent Default');
    expect(resultSubagentExt['subagent/chain_node_id']).toBe(176);
    const resultBookkeeping = JSON.parse(resultRow.metadata as string);
    expect(resultBookkeeping['sal/synthetic_subagent_kind']).toBe('result');
    expect(resultBookkeeping['sal/synthetic_subagent_is_background']).toBe(false);
    expect(resultBookkeeping['sal/synthetic_subagent_source_node_id']).toBe(178);

    // node ids: far above any real node id, unique, deterministic,
    // parent-linked prompt->result (never negative -- see the "Deliberately
    // NOT negative" doc comment on buildSubagentSyntheticNodes).
    expect(promptRow.node_id).toBeGreaterThan(1_000_000);
    expect(resultRow.node_id).toBeGreaterThan(1_000_000);
    expect(resultRow.parent_node_id).toBe(promptRow.node_id);
  });

  it('background: a naive "read the tagged node" strategy would silently produce an empty report -- must source from the untagged notification node instead', () => {
    // Reproduces shadow-collar's background chain: 226 (call site) -> 227
    // (run_subagent result, TAGGED but only a "started" pointer) -> 228 ->
    // 246 -> 247 (read_subagent result, UNTAGGED, also no report) -> 248
    // (system role, UNTAGGED, the real <subagent_completion_notification>).
    const callSite = node(226, 90, {
      message_id: 'msg-226',
      role: 'assistant',
      content: 'run it bg',
    });
    const startedPointer = node(227, 226, {
      message_id: 'msg-227',
      role: 'tool',
      content: 'Background subagent started with agent_id=55c47591 running in the background.',
      tool_call_id: 'functions.run_subagent:4',
      metadata: {
        extensions: {
          'subagent/agent_id': '55c47591',
          'subagent/profile_name': 'Explore',
          'subagent/model': 'Subagent Default',
        },
      },
    });
    const intermediate = node(228, 227, {
      message_id: 'msg-228',
      role: 'assistant',
      content: 'ok, later',
    });
    const readSubagentCallSite = node(246, 228, {
      message_id: 'msg-246',
      role: 'assistant',
      content: 'checking on it',
    });
    const readSubagentResult = node(247, 246, {
      message_id: 'msg-247',
      role: 'tool',
      content:
        'Subagent 55c47591 completed. Its full report is delivered in the ' +
        '<subagent_completion_notification> message; you do not need to read it again.',
      // Deliberately untagged -- finding #3.
    });
    const notification = node(248, 247, {
      message_id: 'msg-248',
      role: 'system',
      content:
        '<subagent_completion_notification>\n[Background subagent with agent_id=55c47591 completed]\n\n' +
        'full background report',
      // Deliberately untagged -- finding #3.
    });
    const nodes = [
      callSite,
      startedPointer,
      intermediate,
      readSubagentCallSite,
      readSubagentResult,
      notification,
    ];
    const toolCalls = [
      runSubagentCall('functions.run_subagent:4', 'Explore the billing module', 'subagent_explore'),
    ];

    const synthetic = buildSubagentSyntheticNodes(nodes, toolCalls);
    expect(synthetic).toHaveLength(2);
    const [promptRow, resultRow] = synthetic;

    const prompt = JSON.parse(promptRow.chat_message as string);
    expect(prompt.content).toBe('Explore the billing module');

    const result = JSON.parse(resultRow.chat_message as string);
    // The real report, sourced from node 248 -- NOT the tagged node's
    // "started" text, and NOT the read_subagent result's pointer text.
    expect(result.content).toBe(
      '<subagent_completion_notification>\n[Background subagent with agent_id=55c47591 completed]\n\n' +
        'full background report',
    );
    expect(result.content).not.toContain('Background subagent started');
    expect(result.content).not.toContain('do not need to read it again');

    const resultBookkeeping = JSON.parse(resultRow.metadata as string);
    expect(resultBookkeeping['sal/synthetic_subagent_is_background']).toBe(true);
    expect(resultBookkeeping['sal/synthetic_subagent_source_node_id']).toBe(248);
  });

  it('emits only the prompt line when no report is recoverable at all (read_subagent timeout)', () => {
    const callSite = node(90, null, { message_id: 'msg-90', role: 'assistant', content: 'start' });
    const startedPointer = node(316, 90, {
      message_id: 'msg-316',
      role: 'tool',
      content: 'Background subagent started with agent_id=8d591a24 running in the background.',
      tool_call_id: 'functions.run_subagent:9',
      metadata: { extensions: { 'subagent/agent_id': '8d591a24' } },
    });
    const nodes = [callSite, startedPointer];
    const toolCalls = [runSubagentCall('functions.run_subagent:9', 'Review the PR', 'pr-review')];

    const synthetic = buildSubagentSyntheticNodes(nodes, toolCalls);
    expect(synthetic).toHaveLength(1);
    const prompt = JSON.parse(synthetic[0].chat_message as string);
    expect(prompt.content).toBe('Review the PR');
    const bookkeeping = JSON.parse(synthetic[0].metadata as string);
    expect(bookkeeping['sal/synthetic_subagent_kind']).toBe('prompt');
  });

  it('emits nothing for a run_subagent call with no correlated tagged node yet (still running)', () => {
    const callSite = node(1, null, { message_id: 'msg-1', role: 'assistant', content: 'start' });
    const toolCalls = [runSubagentCall('functions.run_subagent:1', 'do work', 'pr-review')];
    expect(buildSubagentSyntheticNodes([callSite], toolCalls)).toHaveLength(0);
  });

  it('emits nothing when the tool call has no real task text (never fabricates a prompt)', () => {
    const tagged = node(2, 1, {
      message_id: 'msg-2',
      role: 'tool',
      content: 'Subagent agent_id=abc completed successfully: report',
      tool_call_id: 'functions.run_subagent:1',
      metadata: { extensions: { 'subagent/agent_id': 'abc' } },
    });
    const toolCall: DevinToolCallStateRow = {
      row_id: 1,
      session_id: 'shadow-collar',
      tool_call_id: 'functions.run_subagent:1',
      tool_call_json: JSON.stringify({
        toolCallId: 'functions.run_subagent:1',
        rawInput: { profile: 'pr-review' },
        _meta: { 'cognition.ai/inferenceToolName': 'run_subagent' },
      }),
      tool_call_update_json: null,
    };
    expect(buildSubagentSyntheticNodes([tagged], [toolCall])).toHaveLength(0);
  });

  it('captures a real subagent/* extension key not yet known to this module (#298 widening)', () => {
    // Previously realSubagentTagExtensions filtered to a 4-key whitelist
    // (subagent/agent_id, subagent/profile_name, subagent/model,
    // subagent/chain_node_id); a 5th real key would have been silently
    // dropped. #298 widens this to pass through everything present.
    const callSite = node(177, 90, {
      message_id: 'msg-177',
      role: 'assistant',
      content: 'calling run_subagent',
    });
    const taggedResult = node(178, 177, {
      message_id: 'msg-178',
      role: 'tool',
      content: 'Subagent agent_id=44472e00 completed successfully:\n\nreport',
      tool_call_id: 'functions.run_subagent:1',
      metadata: {
        extensions: {
          'subagent/agent_id': '44472e00',
          'subagent/profile_name': 'Explore',
          'subagent/future_field_not_yet_modeled': 'some-future-value',
        },
      },
    });
    const toolCalls = [
      runSubagentCall('functions.run_subagent:1', 'Explore the auth module', 'subagent_explore'),
    ];

    const synthetic = buildSubagentSyntheticNodes([callSite, taggedResult], toolCalls);
    const resultRow = synthetic[1];
    const result = JSON.parse(resultRow.chat_message as string);
    expect(result.metadata.extensions['subagent/future_field_not_yet_modeled']).toBe(
      'some-future-value',
    );
  });

  it('ignores non-run_subagent tool calls entirely', () => {
    const toolCall: DevinToolCallStateRow = {
      row_id: 1,
      session_id: 's1',
      tool_call_id: 'functions.exec:1',
      tool_call_json: JSON.stringify({
        toolCallId: 'functions.exec:1',
        rawInput: { command: 'ls' },
        _meta: { 'cognition.ai/inferenceToolName': 'exec' },
      }),
      tool_call_update_json: null,
    };
    expect(buildSubagentSyntheticNodes([], [toolCall])).toHaveLength(0);
  });
});
