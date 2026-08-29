import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ANALYTICS_QUERY_TIMEOUT_MS, AnalyticsClient } from '../../src/db/analytics-client';
import type {
  AnalyticsBackendReport,
  AnalyticsRequest,
  AnalyticsResponse,
} from '../../src/db/analytics-protocol';

/** Minimal Worker double that records posted messages and lets tests reply. */
class FakeWorker {
  onmessage: ((event: MessageEvent<AnalyticsResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  posted: AnalyticsRequest[] = [];

  postMessage(request: AnalyticsRequest): void {
    this.posted.push(request);
  }

  respond(response: AnalyticsResponse): void {
    this.onmessage?.({ data: response } as MessageEvent<AnalyticsResponse>);
  }

  fail(message: string): void {
    this.onerror?.({ message } as ErrorEvent);
  }
}

function backendReport(overrides: Partial<AnalyticsBackendReport> = {}): AnalyticsBackendReport {
  return {
    backendName: 'wasm-memory',
    durability: 'ephemeral',
    journalMode: 'delete',
    storage: 'memory',
    ...overrides,
  };
}

describe('AnalyticsClient', () => {
  let worker: FakeWorker;
  let client: AnalyticsClient;

  beforeEach(() => {
    worker = new FakeWorker();
    client = new AnalyticsClient(() => worker as unknown as Worker);
  });

  it('initializes once and reports the backend', async () => {
    const ready = client.ensureReady();
    expect(worker.posted.length).toBe(1);
    expect(worker.posted[0].type).toBe('init');

    worker.respond({ id: worker.posted[0].id, ok: true, backend: backendReport() });
    await expect(ready).resolves.toEqual(backendReport());

    // Second call reuses the first initialization.
    await expect(client.ensureReady()).resolves.toEqual(backendReport());
    expect(worker.posted.length).toBe(1);
  });

  it('correlates concurrent requests by id', async () => {
    void client.ensureReady();
    worker.respond({ id: 1, ok: true, backend: backendReport() });

    const projectsPromise = client.portfolio.getProjectList({});
    const projectPromise = client.project.getSummary('p1', {});

    worker.respond({
      id: 2,
      ok: true,
      result: { token: { generationToken: 'g1' }, items: [] },
    });
    worker.respond({
      id: 3,
      ok: true,
      result: { token: { generationToken: 'g1' }, headlineMetrics: [] },
    });

    await expect(projectsPromise).resolves.toEqual({
      token: { generationToken: 'g1' },
      items: [],
    });
    await expect(projectPromise).resolves.toEqual({
      token: { generationToken: 'g1' },
      headlineMetrics: [],
    });
    expect(worker.posted.map((request) => request.type)).toEqual(['init', 'query', 'query']);
  });

  it('rejects when the worker reports an error response', async () => {
    void client.ensureReady();
    worker.respond({ id: 1, ok: true, backend: backendReport() });

    const promise = client.portfolio.getOverview({});
    worker.respond({ id: worker.posted[1].id, ok: false, error: 'boom' });

    await expect(promise).rejects.toThrow('boom');
  });

  it('rejects all pending calls on worker failure', async () => {
    const ready = client.ensureReady();
    const projects = client.portfolio.getProjectList({});
    const readyAssertion = expect(ready).rejects.toThrow('worker crashed');
    const projectsAssertion = expect(projects).rejects.toThrow('worker crashed');

    worker.fail('worker crashed');

    await readyAssertion;
    await projectsAssertion;
  });

  it('lazily initializes on the first ordinary call', async () => {
    const promise = client.portfolio.getOverview({});
    expect(worker.posted[0].type).toBe('init');
    worker.respond({ id: 1, ok: true, backend: backendReport() });
    worker.respond({ id: 2, ok: true, result: { token: { generationToken: 'g1' } } });

    await expect(promise).resolves.toEqual({ token: { generationToken: 'g1' } });
  });

  it('posts the full query payloads for data source methods', () => {
    void client.ensureReady();
    worker.respond({ id: 1, ok: true, backend: backendReport() });

    void client.portfolio.getOverview({ analysisReleaseId: 'r1' });
    void client.project.getSummary('p1', { timeRange: { start: 'a', end: 'b' } });
    void client.session.getSummary('s1');
    void client.component.getSummary({});
    void client.artifact.getMetadata('a1');
    void client.search.getRootSessionTree('s1');
    void client.metadata.getFilterMetadata({});

    expect(worker.posted[1]).toMatchObject({
      type: 'query',
      view: 'portfolio',
      method: 'getOverview',
      args: [{ analysisReleaseId: 'r1' }],
    });
    expect(worker.posted[2]).toMatchObject({
      type: 'query',
      view: 'project',
      method: 'getSummary',
      args: ['p1', { timeRange: { start: 'a', end: 'b' } }],
    });
    expect(worker.posted[3]).toMatchObject({
      type: 'query',
      view: 'session',
      method: 'getSummary',
      args: ['s1'],
    });
    expect(worker.posted[4]).toMatchObject({
      type: 'query',
      view: 'component',
      method: 'getSummary',
      args: [{}],
    });
    expect(worker.posted[5]).toMatchObject({
      type: 'query',
      view: 'artifact',
      method: 'getMetadata',
      args: ['a1'],
    });
    expect(worker.posted[6]).toMatchObject({
      type: 'query',
      view: 'search',
      method: 'getRootSessionTree',
      args: ['s1'],
    });
    expect(worker.posted[7]).toMatchObject({
      type: 'query',
      view: 'metadata',
      method: 'getFilterMetadata',
      args: [{}],
    });
  });

  it('reports the WASM/OPFS adapter backend', async () => {
    void client.ensureReady();
    worker.respond({ id: 1, ok: true, backend: backendReport() });

    const reportPromise = client.getBackend();
    worker.respond({
      id: worker.posted[1].id,
      ok: true,
      backend: backendReport({ backendName: 'wasm-opfs', storage: 'opfs' }),
    });

    const report = await reportPromise;
    expect(report.backendName).toBe('wasm-opfs');
    expect(report.storage).toBe('opfs');
    expect(report.durability).toBe('ephemeral');
  });

  it('forwards retainSyncArtifact requests and transfers Uint8Array content', async () => {
    void client.ensureReady();
    worker.respond({ id: 1, ok: true, backend: backendReport() });

    const encoder = new TextEncoder();
    const content = encoder.encode('hello');
    const artifact = {
      sha256: 'abc',
      size: 5,
      relativePath: 't.jsonl',
      mediaType: 'application/jsonl',
      content,
      sourceLocation: {
        reacquisitionKey: '/p1/s1/t.jsonl',
        sourceNamespace: 's3',
        relativePath: 't.jsonl',
        retentionClass: 'local' as const,
      },
    };

    void client.retainSyncArtifact(artifact);
    expect(worker.posted[1].type).toBe('retainSyncArtifact');
    const request = worker.posted[1] as Extract<AnalyticsRequest, { type: 'retainSyncArtifact' }>;
    expect(request.artifact.sha256).toBe('abc');
  });

  /**
   * Regression: the sync flow must feed manifests into the analytics ingestion
   * pipeline. If the client does not post `ingestSyncManifest`, synced sessions
   * never produce metrics and portfolio charts stay empty.
   */
  it('posts ingestSyncManifest with manifest and source and unwraps the receipt', async () => {
    void client.ensureReady();
    worker.respond({ id: 1, ok: true, backend: backendReport() });

    const manifest = {
      schemaVersion: 2,
      projectId: 'p1',
      sessionId: 's1',
      harness: 'claude-code',
      mainTranscriptRelativePath: 'session/transcript.jsonl',
      artifacts: [],
      syncRuns: [],
    };
    const source = { sourceId: 'sync', projectId: 'p1', sessionId: 's1' };

    const promise = client.ingestSyncManifest(manifest, source);
    expect(worker.posted[1].type).toBe('ingestSyncManifest');
    const request = worker.posted[1] as Extract<AnalyticsRequest, { type: 'ingestSyncManifest' }>;
    expect(request.manifest).toEqual(manifest);
    expect(request.source).toEqual(source);

    const receipt = { generationId: 'gen-1', status: 'committed', issueIds: [] };
    worker.respond({ id: request.id, ok: true, result: receipt });

    await expect(promise).resolves.toEqual(receipt);
  });

  it('rejects ingestSyncManifest when the worker reports an error', async () => {
    void client.ensureReady();
    worker.respond({ id: 1, ok: true, backend: backendReport() });

    const promise = client.ingestSyncManifest({ artifacts: [] }, { sourceId: 'sync' });
    worker.respond({ id: worker.posted[1].id, ok: false, error: 'ingest failed' });

    await expect(promise).rejects.toThrow('ingest failed');
  });

  it('does not carry SQL implementation types across the worker boundary', async () => {
    // A query request should only contain DTO fields.
    const query: AnalyticsRequest = {
      id: 1,
      type: 'query',
      view: 'portfolio',
      method: 'getOverview',
      args: [{ analysisReleaseId: 'r1' }],
    };

    // @ts-expect-error - SQL rows must not leak into the protocol.
    const bad: AnalyticsRequest = { ...query, rows: [{ id: 1 }] };

    void bad; // satisfy lint: type-only boundary assertion

    const worker2 = new FakeWorker();
    const client2 = new AnalyticsClient(() => worker2 as unknown as Worker);
    void client2.ensureReady();
    worker2.respond({ id: 1, ok: true, backend: backendReport() });

    const promise = client2.portfolio.getOverview({});
    worker2.respond({ id: 2, ok: true, result: { token: { generationToken: 'g1' } } });
    await expect(promise).resolves.toEqual({ token: { generationToken: 'g1' } });
  });

  it('rejects a query when the worker never responds within the timeout', async () => {
    vi.useFakeTimers();
    try {
      void client.ensureReady();
      worker.respond({ id: worker.posted[0].id, ok: true, backend: backendReport() });

      const promise = client.portfolio.getOverview({});
      const request = worker.posted[worker.posted.length - 1];
      expect(request.type).toBe('query');

      vi.advanceTimersByTime(ANALYTICS_QUERY_TIMEOUT_MS / 2);
      await expect(Promise.race([promise, Promise.resolve('still-pending')])).resolves.toBe(
        'still-pending',
      );

      vi.advanceTimersByTime(ANALYTICS_QUERY_TIMEOUT_MS - ANALYTICS_QUERY_TIMEOUT_MS / 2);
      await expect(promise).rejects.toThrow(
        `analytics query timed out after ${ANALYTICS_QUERY_TIMEOUT_MS}ms`,
      );

      // A late response must not be able to resolve or reject the timed-out promise again.
      expect(() =>
        worker.respond({
          id: request.id,
          ok: true,
          result: { token: { generationToken: 'late' } },
        }),
      ).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolves a query that responds before the timeout', async () => {
    vi.useFakeTimers();
    try {
      void client.ensureReady();
      worker.respond({ id: worker.posted[0].id, ok: true, backend: backendReport() });

      const promise = client.portfolio.getOverview({});
      const request = worker.posted[worker.posted.length - 1];
      worker.respond({
        id: request.id,
        ok: true,
        result: { token: { generationToken: 'g1' } },
      });

      vi.advanceTimersByTime(ANALYTICS_QUERY_TIMEOUT_MS / 2);
      await expect(promise).resolves.toEqual({ token: { generationToken: 'g1' } });
    } finally {
      vi.useRealTimers();
    }
  });
});
