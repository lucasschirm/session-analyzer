/**
 * Analytics Web Worker
 *
 * Hosts the SQLite WASM executor, the `sal-db` analytics data source, and the
 * ingestion/read facade. All SQL and SQLite types stay inside the worker. The
 * message protocol with the main thread is DTO-only.
 */

import {
  type AnalyticsDataSource,
  type ArtifactBlobStore,
  createAnalyticsDataSource,
  DefaultIngestionOrchestrator,
  type IngestionOrchestrator,
  type ResolvedArtifact,
} from '@lucasschirm/sal-db';
import { ANALYTICS_SCHEMA_NAME, MIGRATIONS, MigrationRunner } from '@lucasschirm/sal-db-core';
import { createDefaultRegistry } from '@lucasschirm/sal-transformer';
import type {
  AnalyticsBackendReport,
  AnalyticsRequest,
  AnalyticsResponse,
} from './analytics-protocol';
import {
  createBrowserArtifactBlobStore,
  createBrowserArtifactResolver,
  createBrowserContentHasher,
  createSyncArtifactCache,
  type SyncArtifactCache,
} from './artifact-adapters';
import { WasmSqliteExecutor } from './wasm-sqlite-executor';

const ANALYTICS_DB_FILENAME = '/sal-analytics.sqlite3';
const DEFAULT_ANALYSIS_RELEASE = 'rel-default';

interface AnalyticsWorkerState {
  readonly executor: WasmSqliteExecutor;
  readonly dataSource: AnalyticsDataSource;
  readonly ingestion: IngestionOrchestrator;
  readonly blobStore: ArtifactBlobStore;
  readonly syncCache: SyncArtifactCache;
  readonly backend: AnalyticsBackendReport;
}

let statePromise: Promise<AnalyticsWorkerState> | null = null;

function buildBackendReport(executor: WasmSqliteExecutor): AnalyticsBackendReport {
  const { backend } = executor;
  return {
    backendName: backend.backendName,
    durability: backend.durability,
    journalMode: backend.journalMode,
    storage: backend.backendName === 'wasm-opfs' ? 'opfs' : 'memory',
    fallbackReason: executor.fallbackReason,
    supports: {
      integersAsBigint: backend.supports.integersAsBigint,
      blob: backend.supports.blob,
      preparedStatements: backend.supports.preparedStatements,
      foreignKeys: backend.supports.foreignKeys,
      wal: backend.supports.wal,
      nestedTransactions: backend.supports.nestedTransactions,
      concurrentTransactions: backend.supports.concurrentTransactions,
      cancellation: backend.supports.cancellation,
      busyTimeout: backend.supports.busyTimeout,
      durable: backend.supports.durable,
      sharedMemory: backend.supports.sharedMemory,
      sql: {
        features: [...backend.supports.sql.features],
        maxBoundParameters: backend.supports.sql.maxBoundParameters,
        maxSqlLength: backend.supports.sql.maxSqlLength,
        maxColumnNameLength: backend.supports.sql.maxColumnNameLength,
      },
    },
  };
}

export async function createAnalyticsWorkerState(): Promise<AnalyticsWorkerState> {
  const executor = await WasmSqliteExecutor.create({
    filename: ANALYTICS_DB_FILENAME,
    preferOpfs: true,
  });

  const runner = new MigrationRunner(executor, MIGRATIONS, ANALYTICS_SCHEMA_NAME);
  await runner.migrate();

  const hasher = createBrowserContentHasher();
  const blobStore = createBrowserArtifactBlobStore(executor);
  const syncCache = createSyncArtifactCache();
  const resolver = createBrowserArtifactResolver({ blobStore, syncCache });

  const dataSource = createAnalyticsDataSource(executor, hasher);
  const ingestion = new DefaultIngestionOrchestrator({
    executor,
    resolver,
    hasher,
    blobStore,
    registry: createDefaultRegistry(),
    analysisReleaseId: DEFAULT_ANALYSIS_RELEASE,
  });

  return {
    executor,
    dataSource,
    ingestion,
    blobStore,
    syncCache,
    backend: buildBackendReport(executor),
  };
}

function getState(): Promise<AnalyticsWorkerState> {
  if (!statePromise) {
    statePromise = createAnalyticsWorkerState();
  }
  return statePromise;
}

function toErrorResponse(error: unknown): AnalyticsResponse {
  return {
    id: 0,
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  };
}

function withId(response: AnalyticsResponse, id: number): AnalyticsResponse {
  return { ...response, id };
}

async function handleQuery(
  state: AnalyticsWorkerState,
  request: Extract<AnalyticsRequest, { type: 'query' }>,
): Promise<AnalyticsResponse> {
  const view = state.dataSource[request.view] as unknown as
    | Record<string, (...args: unknown[]) => Promise<unknown>>
    | undefined;
  if (!view) {
    return { id: 0, ok: false, error: `Unknown data source view: ${request.view}` };
  }

  const method = view[request.method];
  if (typeof method !== 'function') {
    return { id: 0, ok: false, error: `Unknown method: ${request.view}.${request.method}` };
  }

  try {
    const result = await method.apply(view, [...request.args]);
    return { id: 0, ok: true, result };
  } catch (error) {
    return toErrorResponse(error);
  }
}

async function handleRetainSyncArtifact(
  state: AnalyticsWorkerState,
  request: Extract<AnalyticsRequest, { type: 'retainSyncArtifact' }>,
): Promise<AnalyticsResponse> {
  try {
    const resolved: ResolvedArtifact = {
      ...request.artifact,
      sourceLocation: request.artifact.sourceLocation,
    };
    state.syncCache.set(resolved);
    await state.blobStore.retain(resolved);
    return { id: 0, ok: true };
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function handleAnalyticsRequest(
  request: AnalyticsRequest,
): Promise<AnalyticsResponse> {
  const state = await getState();
  try {
    switch (request.type) {
      case 'init':
      case 'getBackend':
        return {
          id: 0,
          ok: true,
          backend: state.backend,
          storage: state.backend.storage,
          fallbackReason: state.backend.fallbackReason,
        };
      case 'query':
        return await handleQuery(state, request);
      case 'retainSyncArtifact':
        return await handleRetainSyncArtifact(state, request);
      case 'close':
        await state.executor.close();
        statePromise = null;
        return { id: 0, ok: true };
      default: {
        const unknown = request as { type?: string };
        return { id: 0, ok: false, error: `Unknown request type: ${unknown.type ?? 'undefined'}` };
      }
    }
  } catch (error) {
    return toErrorResponse(error);
  }
}

let pending: Array<{ readonly request: AnalyticsRequest; readonly id: number }> = [];
let ready = false;

function flushPending(): void {
  for (const { request, id } of pending) {
    handleAnalyticsRequest(request)
      .then((response) => self.postMessage(withId(response, id)))
      .catch((error) => self.postMessage(withId(toErrorResponse(error), id)));
  }
  pending = [];
}

function start(): void {
  if (typeof self === 'undefined') return;

  self.onmessage = (event: MessageEvent<AnalyticsRequest>) => {
    const request = event.data;
    const id = event.data.id;
    if (!ready) {
      pending.push({ request, id });
      return;
    }
    handleAnalyticsRequest(request)
      .then((response) => self.postMessage(withId(response, id)))
      .catch((error) => self.postMessage(withId(toErrorResponse(error), id)));
  };

  void getState().then(() => {
    ready = true;
    flushPending();
  });
}

start();
