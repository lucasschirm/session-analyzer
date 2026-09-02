import { expect, type Page, test } from '@playwright/test';
import { installFailingWorker } from './helpers/worker-failure';

const HANGING_PROJECT = 'UX009Hang';

const HANGING_ANALYTICS_WORKER = `
const token = {
  analysisReleaseId: '',
  generationId: 'gen-hang',
  comparabilityGroupId: '',
  eligibleN: 0,
  knownN: 0,
  unknownCount: 0,
  coverage: 'complete',
  measurementClass: 'observed',
  confidence: 'high',
  metricVersion: '1.0.0',
  evidenceLinks: [],
};

const emptySummary = { token, headlineMetrics: [], trendToken: token };
const emptyTrends = { token, series: [] };
const emptyTimeline = { token, events: [] };
const emptyOutliers = { items: [], generationToken: 'gen-hang', analysisReleaseToken: '' };
const emptyComparisons = { items: [], generationToken: 'gen-hang', analysisReleaseToken: '' };

function replyOk(id, result) {
  self.postMessage({ id, ok: true, result });
}

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
      });
      break;

    case 'resolveProjectId':
      self.postMessage({ id, ok: true, result: request.projectId });
      break;

    case 'query':
      if (request.view === 'project' && request.method === 'getSummary') {
        // Intentionally drop the summary query so the 30s client-side
        // timeout must fire and the view reaches an error affordance.
        break;
      }
      if (request.view === 'project' && request.method === 'getSessionTrendSeries') {
        replyOk(id, emptyTrends);
      } else if (request.view === 'project' && request.method === 'getConfigurationTimeline') {
        replyOk(id, emptyTimeline);
      } else if (request.view === 'project' && request.method === 'getOutliers') {
        replyOk(id, emptyOutliers);
      } else if (request.view === 'project' && request.method === 'getComparisons') {
        replyOk(id, emptyComparisons);
      } else {
        self.postMessage({ id, ok: true, result: null });
      }
      break;

    default:
      self.postMessage({ id, ok: true });
  }
};
`;

async function installHangingAnalyticsWorker(page: Page): Promise<void> {
  await installFailingWorker(page, {
    match: 'analytics-worker',
    workerScript: HANGING_ANALYTICS_WORKER,
  });
}

test.describe('UX-009: query hang bounded', () => {
  test('blocked project summary query reaches a bounded timeout error', async ({ page }) => {
    test.setTimeout(70_000);

    await installHangingAnalyticsWorker(page);
    await page.goto(`/#/projects/${encodeURIComponent(HANGING_PROJECT)}`);

    await expect(page.getByRole('heading', { name: 'Project Behavior' })).toBeVisible({
      timeout: 15_000,
    });

    // The Overview section derives its state from the summary query, so it
    // transitions to the error state when the summary query times out.
    const overviewSection = page.locator('.section', { hasText: 'Overview' });

    await expect(page.getByText(/analytics query timed out after 30000ms/)).toBeVisible({
      timeout: 35_000,
    });

    // The error affordance must appear inside the Overview section (not just
    // as a floating toast), proving the panel surfaced the bounded timeout
    // instead of an indefinite loading spinner.
    await expect(overviewSection.locator('.error')).toContainText(
      /analytics query timed out after 30000ms/,
      { timeout: 5_000 },
    );
    await expect(page.getByText('Loading project behavior…')).toBeHidden();
  });
});
