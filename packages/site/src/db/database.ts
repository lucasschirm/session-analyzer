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
  PasskeyState,
  Project,
  ProjectSyncStatus,
  SessionFileRecord,
  SessionStub,
  SessionSyncStatus,
  StoredS3Credentials,
  SyncManifest,
} from '../types';

export type StorageBackend = 'opfs' | 'memory';
export type FallbackReason = 'locked' | 'unsupported';

/**
 * Receipt proving an analytics generation was committed. The checkpoint
 * commit path requires this so control-side progress is only persisted
 * after analytics has accepted the data.
 */
export interface CommittedGenerationReceipt {
  /** Opaque id of the committed analytics generation. */
  generationId: string;
  /** Timestamp when the generation was committed, in milliseconds. */
  committedAt?: number;
}

/**
 * A source checkpoint stored in the control database. It tracks the last
 * successfully ingested sequence/cursor for a source and the generation
 * that produced it.
 */
export interface SourceCheckpoint {
  source_id: string;
  source_type: string;
  last_sequence?: string;
  last_cursor?: string;
  committed_generation_id?: string;
  committed_at?: number;
  created_at?: number;
  updated_at?: number;
}

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
  /** `null` = no compaction count recorded yet (missing, never coerced to a
   * fabricated `0`); see `DashboardSession.context_compactions`. */
  context_compactions: number | null;
  total_turns: number;
  files_read: number;
  files_written: number;
  agent_invocations: number;
  sync_session_id: string | null;
  sync_status: string | null;
  sync_details: string | null;
  sync_schema_version: number | null;
  sync_harness: string | null;
  sync_harness_version: string | null;
  sync_manifest_model: string | null;
  sync_started_at: string | null;
  sync_ended_at: string | null;
  sync_duration_ms: number | null;
  sync_end_reason: string | null;
  sync_engine_version: string | null;
  sync_plugin_version: string | null;
  sync_transcripts_captured: number | null;
  sync_main_transcript_relative_path: string | null;
  sync_artifacts: string | null;
  sync_runs: string | null;
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
  'ALTER TABLE session_files ADD COLUMN etag TEXT',
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

