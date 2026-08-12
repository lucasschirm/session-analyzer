/**
 * SQLite WASM Database Manager
 *
 * Wraps the sqlite3 oo1 API with parameterized queries. Runs inside the
 * database Web Worker where the OPFS VFS is available (sqlite3.oo1.OpfsDb);
 * falls back to an in-memory database when OPFS is unavailable. All SQL uses
 * bound parameters - user-controlled values are never interpolated into SQL.
 */

import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import type { Database } from '@sqlite.org/sqlite-wasm';
import type {
  DashboardSession,
  ModelTokenUsage,
  Project,
  SessionEvent,
  SessionMetrics,
  SessionTask,
  SubagentUsage,
  ToolExecution,
  TranscriptMessage,
} from '../types';

export type StorageBackend = 'opfs' | 'memory';

interface SessionRow {
  id: string;
  project_id: string;
  source: string;
  title: string;
  started_at: number;
  ended_at: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  total_tokens: number;
  cost_usd: number | null;
  model: string | null;
  model_usage: string | null;
  tasks: string | null;
  external_id: string | null;
  subagents: string | null;
  context_compactions: number;
  total_turns: number;
  files_read: number;
  files_written: number;
  agent_invocations: number;
}

interface EventRow {
  id: string;
  session_id: string;
  timestamp: number;
  event_type: string;
  description: string | null;
  metadata: string | null;
}

interface MessageRow {
  id: string;
  session_id: string;
  role: string;
  content: string;
  timestamp: number;
  uuid: string | null;
  parent_uuid: string | null;
}

interface ToolExecutionRow {
  id: string;
  session_id: string;
  timestamp: number;
  tool_name: string;
  tool_type: string;
  target: string | null;
  success: number;
  duration_ms: number | null;
  parameters: string | null;
  result: string | null;
}

export class DatabaseManager {
  private db: Database | null = null;
  private sqlite3: Awaited<ReturnType<typeof sqlite3InitModule>> | null = null;
  storage: StorageBackend = 'memory';

  /**
   * Initializes the SQLite WASM runtime and opens the database.
   * Uses OPFS persistence when the VFS is available (worker context with
   * SharedArrayBuffer), otherwise falls back to an in-memory database.
   */
  async initialize(filename = '/session-analyzer.sqlite3'): Promise<StorageBackend> {
    if (this.db) return this.storage;

    this.sqlite3 = await sqlite3InitModule();
    const sqlite3 = this.sqlite3;

    if (sqlite3.oo1.OpfsDb) {
      this.db = new sqlite3.oo1.OpfsDb(filename, 'c');
      this.storage = 'opfs';
    } else {
      this.db = new sqlite3.oo1.DB(':memory:', 'c');
      this.storage = 'memory';
    }

    this.db.exec('PRAGMA foreign_keys = ON;');
    this.createTables();
    this.migrate();
    return this.storage;
  }

  /**
   * Lightweight schema migration for columns added after a database file was
   * first created. `CREATE TABLE IF NOT EXISTS` is a no-op on an existing
   * table, so new columns must be added explicitly; SQLite has no
   * `ADD COLUMN IF NOT EXISTS`, so "duplicate column" failures (a fresh
   * database that already has the column from `createTables`) are expected
   * and swallowed - any other error is a real problem and is rethrown.
   */
  private migrate(): void {
    const db = this.requireDb();
    const alterations = [
      'ALTER TABLE sessions ADD COLUMN cache_creation_tokens INTEGER NOT NULL DEFAULT 0',
      'ALTER TABLE sessions ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0',
      'ALTER TABLE sessions ADD COLUMN model_usage TEXT',
      'ALTER TABLE sessions ADD COLUMN tasks TEXT',
      'ALTER TABLE sessions ADD COLUMN external_id TEXT',
      'ALTER TABLE sessions ADD COLUMN subagents TEXT',
      'ALTER TABLE tool_executions ADD COLUMN parameters TEXT',
      'ALTER TABLE tool_executions ADD COLUMN result TEXT',
      'ALTER TABLE session_messages ADD COLUMN uuid TEXT',
      'ALTER TABLE session_messages ADD COLUMN parent_uuid TEXT',
    ];
    for (const sql of alterations) {
      try {
        db.exec(sql);
      } catch (error) {
        if (!/duplicate column name/i.test((error as Error).message)) throw error;
      }
    }

    // Run after the alterations above so `external_id` is guaranteed to
    // exist on both fresh databases (added in createTables) and databases
    // upgraded by this migration.
    db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_external_id ON sessions(project_id, external_id)');
  }

