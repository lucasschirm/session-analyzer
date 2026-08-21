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
import type { DbRequest, DbRequestPayload, DbResponse } from './db-protocol';

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
  fallbackReason?: 'locked' | 'unsupported';

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

  updateProject(projectId: string, fields: { name?: string; description?: string }): Promise<void> {
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

  getSessionsByProject(projectId: string): Promise<DashboardSession[]> {
    return this.call({ type: 'getSessionsByProject', projectId }) as Promise<DashboardSession[]>;
  }

  searchSessions(projectId: string, query: string): Promise<DashboardSession[]> {
    return this.call({ type: 'searchSessions', projectId, query }) as Promise<DashboardSession[]>;
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

  createConnection(connection: Connection): Promise<void> {
    return this.call({ type: 'createConnection', connection }) as Promise<void>;
  }

  updateConnection(
    connectionId: string,
    fields: Partial<Pick<Connection, 'name' | 'sync_only_new' | 'last_sync_at'>>,
  ): Promise<void> {
    return this.call({ type: 'updateConnection', connectionId, fields }) as Promise<void>;
  }

  deleteConnection(connectionId: string): Promise<void> {
    return this.call({ type: 'deleteConnection', connectionId }) as Promise<void>;
  }

  getConnections(): Promise<Connection[]> {
    return this.call({ type: 'getConnections' }) as Promise<Connection[]>;
  }

  saveS3Credentials(credentials: StoredS3Credentials): Promise<void> {
    return this.call({ type: 'saveS3Credentials', credentials }) as Promise<void>;
  }

  getS3Credentials(connectionId: string): Promise<StoredS3Credentials | null> {
    return this.call({
      type: 'getS3Credentials',
      connectionId,
    }) as Promise<StoredS3Credentials | null>;
  }

  deleteAllCredentials(): Promise<void> {
    return this.call({ type: 'deleteAllCredentials' }) as Promise<void>;
  }

  // ==================== Passkey ====================

  getPasskeyState(): Promise<PasskeyState | null> {
    return this.call({ type: 'getPasskeyState' }) as Promise<PasskeyState | null>;
  }

  savePasskeyState(state: PasskeyState): Promise<void> {
    return this.call({ type: 'savePasskeyState', state }) as Promise<void>;
  }

  // ==================== Project sync ====================

  getProjectByReadableId(readableId: string): Promise<Project | null> {
    return this.call({ type: 'getProjectByReadableId', readableId }) as Promise<Project | null>;
  }

  setProjectSyncStatus(projectId: string, status: 'in_sync' | 'syncing'): Promise<void> {
    return this.call({ type: 'setProjectSyncStatus', projectId, status }) as Promise<void>;
  }

  backfillReadableIds(): Promise<void> {
    return this.call({ type: 'backfillReadableIds' }) as Promise<void>;
  }

  // ==================== Session sync ====================

  getSessionBySyncId(projectId: string, syncSessionId: string): Promise<DashboardSession | null> {
    return this.call({
      type: 'getSessionBySyncId',
      projectId,
      syncSessionId,
    }) as Promise<DashboardSession | null>;
  }

  upsertSessionStub(stub: SessionStub): Promise<void> {
    return this.call({ type: 'upsertSessionStub', stub }) as Promise<void>;
  }

  setSessionSyncStatus(
    sessionId: string,
    status: SessionSyncStatus,
    details?: string,
  ): Promise<void> {
    return this.call({ type: 'setSessionSyncStatus', sessionId, status, details }) as Promise<void>;
  }

  updateSessionManifest(sessionId: string, manifest: SyncManifest): Promise<void> {
    return this.call({ type: 'updateSessionManifest', sessionId, manifest }) as Promise<void>;
  }

  getSyncRunCount(sessionId: string): Promise<number> {
    return this.call({ type: 'getSyncRunCount', sessionId }) as Promise<number>;
  }

  failStaleSessions(projectId: string, details: string): Promise<void> {
    return this.call({ type: 'failStaleSessions', projectId, details }) as Promise<void>;
  }

  reconcileSyncStates(sessionDetails: string): Promise<void> {
    return this.call({ type: 'reconcileSyncStates', sessionDetails }) as Promise<void>;
  }

  // ==================== Session files ====================

  getSessionFiles(sessionId: string): Promise<SessionFileRecord[]> {
    return this.call({ type: 'getSessionFiles', sessionId }) as Promise<SessionFileRecord[]>;
  }

  upsertSessionFile(file: SessionFileRecord): Promise<void> {
    return this.call({ type: 'upsertSessionFile', file }) as Promise<void>;
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
    } else if (pendingCall.requestType === 'exportDatabase') {
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
