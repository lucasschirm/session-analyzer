/**
 * Analytics Web Worker
 *
 * Hosts the SQLite WASM executor, the `sal-db` analytics data source, and the
 * ingestion/read facade. All SQL and SQLite types stay inside the worker. The
 * message protocol with the main thread is DTO-only.
 */

import {
  type AnalyticsDataSource,
  type Artifact,
  type ArtifactBlobStore,
  type ArtifactContent,
  createAnalyticsDataSource,
  DefaultIngestionOrchestrator,
  DefaultReprocessingEngine,
  type IngestionContext,
  type IngestionOrchestrator,
  type IngestionReceipt,
  type ManualIngestionDetection,
  type ManualIngestionFlowInput,
  ManualIngestionOrchestrator,
  type ResolvedArtifact,
  type VerifiedManifestBundle,
} from '@lucasschirm/sal-db';
import { ANALYTICS_SCHEMA_NAME, MIGRATIONS, MigrationRunner } from '@lucasschirm/sal-db-core';
import { parseSyncManifest } from '@lucasschirm/sal-sync-core';
import { createDefaultRegistry, type TransformerRegistry } from '@lucasschirm/sal-transformer';
import type {
  AnalyticsBackendReport,
  AnalyticsRequest,
  AnalyticsResponse,
  ManualArtifactPayload,
  ManualIngestionBundleRequest,
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
  readonly manualIngestion: ManualIngestionOrchestrator;
  readonly reprocessing: DefaultReprocessingEngine;
  readonly context: IngestionContext;
  readonly registry: TransformerRegistry;
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

function inferMediaType(relativePath: string): string {
  const normalized = relativePath.toLowerCase();
  if (normalized.endsWith('.jsonl')) return 'application/jsonl';
  if (normalized.endsWith('.json')) return 'application/json';
  if (normalized.endsWith('.md')) return 'text/markdown';
  if (normalized.endsWith('.log')) return 'text/plain';
  return 'application/octet-stream';
}

function toManualArtifact(payload: ManualArtifactPayload): Artifact<ArtifactContent> {
  const mediaType = payload.mediaType || inferMediaType(payload.relativePath);
  const size = payload.size ?? payload.content.length;
  const status = (payload.status as 'uploaded' | 'failed' | 'skipped' | 'pending') ?? 'uploaded';
  return {
    relativePath: payload.relativePath,
    mediaType,
    content: payload.content,
    sha256: payload.sha256,
    size,
    status,
  };
}

function toManualFlowInput(bundle: ManualIngestionBundleRequest): ManualIngestionFlowInput {
  return {
    ...bundle,
    source: bundle.source ?? { sourceId: 'manual' },
    artifacts: bundle.artifacts.map(toManualArtifact),
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
  const registry = createDefaultRegistry();

  const context: IngestionContext = {
    executor,
    resolver,
    hasher,
    blobStore,
    registry,
    analysisReleaseId: DEFAULT_ANALYSIS_RELEASE,
  };

  const dataSource = createAnalyticsDataSource(executor, hasher);
  const ingestion = new DefaultIngestionOrchestrator(context);
  const manualIngestion = new ManualIngestionOrchestrator(context);
  const reprocessing = new DefaultReprocessingEngine(context);

  return {
    executor,
    dataSource,
    ingestion,
    manualIngestion,
    reprocessing,
    context,
    registry,
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

function mapDetection(resolution: {
  kind: 'matched' | 'unmatched' | 'ambiguous';
  harness?: string;
  reason?: string;
  candidates?: readonly string[];
}): ManualIngestionDetection {
  if (resolution.kind === 'matched') {
    return {
      kind: 'matched',
      harness: resolution.harness,
      confidence: 1,
      reason: resolution.reason ?? 'schema detection matched a single transformer',
    };
  }
  if (resolution.kind === 'ambiguous') {
    const candidates = (resolution.candidates ?? []).map((candidate) => {
      const parts = candidate.split(':');
      return parts.length > 1 ? parts[1] : candidate;
    });
    return {
      kind: 'ambiguous',
      reason: resolution.reason ?? 'multiple harnesses matched',
      candidates,
    };
  }
  return {
    kind: 'unmatched',
    reason: resolution.reason ?? 'no harness detected',
  };
}

async function handleDetectManualHarness(
  state: AnalyticsWorkerState,
  request: Extract<AnalyticsRequest, { type: 'detectManualHarness' }>,
): Promise<AnalyticsResponse> {
  try {
    const artifacts = request.artifacts.map(toManualArtifact);
    const resolution = state.registry.resolveByDetection({ artifacts });
    return { id: 0, ok: true, result: mapDetection(resolution) };
  } catch (error) {
    return toErrorResponse(error);
  }
}

async function handleIngestManualBundle(
  state: AnalyticsWorkerState,
  request: Extract<AnalyticsRequest, { type: 'ingestManualBundle' }>,
): Promise<AnalyticsResponse> {
  try {
    const bundle = toManualFlowInput(request.bundle);
    const receipt = await state.manualIngestion.ingestManual(bundle);
    return { id: 0, ok: true, result: receipt };
  } catch (error) {
    return toErrorResponse(error);
  }
}

interface ExistingSessionRef {
  readonly sessionId: string;
  readonly projectId: string;
  readonly portfolioId: string;
}

async function findExistingManualSession(
  state: AnalyticsWorkerState,
  bundle: ManualIngestionBundleRequest,
): Promise<ExistingSessionRef | undefined> {
  const { rows } = await state.executor.exec(
    `SELECT s.id AS session_id, s.project_id, p.portfolio_id
     FROM sessions s
     JOIN projects p ON p.id = s.project_id
     WHERE p.name = ? AND s.native_session_id = ?
     LIMIT 1`,
    [bundle.projectId, bundle.sessionId],
  );
  if (rows.length === 0) return undefined;
  const row = rows[0];
  return {
    sessionId: String(row.session_id),
    projectId: String(row.project_id),
    portfolioId: String(row.portfolio_id),
  };
}

async function handleResolveManualConflict(
  state: AnalyticsWorkerState,
  request: Extract<AnalyticsRequest, { type: 'resolveManualConflict' }>,
): Promise<AnalyticsResponse> {
  try {
    if (request.resolution === 'keep') {
      const receipt: IngestionReceipt = {
        status: 'superseded',
        generationId: '',
        sessionId: request.bundle.sessionId,
        analysisReleaseId: state.context.analysisReleaseId,
        issueIds: [],
      };
      return { id: 0, ok: true, result: receipt };
    }

    const existing = await findExistingManualSession(state, request.bundle);
    if (existing) {
      await state.reprocessing.deleteSession(
        existing.sessionId,
        existing.projectId,
        existing.portfolioId,
      );
    }

    const bundle = toManualFlowInput(request.bundle);
    const receipt = await state.manualIngestion.ingestManual(bundle);
    return { id: 0, ok: true, result: receipt };
  } catch (error) {
    return toErrorResponse(error);
  }
}

async function handleIngestSyncManifest(
  state: AnalyticsWorkerState,
  request: Extract<AnalyticsRequest, { type: 'ingestSyncManifest' }>,
): Promise<AnalyticsResponse> {
  try {
    const manifest = parseSyncManifest(request.manifest as unknown as Record<string, unknown>);
    const source = {
      sourceId: request.source.sourceId ?? manifest.sourceEnvironmentNamespace ?? 'default',
      environmentId: request.source.environmentId ?? manifest.environmentId,
      projectId: request.source.projectId ?? manifest.projectId,
      sessionId: request.source.sessionId ?? manifest.sessionId,
    };

    // Resolve artifacts from the blob store / sync cache that were retained
    // during sync file download.
    const resolvedArtifacts: ResolvedArtifact[] = [];
    for (const artifact of manifest.artifacts) {
      const resolved = await state.context.resolver.resolve({
        sha256: artifact.sha256,
        size: artifact.size ?? 0,
        relativePath: artifact.relativePath,
        mediaType: artifact.mediaType ?? 'application/octet-stream',
      });
      resolvedArtifacts.push(resolved);
    }

    const bundle: VerifiedManifestBundle = {
      manifest,
      source,
      resolvedArtifacts,
      integrityVerified: false,
    };
    const receipt = await state.ingestion.ingestManifest(bundle);
    return { id: 0, ok: true, result: receipt };
  } catch (error) {
    return toErrorResponse(error);
  }
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
      case 'detectManualHarness':
        return await handleDetectManualHarness(state, request);
      case 'ingestManualBundle':
        return await handleIngestManualBundle(state, request);
      case 'resolveManualConflict':
        return await handleResolveManualConflict(state, request);
      case 'ingestSyncManifest':
        return await handleIngestSyncManifest(state, request);
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
