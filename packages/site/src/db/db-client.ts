/**
 * Main-thread proxy for the database Web Worker.
 *
 * Every call is correlated to a worker response by message id. The worker is
 * created lazily on first use so importing this module has no side effects.
 */

import type {
  Connection,
  DashboardSession,
  PasskeyState,
  Project,
  SessionFileRecord,
  SessionMetrics,
  SessionStub,
  SessionSyncStatus,
  StoredS3Credentials,
  SyncManifest,
} from '../types';
import type { CommittedGenerationReceipt, FallbackReason, SourceCheckpoint } from './database';
import type { DbDatabaseHandle, DbRequest, DbRequestPayload, DbResponse } from './db-protocol';

interface PendingCall {
  requestType: DbRequest['type'];
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export class DbClient {
  private worker: Worker | null = null;
  private seq = 0;
  private pending = new Map<number, PendingCall>();
  private initPromise: Promise<'opfs' | 'memory'> | null = null;
  private createWorker: () => Worker;
  /** Populated after a successful init when the worker fell back to memory. */
  fallbackReason?: FallbackReason;

  constructor(createWorker?: () => Worker) {
    this.createWorker =
      createWorker ??
      (() => new Worker(new URL('./db-worker.ts', import.meta.url), { type: 'module' }));
  }

  /** Initializes the worker + database and resolves with the storage backend. */
  ensureReady(): Promise<'opfs' | 'memory'> {
    if (!this.initPromise) {
      this.worker = this.createWorker();
      this.worker.onmessage = (event: MessageEvent<DbResponse>) => this.handleResponse(event.data);
      this.worker.onerror = (event) => {
        this.failAll(new Error(`Database worker error: ${event.message}`));
      };
      this.initPromise = this.call({ type: 'init' }) as Promise<'opfs' | 'memory'>;
    }
    return this.initPromise;
  }

  get storageReady(): boolean {
    return this.worker !== null;
  }

  createProject(project: Project): Promise<void> {
    return this.call({ type: 'createProject', project }) as Promise<void>;
  }

  getProjects(): Promise<Project[]> {
    return this.call({ type: 'getProjects' }) as Promise<Project[]>;
  }

  getProject(projectId: string): Promise<Project | null> {
    return this.call({ type: 'getProject', projectId }) as Promise<Project | null>;
  }

  updateProject(
    projectId: string,
    fields: { name?: string; description?: string; readable_id?: string },
  ): Promise<void> {
    return this.call({ type: 'updateProject', projectId, fields }) as Promise<void>;
  }

  deleteProject(projectId: string): Promise<void> {
    return this.call({ type: 'deleteProject', projectId }) as Promise<void>;
  }

  saveSession(session: DashboardSession): Promise<void> {
    return this.call({ type: 'saveSession', session }) as Promise<void>;
  }

  /** Inserts, or - if `session.external_id` already exists in this project - updates in place. Resolves with the effective session id. */
  upsertSessionByExternalId(session: DashboardSession): Promise<string> {
    return this.call({ type: 'upsertSessionByExternalId', session }) as Promise<string>;
  }

  /** Replaces an existing session's row and child rows in place (same id). */
  replaceSession(session: DashboardSession): Promise<void> {
    return this.call({ type: 'replaceSession', session }) as Promise<void>;
  }

  findSessionByExternalId(projectId: string, externalId: string): Promise<DashboardSession | null> {
    return this.call({
      type: 'findSessionByExternalId',
      projectId,
      externalId,
    }) as Promise<DashboardSession | null>;
  }

  getSessionsByProject(
    projectId: string,
    limit?: number,
    offset?: number,
  ): Promise<DashboardSession[]> {
    return this.call({
      type: 'getSessionsByProject',
      projectId,
      limit,
      offset,
    }) as Promise<DashboardSession[]>;
  }

  searchSessions(
    projectId: string,
    query: string,
    limit?: number,
    offset?: number,
  ): Promise<DashboardSession[]> {
    return this.call({
      type: 'searchSessions',
      projectId,
      query,
      limit,
      offset,
    }) as Promise<DashboardSession[]>;
  }

  getSession(sessionId: string): Promise<DashboardSession | null> {
    return this.call({ type: 'getSession', sessionId }) as Promise<DashboardSession | null>;
  }

  deleteSession(sessionId: string): Promise<void> {
    return this.call({ type: 'deleteSession', sessionId }) as Promise<void>;
  }

  getProjectMetrics(projectId: string): Promise<SessionMetrics> {
    return this.call({ type: 'getProjectMetrics', projectId }) as Promise<SessionMetrics>;
  }

  exportDatabase(): Promise<Uint8Array> {
    return this.call({ type: 'exportDatabase' }) as Promise<Uint8Array>;
  }

  // ==================== Connections ====================

  /** Creates a new remote storage connection. */
  createConnection(connection: Connection): Promise<void> {
    return this.call({ type: 'createConnection', connection }) as Promise<void>;
  }

  /**
   * Updates the mutable fields of an existing connection.
   * Throws if the connection does not exist.
   */
  updateConnection(
    connectionId: string,
    fields: Partial<Pick<Connection, 'name' | 'sync_only_new' | 'last_sync_at'>>,
  ): Promise<void> {
    return this.call({ type: 'updateConnection', connectionId, fields }) as Promise<void>;
  }

  /** Deletes a connection and its associated S3 credentials. */
  deleteConnection(connectionId: string): Promise<void> {
    return this.call({ type: 'deleteConnection', connectionId }) as Promise<void>;
  }

  /** Lists all connections, newest first. */
  getConnections(): Promise<Connection[]> {
    return this.call({ type: 'getConnections' }) as Promise<Connection[]>;
  }

  /** Stores or replaces encrypted S3 credentials for a connection. */
  saveS3Credentials(credentials: StoredS3Credentials): Promise<void> {
    return this.call({ type: 'saveS3Credentials', credentials }) as Promise<void>;
  }

  /** Returns the encrypted S3 credentials for a connection, if any. */
  getS3Credentials(connectionId: string): Promise<StoredS3Credentials | null> {
    return this.call({
      type: 'getS3Credentials',
      connectionId,
    }) as Promise<StoredS3Credentials | null>;
  }

  /** Wipes all stored S3 credentials and passkey state. */
  deleteAllCredentials(): Promise<void> {
    return this.call({ type: 'deleteAllCredentials' }) as Promise<void>;
  }

  // ==================== Passkey ====================

  /** Returns the singleton passkey vault state, if one exists. */
  getPasskeyState(): Promise<PasskeyState | null> {
    return this.call({ type: 'getPasskeyState' }) as Promise<PasskeyState | null>;
  }

  /** Saves or replaces the singleton passkey vault state. */
  savePasskeyState(state: PasskeyState): Promise<void> {
    return this.call({ type: 'savePasskeyState', state }) as Promise<void>;
  }

  // ==================== Project sync ====================

  /** Looks up a project by its URL-safe readable id. */
  getProjectByReadableId(readableId: string): Promise<Project | null> {
    return this.call({ type: 'getProjectByReadableId', readableId }) as Promise<Project | null>;
  }

  /** Sets the sync state of a project. */
  setProjectSyncStatus(projectId: string, status: 'in_sync' | 'syncing'): Promise<void> {
    return this.call({ type: 'setProjectSyncStatus', projectId, status }) as Promise<void>;
  }

  /** Generates and assigns readable ids for any projects missing one. */
  backfillReadableIds(): Promise<void> {
    return this.call({ type: 'backfillReadableIds' }) as Promise<void>;
  }

  // ==================== Session sync ====================

  /** Finds a session by its remote sync id within a project. */
  getSessionBySyncId(projectId: string, syncSessionId: string): Promise<DashboardSession | null> {
    return this.call({
      type: 'getSessionBySyncId',
      projectId,
      syncSessionId,
    }) as Promise<DashboardSession | null>;
  }

  /**
   * Inserts a sync stub or updates an existing session's stub-relevant
   * columns. Existing parsed rows are never overwritten.
   */
  upsertSessionStub(stub: SessionStub): Promise<void> {
    return this.call({ type: 'upsertSessionStub', stub }) as Promise<void>;
  }

  /** Updates only the sync status (and optional detail text) of a session. */
  setSessionSyncStatus(
    sessionId: string,
    status: SessionSyncStatus,
    details?: string,
  ): Promise<void> {
    return this.call({ type: 'setSessionSyncStatus', sessionId, status, details }) as Promise<void>;
  }

  /** Writes all sync mirror columns from a manifest onto a session row. */
  updateSessionManifest(sessionId: string, manifest: SyncManifest): Promise<void> {
    return this.call({ type: 'updateSessionManifest', sessionId, manifest }) as Promise<void>;
  }

  /** Reads the sync manifest mirror columns back as a `SyncManifest`. */
  getSessionSyncManifest(sessionId: string): Promise<SyncManifest | null> {
    return this.call({ type: 'getSessionSyncManifest', sessionId }) as Promise<SyncManifest | null>;
  }

  /** Returns the number of recorded sync runs for a session. */
  getSyncRunCount(sessionId: string): Promise<number> {
    return this.call({ type: 'getSyncRunCount', sessionId }) as Promise<number>;
  }

  /** Marks every pending/processing session in a project as failed. */
  failStaleSessions(projectId: string, details: string): Promise<void> {
    return this.call({ type: 'failStaleSessions', projectId, details }) as Promise<void>;
  }

  /**
   * Crash-recovery primitive: resets any syncing projects and any
   * pending/processing sessions back to a safe state.
   */
  reconcileSyncStates(sessionDetails: string): Promise<void> {
    return this.call({ type: 'reconcileSyncStates', sessionDetails }) as Promise<void>;
  }

  // ==================== Session files ====================

  /** Lists all file records for a session, ordered by path. */
  getSessionFiles(sessionId: string): Promise<SessionFileRecord[]> {
    return this.call({ type: 'getSessionFiles', sessionId }) as Promise<SessionFileRecord[]>;
  }

  /** Inserts or updates a session file record on the (session_id, path) key. */
  upsertSessionFile(file: SessionFileRecord): Promise<void> {
    return this.call({ type: 'upsertSessionFile', file }) as Promise<void>;
  }

  // ==================== Source checkpoints and UI preferences ====================

  /**
   * Commits a source checkpoint in the control database only after a valid
   * committed-generation receipt has been provided.
   */
  commitSourceCheckpoint(
    sourceId: string,
    checkpoint: SourceCheckpoint,
    receipt: CommittedGenerationReceipt,
  ): Promise<void> {
    return this.call({
      type: 'commitSourceCheckpoint',
      sourceId,
      checkpoint,
      receipt,
    }) as Promise<void>;
  }

  /** Returns a single source checkpoint, or null if none exists. */
  getSourceCheckpoint(sourceId: string): Promise<SourceCheckpoint | null> {
    return this.call({ type: 'getSourceCheckpoint', sourceId }) as Promise<SourceCheckpoint | null>;
  }

  /** Lists all source checkpoints, most recently updated first. */
  getSourceCheckpoints(): Promise<SourceCheckpoint[]> {
    return this.call({ type: 'getSourceCheckpoints' }) as Promise<SourceCheckpoint[]>;
  }

  /** Stores or replaces a UI preference value. */
  setUiPreference(key: string, value: string): Promise<void> {
    return this.call({ type: 'setUiPreference', key, value }) as Promise<void>;
  }

  /** Returns a UI preference value, or null if it has never been set. */
  getUiPreference(key: string): Promise<string | null> {
    return this.call({ type: 'getUiPreference', key }) as Promise<string | null>;
  }

  /** Resets the analytics database without touching control data. */
  resetAnalyticsDatabase(): Promise<void> {
    return this.call({ type: 'resetAnalyticsDatabase' }) as Promise<void>;
  }

  /** Serializes the control database as bytes. */
  exportControlDatabase(): Promise<Uint8Array> {
    return this.call({ type: 'exportControlDatabase' }) as Promise<Uint8Array>;
  }

  /** Returns a handle describing the analytics database connection. */
  getAnalyticsDb(): Promise<DbDatabaseHandle> {
    return this.call({ type: 'getAnalyticsDb' }) as Promise<DbDatabaseHandle>;
  }

  /** Returns a handle describing the control database connection. */
  getControlDb(): Promise<DbDatabaseHandle> {
    return this.call({ type: 'getControlDb' }) as Promise<DbDatabaseHandle>;
  }

  /** Exports the SQLite file and triggers a browser download. */
  async exportAndDownload(): Promise<void> {
    const bytes = await this.exportDatabase();
    const blob = new Blob([bytes.buffer as ArrayBuffer], { type: 'application/x-sqlite3' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `session-analyzer-${new Date().toISOString().slice(0, 10)}.sqlite`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  private call(payload: DbRequestPayload): Promise<unknown> {
    if (!this.worker) {
      // Lazy initialization: the worker is created on first use and the
      // 'init' message is queued ahead of this request.
      this.ensureReady();
    }
    const worker = this.worker;
    if (!worker) {
      throw new Error('Worker failed to initialize');
    }
    const id = ++this.seq;
    const request = { ...payload, id } as DbRequest;

    return new Promise((resolve, reject) => {
      this.pending.set(id, { requestType: request.type, resolve, reject });
      worker.postMessage(request);
    });
  }

  private handleResponse(response: DbResponse): void {
    const pendingCall = this.pending.get(response.id);
    if (!pendingCall) return;
    this.pending.delete(response.id);

    if (!response.ok) {
      pendingCall.reject(new Error(response.error));
      return;
    }

    if (pendingCall.requestType === 'init') {
      this.fallbackReason = response.fallbackReason;
      pendingCall.resolve(response.storage ?? 'memory');
    } else if (
      pendingCall.requestType === 'exportDatabase' ||
      pendingCall.requestType === 'exportControlDatabase'
    ) {
      pendingCall.resolve(response.bytes ?? new Uint8Array());
    } else {
      pendingCall.resolve(response.result);
    }
  }

  private failAll(error: Error): void {
    for (const pendingCall of this.pending.values()) {
      pendingCall.reject(error);
    }
    this.pending.clear();
  }
}

export const dbClient = new DbClient();
