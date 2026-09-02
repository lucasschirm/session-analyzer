import { describe, expect, it } from 'vitest';
import { parseDevinJsonlLine, parseDevinJsonlText } from './parse-line.js';

function line(obj: Record<string, unknown>): string {
  return JSON.stringify(obj);
}

describe('parseDevinJsonlLine — session', () => {
  it('parses a valid session line', () => {
    const result = parseDevinJsonlLine(
      line({
        type: 'session',
        ts: 1000,
        order: 0,
        id: 'sess-1',
        working_directory: '/repo',
        backend_type: 'cli',
        model: 'model-a',
        agent_mode: 'auto',
        created_at: 900,
        last_activity_at: 1000,
        title: 'My session',
        main_chain_id: 'chain-1',
        cogs_json: null,
        workspace_dirs: '["/repo"]',
        hidden: 0,
        metadata: null,
      }),
      1,
    );
    expect('line' in result).toBe(true);
    if (!('line' in result)) throw new Error('expected a line');
    expect(result.line).toEqual({
      type: 'session',
      ts: 1000,
      order: 0,
      id: 'sess-1',
      workingDirectory: '/repo',
      backendType: 'cli',
      model: 'model-a',
      agentMode: 'auto',
      createdAt: 900,
      lastActivityAt: 1000,
      title: 'My session',
      mainChainId: 'chain-1',
      cogsJson: null,
      workspaceDirs: '["/repo"]',
      hidden: 0,
      metadata: null,
    });
  });

  it('skips a session line missing id', () => {
    const result = parseDevinJsonlLine(line({ type: 'session', ts: null, order: 0 }), 1);
    expect('warning' in result).toBe(true);
  });
});

describe('parseDevinJsonlLine — message', () => {
  it('parses a valid message line and maps a known role', () => {
    const chatMessage = JSON.stringify({ role: 'assistant', content: 'hi' });
    const result = parseDevinJsonlLine(
      line({
        type: 'message',
        ts: null,
        order: 1,
        row_id: 5,
        session_id: 'sess-1',
        node_id: 2,
        parent_node_id: 1,
        chat_message: chatMessage,
        created_at: 111,
        metadata: null,
      }),
      2,
    );
    if (!('line' in result)) throw new Error('expected a line');
    expect(result.line).toMatchObject({
      type: 'message',
      rowId: 5,
      sessionId: 'sess-1',
      nodeId: 2,
      parentNodeId: 1,
      role: 'assistant',
      rawRole: null,
    });
  });

  it('falls back role to unknown without crashing on an unrecognized value', () => {
    const chatMessage = JSON.stringify({ role: 'narrator' });
    const result = parseDevinJsonlLine(
      line({
        type: 'message',
        ts: null,
        order: 1,
        row_id: 5,
        session_id: 'sess-1',
        node_id: 2,
        parent_node_id: null,
        chat_message: chatMessage,
        created_at: null,
        metadata: null,
      }),
      2,
    );
    if (!('line' in result)) throw new Error('expected a line');
    expect(result.line).toMatchObject({ role: 'unknown', rawRole: 'narrator' });
  });

  it('handles unparseable chat_message without crashing', () => {
    const result = parseDevinJsonlLine(
      line({
        type: 'message',
        ts: null,
        order: 1,
        row_id: 5,
        session_id: 'sess-1',
        node_id: 2,
        parent_node_id: null,
        chat_message: 'not json',
        created_at: null,
        metadata: null,
      }),
      2,
    );
    if (!('line' in result)) throw new Error('expected a line');
    expect(result.line).toMatchObject({ role: 'unknown', chatMessage: null });
  });

  it('skips a message line missing node_id', () => {
    const result = parseDevinJsonlLine(
      line({ type: 'message', ts: null, order: 1, session_id: 'sess-1' }),
      2,
    );
    expect('warning' in result).toBe(true);
  });
});

describe('parseDevinJsonlLine — tool_call', () => {
  it('parses a valid tool_call line preserving the ACP kind', () => {
    const callJson = JSON.stringify({ toolCallId: 'call-1', title: 'Edit file', kind: 'edit' });
    const result = parseDevinJsonlLine(
      line({
        type: 'tool_call',
        ts: null,
        order: 3,
        row_id: 9,
        session_id: 'sess-1',
        tool_call_id: 'call-1',
        tool_call_json: callJson,
        tool_call_update_json: null,
      }),
      3,
    );
    if (!('line' in result)) throw new Error('expected a line');
    expect(result.line).toMatchObject({
      type: 'tool_call',
      ts: null,
      toolCallId: 'call-1',
      call: { toolCallId: 'call-1', kind: 'edit' },
      update: null,
    });
  });

  it('skips a tool_call line missing tool_call_id', () => {
    const result = parseDevinJsonlLine(
      line({ type: 'tool_call', ts: null, order: 3, session_id: 'sess-1' }),
      3,
    );
    expect('warning' in result).toBe(true);
  });
});

