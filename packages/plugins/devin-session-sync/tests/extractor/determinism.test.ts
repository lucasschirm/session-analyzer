import { afterEach, describe, expect, it } from 'vitest';
import { buildDevinJsonl } from '../../src/extractor/jsonl-writer.js';
import { openDevinDatabase, readDevinTables } from '../../src/extractor/reader.js';
import { EMPTY_WATERMARKS } from '../../src/extractor/types.js';
import { buildFixtureDb } from './fixtures/build-fixture-db.js';

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

function extractOnce(dbPath: string) {
  return openDevinDatabase(dbPath).then((opened) => {
    try {
      const { tables } = readDevinTables(opened.db, EMPTY_WATERMARKS);
      return buildDevinJsonl(tables);
    } finally {
      opened.close();
    }
  });
}

describe('determinism', () => {
  it('two extraction runs over the same fixture DB snapshot produce byte-identical JSONL text', async () => {
    const fixture = buildFixtureDb({
      sessions: [
        {
          id: 's1',
          working_directory: '/repo',
          backend_type: 'local',
          model: 'gpt',
          agent_mode: 'code',
          created_at: 1,
          last_activity_at: 2,
          title: 'Fix bug',
          main_chain_id: null,
          cogs_json: null,
          workspace_dirs: null,
          hidden: 0,
          metadata: null,
        },
        {
          id: 'zzz',
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
      messageNodes: [
        {
          session_id: 's1',
          node_id: 0,
          parent_node_id: null,
          chat_message: JSON.stringify({ ref: 'call-1' }),
          created_at: 1,
          metadata: null,
        },
        {
          session_id: 's1',
          node_id: 2,
          parent_node_id: 0,
          chat_message: null,
          created_at: 1,
          metadata: null,
        },
        {
          session_id: 's1',
          node_id: 1,
          parent_node_id: 0,
          chat_message: null,
          created_at: 1,
          metadata: null,
        },
      ],
      promptHistory: [
        { id: 1, content: 'do the thing', timestamp: 5, session_id: 's1', is_shell: 0 },
        { id: 2, content: null, timestamp: null, session_id: 's1', is_shell: 1 },
      ],
      toolCallStates: [
        {
          session_id: 's1',
          tool_call_id: 'call-1',
          tool_call_json: '{}',
          tool_call_update_json: null,
        },
        {
          session_id: 's1',
          tool_call_id: 'orphan',
          tool_call_json: null,
          tool_call_update_json: null,
        },
      ],
    });
    cleanup = fixture.close;

    const runA = await extractOnce(fixture.path);
    const runB = await extractOnce(fixture.path);

    expect(runB.text).toBe(runA.text);
    expect(JSON.stringify(runB.lines)).toBe(JSON.stringify(runA.lines));
    expect(runA.text.length).toBeGreaterThan(0);
  });

  it('two reads via readDevinTables + buildDevinJsonl on the same live handle agree', () => {
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
      ],
    });
    cleanup = fixture.close;

    const a = buildDevinJsonl(readDevinTables(fixture.db, EMPTY_WATERMARKS).tables);
    const b = buildDevinJsonl(readDevinTables(fixture.db, EMPTY_WATERMARKS).tables);
    expect(a.text).toBe(b.text);
  });
});
