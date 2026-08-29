/**
 * Main-thread client for the analytics Web Worker.
 *
 * Exposes the full `AnalyticsDataSource` contract so Lit pages can query the
 * analytics database without importing any SQL types. All communication with
 * the worker is DTO-only.
 */

import type {
  AnalyticsDataSource,
  ArtifactVersionView,
  ComponentEcosystemView,
  IngestionReceipt,
  ManualIngestionDetection,
  MetadataView,
  PortfolioView,
  ProjectBehaviorView,
  ProjectSessionSearchView,
  ResolvedArtifact,
  SessionEvidenceView,
} from '@lucasschirm/sal-db';
import type {
  AnalyticsBackendReport,
  AnalyticsDataChangedBroadcast,
  AnalyticsRequest,
  AnalyticsRequestPayload,
  AnalyticsResponse,
  ManualArtifactPayload,
  ManualIngestionBundleRequest,
} from './analytics-protocol';

export type { AnalyticsBackendReport, ManualArtifactPayload, ManualIngestionBundleRequest };

export type CreateWorkerFactory = () => Worker;

const defaultWorkerFactory: CreateWorkerFactory = () =>
  new Worker(new URL('./analytics-worker.ts', import.meta.url), {
    type: 'module',
  });

function postRequest(worker: Worker, request: AnalyticsRequest): void {
  worker.postMessage(request);
}

/**
 * 30s matches the default sync operation timeout budget and is long enough for
 * heavy analytics queries while still surfacing a hung worker promptly.
 */
export const ANALYTICS_QUERY_TIMEOUT_MS = 30_000;

interface PendingHandler {
  resolve: (value: AnalyticsResponse) => void;
  reject: (reason: Error) => void;
  timer?: number;
}

export interface ManualImportClient {
  /** Detect which harness (if any) matches the supplied artifacts. */
  detect(artifacts: ManualArtifactPayload[]): Promise<ManualIngestionDetection>;
  /** Ingest a manually supplied artifact bundle as a partial generation. */
  ingest(bundle: ManualIngestionBundleRequest): Promise<IngestionReceipt>;
  /** Resolve a manual-import conflict by replacing or keeping the existing generation. */
  resolveConflict(
    bundle: ManualIngestionBundleRequest,
    resolution: 'replace' | 'keep',
  ): Promise<IngestionReceipt>;
}

export class AnalyticsClient extends EventTarget implements AnalyticsDataSource {
  readonly portfolio: PortfolioView;
  readonly project: ProjectBehaviorView;
  readonly session: SessionEvidenceView;
  readonly component: ComponentEcosystemView;
  readonly artifact: ArtifactVersionView;
  readonly search: ProjectSessionSearchView;
  readonly metadata: MetadataView;
  readonly manual: ManualImportClient;

  private worker: Worker | null = null;
  private readonly createWorker: CreateWorkerFactory;
  private readonly pending = new Map<number, PendingHandler>();
  private nextId = 1;
  private initPromise: Promise<AnalyticsBackendReport> | null = null;
  private fallbackReason?: 'locked' | 'unsupported';

  fallbackReasonForInit?: 'locked' | 'unsupported';

  constructor(createWorker: CreateWorkerFactory = defaultWorkerFactory) {
    super();
    this.createWorker = createWorker;

    this.portfolio = this.createViewClient<PortfolioView>('portfolio');
    this.project = this.createViewClient<ProjectBehaviorView>('project');
    this.session = this.createViewClient<SessionEvidenceView>('session');
    this.component = this.createViewClient<ComponentEcosystemView>('component');
    this.artifact = this.createViewClient<ArtifactVersionView>('artifact');
    this.search = this.createViewClient<ProjectSessionSearchView>('search');
    this.metadata = this.createViewClient<MetadataView>('metadata');
    this.manual = this.createManualClient();
  }

  private ensureWorker(): Worker {
    if (!this.worker) {
      const worker = this.createWorker();
      worker.onmessage = (
        event: MessageEvent<AnalyticsResponse | AnalyticsDataChangedBroadcast>,
      ) => {
        this.handleResponse(event.data);
      };
      worker.onerror = (event) => {
        this.rejectAll(String(event.message ?? 'worker error'));
      };
      worker.onmessageerror = () => {
        this.rejectAll('worker message deserialization error');
      };
      this.worker = worker;
    }
    return this.worker;
  }

  private createViewClient<View extends object>(viewName: string): View {
    return new Proxy({} as View, {
      get: (_target, method) => {
        if (typeof method !== 'string') return undefined;
        return (...args: unknown[]) => this.query(viewName, method, args);
      },
    });
  }

  private createManualClient(): ManualImportClient {
    return {
      detect: (artifacts) =>
        this.postAndReturn<ManualIngestionDetection>({
          type: 'detectManualHarness',
          artifacts,
        }),
      ingest: (bundle) =>
        this.postAndReturn<IngestionReceipt>({
          type: 'ingestManualBundle',
          bundle,
        }),
      resolveConflict: (bundle, resolution) =>
        this.postAndReturn<IngestionReceipt>({
          type: 'resolveManualConflict',
          bundle,
          resolution,
        }),
    };
  }

  private rejectAll(message: string): void {
    const error = new Error(message);
    for (const handler of this.pending.values()) {
      window.clearTimeout(handler.timer);
      handler.reject(error);
    }
    this.pending.clear();
  }

