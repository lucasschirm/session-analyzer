import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';
import { assertEmptyAffordance, assertErrorBoundary } from './helpers/chart-content';

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
 * Worker script used to inject a query failure. It responds to init,
 * resolveProjectId and other housekeeping messages so the app can load; any
 * analytics query is forced to return an error response, which the main-thread
 * client turns into a rejected promise and the page turns into the chart error
 * state.
 */
const FAKE_ANALYTICS_WORKER = `
  self.onmessage = (event) => {
    const request = event.data;
    const id = request.id ?? 0;

    switch (request.type) {
      case 'init':
      case 'getBackend':
        self.postMessage({
          id,
          ok: true,
          backend: {
            backendName: 'wasm-memory',
            durability: 'ephemeral',
            journalMode: 'delete',
            storage: 'memory',
            fallbackReason: undefined,
          },
          storage: 'memory',
          fallbackReason: undefined,
        });
        break;

      case 'resolveProjectId':
        self.postMessage({ id, ok: true, result: request.projectId });
        break;

      case 'query':
        self.postMessage({
          id,
          ok: false,
          error: 'Simulated worker query failure',
        });
        break;

      default:
        self.postMessage({ id, ok: true });
    }
  };
`;

/**
 * Replace the analytics worker with the fake worker above while leaving the
 * database and sync workers untouched.
 */
async function installFakeAnalyticsWorker(page: Page): Promise<void> {
  await page.addInitScript((workerScript: string) => {
    const OriginalWorker = window.Worker;

    class PatchedWorker extends OriginalWorker {
      constructor(scriptURL: string | URL, options?: WorkerOptions) {
        const href =
          typeof scriptURL === 'string'
            ? new URL(scriptURL, window.location.href).href
            : scriptURL.href;

        if (href.includes('analytics-worker')) {
          const blob = new Blob([workerScript], { type: 'application/javascript' });
          super(URL.createObjectURL(blob), { type: 'module' });
        } else {
          super(scriptURL, options);
        }
      }
    }

    window.Worker = PatchedWorker as unknown as typeof Worker;
  }, FAKE_ANALYTICS_WORKER);
}

const EMPTY_PROJECT = 'UX002Empty';
const ERROR_PROJECT = 'UX002Error';

test.describe('UX-002: empty vs error state disambiguation', () => {
  test('empty affordance renders on a genuine zero-row result', async ({ page }) => {
    // Import a real session so the analytics database has data.
    await importSession(page, EMPTY_PROJECT, ['claude-session.jsonl']);

    // Force a zero-row result by filtering on an analysis release that does
    // not exist. This is a real query with real data that returns no rows.
    await page.goto(
      `/#/projects/${encodeURIComponent(EMPTY_PROJECT)}?analysisRelease=no-such-release`,
    );

    await expect(page.getByRole('heading', { name: 'Project Behavior' })).toBeVisible({
      timeout: 15000,
    });

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

    await expect(page.getByRole('heading', { name: 'Project Behavior' })).toBeVisible({
      timeout: 15000,
    });

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