function isSessionSyncStatus(value: unknown): value is SessionSyncStatus {
  return (
    value === 'pending' ||
    value === 'processing' ||
    value === 'in_sync' ||
    value === 'failed' ||
    value === 'transcript_unavailable'
  );
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
  private storageBackend: StorageBackend = 'memory';

  get storage(): StorageBackend {
    return this.storageBackend;
  }

  fallbackReason?: FallbackReason;

  /**
   * Initializes the SQLite WASM runtime and opens the site control database.
   * Falls back to in-memory when OPFS is unavailable or locked.
   */
  async initialize(filename = '/session-analyzer.sqlite3'): Promise<StorageBackend> {
    if (this.db) return this.storage;

    if (!this.sqlite3) this.sqlite3 = await sqlite3InitModule();

    this.db = this.openDatabase(filename);
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.createTables();
    this.migrate();
    return this.storage;
  }

  private openDatabase(filename: string): Database {
    const sqlite3 = this.sqlite3;
    if (!sqlite3) throw new Error('Database not initialized');

    if (sqlite3.oo1.OpfsDb) {
      try {
        const db = new sqlite3.oo1.OpfsDb(filename, 'c');
        this.storageBackend = 'opfs';
        return db;
      } catch (error) {
        if (isOpfsLockedError(error, sqlite3.capi)) {
          this.fallbackReason = 'locked';
        } else {
          throw error;
        }
        const db = new sqlite3.oo1.DB(':memory:', 'c');
        this.storageBackend = 'memory';
        return db;
      }
    }

    const db = new sqlite3.oo1.DB(':memory:', 'c');
    this.storageBackend = 'memory';
    this.fallbackReason = 'unsupported';
    return db;
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
    this.createSessionFilesTable();
    this.createConnectionsTable();
    this.createS3CredentialsTable();
    this.createPasskeyStateTable();
    this.createSourceCheckpointsTable();
    this.createUiPreferencesTable();
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
        -- NULL = no compaction count recorded yet (missing, distinct from a
        -- confirmed 0) - see DashboardSession.context_compactions.
        context_compactions INTEGER,
        total_turns INTEGER NOT NULL DEFAULT 0,
        files_read INTEGER NOT NULL DEFAULT 0,
        files_written INTEGER NOT NULL DEFAULT 0,
        agent_invocations INTEGER NOT NULL DEFAULT 0,
        sync_session_id TEXT,
        sync_status TEXT,
        sync_details TEXT,
        sync_schema_version INTEGER,
        sync_harness TEXT,
        sync_harness_version TEXT,
        sync_manifest_model TEXT,
        sync_started_at TEXT,
        sync_ended_at TEXT,
        sync_duration_ms INTEGER,
        sync_end_reason TEXT,
        sync_engine_version TEXT,
        sync_plugin_version TEXT,
        sync_transcripts_captured INTEGER,
        sync_main_transcript_relative_path TEXT,
        sync_artifacts TEXT,
        sync_runs TEXT,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
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

  private createSourceCheckpointsTable(): void {
    this.requireDb().exec(`
      CREATE TABLE IF NOT EXISTS source_checkpoints (
        source_id TEXT PRIMARY KEY,
        source_type TEXT NOT NULL,
        last_sequence TEXT,
        last_cursor TEXT,
        committed_generation_id TEXT,
        committed_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  private createUiPreferencesTable(): void {
    this.requireDb().exec(`
      CREATE TABLE IF NOT EXISTS ui_preferences (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at INTEGER NOT NULL
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
        etag TEXT,
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
  }

  private requireDb(): Database {
    if (!this.db) throw new Error('Database not initialized');
    return this.db;
  }

  /** Returns the raw database handle (for tests and diagnostics). */
  getControlDb(): Database {
    return this.requireDb();
  }

  // ==================== Project operations ====================

  /** Inserts a new project record. */
  createProject(project: Project): void {
    const sql = `INSERT INTO projects (id, name, description, readable_id, created_at, updated_at, session_count, connection_id)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
    const bind = [
      project.id,
      project.name,
      project.description ?? '',
      project.readable_id || null,
      project.created_at,
      project.updated_at,
      project.session_count || 0,
      project.connection_id || null,
    ];
    this.tryExecReadableId(sql, bind);
  }

  /**
   * Runs a project write and maps a readable_id unique-index violation to a
   * user-facing error. Other SQLite errors are rethrown unchanged.
   */
  private tryExecReadableId(sql: string, bind: (string | number | null)[]): void {
    try {
      this.requireDb().exec({ sql, bind });
    } catch (error) {
      if (error instanceof Error && /UNIQUE constraint failed.*readable_id/i.test(error.message)) {
        throw new Error('This project ID is already in use');
      }
      throw error;
    }
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

  /** Updates a project's name, description and/or readable id. */
  updateProject(
    id: string,
    fields: { name?: string; description?: string; readable_id?: string },
  ): void {
    const project = this.getProject(id);
    if (!project) throw new Error(`Project not found: ${id}`);

    const sql =
      'UPDATE projects SET name = ?, description = ?, readable_id = ?, updated_at = ? WHERE id = ?';
    const readableId = (fields.readable_id?.trim() || project.readable_id) ?? null;
    const bind = [
      fields.name ?? project.name,
      fields.description ?? project.description,
      readableId,
      Date.now(),
      id,
    ];
    this.tryExecReadableId(sql, bind);
  }

  /** Deletes a project and cascades to its sessions and session files. */
  deleteProject(id: string): void {
    const db = this.requireDb();
    db.transaction(() => {
      db.exec({ sql: 'DELETE FROM session_files WHERE project_id = ?', bind: [id] });
      db.exec({ sql: 'DELETE FROM sessions WHERE project_id = ?', bind: [id] });
      db.exec({ sql: 'DELETE FROM projects WHERE id = ?', bind: [id] });
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

  // ==================== Source checkpoint operations ====================

  /**
   * Commits a source checkpoint in the control database, but only after
   * validating a non-empty generation id receipt from analytics ingestion.
   */
  commitSourceCheckpoint(
    sourceId: string,
    checkpoint: SourceCheckpoint,
    receipt: CommittedGenerationReceipt,
  ): void {
    if (!receipt?.generationId?.trim()) {
      throw new Error(
        'A valid CommittedGenerationReceipt with a non-empty generationId is required',
      );
    }

    const db = this.requireDb();
    const now = Date.now();
    const existing = db.selectObject(
      'SELECT created_at FROM source_checkpoints WHERE source_id = ?',
      [sourceId],
    ) as { created_at: number } | undefined;
    const createdAt = existing?.created_at ?? now;

    db.exec({
      sql: `INSERT INTO source_checkpoints (
        source_id, source_type, last_sequence, last_cursor,
        committed_generation_id, committed_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_id) DO UPDATE SET
        source_type = excluded.source_type,
        last_sequence = excluded.last_sequence,
        last_cursor = excluded.last_cursor,
        committed_generation_id = excluded.committed_generation_id,
        committed_at = excluded.committed_at,
        updated_at = excluded.updated_at`,
      bind: [
        sourceId,
        checkpoint.source_type,
        checkpoint.last_sequence ?? null,
        checkpoint.last_cursor ?? null,
        receipt.generationId,
        receipt.committedAt ?? now,
        createdAt,
        now,
      ],
    });
  }

  /** Returns a single source checkpoint, or null if none exists. */
  getSourceCheckpoint(sourceId: string): SourceCheckpoint | null {
    const row = this.requireDb().selectObject(
      'SELECT * FROM source_checkpoints WHERE source_id = ?',
      [sourceId],
    );
    return row ? rowToSourceCheckpoint(row as Record<string, unknown>) : null;
  }

  /** Lists all source checkpoints, most recently updated first. */
  getSourceCheckpoints(): SourceCheckpoint[] {
    const rows = this.requireDb().selectObjects(
      'SELECT * FROM source_checkpoints ORDER BY updated_at DESC',
    );
    return rows.map((row) => rowToSourceCheckpoint(row as Record<string, unknown>));
  }

  // ==================== UI preference operations ====================

  /** Stores or replaces a UI preference value in the control database. */
  setUiPreference(key: string, value: string): void {
    this.requireDb().exec({
      sql: `INSERT INTO ui_preferences (key, value, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET
              value = excluded.value,
              updated_at = excluded.updated_at`,
      bind: [key, value, Date.now()],
    });
  }

  /** Returns a UI preference value, or null if it has never been set. */
  getUiPreference(key: string): string | null {
    const row = this.requireDb().selectObject('SELECT value FROM ui_preferences WHERE key = ?', [
      key,
    ]) as { value: string | null } | undefined;
    return row?.value ?? null;
  }

  // ==================== Session sync state ====================

  /** Finds a session by its remote sync id within a project. */
  getSessionBySyncId(projectId: string, syncSessionId: string): DashboardSession | null {
    const row = this.requireDb().selectObject(
      'SELECT * FROM sessions WHERE project_id = ? AND sync_session_id = ?',
      [projectId, syncSessionId],
    ) as unknown as SessionRow | undefined;
    return row ? rowToSession(row) : null;
  }

  /**
   * Inserts a sync stub or updates an existing session's stub-relevant
   * columns. Parsed-content columns are never overwritten by this call.
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
      // Never coerced to 0: a stub written before parsed content lands has
      // no compaction signal yet, and that must stay distinguishable from a
      // confirmed zero-compaction session (missing-is-never-zero).
      stub.context_compactions ?? null,
      stub.total_turns ?? 0,
      stub.files_read ?? 0,
      stub.files_written ?? 0,
      stub.agent_invocations ?? 0,
      stub.sync_session_id,
      stub.sync_status,
    ];
  }

  private insertSessionStub(stub: SessionStub): void {
    const db = this.requireDb();
    db.transaction(() => {
      db.exec({
        sql: `INSERT INTO sessions (
          id, project_id, source, title, started_at, ended_at,
          input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, total_tokens,
          cost_usd, model, model_usage, tasks, external_id, subagents,
          context_compactions, total_turns, files_read, files_written, agent_invocations,
          sync_session_id, sync_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        bind: DatabaseManager.sessionStubBindParams(stub),
      });
      db.exec({
        sql: 'UPDATE projects SET session_count = session_count + 1, updated_at = ? WHERE id = ?',
        bind: [Date.now(), stub.project_id],
      });
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
    const db = this.requireDb();
    const exists = db.selectObject('SELECT id FROM sessions WHERE id = ?', [sessionId]);
    if (!exists) throw new Error(`Session not found: ${sessionId}`);

    db.exec({
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

  /** Reads the sync manifest mirror columns back as a `SyncManifest`. */
  getSessionSyncManifest(sessionId: string): SyncManifest | null {
    const row = this.requireDb().selectObject(
      `SELECT
        sync_session_id, sync_schema_version, sync_harness, sync_harness_version,
        sync_manifest_model, sync_started_at, sync_ended_at, sync_duration_ms,
        sync_end_reason, sync_engine_version, sync_plugin_version, sync_transcripts_captured,
        sync_main_transcript_relative_path, sync_artifacts, sync_runs
      FROM sessions WHERE id = ?`,
      [sessionId],
    ) as Record<string, unknown> | undefined;

    if (!row || row.sync_session_id == null) return null;

    return {
      sessionId: String(row.sync_session_id),
      schemaVersion: Number(row.sync_schema_version),
      harness: row.sync_harness ? String(row.sync_harness) : undefined,
      harnessVersion: row.sync_harness_version ? String(row.sync_harness_version) : undefined,
      model: row.sync_manifest_model ? String(row.sync_manifest_model) : undefined,
      startedAt: row.sync_started_at ? String(row.sync_started_at) : undefined,
      endedAt: row.sync_ended_at ? String(row.sync_ended_at) : undefined,
      durationMs: typeof row.sync_duration_ms === 'number' ? row.sync_duration_ms : undefined,
      endReason: row.sync_end_reason ? String(row.sync_end_reason) : undefined,
      syncVersion: row.sync_engine_version ? String(row.sync_engine_version) : undefined,
      pluginVersion: row.sync_plugin_version ? String(row.sync_plugin_version) : undefined,
      transcriptsCaptured: Number(row.sync_transcripts_captured) === 1,
      mainTranscriptRelativePath: row.sync_main_transcript_relative_path
        ? String(row.sync_main_transcript_relative_path)
        : undefined,
      artifacts: safeJsonParseArray<unknown>(String(row.sync_artifacts ?? '[]')),
      syncRuns: safeJsonParseArray<unknown>(String(row.sync_runs ?? '[]')),
    };
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
        id, project_id, session_id, path, scope, sha256, etag, size, status, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, path) DO UPDATE SET
        scope = excluded.scope, sha256 = excluded.sha256, etag = excluded.etag,
        size = excluded.size, status = excluded.status, updated_at = excluded.updated_at`,
      bind: [
        file.id,
        file.project_id,
        file.session_id,
        file.path,
        file.scope,
        file.sha256,
        file.etag ?? null,
        file.size,
        file.status,
        file.updated_at,
      ],
    });
  }

  /** Deletes all file records for a session. */
  deleteSessionFiles(sessionId: string): void {
    this.requireDb().exec({
      sql: 'DELETE FROM session_files WHERE session_id = ?',
      bind: [sessionId],
    });
  }

  // ==================== Sync boot reconciliation ====================

  /**
   * Crash-recovery primitive: set every 'syncing' project to 'in_sync' and
   * every 'pending'/'processing' session to 'failed'. Runs as one atomic
   * transaction.
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

  // ==================== Export ====================

  /** Serializes the control database as bytes (a valid SQLite file). */
  exportControlDatabase(): Uint8Array {
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

function rowToSession(row: SessionRow): DashboardSession {
  return {
    id: row.id,
    project_id: row.project_id,
    source: row.source as DashboardSession['source'],
    title: row.title,
    started_at: row.started_at,
    ended_at: row.ended_at,
    input_tokens: row.input_tokens,
    output_tokens: row.output_tokens,
    cache_creation_tokens: row.cache_creation_tokens,
    cache_read_tokens: row.cache_read_tokens,
    total_tokens: row.total_tokens,
    cost_usd: row.cost_usd ?? undefined,
    model: row.model ?? undefined,
    models: [],
    context_compactions: row.context_compactions,
    total_turns: row.total_turns,
    files_read: row.files_read,
    files_written: row.files_written,
    agent_invocations: row.agent_invocations,
    tool_executions: [],
    events: [],
    messages: [],
    tasks: [],
    external_id: row.external_id ?? undefined,
    subagents: [],
    sync_session_id: row.sync_session_id ?? undefined,
    sync_status: isSessionSyncStatus(row.sync_status) ? row.sync_status : undefined,
    sync_details: row.sync_details ?? undefined,
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
    etag: typeof row.etag === 'string' ? row.etag : undefined,
    size: Number(row.size),
    status: row.status as SessionFileRecord['status'],
    updated_at: Number(row.updated_at),
  };
}

function rowToSourceCheckpoint(row: Record<string, unknown>): SourceCheckpoint {
  return {
    source_id: String(row.source_id),
    source_type: String(row.source_type),
    last_sequence: typeof row.last_sequence === 'string' ? row.last_sequence : undefined,
    last_cursor: typeof row.last_cursor === 'string' ? row.last_cursor : undefined,
    committed_generation_id:
      typeof row.committed_generation_id === 'string' ? row.committed_generation_id : undefined,
    committed_at: typeof row.committed_at === 'number' ? row.committed_at : undefined,
    created_at: typeof row.created_at === 'number' ? row.created_at : undefined,
    updated_at: typeof row.updated_at === 'number' ? row.updated_at : undefined,
  };
}