  private createTables(): void {
    this.requireDb().exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        session_count INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        source TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        started_at INTEGER NOT NULL,
        ended_at INTEGER NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL,
        model TEXT,
        model_usage TEXT,
        tasks TEXT,
        external_id TEXT,
        subagents TEXT,
        context_compactions INTEGER NOT NULL DEFAULT 0,
        total_turns INTEGER NOT NULL DEFAULT 0,
        files_read INTEGER NOT NULL DEFAULT 0,
        files_written INTEGER NOT NULL DEFAULT 0,
        agent_invocations INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS tool_executions (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        tool_name TEXT NOT NULL,
        tool_type TEXT NOT NULL,
        target TEXT,
        success INTEGER NOT NULL DEFAULT 1,
        duration_ms INTEGER,
        parameters TEXT,
        result TEXT,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS session_events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        description TEXT,
        metadata TEXT,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS session_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        uuid TEXT,
        parent_uuid TEXT,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_tool_executions_session ON tool_executions(session_id);
      CREATE INDEX IF NOT EXISTS idx_session_events_session ON session_events(session_id);
      CREATE INDEX IF NOT EXISTS idx_session_messages_session ON session_messages(session_id);
    `);
  }

  private requireDb(): Database {
    if (!this.db) throw new Error('Database not initialized');
    return this.db;
  }

  // ==================== Project operations ====================

  createProject(project: Project): void {
    this.requireDb().exec({
      sql: `INSERT INTO projects (id, name, description, created_at, updated_at, session_count)
            VALUES (?, ?, ?, ?, ?, ?)`,
      bind: [
        project.id,
        project.name,
        project.description ?? '',
        project.created_at,
        project.updated_at,
        project.session_count || 0,
      ],
    });
  }

  getProjects(): Project[] {
    const rows = this.requireDb().selectObjects(
      'SELECT * FROM projects ORDER BY updated_at DESC'
    );
    return rows.map(rowToProject);
  }

  getProject(id: string): Project | null {
    const row = this.requireDb().selectObject('SELECT * FROM projects WHERE id = ?', [id]);
    return row ? rowToProject(row) : null;
  }

  updateProject(id: string, fields: { name?: string; description?: string }): void {
    const db = this.requireDb();
    const project = this.getProject(id);
    if (!project) throw new Error(`Project not found: ${id}`);

    db.exec({
      sql: 'UPDATE projects SET name = ?, description = ?, updated_at = ? WHERE id = ?',
      bind: [fields.name ?? project.name, fields.description ?? project.description, Date.now(), id],
    });
  }

  /** Deletes a project and cascades to its sessions and their child rows. */
  deleteProject(id: string): void {
    const db = this.requireDb();
    db.transaction(() => {
      const sessionIds = db.selectValues('SELECT id FROM sessions WHERE project_id = ?', [id]);
      for (const sessionId of sessionIds) {
        this.deleteSessionRows(String(sessionId));
      }
      db.exec({ sql: 'DELETE FROM sessions WHERE project_id = ?', bind: [id] });
      db.exec({ sql: 'DELETE FROM projects WHERE id = ?', bind: [id] });
    });
  }

  private touchProject(projectId: string): void {
    this.requireDb().exec({
      sql: 'UPDATE projects SET updated_at = ? WHERE id = ?',
      bind: [Date.now(), projectId],
    });
  }

  // ==================== Session operations ====================

  /** Inserts a brand new session row and bumps the project's session count. */
  saveSession(session: DashboardSession): void {
    const db = this.requireDb();
    db.transaction(() => {
      this.insertSessionRow(session);
      this.writeChildRows(session);
      db.exec({
        sql: 'UPDATE projects SET session_count = session_count + 1, updated_at = ? WHERE id = ?',
        bind: [Date.now(), session.project_id],
      });
    });
  }

  /**
   * Replaces an existing session's row and child rows in place (same `id`,
   * so URLs/links to it keep working), without touching the project's
   * session count. Used both for re-uploads of the same external session
   * (matched by `external_id`) and for folding in subagent data.
   */
  replaceSession(session: DashboardSession): void {
    const db = this.requireDb();
    db.transaction(() => {
      this.deleteSessionRows(session.id);
      db.exec({ sql: 'DELETE FROM sessions WHERE id = ?', bind: [session.id] });
      this.insertSessionRow(session);
      this.writeChildRows(session);
      this.touchProject(session.project_id);
    });
  }

  /**
   * Inserts `session` if its `external_id` isn't already present in this
   * project, otherwise replaces the existing row in place (reusing its
   * `id`) - so re-uploading the same session updates it instead of creating
   * a duplicate. Returns the effective session id (the existing one on
   * update, or `session.id` on insert).
   */
  upsertSessionByExternalId(session: DashboardSession): string {
    const existing = session.external_id
      ? this.findSessionByExternalId(session.project_id, session.external_id)
      : null;

    if (!existing) {
      this.saveSession(session);
      return session.id;
    }

    // Reuse the existing row's id (so links to it keep working), which
    // means every child row's `session_id` foreign key must be remapped too
    // - they were generated against `session.id`, not `existing.id`.
    this.replaceSession({
      ...session,
      id: existing.id,
      tool_executions: session.tool_executions.map((tool) => ({ ...tool, session_id: existing.id })),
      events: session.events.map((event) => ({ ...event, session_id: existing.id })),
      messages: session.messages.map((message) => ({ ...message, session_id: existing.id })),
    });
    return existing.id;
  }

  findSessionByExternalId(projectId: string, externalId: string): DashboardSession | null {
    const row = this.requireDb().selectObject(
      'SELECT * FROM sessions WHERE project_id = ? AND external_id = ?',
      [projectId, externalId]
    ) as unknown as SessionRow | undefined;
    return row ? this.hydrateSession(row) : null;
  }

  private insertSessionRow(session: DashboardSession): void {
    this.requireDb().exec({
      sql: `INSERT INTO sessions (
              id, project_id, source, title, started_at, ended_at,
              input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
              total_tokens, cost_usd, model, model_usage, tasks, external_id, subagents,
              context_compactions, total_turns, files_read, files_written, agent_invocations
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      bind: [
        session.id,
        session.project_id,
        session.source,
        session.title ?? '',
        session.started_at,
        session.ended_at,
        session.input_tokens,
        session.output_tokens,
        session.cache_creation_tokens ?? 0,
        session.cache_read_tokens ?? 0,
        session.total_tokens,
        session.cost_usd ?? null,
        session.model ?? null,
        session.models && session.models.length > 0 ? JSON.stringify(session.models) : null,
        session.tasks && session.tasks.length > 0 ? JSON.stringify(session.tasks) : null,
        session.external_id ?? null,
        session.subagents && session.subagents.length > 0 ? JSON.stringify(session.subagents) : null,
        session.context_compactions ?? 0,
        session.total_turns ?? 0,
        session.files_read ?? 0,
        session.files_written ?? 0,
        session.agent_invocations ?? 0,
      ],
    });
  }

