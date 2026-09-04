import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertSqliteAvailable,
  computeSchemaDescriptor,
  DevinSqliteUnavailableError,
  openDevinDatabase,
  readDevinTables,
} from '../../src/extractor/reader.js';
import { mergeSessionHashes } from '../../src/extractor/session-watermark.js';
import { mergeToolCallStateHashes } from '../../src/extractor/tool-call-watermark.js';
import { EMPTY_WATERMARKS } from '../../src/extractor/types.js';
import { buildFixtureDb } from './fixtures/build-fixture-db.js';

let cleanup: (() => void) | undefined;

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

describe('assertSqliteAvailable', () => {
  it('resolves node:sqlite when DatabaseSync is present', async () => {
    const mod = await assertSqliteAvailable();
    expect(typeof mod.DatabaseSync).toBe('function');
  });

  it('fails with a clear, user-visible error when the import throws', async () => {
    const failingImporter = async () => {
      throw new Error('simulated: module not found on this Node version');
    };
    await expect(assertSqliteAvailable(failingImporter)).rejects.toThrow(
      DevinSqliteUnavailableError,
    );
    await expect(assertSqliteAvailable(failingImporter)).rejects.toThrow(/Node\.js >=22\.13\.0/);
  });

  it('fails with a clear error when DatabaseSync is missing from the module', async () => {
    const emptyImporter = async () => ({}) as typeof import('node:sqlite');
    await expect(assertSqliteAvailable(emptyImporter)).rejects.toThrow(DevinSqliteUnavailableError);
  });
});

describe('readDevinTables', () => {
  it('reads sessions, message_nodes, prompt_history, and tool_call_state from a fixture db', () => {
    const fixture = buildFixtureDb({
      sessions: [session('s1')],
      messageNodes: [messageNode('s1', 0, null), messageNode('s1', 1, 0)],
      promptHistory: [prompt('s1', 1, 1_700_000_000)],
      toolCallStates: [toolCall('s1', 'call-1')],
    });
    cleanup = fixture.close;

    const { tables, schema } = readDevinTables(fixture.db, EMPTY_WATERMARKS);
    expect(schema.supported).toBe(true);
    expect(tables.sessions).toHaveLength(1);
    expect(tables.messageNodes).toHaveLength(2);
    expect(tables.promptHistory).toHaveLength(1);
    expect(tables.toolCallStates).toHaveLength(1);
    expect(tables.toolCallStates[0].row_id).toBeGreaterThan(0);
  });

  it('reads a WAL-mode fixture safely via read-only open while a writer is active', async () => {
    const fixture = buildFixtureDb({ sessions: [session('s1')] });
    cleanup = fixture.close;

    // Keep the fixture's own writer connection open (simulating the live
    // Devin CLI) and insert more rows without closing it, then read
    // read-only through openDevinDatabase concurrently.
    fixture.db.prepare('INSERT INTO sessions (id) VALUES (?)').run('s2');

    const opened = await openDevinDatabase(fixture.path);
    try {
      const { tables } = readDevinTables(opened.db, EMPTY_WATERMARKS);
      expect(tables.sessions.map((s) => s.id).sort()).toEqual(['s1', 's2']);
    } finally {
      opened.close();
    }
  });

  it('falls back to a snapshot copy when the read-only open fails, and still reads correctly', async () => {
    const fixture = buildFixtureDb({ sessions: [session('s1')] });
    cleanup = fixture.close;

    const opened = await openDevinDatabase(fixture.path, flakyImporter(1));
    try {
      const { tables } = readDevinTables(opened.db, EMPTY_WATERMARKS);
      expect(tables.sessions.map((s) => s.id)).toEqual(['s1']);
    } finally {
      opened.close();
    }
  });

  it('reports both the read-only and snapshot-copy errors when both fail', async () => {
    await expect(
      openDevinDatabase(
        '/nonexistent/devin-session-sync-test/sessions.db',
        flakyImporter(Infinity),
      ),
    ).rejects.toThrow(/read-only open failed.*snapshot-copy fallback also failed/s);
  });

  it('degrades gracefully (never throws) on an unrecognized refinery schema version', () => {
    const fixture = buildFixtureDb({ refineryVersion: 999, sessions: [session('s1')] });
    cleanup = fixture.close;

    const { tables, schema } = readDevinTables(fixture.db, EMPTY_WATERMARKS);
    expect(schema.supported).toBe(false);
    expect(schema.warnings.length).toBeGreaterThan(0);
    expect(tables.sessions).toHaveLength(1);
    expect(tables.toolCallStates).toEqual([]);
  });

  it('only returns rows above the given watermarks', () => {
    const fixture = buildFixtureDb({
      messageNodes: [messageNode('s1', 0, null), messageNode('s1', 1, 0)],
      promptHistory: [prompt('s1', 1, 1), prompt('s1', 2, 2)],
    });
    cleanup = fixture.close;

    const first = readDevinTables(fixture.db, EMPTY_WATERMARKS);
    const firstWatermark = {
      ...EMPTY_WATERMARKS,
      messageNodesRowId: first.tables.messageNodes[0].row_id,
      promptHistoryId: first.tables.promptHistory[0].id,
    };
    const second = readDevinTables(fixture.db, firstWatermark);
    expect(second.tables.messageNodes).toHaveLength(1);
    expect(second.tables.promptHistory).toHaveLength(1);
  });
});

