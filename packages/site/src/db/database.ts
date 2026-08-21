/**
 * SQLite WASM Database Manager
 *
 * Wraps the sqlite3 oo1 API with parameterized queries. Runs inside the
 * database Web Worker where the OPFS VFS is available (sqlite3.oo1.OpfsDb);
 * falls back to an in-memory database when OPFS is unavailable or already
 * locked by another browser tab. All SQL uses bound parameters - user-
 * controlled values are never interpolated into SQL.
 */

import type { Database } from '@sqlite.org/sqlite-wasm';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import type {
  Connection,
  DashboardSession,
  ModelTokenUsage,
  PasskeyState,
  Project,
  ProjectSyncStatus,
  SessionEvent,
  SessionFileRecord,
  SessionMetrics,
  SessionStub,
  SessionSyncStatus,
  SessionTask,
  StoredS3Credentials,
  SubagentUsage,
  SyncManifest,
  ToolExecution,
  TranscriptMessage,
} from '../types';

export type StorageBackend = 'opfs' | 'memory';
export type FallbackReason = 'locked' | 'unsupported';

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
  result_uuid: string | null;
}

interface CapiLike {
  readonly SQLITE_BUSY: number;
  readonly SQLITE_IOERR: number;
  readonly SQLITE_LOCKED: number;
}

const COLUMN_MIGRATIONS = [
  'ALTER TABLE sessions ADD COLUMN cache_creation_tokens INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE sessions ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE sessions ADD COLUMN model_usage TEXT',
  'ALTER TABLE sessions ADD COLUMN tasks TEXT',
  'ALTER TABLE sessions ADD COLUMN external_id TEXT',
  'ALTER TABLE sessions ADD COLUMN subagents TEXT',
  'ALTER TABLE tool_executions ADD COLUMN parameters TEXT',
  'ALTER TABLE tool_executions ADD COLUMN result TEXT',
  'ALTER TABLE tool_executions ADD COLUMN result_uuid TEXT',
  'ALTER TABLE session_messages ADD COLUMN uuid TEXT',
  'ALTER TABLE session_messages ADD COLUMN parent_uuid TEXT',
  'ALTER TABLE projects ADD COLUMN readable_id TEXT',
  'ALTER TABLE projects ADD COLUMN sync_status TEXT',
  'ALTER TABLE projects ADD COLUMN connection_id TEXT',
  'ALTER TABLE sessions ADD COLUMN sync_session_id TEXT',
  'ALTER TABLE sessions ADD COLUMN sync_status TEXT',
  'ALTER TABLE sessions ADD COLUMN sync_details TEXT',
  'ALTER TABLE sessions ADD COLUMN sync_schema_version INTEGER',
  'ALTER TABLE sessions ADD COLUMN sync_harness TEXT',
  'ALTER TABLE sessions ADD COLUMN sync_harness_version TEXT',
  'ALTER TABLE sessions ADD COLUMN sync_manifest_model TEXT',
  'ALTER TABLE sessions ADD COLUMN sync_started_at TEXT',
  'ALTER TABLE sessions ADD COLUMN sync_ended_at TEXT',
  'ALTER TABLE sessions ADD COLUMN sync_duration_ms INTEGER',
  'ALTER TABLE sessions ADD COLUMN sync_end_reason TEXT',
  'ALTER TABLE sessions ADD COLUMN sync_engine_version TEXT',
  'ALTER TABLE sessions ADD COLUMN sync_plugin_version TEXT',
  'ALTER TABLE sessions ADD COLUMN sync_transcripts_captured INTEGER',
  'ALTER TABLE sessions ADD COLUMN sync_main_transcript_relative_path TEXT',
  'ALTER TABLE sessions ADD COLUMN sync_artifacts TEXT',
  'ALTER TABLE sessions ADD COLUMN sync_runs TEXT',
] as const;

const LOCKED_MESSAGE_RE =
  /NoModificationAllowedError|Access Handles cannot|busy|locked|already in use/i;