  private writeChildRows(session: DashboardSession): void {
    const db = this.requireDb();

    for (const tool of session.tool_executions) {
      db.exec({
        sql: `INSERT INTO tool_executions
              (id, session_id, timestamp, tool_name, tool_type, target, success, duration_ms, parameters, result)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        bind: [
          tool.id,
          tool.session_id,
          tool.timestamp,
          tool.tool_name,
          tool.tool_type,
          tool.target ?? null,
          tool.success ? 1 : 0,
          tool.duration_ms ?? null,
          tool.parameters ? JSON.stringify(tool.parameters) : null,
          tool.result ?? null,
        ],
      });
    }

    for (const event of session.events) {
      db.exec({
        sql: `INSERT INTO session_events
              (id, session_id, timestamp, event_type, description, metadata)
              VALUES (?, ?, ?, ?, ?, ?)`,
        bind: [
          event.id,
          event.session_id,
          event.timestamp,
          event.event_type,
          event.description ?? null,
          event.metadata ? JSON.stringify(event.metadata) : null,
        ],
      });
    }

    for (const message of session.messages ?? []) {
      db.exec({
        sql: `INSERT INTO session_messages (id, session_id, role, content, timestamp, uuid, parent_uuid)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        bind: [
          message.id,
          message.session_id,
          message.role,
          message.content,
          message.timestamp,
          message.uuid ?? null,
          message.parent_uuid ?? null,
        ],
      });
    }
  }

