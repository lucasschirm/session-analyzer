import { afterEach, describe, expect, it } from 'vitest';
import { buildDevinJsonl } from '../../src/extractor/jsonl-writer.js';
import { readDevinTables } from '../../src/extractor/reader.js';
import type { DevinJsonlLine } from '../../src/extractor/types.js';
import { EMPTY_WATERMARKS } from '../../src/extractor/types.js';
import { buildFixtureDb } from './fixtures/build-fixture-db.js';

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

const byType = (lines: DevinJsonlLine[], type: DevinJsonlLine['type']) =>
  lines.filter((l) => l.type === type);

describe('watermark-based incremental extraction', () => {
  it('message_nodes: resuming from a watermark emits only new rows, in the same order a full extraction would', () => {
    const fixture = buildFixtureDb({
      sessions: [minimalSession('s1')],
      messageNodes: [
        {
          session_id: 's1',
          node_id: 0,
          parent_node_id: null,
          chat_message: null,
          created_at: 1,
          metadata: null,
        },
      ],
    });
    cleanup = fixture.close;

    const first = readDevinTables(fixture.db, EMPTY_WATERMARKS);
    const firstResult = buildDevinJsonl(first.tables, { priorWatermarks: EMPTY_WATERMARKS });

    fixture.db
      .prepare('INSERT INTO message_nodes (session_id, node_id, parent_node_id) VALUES (?, ?, ?)')
      .run('s1', 1, 0);

    const second = readDevinTables(fixture.db, firstResult.watermarks);
    expect(second.tables.messageNodes).toHaveLength(1); // only the new row, not re-emitted
    const secondResult = buildDevinJsonl(second.tables, {
      orderOffset: firstResult.lines.length,
      priorWatermarks: firstResult.watermarks,
    });

    const full = readDevinTables(fixture.db, EMPTY_WATERMARKS);
    const fullResult = buildDevinJsonl(full.tables);

    const incrementalMessages = [
      ...byType(firstResult.lines, 'message'),
      ...byType(secondResult.lines, 'message'),
    ];
    expect(incrementalMessages.map((l) => l.node_id)).toEqual(
      byType(fullResult.lines, 'message').map((l) => l.node_id),
    );
    expect(secondResult.watermarks.messageNodesRowId).toBeGreaterThan(
      firstResult.watermarks.messageNodesRowId ?? -1,
    );
  });

  it('prompt_history: resuming from a watermark never duplicates or reorders previously emitted prompts', () => {
    const fixture = buildFixtureDb({
      promptHistory: [{ id: 1, content: 'first', timestamp: 10, session_id: 's1', is_shell: 0 }],
    });
    cleanup = fixture.close;

    const first = readDevinTables(fixture.db, EMPTY_WATERMARKS);
    const firstResult = buildDevinJsonl(first.tables, { priorWatermarks: EMPTY_WATERMARKS });

    fixture.db
      .prepare(
        'INSERT INTO prompt_history (content, timestamp, session_id, is_shell) VALUES (?, ?, ?, ?)',
      )
      .run('second', 20, 's1', 0);

    const second = readDevinTables(fixture.db, firstResult.watermarks);
    const secondResult = buildDevinJsonl(second.tables, {
      priorWatermarks: firstResult.watermarks,
    });

    expect(byType(firstResult.lines, 'prompt')).toHaveLength(1);
    expect(byType(secondResult.lines, 'prompt')).toHaveLength(1);
    expect(byType(secondResult.lines, 'prompt')[0].content).toBe('second');
    expect(secondResult.watermarks.promptHistoryId).toBe(2);
  });

  it('tool_call_state: resuming from a watermark emits each row exactly once, in row_id order', () => {
    const fixture = buildFixtureDb({
      toolCallStates: [
        {
          session_id: 's1',
          tool_call_id: 'call-1',
          tool_call_json: null,
          tool_call_update_json: null,
        },
      ],
    });
    cleanup = fixture.close;

    const first = readDevinTables(fixture.db, EMPTY_WATERMARKS);
    const firstResult = buildDevinJsonl(first.tables, { priorWatermarks: EMPTY_WATERMARKS });

    fixture.db
      .prepare('INSERT INTO tool_call_state (session_id, tool_call_id) VALUES (?, ?)')
      .run('s1', 'call-2');

    const second = readDevinTables(fixture.db, firstResult.watermarks);
    const secondResult = buildDevinJsonl(second.tables, {
      priorWatermarks: firstResult.watermarks,
    });

    const allToolCalls = [
      ...byType(firstResult.lines, 'tool_call'),
      ...byType(secondResult.lines, 'tool_call'),
    ];
    expect(allToolCalls.map((l) => l.tool_call_id)).toEqual(['call-1', 'call-2']);
    expect(new Set(allToolCalls.map((l) => l.tool_call_id)).size).toBe(2); // no duplicates
  });

  it('a no-op resume (no new rows) preserves the prior watermark rather than regressing to null', () => {
    const fixture = buildFixtureDb({
      promptHistory: [{ id: 1, content: 'only', timestamp: 1, session_id: 's1', is_shell: 0 }],
    });
    cleanup = fixture.close;

    const first = readDevinTables(fixture.db, EMPTY_WATERMARKS);
    const firstResult = buildDevinJsonl(first.tables, { priorWatermarks: EMPTY_WATERMARKS });

    const second = readDevinTables(fixture.db, firstResult.watermarks);
    const secondResult = buildDevinJsonl(second.tables, {
      priorWatermarks: firstResult.watermarks,
    });

    expect(secondResult.lines).toEqual([]);
    expect(secondResult.watermarks).toEqual(firstResult.watermarks);
    expect(secondResult.watermarks.promptHistoryId).toBe(1);
  });
});

function minimalSession(id: string) {
  return {
    id,
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
  };
}
