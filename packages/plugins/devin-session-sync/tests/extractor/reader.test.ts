import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertSqliteAvailable,
  computeSchemaDescriptor,
  DevinSqliteUnavailableError,
  openDevinDatabase,
  readDevinTables,
} from '../../src/extractor/reader.js';
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