  getSessionsByProject(projectId: string): DashboardSession[] {
    const rows = this.requireDb().selectObjects(
      'SELECT * FROM sessions WHERE project_id = ? ORDER BY started_at DESC',
      [projectId]
    ) as unknown as SessionRow[];
    return rows.map((row) => this.hydrateSession(row));
  }

  /**
   * Filters a project's sessions by title or by transcript message content
   * (case-insensitive substring match).
   */
  searchSessions(projectId: string, query: string): DashboardSession[] {
    const like = `%${query}%`;
    const rows = this.requireDb().selectObjects(
      `SELECT s.* FROM sessions s
       WHERE s.project_id = ?
         AND (s.title LIKE ? COLLATE NOCASE
              OR EXISTS (
                SELECT 1 FROM session_messages m
                WHERE m.session_id = s.id AND m.content LIKE ? COLLATE NOCASE
              ))
       ORDER BY s.started_at DESC`,
      [projectId, like, like]
    ) as unknown as SessionRow[];
    return rows.map((row) => this.hydrateSession(row));
  }

  getSession(id: string): DashboardSession | null {
    const row = this.requireDb().selectObject('SELECT * FROM sessions WHERE id = ?', [
      id,
    ]) as unknown as SessionRow | undefined;
    return row ? this.hydrateSession(row) : null;
  }

  deleteSession(id: string): void {
    const db = this.requireDb();
    db.transaction(() => {
      const row = db.selectObject('SELECT project_id FROM sessions WHERE id = ?', [id]);
      this.deleteSessionRows(id);
      db.exec({ sql: 'DELETE FROM sessions WHERE id = ?', bind: [id] });
      if (row) {
        db.exec({
          sql: 'UPDATE projects SET session_count = MAX(session_count - 1, 0), updated_at = ? WHERE id = ?',
          bind: [Date.now(), String(row.project_id)],
        });
      }
    });
  }

  private deleteSessionRows(sessionId: string): void {
    const db = this.requireDb();
    db.exec({ sql: 'DELETE FROM session_messages WHERE session_id = ?', bind: [sessionId] });
    db.exec({ sql: 'DELETE FROM session_events WHERE session_id = ?', bind: [sessionId] });
    db.exec({ sql: 'DELETE FROM tool_executions WHERE session_id = ?', bind: [sessionId] });
  }

  private hydrateSession(row: SessionRow): DashboardSession {
    const { model_usage, tasks, subagents, ...rest } = row;
    return {
      ...rest,
      cache_creation_tokens: rest.cache_creation_tokens ?? 0,
      cache_read_tokens: rest.cache_read_tokens ?? 0,
      cost_usd: rest.cost_usd ?? undefined,
      model: rest.model ?? undefined,
      external_id: rest.external_id ?? undefined,
      models: model_usage ? safeJsonParseArray<ModelTokenUsage>(model_usage) : [],
      source: rest.source as DashboardSession['source'],
      tool_executions: this.getToolExecutionsForSession(rest.id),
      events: this.getSessionEventsForSession(rest.id),
      messages: this.getMessagesForSession(rest.id),
      tasks: tasks ? safeJsonParseArray<SessionTask>(tasks) : [],
      subagents: subagents ? safeJsonParseArray<SubagentUsage>(subagents) : [],
    };
  }