  private handleResponse(response: AnalyticsResponse | AnalyticsDataChangedBroadcast): void {
    if ('type' in response && response.type === 'dataChanged') {
      this.dispatchEvent(new CustomEvent('data-change'));
      return;
    }
    const typed = response as AnalyticsResponse;
    const handler = this.pending.get(typed.id);
    if (!handler) return;
    this.pending.delete(typed.id);
    window.clearTimeout(handler.timer);
    if (typed.ok) {
      handler.resolve(typed);
    } else {
      handler.reject(new Error(typed.error));
    }
  }

  private send(request: AnalyticsRequestPayload, timeoutMs?: number): Promise<AnalyticsResponse> {
    const worker = this.ensureWorker();
    const id = this.nextId++;
    const withId = { ...request, id } as AnalyticsRequest;
    const promise = new Promise<AnalyticsResponse>((resolve, reject) => {
      const handler: PendingHandler = { resolve, reject };
      this.pending.set(id, handler);
      if (timeoutMs) {
        handler.timer = window.setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`analytics query timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }
    });
    postRequest(worker, withId);
    return promise;
  }

  private call(request: AnalyticsRequestPayload, timeoutMs?: number): Promise<AnalyticsResponse> {
    if (!this.initPromise) {
      this.ensureReady();
    }
    return this.send(request, timeoutMs);
  }

  private async postAndReturn<T>(request: AnalyticsRequestPayload): Promise<T> {
    const response = await this.call(request);
    if (!response.ok) {
      throw new Error(response.error);
    }
    return response.result as T;
  }

  private async query(view: string, method: string, args: unknown[]): Promise<unknown> {
    const response = await this.call(
      {
        type: 'query',
        view: view as keyof AnalyticsDataSource,
        method,
        args: args as unknown[],
      },
      ANALYTICS_QUERY_TIMEOUT_MS,
    );
    if (!response.ok) {
      throw new Error(response.error);
    }
    return response.result;
  }

  /**
   * Ensures the worker has initialized and returns the backend report.
   * Subsequent calls reuse the same initialization.
   */
  async ensureReady(): Promise<AnalyticsBackendReport> {
    if (this.initPromise) return this.initPromise;

    this.ensureWorker();
    this.initPromise = this.send({ type: 'init' })
      .then((response) => {
        if (!response.ok) {
          throw new Error(response.error);
        }
        if (!response.backend) {
          throw new Error('worker did not report backend');
        }
        this.fallbackReason = response.backend.fallbackReason;
        this.fallbackReasonForInit = response.backend.fallbackReason;
        return response.backend;
      })
      .catch((error) => {
        this.initPromise = null;
        throw error;
      });

    return this.initPromise;
  }

  private inferBackend(storage: 'opfs' | 'memory' | undefined): AnalyticsBackendReport {
    return {
      backendName: storage === 'opfs' ? 'wasm-opfs' : 'wasm-memory',
      durability: storage === 'opfs' ? 'persistent' : 'ephemeral',
      journalMode: 'delete',
      storage: storage ?? 'memory',
      fallbackReason: this.fallbackReason,
    };
  }

  /**
   * Reports the WASM/OPFS adapter backend from the worker. This is a separate
   * round-trip so tests can verify adapter backend reporting without depending
   * on an explicit query.
   */
  async getBackend(): Promise<AnalyticsBackendReport> {
    const response = await this.call({ type: 'getBackend' });
    if (!response.ok) {
      throw new Error(response.error);
    }
    return response.backend ?? this.inferBackend(response.storage);
  }

  /**
   * Forwards a resolved artifact downloaded by the sync worker into the
   * analytics blob store and resolver cache.
   */
  async retainSyncArtifact(artifact: ResolvedArtifact): Promise<void> {
    const response = await this.call({
      type: 'retainSyncArtifact',
      artifact,
    });
    if (!response.ok) {
      throw new Error(response.error);
    }
  }

  /**
   * Ingest a sync manifest bundle into the analytics pipeline. Artifacts must
   * have been previously retained via `retainSyncArtifact` so the worker can
   * resolve them from the blob store or sync cache.
   */
  async ingestSyncManifest(
    manifest: unknown,
    source: {
      sourceId: string;
      environmentId?: string;
      projectId?: string;
      sessionId?: string;
    },
  ): Promise<IngestionReceipt> {
    const response = await this.call({
      type: 'ingestSyncManifest',
      manifest,
      source,
    });
    if (!response.ok) {
      throw new Error(response.error);
    }
    return response.result as IngestionReceipt;
  }

  /**
   * Resolve a project identifier (which may be a native/sync project id or an
   * internal analytics project id) to the internal analytics project id used
   * by all analytics queries. Returns null if no matching project exists.
   */
  async resolveProjectId(projectId: string): Promise<string | null> {
    const response = await this.call({
      type: 'resolveProjectId',
      projectId,
    });
    if (!response.ok) {
      throw new Error(response.error);
    }
    return (response.result as string | null) ?? null;
  }

  /**
   * Delete a project and all its derived data (sessions, rollups, distributions)
   * from the analytics DB. Safe to call even if the project was never ingested
   * into the analytics DB.
   */
  async deleteProject(projectId: string): Promise<void> {
    const response = await this.call({
      type: 'deleteProject',
      projectId,
    });
    if (!response.ok) {
      throw new Error(response.error);
    }
  }

  async close(): Promise<void> {
    const response = await this.call({ type: 'close' });
    if (!response.ok) {
      throw new Error(response.error);
    }
    this.initPromise = null;
    this.worker = null;
  }
}

/**
 * Shared, lazy analytics client. The worker is only created on the first view
 * method call, so importing this module in tests or on pages that do not use
 * analytics has no side effects.
 */
export const analyticsClient = new AnalyticsClient();
