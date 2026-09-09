import { describe, expect, it } from 'vitest';
import { buildDevinJsonl } from '../../src/extractor/jsonl-writer.js';
import type { DevinExtractedTables } from '../../src/extractor/types.js';

function emptyTables(overrides: Partial<DevinExtractedTables> = {}): DevinExtractedTables {
  return { sessions: [], messageNodes: [], promptHistory: [], toolCallStates: [], ...overrides };
}

describe('buildDevinJsonl', () => {
  it('emits a session line with ts from last_activity_at and the raw row fields', () => {
    const tables = emptyTables({
      sessions: [
        {
          id: 's1',
          working_directory: '/repo',
          backend_type: 'local',
          model: 'gpt',
          agent_mode: 'code',
          created_at: 100,
          last_activity_at: 200,
          title: 'Fix bug',
          main_chain_id: null,
          cogs_json: null,
          workspace_dirs: null,
          hidden: 0,
          metadata: null,
        },
      ],
    });
    const { lines } = buildDevinJsonl(tables);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      type: 'session',
      ts: 200,
      order: 0,
      id: 's1',
      title: 'Fix bug',
    });
  });

  it('emits message lines with ts:null, never using created_at as ts', () => {
    const tables = emptyTables({
      messageNodes: [
        {
          row_id: 1,
          session_id: 's1',
          node_id: 0,
          parent_node_id: null,
          chat_message: '{}',
          created_at: 555,
          metadata: null,
        },
      ],
    });
    const { lines } = buildDevinJsonl(tables);
    expect(lines[0]).toMatchObject({ type: 'message', ts: null, node_id: 0, created_at: 555 });
  });

  it('carries prompt_history.timestamp verbatim as ts', () => {
    const tables = emptyTables({
      promptHistory: [{ id: 1, content: 'hi', timestamp: 42, session_id: 's1', is_shell: 0 }],
    });
    const { lines } = buildDevinJsonl(tables);
    expect(lines[0]).toMatchObject({ type: 'prompt', ts: 42 });
  });

  it('serializes prompt.timestamp as null (never 0) when missing', () => {
    const tables = emptyTables({
      promptHistory: [{ id: 1, content: 'hi', timestamp: null, session_id: 's1', is_shell: 0 }],
    });
    const { lines } = buildDevinJsonl(tables);
    expect(lines[0].ts).toBeNull();
    expect(lines[0].ts).not.toBe(0);
  });

  it('serializes session.ts as null (never 0) when last_activity_at is missing', () => {
    const tables = emptyTables({
      sessions: [
        {
          id: 's1',
          working_directory: null,
          backend_type: null,
          model: null,
          agent_mode: null,
          created_at: null,
          last_activity_at: null,
          title: null,
          main_chain_id: null,
          cogs_json: null,
          workspace_dirs: null,
          hidden: null,
          metadata: null,
        },
      ],
    });
    const { lines } = buildDevinJsonl(tables);
    expect(lines[0].ts).toBeNull();
  });

  it('assigns a monotonic, zero-based order by default and honors orderOffset', () => {
    const tables = emptyTables({
      promptHistory: [
        { id: 1, content: 'a', timestamp: 1, session_id: 's1', is_shell: 0 },
        { id: 2, content: 'b', timestamp: 2, session_id: 's1', is_shell: 0 },
      ],
    });
    const fresh = buildDevinJsonl(tables);
    expect(fresh.lines.map((l) => l.order)).toEqual([0, 1]);

    const offset = buildDevinJsonl(tables, { orderOffset: 10 });
    expect(offset.lines.map((l) => l.order)).toEqual([10, 11]);
  });

  it('emits newline-terminated JSONL text matching the lines array', () => {
    const tables = emptyTables({
      promptHistory: [{ id: 1, content: 'a', timestamp: 1, session_id: 's1', is_shell: 0 }],
    });
    const { lines, text } = buildDevinJsonl(tables);
    expect(text).toBe(`${JSON.stringify(lines[0])}\n`);
  });

  it('emits empty text and no lines for empty input', () => {
    const { lines, text } = buildDevinJsonl(emptyTables());
    expect(lines).toEqual([]);
    expect(text).toBe('');
  });

  it('orders sessions deterministically (ascending session id) regardless of input order', () => {
    const tables = emptyTables({
      promptHistory: [
        { id: 1, content: 'b', timestamp: 1, session_id: 'zeta', is_shell: 0 },
        { id: 2, content: 'a', timestamp: 1, session_id: 'alpha', is_shell: 0 },
      ],
    });
    const { lines } = buildDevinJsonl(tables);
    expect(lines.map((l) => l.session_id)).toEqual(['alpha', 'zeta']);
  });
});