  private getToolExecutionsForSession(sessionId: string): ToolExecution[] {
    const rows = this.requireDb().selectObjects(
      'SELECT * FROM tool_executions WHERE session_id = ? ORDER BY timestamp ASC',
      [sessionId]
    ) as unknown as ToolExecutionRow[];
    return rows.map((row) => ({
      ...row,
      success: Boolean(row.success),
      target: row.target ?? undefined,
      duration_ms: row.duration_ms ?? undefined,
      parameters: row.parameters ? safeJsonParse(row.parameters) : undefined,
      result: row.result ?? undefined,
    }));
  }

  private getSessionEventsForSession(sessionId: string): SessionEvent[] {
    const rows = this.requireDb().selectObjects(
      'SELECT * FROM session_events WHERE session_id = ? ORDER BY timestamp ASC',
      [sessionId]
    ) as unknown as EventRow[];
    return rows.map((row) => ({
      id: row.id,
      session_id: row.session_id,
      timestamp: row.timestamp,
      event_type: row.event_type,
      description: row.description ?? '',
      metadata: row.metadata ? safeJsonParse(row.metadata) : undefined,
    }));
  }

  private getMessagesForSession(sessionId: string): TranscriptMessage[] {
    const rows = this.requireDb().selectObjects(
      'SELECT * FROM session_messages WHERE session_id = ? ORDER BY timestamp ASC',
      [sessionId]
    ) as unknown as MessageRow[];
    return rows.map((row) => ({
      ...row,
      role: row.role as TranscriptMessage['role'],
      uuid: row.uuid ?? undefined,
      parent_uuid: row.parent_uuid ?? undefined,
    }));
  }

  // ==================== Metrics ====================

  getProjectMetrics(projectId: string): SessionMetrics {
    const sessions = this.getSessionsByProject(projectId);

    const metrics: SessionMetrics = {
      total_sessions: sessions.length,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cache_creation_tokens: 0,
      total_cache_read_tokens: 0,
      total_tokens: 0,
      total_cost_usd: 0,
      total_tool_executions: 0,
      avg_session_duration_ms: 0,
      models_used: [],
    };

    const models = new Set<string>();
    let totalDuration = 0;

    for (const session of sessions) {
      metrics.total_input_tokens += session.input_tokens;
      metrics.total_output_tokens += session.output_tokens;
      metrics.total_cache_creation_tokens += session.cache_creation_tokens ?? 0;
      metrics.total_cache_read_tokens += session.cache_read_tokens ?? 0;
      metrics.total_tokens += session.total_tokens;
      metrics.total_cost_usd += session.cost_usd ?? 0;
      metrics.total_tool_executions += session.tool_executions.length;
      totalDuration += Math.max(0, session.ended_at - session.started_at);
      if (session.model) models.add(session.model);
    }

    metrics.avg_session_duration_ms = sessions.length > 0 ? totalDuration / sessions.length : 0;
    metrics.models_used = Array.from(models);
    return metrics;
  }

  // ==================== Export ====================

  /** Serializes the whole database file as bytes (a valid SQLite file). */
  exportDatabase(): Uint8Array {
    const db = this.requireDb();
    const sqlite3 = this.sqlite3;
    if (!sqlite3 || !db.pointer) throw new Error('Database not initialized');
    return sqlite3.capi.sqlite3_js_db_export(db.pointer);
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

function rowToProject(row: Record<string, unknown>): Project {
  return {
    id: String(row.id),
    name: String(row.name),
    description: typeof row.description === 'string' ? row.description : '',
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
    session_count: Number(row.session_count ?? 0),
  };
}

function safeJsonParseArray<T>(value: string): T[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function safeJsonParse(value: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}
