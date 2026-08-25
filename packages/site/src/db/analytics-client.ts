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
  MetadataView,
  PortfolioView,
  ProjectBehaviorView,
  ProjectSessionSearchView,
  ResolvedArtifact,
  SessionEvidenceView,
} from '@lucasschirm/sal-db';
import type {
  AnalyticsBackendReport,
  AnalyticsRequest,
  AnalyticsRequestPayload,
  AnalyticsResponse,
} from './analytics-protocol';

export type { AnalyticsBackendReport };

export type CreateWorkerFactory = () => Worker;

const defaultWorkerFactory: CreateWorkerFactory = () =>
  new Worker(new URL('./analytics-worker.ts', import.meta.url), {
    type: 'module',
  });

function postRequest(worker: Worker, request: AnalyticsRequest): void {
  worker.postMessage(request);
}

export class AnalyticsClient implements AnalyticsDataSource {
  readonly portfolio: PortfolioView;
  readonly project: ProjectBehaviorView;
  readonly session: SessionEvidenceView;
  readonly component: ComponentEcosystemView;
  readonly artifact: ArtifactVersionView;
  readonly search: ProjectSessionSearchView;
  readonly metadata: MetadataView;

  private readonly worker: Worker;
  private readonly pending = new Map<
    number,
    { resolve: (value: AnalyticsResponse) => void; reject: (reason: Error) => void }
  >();
  private nextId = 1;
  private initPromise: Promise<AnalyticsBackendReport> | null = null;
  private fallbackReason?: 'locked' | 'unsupported';

  fallbackReasonForInit?: 'locked' | 'unsupported';

  constructor(createWorker: CreateWorkerFactory = defaultWorkerFactory) {
    this.worker = createWorker();
    this.worker.onmessage = (event: MessageEvent<AnalyticsResponse>) => {
      this.handleResponse(event.data);
    };
    this.worker.onerror = (event) => {
      this.rejectAll(String(event.message ?? 'worker error'));
    };
    this.worker.onmessageerror = () => {
      this.rejectAll('worker message deserialization error');
    };

    this.portfolio = this.createViewClient<PortfolioView>('portfolio');
    this.project = this.createViewClient<ProjectBehaviorView>('project');
    this.session = this.createViewClient<SessionEvidenceView>('session');
    this.component = this.createViewClient<ComponentEcosystemView>('component');
    this.artifact = this.createViewClient<ArtifactVersionView>('artifact');
    this.search = this.createViewClient<ProjectSessionSearchView>('search');
    this.metadata = this.createViewClient<MetadataView>('metadata');
  }

  private createViewClient<View extends object>(viewName: string): View {
    return new Proxy({} as View, {
      get: (_target, method) => {
        if (typeof method !== 'string') return undefined;
        return (...args: unknown[]) => this.query(viewName, method, args);
      },
    });
  }

  private rejectAll(message: string): void {
    const error = new Error(message);
    for (const { reject } of this.pending.values()) {
      reject(error);
    }
    this.pending.clear();
  }

  private handleResponse(response: AnalyticsResponse): void {
    const handler = this.pending.get(response.id);
    if (!handler) return;
    this.pending.delete(response.id);
    if (response.ok) {
      handler.resolve(response);
    } else {
      handler.reject(new Error(response.error));
    }
  }

  private send(request: AnalyticsRequestPayload): Promise<AnalyticsResponse> {
    const id = this.nextId++;
    const withId = { ...request, id } as AnalyticsRequest;
    const promise = new Promise<AnalyticsResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    postRequest(this.worker, withId);
    return promise;
  }

  private call(request: AnalyticsRequestPayload): Promise<AnalyticsResponse> {
    if (!this.initPromise) {
      this.ensureReady();
    }
    return this.send(request);
  }

  private async query(view: string, method: string, args: unknown[]): Promise<unknown> {
    const response = await this.call({
      type: 'query',
      view: view as keyof AnalyticsDataSource,
      method,
      args: args as unknown[],
    });
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
   * analytics blob store and resolver cache. The Uint8Array content is
   * transferred, not copied, when possible.
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

  async close(): Promise<void> {
    const response = await this.call({ type: 'close' });
    if (!response.ok) {
      throw new Error(response.error);
    }
    this.initPromise = null;
  }
}