describe('SELECT * / dynamic column discovery (#298)', () => {
  const FUTURE_COL = 'sal_test_future_column';

  it('captures a column previously unknown to KNOWN_TABLE_COLUMNS on sessions, unfiltered', () => {
    const fixture = buildFixtureDb({ sessions: [session('s1')] });
    cleanup = fixture.close;
    fixture.db.exec(`ALTER TABLE sessions ADD COLUMN ${FUTURE_COL} TEXT`);
    fixture.db.prepare(`UPDATE sessions SET ${FUTURE_COL} = 'future-value' WHERE id = 's1'`).run();

    const { tables } = readDevinTables(fixture.db, EMPTY_WATERMARKS);
    expect(tables.sessions[0][FUTURE_COL]).toBe('future-value');
  });

  it('captures a column previously unknown to KNOWN_TABLE_COLUMNS on message_nodes, unfiltered', () => {
    const fixture = buildFixtureDb({});
    cleanup = fixture.close;
    fixture.db.exec(`ALTER TABLE message_nodes ADD COLUMN ${FUTURE_COL} TEXT`);
    fixture.db
      .prepare(
        `INSERT INTO message_nodes (session_id, node_id, parent_node_id, ${FUTURE_COL}) VALUES (?, ?, ?, ?)`,
      )
      .run('s1', 0, null, 'future-value');

    const { tables } = readDevinTables(fixture.db, EMPTY_WATERMARKS);
    expect(tables.messageNodes[0][FUTURE_COL]).toBe('future-value');
  });

  it('captures a column previously unknown to KNOWN_TABLE_COLUMNS on prompt_history, unfiltered', () => {
    const fixture = buildFixtureDb({});
    cleanup = fixture.close;
    fixture.db.exec(`ALTER TABLE prompt_history ADD COLUMN ${FUTURE_COL} TEXT`);
    fixture.db
      .prepare(
        `INSERT INTO prompt_history (content, timestamp, session_id, is_shell, ${FUTURE_COL}) VALUES (?, ?, ?, ?, ?)`,
      )
      .run('hi', 1, 's1', 0, 'future-value');

    const { tables } = readDevinTables(fixture.db, EMPTY_WATERMARKS);
    expect(tables.promptHistory[0][FUTURE_COL]).toBe('future-value');
  });

  it('captures a column previously unknown to KNOWN_TABLE_COLUMNS on tool_call_state, unfiltered', () => {
    const fixture = buildFixtureDb({ toolCallStates: [toolCall('s1', 'call-1')] });
    cleanup = fixture.close;
    fixture.db.exec(`ALTER TABLE tool_call_state ADD COLUMN ${FUTURE_COL} TEXT`);
    fixture.db.prepare(`UPDATE tool_call_state SET ${FUTURE_COL} = 'future-value'`).run();

    const { tables } = readDevinTables(fixture.db, EMPTY_WATERMARKS);
    expect(tables.toolCallStates[0][FUTURE_COL]).toBe('future-value');
  });

  it('closes the confirmed, real sessions.shell_last_seen_index gap specifically', () => {
    // #298: KNOWN_TABLE_COLUMNS['sessions'] never listed this real column
    // (confirmed on-machine against a live Devin CLI v3000.6.7
    // sessions.db, refinery version 16) -- it was silently dropped by the
    // old curated-column SELECT. This is a dedicated regression for that
    // exact column, not just the generic dynamic-column test above.
    const fixture = buildFixtureDb({ sessions: [session('s1')] });
    cleanup = fixture.close;
    fixture.db.exec('ALTER TABLE sessions ADD COLUMN shell_last_seen_index INTEGER');
    fixture.db.prepare('UPDATE sessions SET shell_last_seen_index = ? WHERE id = ?').run(7, 's1');

    const { tables } = readDevinTables(fixture.db, EMPTY_WATERMARKS);
    expect(tables.sessions[0].shell_last_seen_index).toBe(7);
  });
});

