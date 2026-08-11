/**
 * SQLite WASM Database Manager
 * Handles all database operations for the offline session dashboard
 */

import type { DashboardSession, Project, SessionMetrics, ToolExecution, SessionEvent } from '../types';

// SQLite WASM types
interface Sqlite3Static {
  sqlite3: {
    DB: new (filename: string, flags?: string) => SqliteDB;
  };
}

interface SqliteDB {
  exec(sql: string): void;
  selectObjects<T>(sql: string): T[];
  close(): void;
}

declare global {
  interface Window {
    sqlite3?: Sqlite3Static;
  }
}

export class DatabaseManager {
  private db: SqliteDB | null = null;
  private initialized = false;

  async initialize(dbPath: string = ':memory:'): Promise<void> {
    if (this.initialized) return;

    // Load SQLite WASM - type assertion to handle module structure
    const sqlite3Module = await import('@sqlite.org/sqlite-wasm');
    // @ts-ignore - sqlite3 property exists on the default export
    const sqlite3Api = sqlite3Module.default.sqlite3;

    this.db = new sqlite3Api.DB(dbPath, 'c');
    this.createTables();
    this.initialized = true;
  }

  private createTables(): void {
    if (!this.db) throw new Error('Database not initialized');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        session_count INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        source TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER NOT NULL,
        input_tokens INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0,
        total_tokens INTEGER DEFAULT 0,
        cost_usd REAL,
        model TEXT,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS tool_executions (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        tool_name TEXT NOT NULL,
        tool_type TEXT NOT NULL,
        target TEXT,
        success INTEGER DEFAULT 1,
        duration_ms INTEGER,
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

      CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);
      CREATE INDEX IF NOT EXISTS idx_tool_executions_session ON tool_executions(session_id);
      CREATE INDEX IF NOT EXISTS idx_session_events_session ON session_events(session_id);
    `);
  }

  // Project operations
  async createProject(project: Project): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');

    this.db.exec(`
      INSERT INTO projects (id, name, created_at, updated_at, session_count)
      VALUES ('${project.id}', '${project.name}', ${project.created_at}, ${project.updated_at}, ${project.session_count || 0})
    `);
  }

  async getProjects(): Promise<Project[]> {
    if (!this.db) throw new Error('Database not initialized');

    return this.db.selectObjects<Project>('SELECT * FROM projects ORDER BY updated_at DESC');
  }

  async getProject(id: string): Promise<Project | null> {
    if (!this.db) throw new Error('Database not initialized');

    const results = this.db.selectObjects<Project>(`SELECT * FROM projects WHERE id = '${id}'`);
    return results[0] || null;
  }

  async updateProjectTimestamp(id: string): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');

    this.db.exec(`
      UPDATE projects SET updated_at = ${Date.now()} WHERE id = '${id}'
    `);
  }

  async incrementSessionCount(projectId: string): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');

    this.db.exec(`
      UPDATE projects SET session_count = session_count + 1, updated_at = ${Date.now()} WHERE id = '${projectId}'
    `);
  }

  // Session operations
  async saveSession(session: DashboardSession): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');

    // Insert session
    this.db.exec(`
      INSERT INTO sessions (id, project_id, source, started_at, ended_at, input_tokens, output_tokens, total_tokens, cost_usd, model)
      VALUES (
        '${session.id}',
        '${session.project_id}',
        '${session.source}',
        ${session.started_at},
        ${session.ended_at},
        ${session.input_tokens},
        ${session.output_tokens},
        ${session.total_tokens},
        ${session.cost_usd !== undefined ? session.cost_usd : 'NULL'},
        ${session.model ? `'${session.model}'` : 'NULL'}
      )
    `);

    // Insert tool executions
    for (const tool of session.tool_executions) {
      this.db.exec(`
        INSERT INTO tool_executions (id, session_id, timestamp, tool_name, tool_type, target, success, duration_ms)
        VALUES (
          '${tool.id}',
          '${tool.session_id}',
          ${tool.timestamp},
          '${tool.tool_name}',
          '${tool.tool_type}',
          ${tool.target ? `'${tool.target}'` : 'NULL'},
          ${tool.success ? 1 : 0},
          ${tool.duration_ms !== undefined ? tool.duration_ms : 'NULL'}
        )
      `);
    }

    // Insert events
    for (const event of session.events) {
      const metadataJson = event.metadata ? JSON.stringify(event.metadata) : null;
      this.db.exec(`
        INSERT INTO session_events (id, session_id, timestamp, event_type, description, metadata)
        VALUES (
          '${event.id}',
          '${event.session_id}',
          ${event.timestamp},
          '${event.event_type}',
          ${event.description ? `'${event.description.replace(/'/g, "''")}'` : 'NULL'},
          ${metadataJson ? `'${metadataJson.replace(/'/g, "''")}'` : 'NULL'}
        )
      `);
    }

    // Update project session count
    await this.incrementSessionCount(session.project_id);
  }

  async getSessionsByProject(projectId: string): Promise<DashboardSession[]> {
    if (!this.db) throw new Error('Database not initialized');

    const sessions = this.db.selectObjects<DashboardSession>(
      `SELECT * FROM sessions WHERE project_id = '${projectId}' ORDER BY started_at DESC`
    );

    // Enrich sessions with tool executions and events
    return sessions.map(session => ({
      ...session,
      tool_executions: this.getToolExecutionsForSession(session.id),
      events: this.getSessionEventsForSession(session.id),
    }));
  }

  async getAllSessions(): Promise<DashboardSession[]> {
    if (!this.db) throw new Error('Database not initialized');

    const sessions = this.db.selectObjects<DashboardSession>('SELECT * FROM sessions ORDER BY started_at DESC');

    return sessions.map(session => ({
      ...session,
      tool_executions: this.getToolExecutionsForSession(session.id),
      events: this.getSessionEventsForSession(session.id),
    }));
  }

  async getSession(id: string): Promise<DashboardSession | null> {
    if (!this.db) throw new Error('Database not initialized');

    const results = this.db.selectObjects<DashboardSession>(`SELECT * FROM sessions WHERE id = '${id}'`);
    
    if (results.length === 0) return null;

    const session = results[0];
    return {
      ...session,
      tool_executions: this.getToolExecutionsForSession(session.id),
      events: this.getSessionEventsForSession(session.id),
    };
  }

  private getToolExecutionsForSession(sessionId: string): ToolExecution[] {
    if (!this.db) return [];

    return this.db.selectObjects<ToolExecution>(
      `SELECT * FROM tool_executions WHERE session_id = '${sessionId}' ORDER BY timestamp ASC`
    );
  }

  private getSessionEventsForSession(sessionId: string): SessionEvent[] {
    if (!this.db) return [];

    const events = this.db.selectObjects<{ 
      id: string; 
      session_id: string; 
      timestamp: number; 
      event_type: string; 
      description: string; 
      metadata: string;
    }>(
      `SELECT * FROM session_events WHERE session_id = '${sessionId}' ORDER BY timestamp ASC`
    );

    return events.map(event => ({
      ...event,
      metadata: event.metadata ? JSON.parse(event.metadata) : undefined,
    }));
  }

  // Metrics operations
  async getProjectMetrics(projectId: string): Promise<SessionMetrics> {
    if (!this.db) throw new Error('Database not initialized');

    const sessions = await this.getSessionsByProject(projectId);

    const metrics: SessionMetrics = {
      total_sessions: sessions.length,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cost_usd: 0,
      total_tool_executions: 0,
      avg_session_duration_ms: 0,
      models_used: [],
    };

    const modelsSet = new Set<string>();
    let totalDuration = 0;

    sessions.forEach(session => {
      metrics.total_input_tokens += session.input_tokens;
      metrics.total_output_tokens += session.output_tokens;
      metrics.total_cost_usd += session.cost_usd || 0;
      metrics.total_tool_executions += session.tool_executions.length;
      totalDuration += session.ended_at - session.started_at;
      
      if (session.model) {
        modelsSet.add(session.model);
      }
    });

    metrics.avg_session_duration_ms = sessions.length > 0 ? totalDuration / sessions.length : 0;
    metrics.models_used = Array.from(modelsSet);

    return metrics;
  }

  async deleteSession(id: string): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');

    // Get session to decrement project count
    const session = await this.getSession(id);
    
    this.db.exec(`DELETE FROM session_events WHERE session_id = '${id}'`);
    this.db.exec(`DELETE FROM tool_executions WHERE session_id = '${id}'`);
    this.db.exec(`DELETE FROM sessions WHERE id = '${id}'`);

    if (session) {
      this.db.exec(`
        UPDATE projects SET session_count = session_count - 1, updated_at = ${Date.now()} WHERE id = '${session.project_id}'
      `);
    }
  }

  async exportDatabase(): Promise<string> {
    if (!this.db) throw new Error('Database not initialized');

    // Export all data as JSON
    const projects = await this.getProjects();
    const sessions = await this.getAllSessions();

    const exportData = {
      exported_at: Date.now(),
      version: '1.0',
      projects,
      sessions,
    };

    return JSON.stringify(exportData, null, 2);
  }

  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.initialized = false;
    }
  }
}

export const dbManager = new DatabaseManager();
