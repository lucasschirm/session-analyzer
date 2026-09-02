import type { Page } from '@playwright/test';

/**
 * Seeded-store fixture loader: ingest a fixture directly into the app's
 * already-running analytics worker, bypassing the Manual Import UI.
 *
 * Generalizes the pattern introduced by `portfolio-refresh.spec.ts`
 * (`ingestSessionFromPortfolio`): pushing detect + ingest messages through the
 * *same* worker instance the page under test is already using avoids creating
 * a second `AnalyticsClient`/Web Worker, which can hit an OPFS lock fallback
 * in Chromium and make a second upload invisible to the page. This is the
 * seam later sub-issues need to seed the store with fixture data without
 * round-tripping through file-picker UI for every test.
 */

declare global {
  interface Window {
    /** Captured analytics worker instance, set by `captureAnalyticsWorker`. */
    __analyticsWorker?: Worker;
    /** Resolves the in-flight `captureAnalyticsWorker` wait, if any. */
    __onAnalyticsWorkerReady?: (worker: Worker) => void;
  }
}

/**
 * Register an init script that captures the app's analytics worker instance
 * onto `window.__analyticsWorker` as soon as it is constructed. Call this in
 * `test.beforeEach` (or before `page.goto`) so `seedSession` can find the
 * worker once the app boots.
 */
export async function captureAnalyticsWorker(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const OrigWorker = window.Worker;
    window.Worker = class extends OrigWorker {
      constructor(scriptURL: string | URL, options?: WorkerOptions) {
        super(scriptURL, options);
        const href = typeof scriptURL === 'string' ? scriptURL : scriptURL.href;
        if (href.includes('analytics-worker')) {
          window.__analyticsWorker = this;
          if (typeof window.__onAnalyticsWorkerReady === 'function') {
            window.__onAnalyticsWorkerReady(this);
          }
        }
      }
    };
  });
}

export interface SeedSessionOptions {
  page: Page;
  projectId: string;
  sessionId: string;
  /** Raw fixture file content (e.g. a `.jsonl` transcript already read from disk). */
  content: string;
  /** Relative artifact path/extension the harness detector expects. Default `${sessionId}.jsonl`. */
  relativePath?: string;
  mediaType?: string;
  /** Prefix used to build a unique `importBatchId`. Default `'seed'`. */
  importBatchIdPrefix?: string;
}

/**
 * Ingest a fixture into the analytics worker captured by
 * `captureAnalyticsWorker`, exercising the same detect + ingest worker
 * messages as the Manual Import page, without the file-picker UI.
 *
 * Requires `captureAnalyticsWorker(page)` to have run (usually in
 * `beforeEach`) before `page.goto()`, so `window.__analyticsWorker` is
 * available by the time this is called.
 */
export async function seedSession(options: SeedSessionOptions): Promise<void> {
  const {
    page,
    projectId,
    sessionId,
    content,
    relativePath = `${sessionId}.jsonl`,
    mediaType = 'application/jsonl',
    importBatchIdPrefix = 'seed',
  } = options;

  await page.evaluate(
    async ({
      projectId: pid,
      sessionId: sid,
      content: fixtureContent,
      relativePath: rp,
      mediaType: mt,
      importBatchIdPrefix: prefix,
    }) => {
      const worker = await new Promise<Worker>((resolve, reject) => {
        if (window.__analyticsWorker) {
          resolve(window.__analyticsWorker);
          return;
        }
        window.__onAnalyticsWorkerReady = (w) => resolve(w);
        setTimeout(() => reject(new Error('analytics worker was not created within 30s')), 30000);
      });

      function sendMessage<T>(type: string, payload: Record<string, unknown>): Promise<T> {
        const id = 1_000_000 + Math.floor(Math.random() * 1_000_000_000);
        return new Promise((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error(`worker ${type} message timed out`)),
            30000,
          );
          const listener = (event: MessageEvent) => {
            if (event.data?.id === id) {
              clearTimeout(timeout);
              worker.removeEventListener('message', listener);
              resolve(event.data as T);
            }
          };
          worker.addEventListener('message', listener);
          worker.postMessage({ id, type, ...payload });
        });
      }

      const artifact = { relativePath: rp, mediaType: mt, content: fixtureContent };

      const detectResponse = await sendMessage<{
        ok: boolean;
        result?: { harness?: string };
        error?: string;
      }>('detectManualHarness', { artifacts: [artifact] });

      if (!detectResponse.ok || !detectResponse.result?.harness) {
        throw new Error(
          `Harness detection failed: ${detectResponse.error ?? 'no harness matched'}`,
        );
      }

      const bundle = {
        artifacts: [artifact],
        source: { sourceId: 'manual' },
        harness: detectResponse.result.harness,
        projectId: pid,
        sessionId: sid,
        importBatchId: `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      };

      const ingestResponse = await sendMessage<{
        ok: boolean;
        result?: { status: string; sessionId: string };
        error?: string;
      }>('ingestManualBundle', { bundle });

      if (!ingestResponse.ok) {
        throw new Error(`Ingestion failed: ${ingestResponse.error ?? 'unknown'}`);
      }
      if (
        ingestResponse.result?.status !== 'committed' &&
        ingestResponse.result?.status !== 'superseded'
      ) {
        throw new Error(
          `Ingestion was not committed: ${ingestResponse.result?.status ?? 'unknown'}`,
        );
      }
    },
    {
      projectId,
      sessionId,
      content,
      relativePath,
      mediaType,
      importBatchIdPrefix,
    },
  );
}
