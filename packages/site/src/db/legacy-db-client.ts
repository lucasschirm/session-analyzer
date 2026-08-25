/**
 * Main-thread client for the legacy database worker.
 *
 * Spawns a dedicated worker that opens the pre-split SQLite file in a
 * separate read-only connection, keeping its OPFS lock independent from the
 * new analytics/control databases.
 */

import type { FallbackReason } from './database';

interface PendingCall {
  requestType: LegacyDbRequest['type'];
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export type LegacyDbRequest =
  | { id: number; type: 'init'; filename: string }
  | { id: number; type: 'exportDatabase' }
  | { id: number; type: 'close' };

/** Distributive Omit so the union members keep their specific payload keys. */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

/** Request payload as posted from the main thread (id is assigned there). */
export type LegacyDbRequestPayload = DistributiveOmit<LegacyDbRequest, 'id'>;

export interface LegacyDbSuccessResponse {
  id: number;
  ok: true;
  result?: unknown;
  bytes?: Uint8Array;
  storage?: 'opfs' | 'memory';
  fallbackReason?: FallbackReason;
}

export interface LegacyDbErrorResponse {
  id: number;
  ok: false;
  error: string;
}

export type LegacyDbResponse = LegacyDbSuccessResponse | LegacyDbErrorResponse;

export class LegacyDbClient {
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
      (() => new Worker(new URL('./legacy-db.worker.ts', import.meta.url), { type: 'module' }));
  }

  /** Initializes the worker + legacy database and resolves with the storage backend. */
  ensureReady(filename = '/session-analyzer.sqlite3'): Promise<'opfs' | 'memory'> {
    if (!this.initPromise) {
      this.worker = this.createWorker();
      this.worker.onmessage = (event: MessageEvent<LegacyDbResponse>) =>
        this.handleResponse(event.data);
      this.worker.onerror = (event) => {
        this.failAll(new Error(`Legacy database worker error: ${event.message}`));
      };
      this.initPromise = this.call({ type: 'init', filename }) as Promise<'opfs' | 'memory'>;
    }
    return this.initPromise;
  }

  get storageReady(): boolean {
    return this.worker !== null;
  }

  /** Serializes the legacy database as a SQLite file. */
  exportDatabase(): Promise<Uint8Array> {
    return this.call({ type: 'exportDatabase' }) as Promise<Uint8Array>;
  }

  /** Closes the legacy worker and database. */
  close(): Promise<void> {
    return this.call({ type: 'close' }) as Promise<void>;
  }

  private call(payload: LegacyDbRequestPayload): Promise<unknown> {
    if (!this.worker) {
      this.ensureReady();
    }
    const worker = this.worker;
    if (!worker) {
      throw new Error('Worker failed to initialize');
    }
    const id = ++this.seq;
    const request = { ...payload, id } as LegacyDbRequest;

    return new Promise((resolve, reject) => {
      this.pending.set(id, { requestType: request.type, resolve, reject });
      worker.postMessage(request);
    });
  }

  private handleResponse(response: LegacyDbResponse): void {
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