function isLockedMessage(name: unknown, message: unknown): boolean {
  if (typeof message === 'string' && LOCKED_MESSAGE_RE.test(message)) {
    return true;
  }
  return name === 'NoModificationAllowedError' || name === 'InvalidStateError';
}

/**
 * Detects an OPFS file-locked error from the sqlite-wasm opener. The exact
 * exception varies by browser and sqlite-wasm release: it may surface as an
 * SQLite3Error with resultCode SQLITE_BUSY/SQLITE_IOERR/SQLITE_LOCKED, a
 * wrapped DOMException named NoModificationAllowedError, or an I/O error whose
 * message mentions locking. We treat any of those as "already open elsewhere".
 */
function isOpfsLockedError(error: unknown, capi: CapiLike): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { resultCode?: unknown; name?: unknown; message?: unknown; cause?: unknown };
  const resultCode = typeof e.resultCode === 'number' ? e.resultCode : undefined;
  if (resultCode !== undefined) {
    const primary = resultCode & 0xff;
    if (
      primary === capi.SQLITE_BUSY ||
      primary === capi.SQLITE_LOCKED ||
      primary === capi.SQLITE_IOERR
    ) {
      return true;
    }
  }
  if (isLockedMessage(e.name, e.message)) return true;
  const cause = e.cause;
  if (cause && typeof cause === 'object') {
    const c = cause as { name?: unknown; message?: unknown };
    if (isLockedMessage(c.name, c.message)) return true;
  }
  return false;
}

/** Parses an ISO-8601 or numeric timestamp string into milliseconds. */
function parseTimestamp(value: string | number): number {
  if (typeof value === 'number') return value;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number(value) || 0 : parsed;
}