describe('tool_call_state incremental strategy (#298 Phase 1 fix)', () => {
  it('catches a real content mutation whose reinsert reuses a rowid at or below the watermark', () => {
    // Reproduces #298's live finding on SQLite's own rowid-reuse semantics
    // (this table has no AUTOINCREMENT column): a `rowid > watermark`
    // strategy would silently miss this. The content-hash strategy must
    // not.
    const fixture = buildFixtureDb({
      toolCallStates: [
        {
          session_id: 's1',
          tool_call_id: 'call-1',
          tool_call_json: '{}',
          tool_call_update_json: null,
        },
        {
          session_id: 's1',
          tool_call_id: 'call-2',
          tool_call_json: '{}',
          tool_call_update_json: null,
        },
      ],
    });
    cleanup = fixture.close;

    const first = readDevinTables(fixture.db, EMPTY_WATERMARKS);
    expect(first.tables.toolCallStates).toHaveLength(2);
    const priorHashes = mergeToolCallStateHashes({}, first.tables.toolCallStates);

    // Delete both rows, then reinsert call-1 with genuinely new content.
    // With no rows left, SQLite's default rowid assignment restarts at 1
    // -- reusing (or landing below) a rowid this session already saw.
    fixture.db.prepare('DELETE FROM tool_call_state WHERE session_id = ?').run('s1');
    fixture.db
      .prepare(
        'INSERT INTO tool_call_state (session_id, tool_call_id, tool_call_json, tool_call_update_json) VALUES (?, ?, ?, ?)',
      )
      .run('s1', 'call-1', '{}', '{"status":"completed"}');

    const second = readDevinTables(fixture.db, {
      ...EMPTY_WATERMARKS,
      toolCallStateHashes: priorHashes,
    });
    expect(second.tables.toolCallStates.map((t) => t.tool_call_id)).toEqual(['call-1']);
    expect(second.tables.toolCallStates[0].tool_call_update_json).toBe('{"status":"completed"}');
  });

  it('does not re-emit an unchanged tool call even after its rowid churns (no duplication)', () => {
    const fixture = buildFixtureDb({
      toolCallStates: [
        {
          session_id: 's1',
          tool_call_id: 'call-1',
          tool_call_json: '{}',
          tool_call_update_json: null,
        },
      ],
    });
    cleanup = fixture.close;

    const first = readDevinTables(fixture.db, EMPTY_WATERMARKS);
    const priorHashes = mergeToolCallStateHashes({}, first.tables.toolCallStates);

    // Simulate Devin's observed full-session rewrite: same content, new rowid.
    fixture.db.prepare('DELETE FROM tool_call_state WHERE session_id = ?').run('s1');
    fixture.db
      .prepare(
        'INSERT INTO tool_call_state (session_id, tool_call_id, tool_call_json, tool_call_update_json) VALUES (?, ?, ?, ?)',
      )
      .run('s1', 'call-1', '{}', null);

    const second = readDevinTables(fixture.db, {
      ...EMPTY_WATERMARKS,
      toolCallStateHashes: priorHashes,
    });
    expect(second.tables.toolCallStates).toEqual([]);
  });
});

describe('sessions change-detection skip signal (#298)', () => {
  it('skips a session whose full row content has not changed since the watermark', () => {
    const fixture = buildFixtureDb({
      sessions: [{ ...session('s1'), last_activity_at: 100 }],
    });
    cleanup = fixture.close;

    const first = readDevinTables(fixture.db, EMPTY_WATERMARKS);
    expect(first.tables.sessions).toHaveLength(1);

    const priorHashes = mergeSessionHashes({}, first.tables.sessions);
    const watermark = { ...EMPTY_WATERMARKS, sessionsContentHashes: priorHashes };
    const second = readDevinTables(fixture.db, watermark);
    expect(second.tables.sessions).toEqual([]);
  });

  it('never skips a session whose content genuinely changed, even a column other than last_activity_at', () => {
    const fixture = buildFixtureDb({
      sessions: [{ ...session('s1'), last_activity_at: 100, model: 'glm-5-3-high' }],
    });
    cleanup = fixture.close;

    // Deliberately: same last_activity_at as the fixture, different `model`
    // — proves the skip signal is a full-row hash, not a last_activity_at
    // comparison (the #298 review finding this fixes: a skill-only or
    // effort-only mutation that never bumps last_activity_at must not be
    // silently skipped).
    const priorHashes = mergeSessionHashes({}, [
      { ...session('s1'), last_activity_at: 100, model: 'glm-5-3-low' },
    ] as Parameters<typeof mergeSessionHashes>[1]);
    const watermark = { ...EMPTY_WATERMARKS, sessionsContentHashes: priorHashes };
    const result = readDevinTables(fixture.db, watermark);
    expect(result.tables.sessions).toHaveLength(1);
  });

  it('never skips a session absent from the prior watermark (first sight is always included)', () => {
    const fixture = buildFixtureDb({ sessions: [session('s1')] });
    cleanup = fixture.close;

    const watermark = { ...EMPTY_WATERMARKS, sessionsContentHashes: { other: 'deadbeef' } };
    const result = readDevinTables(fixture.db, watermark);
    expect(result.tables.sessions).toHaveLength(1);
  });
});

