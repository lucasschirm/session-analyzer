import type { DevinMessageLine } from '@lucasschirm/sal-devin-session-parser';
import { describe, expect, it } from 'vitest';
import { DevinTransformer } from '../../src/index.js';
import { classifyDevinMessageKinds } from '../../src/message-classification.js';
import { defaultContext, usageAttributionBundle } from '../conformance/fixtures/index.js';

function messageNode(
  nodeId: number,
  role: string,
  fields: Partial<Pick<DevinMessageLine, 'toolCalls' | 'toolCallId'>>,
): DevinMessageLine {
  return { nodeId, role, ...fields } as unknown as DevinMessageLine;
}

function messagePayloads(result: ReturnType<typeof DevinTransformer.transform>) {
  return result.evidence
    .filter((r) => r.recordType === 'message')
    .map((r) => r.payload as { nodeId?: number; invocationKind?: string; role?: string });
}

describe('Devin message Tool/Skill/Agent classification', () => {
  it('maps an embedded native tool name to its canonical domain', () => {
    const kinds = classifyDevinMessageKinds([
      messageNode(1, 'assistant', {
        toolCalls: [
          { id: 'skill:0#a', name: 'skill', arguments: null, index: 0, kind: 'function' },
        ],
      }),
      messageNode(2, 'assistant', {
        toolCalls: [
          {
            id: 'run_subagent:0#b',
            name: 'run_subagent',
            arguments: null,
            index: 0,
            kind: 'function',
          },
        ],
      }),
      messageNode(3, 'assistant', {
        toolCalls: [{ id: 'exec:0#c', name: 'exec', arguments: null, index: 0, kind: 'function' }],
      }),
    ]);
    // `skill` and `run_subagent` are their own domains and never generic
    // tools (.agents/rules/analytics-domain-distinctions.md).
    expect(kinds.get(1)).toBe('skill');
    expect(kinds.get(2)).toBe('agent');
    expect(kinds.get(3)).toBe('tool');
  });

  it('reports the most specific domain when one node dispatches several kinds', () => {
    const kinds = classifyDevinMessageKinds([
      messageNode(1, 'assistant', {
        toolCalls: [
          { id: 'exec:0#a', name: 'exec', arguments: null, index: 0, kind: 'function' },
          {
            id: 'run_subagent:0#b',
            name: 'run_subagent',
            arguments: null,
            index: 1,
            kind: 'function',
          },
          { id: 'skill:0#c', name: 'skill', arguments: null, index: 2, kind: 'function' },
        ],
      }),
    ]);
    expect(kinds.get(1)).toBe('skill');
  });

  it('inherits the domain of the call a tool-result node answers', () => {
    const kinds = classifyDevinMessageKinds([
      messageNode(2, 'assistant', {
        toolCalls: [
          { id: 'skill:0#a', name: 'skill', arguments: null, index: 0, kind: 'function' },
        ],
      }),
      messageNode(3, 'tool', { toolCallId: 'skill:0#a' }),
      messageNode(4, 'tool', { toolCallId: 'unknown:0#zz' }),
    ]);
    expect(kinds.get(3)).toBe('skill');
    // An unanswerable id stays unclassified rather than defaulting to 'tool'.
    expect(kinds.has(4)).toBe(false);
  });

  it('leaves messages with no tool relationship absent from the map entirely', () => {
    const kinds = classifyDevinMessageKinds([
      messageNode(1, 'user', { toolCalls: null, toolCallId: null }),
      messageNode(2, 'assistant', { toolCalls: [], toolCallId: null }),
    ]);
    expect(kinds.size).toBe(0);
  });

  it('surfaces invocationKind on the message evidence records the read path consumes', () => {
    const result = DevinTransformer.transform(usageAttributionBundle, defaultContext);
    const byNode = new Map(messagePayloads(result).map((p) => [p.nodeId, p.invocationKind]));
    // node 1 is the user prompt, node 2 dispatches `exec`, node 3 answers it,
    // node 4 dispatches the skill.
    expect(byNode.get(1)).toBeUndefined();
    expect(byNode.get(2)).toBe('tool');
    expect(byNode.get(3)).toBe('tool');
    expect(byNode.get(4)).toBe('skill');
    // Absent means "plain message": the key is not emitted at all, so the
    // payload shape of ordinary nodes is unchanged (missing-is-never-zero).
    const plain = result.evidence.find(
      (r) => r.recordType === 'message' && (r.payload as { nodeId?: number }).nodeId === 1,
    );
    expect(Object.keys(plain?.payload as object)).not.toContain('invocationKind');
  });
});
