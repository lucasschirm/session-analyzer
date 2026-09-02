import { describe, expect, it } from 'vitest';
import { parseAcpToolCall, parseAcpToolCallUpdate } from './acp-parse.js';

describe('parseAcpToolCall', () => {
  it.each(['edit', 'execute', 'search'] as const)('preserves kind %s distinctly', (kind) => {
    const json = JSON.stringify({
      toolCallId: 'call-1',
      title: 't',
      kind,
      content: 'c',
      rawInput: {},
    });
    const call = parseAcpToolCall(json);
    expect(call?.kind).toBe(kind);
    expect(call?.rawKind).toBeNull();
  });

  it('never collapses distinct kinds into one bucket', () => {
    const edit = parseAcpToolCall(JSON.stringify({ toolCallId: 'a', kind: 'edit' }));
    const execute = parseAcpToolCall(JSON.stringify({ toolCallId: 'b', kind: 'execute' }));
    const search = parseAcpToolCall(JSON.stringify({ toolCallId: 'c', kind: 'search' }));
    const kinds = new Set([edit?.kind, execute?.kind, search?.kind]);
    expect(kinds).toEqual(new Set(['edit', 'execute', 'search']));
  });

  it('falls back to unknown kind, preserving the raw string, without crashing', () => {
    const call = parseAcpToolCall(JSON.stringify({ toolCallId: 'call-1', kind: 'delete' }));
    expect(call?.kind).toBe('unknown');
    expect(call?.rawKind).toBe('delete');
  });

  it('returns null for null input', () => {
    expect(parseAcpToolCall(null)).toBeNull();
  });

  it('returns null for invalid JSON without throwing', () => {
    expect(() => parseAcpToolCall('{bad json')).not.toThrow();
    expect(parseAcpToolCall('{bad json')).toBeNull();
  });

  it('returns null when toolCallId is missing', () => {
    expect(parseAcpToolCall(JSON.stringify({ kind: 'edit' }))).toBeNull();
  });

  it('defaults title/content/rawInput when absent', () => {
    const call = parseAcpToolCall(JSON.stringify({ toolCallId: 'call-1', kind: 'search' }));
    expect(call).toMatchObject({ title: null, content: null, rawInput: null });
  });
});

describe('parseAcpToolCallUpdate', () => {
  it('extracts _meta["cognition.ai/inferenceToolName"]', () => {
    const json = JSON.stringify({
      status: 'completed',
      _meta: { 'cognition.ai/inferenceToolName': 'str_replace_editor' },
    });
    const update = parseAcpToolCallUpdate(json);
    expect(update).toMatchObject({ status: 'completed', inferenceToolName: 'str_replace_editor' });
  });

  it('returns null inferenceToolName when _meta is absent', () => {
    const update = parseAcpToolCallUpdate(JSON.stringify({ status: 'pending' }));
    expect(update?.inferenceToolName).toBeNull();
  });

  it('returns null for null input', () => {
    expect(parseAcpToolCallUpdate(null)).toBeNull();
  });

  it('returns null for invalid JSON without throwing', () => {
    expect(() => parseAcpToolCallUpdate('{bad json')).not.toThrow();
    expect(parseAcpToolCallUpdate('{bad json')).toBeNull();
  });
});