describe('computeSchemaDescriptor', () => {
  it('reports the refinery migration ledger, table checksums, and caller-supplied CLI version', () => {
    const fixture = buildFixtureDb({ sessions: [session('s1')] });
    cleanup = fixture.close;

    const descriptor = computeSchemaDescriptor(fixture.db, '3000.6.7');
    expect(descriptor.devinCliVersion).toBe('3000.6.7');
    expect(descriptor.refineryVersion).toBe(16);
    expect(descriptor.refineryMigrations).toHaveLength(16);
    expect(descriptor.tableChecksums.sessions).toMatch(/^[0-9a-f]{64}$/);
    expect(descriptor.supported).toBe(true);
  });

  it('carries devinCliVersion as null (never a placeholder) when unknown', () => {
    const fixture = buildFixtureDb({});
    cleanup = fixture.close;
    expect(computeSchemaDescriptor(fixture.db).devinCliVersion).toBeNull();
  });

  it('sets missing table checksums to null when a table is absent', () => {
    const fixture = buildFixtureDb({ omitToolCallStateTable: true });
    cleanup = fixture.close;
    const descriptor = computeSchemaDescriptor(fixture.db);
    expect(descriptor.tableChecksums.tool_call_state).toBeNull();
  });

  it('reports refineryVersion 0 and no migrations when the ledger table is absent', () => {
    const fixture = buildFixtureDb({ omitRefineryTable: true });
    cleanup = fixture.close;
    const descriptor = computeSchemaDescriptor(fixture.db);
    expect(descriptor.refineryVersion).toBe(0);
    expect(descriptor.refineryMigrations).toEqual([]);
    expect(descriptor.supported).toBe(false);
  });
});

/**
 * Builds an importer whose `DatabaseSync` throws for the first
 * `failCount` construction attempts, then delegates to the real
 * `node:sqlite` `DatabaseSync` — simulates a read-only open against the
 * live path failing (once) before the snapshot-copy fallback succeeds, or
 * always failing (`Infinity`) to exercise the combined-error path.
 */
function flakyImporter(failCount: number) {
  return async () => {
    const real = await import('node:sqlite');
    let attempts = 0;
    class FlakyDatabaseSync extends real.DatabaseSync {
      constructor(...args: ConstructorParameters<typeof real.DatabaseSync>) {
        attempts += 1;
        if (attempts <= failCount) {
          super(':memory:', { open: false });
          throw new Error(`simulated open failure (attempt ${attempts})`);
        }
        super(...args);
      }
    }
    return { ...real, DatabaseSync: FlakyDatabaseSync };
  };
}

function session(id: string) {
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

function messageNode(sessionId: string, nodeId: number, parentNodeId: number | null) {
  return {
    row_id: 0,
    session_id: sessionId,
    node_id: nodeId,
    parent_node_id: parentNodeId,
    chat_message: null,
    created_at: null,
    metadata: null,
  };
}

function prompt(sessionId: string, id: number, timestamp: number | null) {
  return { id, content: null, timestamp, session_id: sessionId, is_shell: 0 };
}

function toolCall(sessionId: string, toolCallId: string) {
  return {
    row_id: 0,
    session_id: sessionId,
    tool_call_id: toolCallId,
    tool_call_json: null,
    tool_call_update_json: null,
  };
}

// Sanity: node:sqlite's own DatabaseSync must be constructible directly in
// this test environment, or every test above is meaningless.
describe('environment sanity', () => {
  it('node:sqlite DatabaseSync is available in this test runtime', () => {
    expect(typeof DatabaseSync).toBe('function');
  });
});
