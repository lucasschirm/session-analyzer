import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  DevinMessageNodeRow,
  DevinPromptHistoryRow,
  DevinSessionRow,
  DevinToolCallStateRow,
} from '../../../src/extractor/types.js';

/**
 * Builds a real, on-disk `node:sqlite` database matching Devin CLI's
 * `sessions.db` shape (refinery version 16), seeded with the given rows.
 * No binary `.db` fixtures are checked in — every test builds its own via
 * this helper, per the issue's test plan.
 */

export interface FixtureRows {
  refineryVersion?: number;
  sessions?: DevinSessionRow[];
  messageNodes?: DevinMessageNodeRow[];
  promptHistory?: DevinPromptHistoryRow[];
  toolCallStates?: DevinToolCallStateRow[];
  /** Simulate a schema that doesn't have `tool_call_state` at all. */
  omitToolCallStateTable?: boolean;
  /** Simulate a schema with no `refinery_schema_history` ledger at all. */
  omitRefineryTable?: boolean;
}

export interface FixtureDbHandle {
  path: string;
  db: DatabaseSync;
  close: () => void;
}

export function buildFixtureDb(rows: FixtureRows = {}): FixtureDbHandle {
  const dir = mkdtempSync(join(tmpdir(), 'devin-session-sync-fixture-'));
  const path = join(dir, 'sessions.db');
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  createTables(db, rows);
  seedFixture(db, rows);
  return { path, db, close: () => closeFixture(db, dir) };
}

function closeFixture(db: DatabaseSync, dir: string): void {
  db.close();
  rmSync(dir, { recursive: true, force: true });
}

function createTables(db: DatabaseSync, rows: FixtureRows): void {
  if (!rows.omitRefineryTable) createRefineryTable(db);
  createSessionsTable(db);
  createMessageNodesTable(db);
  createPromptHistoryTable(db);
  if (!rows.omitToolCallStateTable) createToolCallStateTable(db);
}

function createRefineryTable(db: DatabaseSync): void {
  db.exec(`CREATE TABLE refinery_schema_history (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL,
    applied_on TEXT NOT NULL, checksum TEXT NOT NULL)`);
}

function createSessionsTable(db: DatabaseSync): void {
  db.exec(`CREATE TABLE sessions (
    id TEXT PRIMARY KEY, working_directory TEXT, backend_type TEXT, model TEXT,
    agent_mode TEXT, created_at INTEGER, last_activity_at INTEGER, title TEXT,
    main_chain_id TEXT, cogs_json TEXT, workspace_dirs TEXT, hidden INTEGER, metadata TEXT)`);
}

function createMessageNodesTable(db: DatabaseSync): void {
  db.exec(`CREATE TABLE message_nodes (
    row_id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
    node_id INTEGER NOT NULL, parent_node_id INTEGER, chat_message TEXT,
    created_at INTEGER, metadata TEXT, UNIQUE(session_id, node_id))`);
}

function createPromptHistoryTable(db: DatabaseSync): void {
  db.exec(`CREATE TABLE prompt_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT, timestamp INTEGER,
    session_id TEXT NOT NULL, is_shell INTEGER)`);
}

function createToolCallStateTable(db: DatabaseSync): void {
  db.exec(`CREATE TABLE tool_call_state (
    session_id TEXT NOT NULL, tool_call_id TEXT NOT NULL,
    tool_call_json TEXT, tool_call_update_json TEXT,
    PRIMARY KEY (session_id, tool_call_id))`);
}

function seedFixture(db: DatabaseSync, rows: FixtureRows): void {
  if (!rows.omitRefineryTable) {
    seedRefineryHistory(db, rows.refineryVersion ?? 16);
  }
  seedSessions(db, rows.sessions ?? []);
  seedMessageNodes(db, rows.messageNodes ?? []);
  seedPromptHistory(db, rows.promptHistory ?? []);
  if (!rows.omitToolCallStateTable) {
    seedToolCallStates(db, rows.toolCallStates ?? []);
  }
}

function seedRefineryHistory(db: DatabaseSync, maxVersion: number): void {
  const stmt = db.prepare(
    'INSERT INTO refinery_schema_history (version, name, applied_on, checksum) VALUES (?, ?, ?, ?)',
  );
  for (let version = 1; version <= maxVersion; version += 1) {
    stmt.run(version, `migration_${version}`, '2026-01-01T00:00:00Z', `checksum-${version}`);
  }
}

function seedSessions(db: DatabaseSync, sessions: DevinSessionRow[]): void {
  const stmt = db.prepare(`INSERT INTO sessions
    (id, working_directory, backend_type, model, agent_mode, created_at, last_activity_at,
     title, main_chain_id, cogs_json, workspace_dirs, hidden, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const s of sessions) {
    stmt.run(
      s.id,
      s.working_directory,
      s.backend_type,
      s.model,
      s.agent_mode,
      s.created_at,
      s.last_activity_at,
      s.title,
      s.main_chain_id,
      s.cogs_json,
      s.workspace_dirs,
      s.hidden,
      s.metadata,
    );
  }
}

function seedMessageNodes(db: DatabaseSync, nodes: DevinMessageNodeRow[]): void {
  const stmt = db.prepare(`INSERT INTO message_nodes
    (session_id, node_id, parent_node_id, chat_message, created_at, metadata)
    VALUES (?, ?, ?, ?, ?, ?)`);
  for (const n of nodes) {
    stmt.run(n.session_id, n.node_id, n.parent_node_id, n.chat_message, n.created_at, n.metadata);
  }
}

function seedPromptHistory(db: DatabaseSync, prompts: DevinPromptHistoryRow[]): void {
  const stmt = db.prepare(
    'INSERT INTO prompt_history (content, timestamp, session_id, is_shell) VALUES (?, ?, ?, ?)',
  );
  for (const p of prompts) {
    stmt.run(p.content, p.timestamp, p.session_id, p.is_shell);
  }
}

function seedToolCallStates(db: DatabaseSync, calls: DevinToolCallStateRow[]): void {
  const stmt = db.prepare(`INSERT INTO tool_call_state
    (session_id, tool_call_id, tool_call_json, tool_call_update_json) VALUES (?, ?, ?, ?)`);
  for (const c of calls) {
    stmt.run(c.session_id, c.tool_call_id, c.tool_call_json, c.tool_call_update_json);
  }
}
