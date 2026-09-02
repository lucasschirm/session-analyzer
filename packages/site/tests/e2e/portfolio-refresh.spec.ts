import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';
import { type ChartGeometry, getRenderedGeometry } from './helpers/chart-content';
import { captureAnalyticsWorker, seedSession } from './helpers/seeded-store';

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

function fixture(name: string): string {
  return path.join(FIXTURES_DIR, name);
}

/**
 * Read the current numeric session-count value from the portfolio view's
 * Sessions KPI tile (`stat-tile-hero`, issue #170's KPI band).
 *
 * Returns `null` when the tile has no value yet (e.g. while loading).
 */
async function readPortfolioSessionCount(page: Page): Promise<number | null> {
  const tile = page.locator('stat-tile-hero');
  const count = await tile.count();
  if (count === 0) {
    return null;
  }
  const raw = await tile.first().getAttribute('value');
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
 * current page, without leaving the Portfolio route. See
 * `helpers/seeded-store.ts` for why this avoids a second `AnalyticsClient`.
 */
async function ingestSessionFromPortfolio(
  page: Page,
  projectName: string,
  sessionId: string,
  fixtureName: string,
): Promise<void> {
  const content = fs.readFileSync(fixture(fixtureName), 'utf8');
  await seedSession({
    page,
    projectId: projectName,
    sessionId,
    content,
    importBatchIdPrefix: 'ux003',
  });
}

test.describe('Portfolio refresh liveness', () => {
  test.beforeEach(async ({ page }) => {
    // Capture the page's Analytics Web Worker so the test can push manual
    // ingestion messages through the same worker that the Portfolio view uses.
    await captureAnalyticsWorker(page);
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
    const preGeometry = await getChartGeometryByTitle(page, 'Token usage trend');

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
        async () => (await getChartGeometryByTitle(page, 'Token usage trend'))?.shapeCount ?? -1,
        {
          message: 'Token usage trend chart should render new geometry after the second upload',
          timeout: 10000,
        },
      )
      .toBeGreaterThan(preGeometry?.shapeCount ?? 0);
  });
});
