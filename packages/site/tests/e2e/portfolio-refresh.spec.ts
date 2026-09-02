import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';
import { type ChartGeometry, getRenderedGeometry } from './helpers/chart-content';

declare global {
  interface Window {
    /** Captured analytics worker instance, set by the test init script. */
    __analyticsWorker?: Worker;
    /** Optional callback for tests waiting on the analytics worker. */
    __onAnalyticsWorkerReady?: (worker: Worker) => void;
  }
}

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

function fixture(name: string): string {
  return path.join(FIXTURES_DIR, name);
}

/**
 * Read the current numeric session-count value from the portfolio view.
 *
 * Returns `null` when the view has no "Session count" metric card yet (e.g.
 * while loading or when it is empty).
 */
async function readPortfolioSessionCount(page: Page): Promise<number | null> {
  const card = page.locator('metrics-card').filter({
    has: page.locator('.label', { hasText: 'Session count' }),
  });
  const count = await card.count();
  if (count === 0) {
    return null;
  }
  const raw = await card.first().locator('.value').textContent({ timeout: 5000 });
  if (!raw) return null;
  const numeric = Number(raw.trim());
  return Number.isNaN(numeric) ? null : numeric;
}

/**
 * Locate an `analytics-chart` by its visible title and return its rendered
 * ECharts geometry, or `null` if the chart is not present or has no rendered
 * marks yet.
 */
async function getChartGeometryByTitle(page: Page, title: string): Promise<ChartGeometry | null> {
  const chart = page.locator('analytics-chart').filter({
    has: page.locator('.chart-title', { hasText: title }),
  });
  if ((await chart.count()) === 0) {
    return null;
  }
  return getRenderedGeometry(chart.first());
}

/**
 * Ingest a fixture into the analytics worker that is already running for the
 * current page, without leaving the Portfolio route.
 *
 * This exercises the same ingestion pipeline as the Manual Import page, but it
 * avoids creating a second `AnalyticsClient`/Web Worker, which can hit an OPFS
 * lock fallback in Chromium and make the second upload invisible. The portfolio
 * re-query defect is about the UI refreshing when the data in the *same* worker
 * changes, so this is the cleanest way to test it.
 */
async function ingestSessionFromPortfolio(
  page: Page,
  projectName: string,
  sessionId: string,
  fixtureName: string,
): Promise<void> {
  const content = fs.readFileSync(fixture(fixtureName), 'utf8');

  await page.evaluate(
    async ({ projectId, sessionId: sid, content: fixtureContent }) => {
      const worker = await new Promise<Worker>((resolve, reject) => {
        if (window.__analyticsWorker) {
          resolve(window.__analyticsWorker);
          return;
        }
        window.__onAnalyticsWorkerReady = (worker) => resolve(worker);
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

      const artifact = {
        relativePath: `${sid}.jsonl`,
        mediaType: 'application/jsonl',
        content: fixtureContent,
      };

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
        projectId,
        sessionId: sid,
        importBatchId: `ux003-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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
    { projectId: projectName, sessionId, content },
  );
}

test.describe('Portfolio refresh liveness', () => {
  test.beforeEach(async ({ page }) => {
    // Capture the page's Analytics Web Worker so the test can push manual
    // ingestion messages through the same worker that the Portfolio view uses.
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
  });

  test('UX-003: portfolio metrics and chart geometry refresh live after a second upload', async ({
    page,
  }) => {
    test.setTimeout(120000);

    const projectName = `UX-003-Portfolio-Refresh-${randomUUID()}`;

    // 1. Land on the Portfolio (Dashboard) view once and never reload or navigate away.
    await page.goto('/#/');
    await expect(page.locator('portfolio-view')).toBeVisible({ timeout: 30000 });
    await expect(page.getByText('Loading portfolio…')).not.toBeVisible({ timeout: 30000 });

    // 2. Ingest session A through the same analytics worker that the Portfolio
    //    view uses (simulating a session upload while on the page).
    await ingestSessionFromPortfolio(page, projectName, 'ux003-session-a', 'claude-session.jsonl');

    // 3. Read the pre-second-upload metric and chart state from the portfolio.
    //    The re-query defect means this is usually still the empty state.
    const preMetric = await readPortfolioSessionCount(page);
    const preGeometry = await getChartGeometryByTitle(page, 'Session Metrics');

    // 4. Ingest session B into the same project, still on #/ (Dashboard).
    await ingestSessionFromPortfolio(
      page,
      projectName,
      'ux003-session-b',
      'claude-rich-session.jsonl',
    );

    // 5. Poll the same Portfolio page for the live-refresh to take effect.
    //    A correct implementation re-queries without a page reload; the
    //    documented `portfolio-view.ts:~104` re-query-only-on-hashchange defect
    //    leaves the metric stuck at the pre-upload value.
    await expect
      .poll(async () => (await readPortfolioSessionCount(page)) ?? -1, {
        message: 'Portfolio session-count metric should have increased after the second upload',
        timeout: 10000,
      })
      .toBeGreaterThan(preMetric ?? 0);

    await expect
      .poll(
        async () => (await getChartGeometryByTitle(page, 'Session Metrics'))?.shapeCount ?? -1,
        {
          message: 'Session Metrics chart should render new geometry after the second upload',
          timeout: 10000,
        },
      )
      .toBeGreaterThan(preGeometry?.shapeCount ?? 0);
  });
});
