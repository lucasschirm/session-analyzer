import { describe, expect, it } from 'vitest';
import { buildDevinJsonl } from '../../src/extractor/jsonl-writer.js';
import { filterChangedSessions } from '../../src/extractor/session-watermark.js';
import { filterChangedToolCallStates } from '../../src/extractor/tool-call-watermark.js';
import type { DevinExtractedTables } from '../../src/extractor/types.js';
import { EMPTY_WATERMARKS } from '../../src/extractor/types.js';
import { deriveWatermarksFromExistingLines } from '../../src/extractor/watermark-derivation.js';

function mixedTables(): DevinExtractedTables {
  return {
    sessions: [
      {
        id: 's1',
        working_directory: '/tmp',
        backend_type: null,
        model: null,
        agent_mode: null,
        created_at: null,
        last_activity_at: 500,
        title: null,
        main_chain_id: null,
        cogs_json: null,
        workspace_dirs: null,
        hidden: null,
        metadata: null,
      },
    ],
    messageNodes: [
      {
        row_id: 5,
        session_id: 's1',
        node_id: 1,
        parent_node_id: null,
        chat_message: '{"role":"user","content":"hi"}',
        created_at: 1,
        metadata: null,
      },
    ],
    promptHistory: [{ id: 7, content: 'hi', timestamp: 1, session_id: 's1', is_shell: 0 }],
    toolCallStates: [
      {
        row_id: 9,
        session_id: 's1',
        tool_call_id: 'call-1',
        tool_call_json: '{}',
        tool_call_update_json: null,
      },
    ],
  };
}

function lineCountOf(text: string): number {
  return text.split('\n').filter((l) => l.length > 0).length;
}

describe('deriveWatermarksFromExistingLines', () => {
  it('derives correct per-table maxima and line count from a mixed-line-type fixture', () => {
    const tables = mixedTables();
    const { text } = buildDevinJsonl(tables);

    const derived = deriveWatermarksFromExistingLines(text);

    expect(derived.lineCount).toBe(lineCountOf(text));
    expect(derived.watermarks.messageNodesRowId).toBe(5);
    expect(derived.watermarks.promptHistoryId).toBe(7);
    // The reconstructed hash maps must round-trip: re-hashing the SAME live
    // rows against the derived hashes recognizes them as already-seen.
    expect(
      filterChangedToolCallStates(tables.toolCallStates, derived.watermarks.toolCallStateHashes),
    ).toEqual([]);
    expect(
      filterChangedSessions(tables.sessions, derived.watermarks.sessionsContentHashes),
    ).toEqual([]);
    expect(derived.messageNodeIds).toEqual(new Set([1]));
  });

  it('collects node_ids from both real and synthetic message lines uniformly', () => {
    const real = { type: 'message', ts: null, order: 0, row_id: 3, node_id: 1, session_id: 's1' };
    const synthetic = {
      type: 'message',
      ts: null,
      order: 1,
      row_id: -1,
      node_id: 9_007_199_254_740_990,
    };
    const nonMessage = { type: 'prompt', ts: 1, order: 2, id: 1, session_id: 's1' };
    const text = `${[real, synthetic, nonMessage].map((l) => JSON.stringify(l)).join('\n')}\n`;

    const derived = deriveWatermarksFromExistingLines(text);
    expect(derived.messageNodeIds).toEqual(new Set([1, 9_007_199_254_740_990]));
  });

  it('returns EMPTY_WATERMARKS/lineCount:0/empty messageNodeIds for empty input', () => {
    expect(deriveWatermarksFromExistingLines('')).toEqual({
      watermarks: EMPTY_WATERMARKS,
      lineCount: 0,
      messageNodeIds: new Set(),
    });
  });

  it('skips one malformed line among valid ones: valid watermark still derived, all lines counted', () => {
    const tables = mixedTables();
    const { text } = buildDevinJsonl(tables);
    const withGarbage = `${text}{not valid json\n`;

    const derived = deriveWatermarksFromExistingLines(withGarbage);

    expect(derived.lineCount).toBe(lineCountOf(text) + 1);
    expect(derived.watermarks.messageNodesRowId).toBe(5);
    expect(derived.watermarks.promptHistoryId).toBe(7);
  });

  it('falls back to EMPTY_WATERMARKS/lineCount:0/empty messageNodeIds when nothing in the file parses as JSONL at all', () => {
    const derived = deriveWatermarksFromExistingLines('not json\nalso not json\n');
    expect(derived).toEqual({
      watermarks: EMPTY_WATERMARKS,
      lineCount: 0,
      messageNodeIds: new Set(),
    });
  });

  it("ignores a synthetic sub-agent line's row_id:-1 sentinel when computing the message watermark", () => {
    const real = {
      type: 'message',
      ts: null,
      order: 0,
      row_id: 3,
      session_id: 's1',
      node_id: 1,
      parent_node_id: null,
      chat_message: null,
      created_at: null,
      metadata: null,
    };
    const synthetic = { ...real, order: 1, row_id: -1, node_id: 2 };
    const text = `${JSON.stringify(real)}\n${JSON.stringify(synthetic)}\n`;

    expect(deriveWatermarksFromExistingLines(text).watermarks.messageNodesRowId).toBe(3);
  });
});
