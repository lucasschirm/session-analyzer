/**
 * Main-thread proxy for the database Web Worker.
 *
 * Every call is correlated to a worker response by message id. The worker is
 * created lazily on first use so importing this module has no side effects.
 */

import type { DashboardSession, Project, SessionMetrics } from '../types';
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
