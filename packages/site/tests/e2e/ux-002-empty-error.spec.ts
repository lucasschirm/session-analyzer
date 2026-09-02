import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';
import { assertEmptyAffordance, assertErrorBoundary } from './helpers/chart-content';
import { buildFailingQueryWorker, installFailingWorker } from './helpers/worker-failure';

/**
 * UX-002: Empty state vs error state are visually and structurally
 * distinguishable on the Project Behavior charts.
 *
 * This file exercises the real analytics query → chart rendering path. It does
 * not stub the <analytics-chart> state prop directly. The empty branch triggers
 * a genuine zero-row result through an unmatched analysis-release filter; the
 * error branch replaces the analytics worker with a failing worker so the
 * query failure propagates through analytics-client and into the chart state.
 */

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

function fixture(name: string): string {
  return path.join(FIXTURES_DIR, name);
}

/**
 * Import a session file through the Manual Import flow into a new analytics
 * project. Reuses the flow established by app.spec.ts.
 */
async function importSession(page: Page, projectName: string, fileNames: string[]): Promise<void> {
  await page.goto('/#/manual-import');
  await expect(page.getByRole('heading', { name: 'Manual Import' })).toBeVisible();

  const filePaths = fileNames.map((f) => fixture(f));
  await page.locator('input[type="file"]').setInputFiles(filePaths);

  await expect(page.getByRole('heading', { name: 'Harness' })).toBeVisible({ timeout: 15000 });

  const projectSelect = page.locator('#project-select');
  await projectSelect.selectOption('__new__');
  await page.locator('input[placeholder="New project name"]').fill(projectName);

  const sessionInput = page.locator('#session-input');
  await expect(sessionInput).not.toHaveValue('');

  await page.getByRole('button', { name: 'Import partial session' }).click();

  await expect(page.getByRole('button', { name: 'View session' })).toBeVisible({
    timeout: 30000,
  });
}

/**
 * Replace the analytics worker with a fake worker that answers the boot
 * handshake but fails every query, while leaving the database and sync
 * workers untouched. See `helpers/worker-failure.ts`.
 */
async function installFakeAnalyticsWorker(page: Page): Promise<void> {
  await installFailingWorker(page, {
    match: 'analytics-worker',
    workerScript: buildFailingQueryWorker('Simulated worker query failure'),
  });
}

const EMPTY_PROJECT = 'UX002Empty';
const ERROR_PROJECT = 'UX002Error';

test.describe('UX-002: empty vs error state disambiguation', () => {
  test('empty affordance renders on a genuine zero-row result', async ({ page }) => {
    // Import a real session so the analytics database has data.
    await importSession(page, EMPTY_PROJECT, ['claude-session.jsonl']);

    // Force a zero-row result with a real time window that excludes every
    // seeded session — the project-behavior query methods (issue #171)
    // scope by `query.timeRange`, not `analysisReleaseId`, so a narrowed
    // window (rather than an unmatched release) is what actually empties
    // the duration-histogram panel.
    await page.goto(
      `/#/projects/${encodeURIComponent(EMPTY_PROJECT)}?timeStart=2099-01-01T00%3A00%3A00.000Z&timeEnd=2099-01-02T00%3A00%3A00.000Z`,
    );

    await expect(page.locator('filter-bar')).toBeVisible({ timeout: 15000 });

    // Target a real analytics-chart inside the project-behavior shadow tree.
    const chart = page
      .locator('css=app-root >> css=project-behavior-view >> css=analytics-chart')
      .first();
    await expect(chart).toBeVisible({ timeout: 15000 });

    // Assert the empty affordance is present and not conflated with an error.
    // The helper proves the chart's shadow DOM carries a .state-empty badge
    // and no .state-error / role=alert marker.
    await expect(() => assertEmptyAffordance(chart)).toPass({ timeout: 10000 });
  });

  test('error affordance renders on a forced worker query failure', async ({ page }) => {
    // Replace the analytics worker before the app creates it so every project
    // query fails and the page must surface an error state in the chart.
    await installFakeAnalyticsWorker(page);

    await page.goto(`/#/projects/${encodeURIComponent(ERROR_PROJECT)}`);

    await expect(page.locator('filter-bar')).toBeVisible({ timeout: 15000 });

    // Target a real analytics-chart inside the project-behavior shadow tree.
    const chart = page
      .locator('css=app-root >> css=project-behavior-view >> css=analytics-chart')
      .first();
    await expect(chart).toBeVisible({ timeout: 15000 });

    // Assert the error affordance is present and not conflated with an empty
    // state. The helper proves the chart's shadow DOM carries a .state-error
    // marker and no .state-empty / .state-unavailable marker.
    await expect(() => assertErrorBoundary(chart)).toPass({ timeout: 10000 });
  });
});
