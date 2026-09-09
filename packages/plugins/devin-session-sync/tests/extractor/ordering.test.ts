import { afterEach, describe, expect, it } from 'vitest';
import { buildDevinJsonl, orderMessageNodes } from '../../src/extractor/jsonl-writer.js';
import { readDevinTables } from '../../src/extractor/reader.js';
import type { DevinMessageNodeRow } from '../../src/extractor/types.js';
import { EMPTY_WATERMARKS } from '../../src/extractor/types.js';
import { buildFixtureDb } from './fixtures/build-fixture-db.js';

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

function node(nodeId: number, parentNodeId: number | null, chatMessage: string | null = null) {
  return {
    session_id: 's1',
    node_id: nodeId,
    parent_node_id: parentNodeId,
    chat_message: chatMessage,
    // Deliberately identical across every row — reproduces the verified
    // "message_nodes.created_at is not per-message" quirk from the issue.
    created_at: 1_700_000_000,
    metadata: null,
  };
}

describe('orderMessageNodes', () => {
  it('orders a linear session sequentially by node_id', () => {
    const nodes = [node(2, 1), node(0, null), node(1, 0)] as DevinMessageNodeRow[];
    const ordered = orderMessageNodes(nodes.map((n, i) => ({ ...n, row_id: i + 1 })));
    expect(ordered.map((n) => n.node_id)).toEqual([0, 1, 2]);
  });

  it('produces a stable, deterministic order for a branchy edit/regenerate tree', () => {
    // 0 is root; 1 and 2 both branch from 0 (regenerate); 3 branches from 1.
    const nodes = [node(3, 1), node(1, 0), node(2, 0), node(0, null)] as DevinMessageNodeRow[];
    const withRowIds = nodes.map((n, i) => ({ ...n, row_id: i + 1 }));
    const ordered = orderMessageNodes(withRowIds);
    expect(ordered.map((n) => n.node_id)).toEqual([0, 1, 2, 3]);
  });

  it('is provably not created_at-based: identical created_at across all rows still yields tree order', () => {
    const nodes = [node(1, 0), node(0, null)].map((n, i) => ({ ...n, row_id: i + 1 }));
    expect(new Set(nodes.map((n) => n.created_at)).size).toBe(1);
    expect(orderMessageNodes(nodes).map((n) => n.node_id)).toEqual([0, 1]);
  });

  it('treats a node whose parent is outside the batch as immediately ready', () => {
    // Simulates an incremental read where node 0's parent (from a prior
    // batch) is not present here.
    const nodes = [node(1, 0)].map((n, i) => ({ ...n, row_id: i + 1 }));
    expect(orderMessageNodes(nodes).map((n) => n.node_id)).toEqual([1]);
  });

  it('runs repeatedly over the same input without mutating it', () => {
    const nodes = [node(1, 0), node(0, null)].map((n, i) => ({ ...n, row_id: i + 1 }));
    const snapshot = JSON.stringify(nodes);
    orderMessageNodes(nodes);
    expect(JSON.stringify(nodes)).toBe(snapshot);
  });
});

describe('tool-call interleaving', () => {
  it('places a resolvable tool_call_state row right after its referencing message', () => {
    const fixture = buildFixtureDb({
      messageNodes: [
        {
          session_id: 's1',
          node_id: 0,
          parent_node_id: null,
          chat_message: null,
          created_at: 1,
          metadata: null,
        },
        {
          session_id: 's1',
          node_id: 1,
          parent_node_id: 0,
          chat_message: JSON.stringify({ toolCall: { id: 'call-1' } }),
          created_at: 1,
          metadata: null,
        },
      ],
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

    const { tables } = readDevinTables(fixture.db, EMPTY_WATERMARKS);
    const { lines } = buildDevinJsonl(tables);
    expect(lines.map((l) => [l.type, l.node_id ?? l.tool_call_id])).toEqual([
      ['message', 0],
      ['message', 1],
      ['tool_call', 'call-1'],
    ]);
  });

  it('appends an unresolvable tool_call_state row at the end, in row_id order', () => {
    const fixture = buildFixtureDb({
      messageNodes: [
        {
          session_id: 's1',
          node_id: 0,
          parent_node_id: null,
          chat_message: 'no references here',
          created_at: 1,
          metadata: null,
        },
      ],
      toolCallStates: [
        {
          session_id: 's1',
          tool_call_id: 'orphan-2',
          tool_call_json: null,
          tool_call_update_json: null,
        },
        {
          session_id: 's1',
          tool_call_id: 'orphan-1',
          tool_call_json: null,
          tool_call_update_json: null,
        },
      ],
    });
    cleanup = fixture.close;

    const { tables } = readDevinTables(fixture.db, EMPTY_WATERMARKS);
    const { lines } = buildDevinJsonl(tables);
    const toolCallIds = lines.filter((l) => l.type === 'tool_call').map((l) => l.tool_call_id);
    // Inserted in this order, so row_id order is orphan-2 then orphan-1.
    expect(toolCallIds).toEqual(['orphan-2', 'orphan-1']);
    expect(lines.at(-1)?.type).toBe('tool_call');
  });
});