describe('parseDevinJsonlLine — prompt', () => {
  it('parses a valid prompt line', () => {
    const result = parseDevinJsonlLine(
      line({
        type: 'prompt',
        ts: 42,
        order: 4,
        id: 7,
        session_id: 'sess-1',
        content: 'do the thing',
        is_shell: 1,
      }),
      4,
    );
    if (!('line' in result)) throw new Error('expected a line');
    expect(result.line).toEqual({
      type: 'prompt',
      ts: 42,
      order: 4,
      id: 7,
      sessionId: 'sess-1',
      content: 'do the thing',
      isShell: true,
    });
  });

  it('skips a prompt line missing id', () => {
    const result = parseDevinJsonlLine(
      line({ type: 'prompt', ts: null, order: 4, session_id: 'sess-1' }),
      4,
    );
    expect('warning' in result).toBe(true);
  });
});

describe('parseDevinJsonlLine — malformed lines', () => {
  it('logs and skips invalid JSON without throwing', () => {
    expect(() => parseDevinJsonlLine('{not valid json', 1)).not.toThrow();
    const result = parseDevinJsonlLine('{not valid json', 1);
    expect('warning' in result).toBe(true);
    if ('warning' in result) {
      expect(result.warning.reason).toBe('invalid JSON');
      expect(result.warning.lineNumber).toBe(1);
    }
  });

  it('logs and skips a JSON array (not an object)', () => {
    const result = parseDevinJsonlLine('[1,2,3]', 1);
    expect('warning' in result).toBe(true);
  });

  it('logs and skips an unknown type', () => {
    const result = parseDevinJsonlLine(line({ type: 'other', ts: null, order: 0 }), 1);
    expect('warning' in result).toBe(true);
    if ('warning' in result) expect(result.warning.reason).toContain('unknown type');
  });
});

describe('parseDevinJsonlLine — ts field', () => {
  it('preserves a present unix-second number', () => {
    const result = parseDevinJsonlLine(
      line({ type: 'prompt', ts: 12345, order: 0, id: 1, session_id: 's' }),
      1,
    );
    if (!('line' in result)) throw new Error('expected a line');
    expect(result.line.ts).toBe(12345);
  });

  it('preserves an explicit null, never coercing to 0', () => {
    const result = parseDevinJsonlLine(
      line({ type: 'prompt', ts: null, order: 0, id: 1, session_id: 's' }),
      1,
    );
    if (!('line' in result)) throw new Error('expected a line');
    expect(result.line.ts).toBeNull();
  });

  it('preserves a missing ts key as null, distinguishing it from a legitimate ts: 0', () => {
    const missing = parseDevinJsonlLine(
      line({ type: 'prompt', order: 0, id: 1, session_id: 's' }),
      1,
    );
    const zero = parseDevinJsonlLine(
      line({ type: 'prompt', ts: 0, order: 0, id: 1, session_id: 's' }),
      1,
    );
    if (!('line' in missing) || !('line' in zero)) throw new Error('expected lines');
    expect(missing.line.ts).toBeNull();
    expect(zero.line.ts).toBe(0);
    expect(zero.line.ts).not.toBeNull();
  });

  it('rejects a non-number, non-null ts', () => {
    const result = parseDevinJsonlLine(
      line({ type: 'prompt', ts: 'yesterday', order: 0, id: 1, session_id: 's' }),
      1,
    );
    expect('warning' in result).toBe(true);
  });
});

describe('parseDevinJsonlLine — order field', () => {
  it('validates a monotonic integer order', () => {
    const result = parseDevinJsonlLine(
      line({ type: 'prompt', ts: null, order: 3, id: 1, session_id: 's' }),
      1,
    );
    if (!('line' in result)) throw new Error('expected a line');
    expect(result.line.order).toBe(3);
  });

  it('rejects a non-integer order', () => {
    const result = parseDevinJsonlLine(
      line({ type: 'prompt', ts: null, order: 1.5, id: 1, session_id: 's' }),
      1,
    );
    expect('warning' in result).toBe(true);
  });

  it('rejects a negative order', () => {
    const result = parseDevinJsonlLine(
      line({ type: 'prompt', ts: null, order: -1, id: 1, session_id: 's' }),
      1,
    );
    expect('warning' in result).toBe(true);
  });

  it('rejects a missing order', () => {
    const result = parseDevinJsonlLine(
      line({ type: 'prompt', ts: null, id: 1, session_id: 's' }),
      1,
    );
    expect('warning' in result).toBe(true);
  });
});

describe('parseDevinJsonlText', () => {
  it('parses multiple lines, skipping malformed ones, never throwing', () => {
    const text = [
      line({ type: 'prompt', ts: 1, order: 0, id: 1, session_id: 's' }),
      '{not valid json',
      line({ type: 'prompt', ts: 2, order: 1, id: 2, session_id: 's' }),
    ].join('\n');
    const result = parseDevinJsonlText(text);
    expect(result.lines).toHaveLength(2);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].lineNumber).toBe(2);
  });

  it('ignores blank trailing lines', () => {
    const text = `${line({ type: 'prompt', ts: 1, order: 0, id: 1, session_id: 's' })}\n\n`;
    const result = parseDevinJsonlText(text);
    expect(result.lines).toHaveLength(1);
    expect(result.warnings).toHaveLength(0);
  });

  it('returns empty result for empty text', () => {
    const result = parseDevinJsonlText('');
    expect(result.lines).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });
});