function safeJsonParse<T>(value: string): T | undefined {
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

function safeJsonParseArray<T>(value: string): T[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function safeJsonStringify(value: unknown[]): string | null {
  return value.length > 0 ? JSON.stringify(value) : null;
}

function safeJsonLength(value: string | null | undefined): number {
  if (!value) return 0;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

function isProjectSyncStatus(value: unknown): value is ProjectSyncStatus {
  return value === 'in_sync' || value === 'syncing';
}

/** Slugifies a project name and resolves collisions with the supplied set. */
function generateReadableId(name: string, used: Set<string>): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') || 'project';
  if (!used.has(base)) return base;
  let counter = 2;
  while (used.has(`${base}-${counter}`)) counter++;
  return `${base}-${counter}`;
}

export class DatabaseManager {
  private db: Database | null = null;
  protected sqlite3: Awaited<ReturnType<typeof sqlite3InitModule>> | null = null;
  storage: StorageBackend = 'memory';
  fallbackReason?: FallbackReason;

  /**
   * Initializes the SQLite WASM runtime and opens the database.
   * Uses OPFS persistence when the VFS is available. If the OPFS file is
   * already locked by another tab, or OPFS is unsupported, falls back to an
   * in-memory database and records the reason on `fallbackReason`.
   */
  async initialize(filename = '/session-analyzer.sqlite3'): Promise<StorageBackend> {
    if (this.db) return this.storage;

    if (!this.sqlite3) this.sqlite3 = await sqlite3InitModule();
    const sqlite3 = this.sqlite3;

    if (sqlite3.oo1.OpfsDb) {
      try {
        this.db = new sqlite3.oo1.OpfsDb(filename, 'c');
        this.storage = 'opfs';
      } catch (error) {
        if (isOpfsLockedError(error, sqlite3.capi)) {
          this.fallbackReason = 'locked';
        } else {
          throw error;
        }
        this.db = new sqlite3.oo1.DB(':memory:', 'c');
        this.storage = 'memory';
      }
    } else {
      this.db = new sqlite3.oo1.DB(':memory:', 'c');
      this.storage = 'memory';
      this.fallbackReason = 'unsupported';
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
    for (const sql of COLUMN_MIGRATIONS) {
      try {
        db.exec(sql);
      } catch (error) {
        if (!/duplicate column name/i.test((error as Error).message)) throw error;
      }
    }
    this.createSyncIndexes(db);
    this.backfillReadableIds();
  }

  private createSyncIndexes(db: Database): void {
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_sessions_external_id ON sessions(project_id, external_id)',
    );
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_readable_id ON projects(readable_id)');
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_sessions_sync_session ON sessions(project_id, sync_session_id)',
    );
    db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_sync_status ON sessions(sync_status)');
  }

  private createTables(): void {
    this.createProjectsTable();
    this.createSessionsTable();
    this.createToolExecutionsTable();
    this.createSessionEventsTable();
    this.createSessionMessagesTable();
    this.createConnectionsTable();
    this.createS3CredentialsTable();
    this.createPasskeyStateTable();
    this.createSessionFilesTable();
    this.createIndexes();
  }

  private createProjectsTable(): void {
    this.requireDb().exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        session_count INTEGER NOT NULL DEFAULT 0
      );
    `);
  }

  private createSessionsTable(): void {
    this.requireDb().exec(`
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
    `);
  }

  private createToolExecutionsTable(): void {
    this.requireDb().exec(`
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
        result_uuid TEXT,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
    `);
  }

  private createSessionEventsTable(): void {
    this.requireDb().exec(`
      CREATE TABLE IF NOT EXISTS session_events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        description TEXT,
        metadata TEXT,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
    `);
  }

  private createSessionMessagesTable(): void {
    this.requireDb().exec(`
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
    `);
  }

  private createConnectionsTable(): void {
    this.requireDb().exec(`
      CREATE TABLE IF NOT EXISTS connections (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        storage_type TEXT NOT NULL,
        sync_only_new INTEGER NOT NULL DEFAULT 0,
        last_sync_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  private createS3CredentialsTable(): void {
    this.requireDb().exec(`
      CREATE TABLE IF NOT EXISTS connection_s3_credentials (
        connection_id TEXT PRIMARY KEY REFERENCES connections(id) ON DELETE CASCADE,
        region TEXT NOT NULL,
        endpoint TEXT,
        bucket TEXT NOT NULL,
        access_key_id TEXT NOT NULL,
        secret_access_key_ct TEXT NOT NULL,
        secret_access_key_iv TEXT NOT NULL,
        session_token_ct TEXT,
        session_token_iv TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  private createPasskeyStateTable(): void {
    this.requireDb().exec(`
      CREATE TABLE IF NOT EXISTS passkey_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        kdf_salt TEXT NOT NULL,
        verifier_iv TEXT NOT NULL,
        verifier_ct TEXT NOT NULL,
        webauthn_credential_id TEXT,
        webauthn_wrapped_key TEXT,
        webauthn_expires_at INTEGER,
        created_at INTEGER NOT NULL
      );
    `);
  }

  private createSessionFilesTable(): void {
    this.requireDb().exec(`
      CREATE TABLE IF NOT EXISTS session_files (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        scope TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        size INTEGER NOT NULL,
        status TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (session_id, path)
      );
    `);
  }

  private createIndexes(): void {
    const db = this.requireDb();
    db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at DESC)');
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_tool_executions_session ON tool_executions(session_id)',
    );
    db.exec('CREATE INDEX IF NOT EXISTS idx_session_events_session ON session_events(session_id)');
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_session_messages_session ON session_messages(session_id)',
    );
  }

  private requireDb(): Database {
    if (!this.db) throw new Error('Database not initialized');
    return this.db;
  }

  // ==================== Project operations ====================

  /** Inserts a new project record. */
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

  /** Lists all projects, most recently updated first. */
  getProjects(): Project[] {
    const rows = this.requireDb().selectObjects('SELECT * FROM projects ORDER BY updated_at DESC');
    return rows.map((row) => rowToProject(row as Record<string, unknown>));
  }

  /** Loads a single project by its primary id. */
  getProject(id: string): Project | null {
    const row = this.requireDb().selectObject('SELECT * FROM projects WHERE id = ?', [id]);
    return row ? rowToProject(row as Record<string, unknown>) : null;
  }

  /** Updates a project's name and/or description. */
  updateProject(id: string, fields: { name?: string; description?: string }): void {
    const db = this.requireDb();
    const project = this.getProject(id);
    if (!project) throw new Error(`Project not found: ${id}`);

    db.exec({
      sql: 'UPDATE projects SET name = ?, description = ?, updated_at = ? WHERE id = ?',
      bind: [
        fields.name ?? project.name,
        fields.description ?? project.description,
        Date.now(),
        id,
      ],
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

  /** Looks up a project by its local readable id (URL-safe slug). */
  getProjectByReadableId(readableId: string): Project | null {
    const row = this.requireDb().selectObject('SELECT * FROM projects WHERE readable_id = ?', [
      readableId,
    ]);
    return row ? rowToProject(row as Record<string, unknown>) : null;
  }

  /** Sets the sync state of a project. */
  setProjectSyncStatus(projectId: string, status: ProjectSyncStatus): void {
    this.requireDb().exec({
      sql: 'UPDATE projects SET sync_status = ? WHERE id = ?',
      bind: [status, projectId],
    });
  }

  /**
   * Generates and assigns readable ids to any projects that do not yet have
   * one. Existing readable ids are never reassigned. Collision handling uses a
   * deterministic `-2`, `-3`, ... suffix scheme.
   */
  backfillReadableIds(): void {
    const db = this.requireDb();
    const rows = db.selectObjects(
      'SELECT id, name, readable_id FROM projects ORDER BY created_at ASC',
    ) as unknown as { id: string; name: string; readable_id: string | null }[];
    const used = new Set<string>();
    for (const row of rows) {
      if (row.readable_id) used.add(row.readable_id);
    }
    for (const row of rows) {
      if (row.readable_id) continue;
      const slug = generateReadableId(row.name, used);
      db.exec({
        sql: 'UPDATE projects SET readable_id = ?, updated_at = ? WHERE id = ?',
        bind: [slug, Date.now(), row.id],
      });
      used.add(slug);
    }
  }

  // ==================== Connection operations ====================

  /** Creates a new S3 storage connection. */
  createConnection(connection: Connection): void {
    this.requireDb().exec({
      sql: `INSERT INTO connections (id, name, storage_type, sync_only_new, last_sync_at, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      bind: [
        connection.id,
        connection.name,
        connection.storage_type,
        connection.sync_only_new ? 1 : 0,
        connection.last_sync_at ?? null,
        connection.created_at,
        connection.updated_at,
      ],
    });
  }

  /** Updates the mutable fields of an existing connection. */
  updateConnection(
    connectionId: string,
    fields: Partial<Pick<Connection, 'name' | 'sync_only_new' | 'last_sync_at'>>,
  ): void {
    const existing = this.getConnection(connectionId);
    if (!existing) throw new Error(`Connection not found: ${connectionId}`);
    const db = this.requireDb();
    db.exec({
      sql: 'UPDATE connections SET name = ?, sync_only_new = ?, last_sync_at = ?, updated_at = ? WHERE id = ?',
      bind: [
        fields.name ?? existing.name,
        fields.sync_only_new === undefined
          ? Number(existing.sync_only_new)
          : Number(fields.sync_only_new),
        fields.last_sync_at ?? existing.last_sync_at ?? null,
        Date.now(),
        connectionId,
      ],
    });
  }

  /** Deletes a connection; S3 credentials cascade. */
  deleteConnection(connectionId: string): void {
    this.requireDb().exec({
      sql: 'DELETE FROM connections WHERE id = ?',
      bind: [connectionId],
    });
  }

  /** Lists all connections, newest first. */
  getConnections(): Connection[] {
    const rows = this.requireDb().selectObjects(
      'SELECT * FROM connections ORDER BY created_at DESC',
    );
    return rows.map((row) => rowToConnection(row as Record<string, unknown>));
  }

  private getConnection(id: string): Connection | null {
    const row = this.requireDb().selectObject('SELECT * FROM connections WHERE id = ?', [id]);
    return row ? rowToConnection(row as Record<string, unknown>) : null;
  }

  /** Stores (or replaces) encrypted S3 credentials for a connection. */
  saveS3Credentials(credentials: StoredS3Credentials): void {
    this.requireDb().exec({
      sql: `INSERT INTO connection_s3_credentials (
        connection_id, region, endpoint, bucket, access_key_id,
        secret_access_key_ct, secret_access_key_iv, session_token_ct, session_token_iv,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(connection_id) DO UPDATE SET
        region = excluded.region, endpoint = excluded.endpoint, bucket = excluded.bucket,
        access_key_id = excluded.access_key_id, secret_access_key_ct = excluded.secret_access_key_ct,
        secret_access_key_iv = excluded.secret_access_key_iv, session_token_ct = excluded.session_token_ct,
        session_token_iv = excluded.session_token_iv, updated_at = excluded.updated_at`,
      bind: [
        credentials.connection_id,
        credentials.region,
        credentials.endpoint ?? null,
        credentials.bucket,
        credentials.access_key_id,
        credentials.secret_access_key_ct,
        credentials.secret_access_key_iv,
        credentials.session_token_ct ?? null,
        credentials.session_token_iv ?? null,
        credentials.created_at,
        credentials.updated_at,
      ],
    });
  }

  /** Returns the encrypted S3 credentials for a connection, if any. */
  getS3Credentials(connectionId: string): StoredS3Credentials | null {
    const row = this.requireDb().selectObject(
      'SELECT * FROM connection_s3_credentials WHERE connection_id = ?',
      [connectionId],
    );
    return row ? rowToS3Credentials(row as Record<string, unknown>) : null;
  }

  /** Wipes all stored S3 credentials and passkey state (forgot-passkey flow). */
  deleteAllCredentials(): void {
    const db = this.requireDb();
    db.exec('DELETE FROM connection_s3_credentials');
    db.exec('DELETE FROM passkey_state');
  }

  // ==================== Passkey operations ====================

  /** Returns the singleton passkey vault state, if one exists. */
  getPasskeyState(): PasskeyState | null {
    const row = this.requireDb().selectObject('SELECT * FROM passkey_state WHERE id = 1');
    return row ? rowToPasskeyState(row as Record<string, unknown>) : null;
  }

  /** Saves or replaces the singleton passkey vault state. */
  savePasskeyState(state: PasskeyState): void {
    this.requireDb().exec({
      sql: `INSERT INTO passkey_state (
        id, kdf_salt, verifier_iv, verifier_ct, webauthn_credential_id,
        webauthn_wrapped_key, webauthn_expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        kdf_salt = excluded.kdf_salt, verifier_iv = excluded.verifier_iv,
        verifier_ct = excluded.verifier_ct, webauthn_credential_id = excluded.webauthn_credential_id,
        webauthn_wrapped_key = excluded.webauthn_wrapped_key,
        webauthn_expires_at = excluded.webauthn_expires_at, created_at = excluded.created_at`,
      bind: [
        state.id,
        state.kdf_salt,
        state.verifier_iv,
        state.verifier_ct,
        state.webauthn_credential_id ?? null,
        state.webauthn_wrapped_key ?? null,
        state.webauthn_expires_at ?? null,
        state.created_at,
      ],
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
      tool_executions: session.tool_executions.map((tool) => ({
        ...tool,
        session_id: existing.id,
      })),
      events: session.events.map((event) => ({ ...event, session_id: existing.id })),
      messages: session.messages.map((message) => ({ ...message, session_id: existing.id })),
    });
    return existing.id;
  }

  findSessionByExternalId(projectId: string, externalId: string): DashboardSession | null {
    const row = this.requireDb().selectObject(
      'SELECT * FROM sessions WHERE project_id = ? AND external_id = ?',
      [projectId, externalId],
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
        session.subagents && session.subagents.length > 0
          ? JSON.stringify(session.subagents)
          : null,
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
              (id, session_id, timestamp, tool_name, tool_type, target, success, duration_ms, parameters, result, result_uuid)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          tool.result_uuid ?? null,
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
      [projectId],
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
      [projectId, like, like],
    ) as unknown as SessionRow[];
    return rows.map((row) => this.hydrateSession(row));
  }

  getSession(id: string): DashboardSession | null {
    const row = this.requireDb().selectObject('SELECT * FROM sessions WHERE id = ?', [
      id,
    ]) as unknown as SessionRow | undefined;
    return row ? this.hydrateSession(row) : null;
  }

  /** Finds a session by its remote sync id within a project. */
  getSessionBySyncId(projectId: string, syncSessionId: string): DashboardSession | null {
    const row = this.requireDb().selectObject(
      'SELECT id FROM sessions WHERE project_id = ? AND sync_session_id = ?',
      [projectId, syncSessionId],
    ) as unknown as { id: string } | undefined;
    return row ? this.getSession(row.id) : null;
  }

  /**
   * Inserts a sync stub or updates an existing session's stub-relevant
   * columns. Parsed-content columns (metrics, child rows, transcript) are
   * never overwritten by this call - the contract with the real parse path
   * is that `sync_session_id`, `sync_status`, and the manifest mirror
   * columns are left intact when the full parse lands later.
   */
  upsertSessionStub(stub: SessionStub): void {
    const db = this.requireDb();
    const existingById = db.selectObject('SELECT id FROM sessions WHERE id = ?', [
      stub.id,
    ]) as unknown as { id: string } | undefined;
    if (existingById) {
      this.updateStubColumns(existingById.id, stub);
      return;
    }
    const existingBySync = db.selectObject(
      'SELECT id FROM sessions WHERE project_id = ? AND sync_session_id = ?',
      [stub.project_id, stub.sync_session_id],
    ) as unknown as { id: string } | undefined;
    if (existingBySync) {
      this.updateStubColumns(existingBySync.id, stub);
      return;
    }
    this.insertSessionStub(stub);
  }

  private static sessionStubBindParams(stub: SessionStub): (string | number | null)[] {
    return [
      stub.id,
      stub.project_id,
      stub.source,
      stub.title,
      parseTimestamp(stub.started_at),
      parseTimestamp(stub.ended_at),
      stub.input_tokens ?? 0,
      stub.output_tokens ?? 0,
      stub.cache_creation_tokens ?? 0,
      stub.cache_read_tokens ?? 0,
      stub.total_tokens ?? 0,
      stub.cost_usd ?? null,
      stub.model ?? null,
      stub.model_usage ?? null,
      stub.tasks ?? null,
      stub.external_id ?? null,
      stub.subagents ?? null,
      stub.context_compactions ?? 0,
      stub.total_turns ?? 0,
      stub.files_read ?? 0,
      stub.files_written ?? 0,
      stub.agent_invocations ?? 0,
      stub.sync_session_id,
      stub.sync_status,
    ];
  }

  private insertSessionStub(stub: SessionStub): void {
    this.requireDb().exec({
      sql: `INSERT INTO sessions (
        id, project_id, source, title, started_at, ended_at,
        input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, total_tokens,
        cost_usd, model, model_usage, tasks, external_id, subagents,
        context_compactions, total_turns, files_read, files_written, agent_invocations,
        sync_session_id, sync_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      bind: DatabaseManager.sessionStubBindParams(stub),
    });
  }

  private updateStubColumns(sessionId: string, stub: SessionStub): void {
    this.requireDb().exec({
      sql: `UPDATE sessions SET
        source = ?, title = ?, started_at = ?, ended_at = ?, sync_session_id = ?, sync_status = ?
        WHERE id = ?`,
      bind: [
        stub.source,
        stub.title,
        parseTimestamp(stub.started_at),
        parseTimestamp(stub.ended_at),
        stub.sync_session_id,
        stub.sync_status,
        sessionId,
      ],
    });
  }

  /** Updates only the sync status (and optional detail text) of a session. */
  setSessionSyncStatus(sessionId: string, status: SessionSyncStatus, details?: string): void {
    this.requireDb().exec({
      sql: 'UPDATE sessions SET sync_status = ?, sync_details = ? WHERE id = ?',
      bind: [status, details ?? null, sessionId],
    });
  }

  /** Writes all sync mirror columns from a manifest onto a session row. */
  updateSessionManifest(sessionId: string, manifest: SyncManifest): void {
    if (!this.getSession(sessionId)) throw new Error(`Session not found: ${sessionId}`);
    this.requireDb().exec({
      sql: `UPDATE sessions SET
        sync_session_id = ?, sync_schema_version = ?, sync_harness = ?, sync_harness_version = ?,
        sync_manifest_model = ?, sync_started_at = ?, sync_ended_at = ?, sync_duration_ms = ?,
        sync_end_reason = ?, sync_engine_version = ?, sync_plugin_version = ?,
        sync_transcripts_captured = ?, sync_main_transcript_relative_path = ?, sync_artifacts = ?,
        sync_runs = ?
        WHERE id = ?`,
      bind: [
        manifest.sessionId,
        manifest.schemaVersion,
        manifest.harness ?? null,
        manifest.harnessVersion ?? null,
        manifest.model ?? null,
        manifest.startedAt ?? null,
        manifest.endedAt ?? null,
        manifest.durationMs ?? null,
        manifest.endReason ?? null,
        manifest.syncVersion ?? null,
        manifest.pluginVersion ?? null,
        Number(manifest.transcriptsCaptured ?? 0),
        manifest.mainTranscriptRelativePath ?? null,
        safeJsonStringify(manifest.artifacts),
        safeJsonStringify(manifest.syncRuns),
        sessionId,
      ],
    });
  }

  /** Returns the number of recorded sync runs for a session. */
  getSyncRunCount(sessionId: string): number {
    const row = this.requireDb().selectObject('SELECT sync_runs FROM sessions WHERE id = ?', [
      sessionId,
    ]) as unknown as { sync_runs: string | null } | undefined;
    return safeJsonLength(row?.sync_runs);
  }

  /** Marks every pending/processing session in a project as failed. */
  failStaleSessions(projectId: string, details: string): void {
    this.requireDb().exec({
      sql: `UPDATE sessions
            SET sync_status = 'failed', sync_details = ?
            WHERE project_id = ? AND sync_status IN ('pending', 'processing')`,
      bind: [details, projectId],
    });
  }

  /** Deletes a session and decrements the project counter. */
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
      [sessionId],
    ) as unknown as ToolExecutionRow[];
    return rows.map((row) => ({
      ...row,
      success: Boolean(row.success),
      target: row.target ?? undefined,
      duration_ms: row.duration_ms ?? undefined,
      parameters: row.parameters ? safeJsonParse(row.parameters) : undefined,
      result: row.result ?? undefined,
      result_uuid: row.result_uuid ?? undefined,
    }));
  }

  private getSessionEventsForSession(sessionId: string): SessionEvent[] {
    const rows = this.requireDb().selectObjects(
      'SELECT * FROM session_events WHERE session_id = ? ORDER BY timestamp ASC',
      [sessionId],
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
      [sessionId],
    ) as unknown as MessageRow[];
    return rows.map((row) => ({
      ...row,
      role: row.role as TranscriptMessage['role'],
      uuid: row.uuid ?? undefined,
      parent_uuid: row.parent_uuid ?? undefined,
    }));
  }

  // ==================== Sync boot reconciliation ====================

  /**
   * Crash-recovery primitive: set every 'syncing' project to 'in_sync' and
   * every 'pending'/'processing' session to 'failed'. Runs as one atomic
   * transaction spanning the whole database.
   */
  reconcileSyncStates(sessionDetails: string): void {
    const db = this.requireDb();
    db.transaction(() => {
      db.exec("UPDATE projects SET sync_status = 'in_sync' WHERE sync_status = 'syncing'");
      db.exec({
        sql: "UPDATE sessions SET sync_status = 'failed', sync_details = ? WHERE sync_status IN ('pending', 'processing')",
        bind: [sessionDetails],
      });
    });
  }

  // ==================== Session file operations ====================

  /** Lists all file records for a session, ordered by path. */
  getSessionFiles(sessionId: string): SessionFileRecord[] {
    const rows = this.requireDb().selectObjects(
      'SELECT * FROM session_files WHERE session_id = ? ORDER BY path',
      [sessionId],
    );
    return rows.map((row) => rowToSessionFile(row as Record<string, unknown>));
  }

  /** Inserts or updates a session file record on the (session_id, path) key. */
  upsertSessionFile(file: SessionFileRecord): void {
    this.requireDb().exec({
      sql: `INSERT INTO session_files (
        id, project_id, session_id, path, scope, sha256, size, status, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, path) DO UPDATE SET
        scope = excluded.scope, sha256 = excluded.sha256, size = excluded.size,
        status = excluded.status, updated_at = excluded.updated_at`,
      bind: [
        file.id,
        file.project_id,
        file.session_id,
        file.path,
        file.scope,
        file.sha256,
        file.size,
        file.status,
        file.updated_at,
      ],
    });
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
    readable_id: typeof row.readable_id === 'string' ? row.readable_id : undefined,
    sync_status: isProjectSyncStatus(row.sync_status) ? row.sync_status : undefined,
    connection_id: typeof row.connection_id === 'string' ? row.connection_id : undefined,
  };
}

function rowToConnection(row: Record<string, unknown>): Connection {
  return {
    id: String(row.id),
    name: String(row.name),
    storage_type: (typeof row.storage_type === 'string'
      ? row.storage_type
      : 's3') as Connection['storage_type'],
    sync_only_new: Number(row.sync_only_new) === 1,
    last_sync_at: typeof row.last_sync_at === 'number' ? row.last_sync_at : undefined,
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

function rowToS3Credentials(row: Record<string, unknown>): StoredS3Credentials {
  return {
    connection_id: String(row.connection_id),
    region: String(row.region),
    endpoint: typeof row.endpoint === 'string' ? row.endpoint : undefined,
    bucket: String(row.bucket),
    access_key_id: String(row.access_key_id),
    secret_access_key_ct: String(row.secret_access_key_ct),
    secret_access_key_iv: String(row.secret_access_key_iv),
    session_token_ct: typeof row.session_token_ct === 'string' ? row.session_token_ct : undefined,
    session_token_iv: typeof row.session_token_iv === 'string' ? row.session_token_iv : undefined,
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

function rowToPasskeyState(row: Record<string, unknown>): PasskeyState {
  return {
    id: 1,
    kdf_salt: String(row.kdf_salt),
    verifier_iv: String(row.verifier_iv),
    verifier_ct: String(row.verifier_ct),
    webauthn_credential_id:
      typeof row.webauthn_credential_id === 'string' ? row.webauthn_credential_id : undefined,
    webauthn_wrapped_key:
      typeof row.webauthn_wrapped_key === 'string' ? row.webauthn_wrapped_key : undefined,
    webauthn_expires_at:
      typeof row.webauthn_expires_at === 'number' ? row.webauthn_expires_at : undefined,
    created_at: Number(row.created_at),
  };
}

function rowToSessionFile(row: Record<string, unknown>): SessionFileRecord {
  return {
    id: String(row.id),
    project_id: String(row.project_id),
    session_id: String(row.session_id),
    path: String(row.path),
    scope: row.scope as SessionFileRecord['scope'],
    sha256: String(row.sha256),
    size: Number(row.size),
    status: row.status as SessionFileRecord['status'],
    updated_at: Number(row.updated_at),
  };
}
