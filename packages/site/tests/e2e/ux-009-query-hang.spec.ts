import { expect, type Page, test } from '@playwright/test';
import { installFailingWorker } from './helpers/worker-failure';

const HANGING_PROJECT = 'UX009Hang';

/**
 * UX-009: a blocked/hung analytics query reaches a bounded client-side
 * timeout error affordance instead of an indefinite spinner. Rewritten for
 * the project-behavior redesign (issue #171): every panel query resolves
 * with a valid, minimal empty DTO except `project.getStatStrip`, which is
 * dropped so its 30s client-side timeout must fire and the stat-strip panel
 * must reach an error affordance instead of hanging indefinitely.
 */
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

const emptyHeader = { token, displayName: 'UX009Hang', harnesses: [], sessionCount: 0 };
const emptyHistogram = { token, bins: [], eligibleN: 0, knownN: 0 };
const emptyOutcomes = { token, buckets: [] };
const emptyToolErrorRate = { token, series: [], currentValue: null, currentWeekN: 0 };
const emptyTopTools = { token, rows: [], totalInvocations: 0 };
const emptyModelCohorts = { token, rows: [] };
const emptyDomains = { projects: [], harnesses: [], models: [] };

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
      if (request.view === 'project' && request.method === 'getStatStrip') {
        // Intentionally drop the reply: no response is ever posted, so the
        // 30s client-side timeout must fire.
        break;
      }
      if (request.view === 'project' && request.method === 'getHeader') {
        replyOk(id, emptyHeader);
      } else if (request.view === 'project' && request.method === 'getDurationHistogram') {
        replyOk(id, emptyHistogram);
      } else if (request.view === 'project' && request.method === 'getOutcomeMix') {
        replyOk(id, emptyOutcomes);
      } else if (request.view === 'project' && request.method === 'getWeeklyToolErrorRate') {
        replyOk(id, emptyToolErrorRate);
      } else if (request.view === 'project' && request.method === 'getTopTools') {
        replyOk(id, emptyTopTools);
      } else if (request.view === 'project' && request.method === 'getModelHarnessCohorts') {
        replyOk(id, emptyModelCohorts);
      } else if (request.view === 'metadata' && request.method === 'getDimensionDomains') {
        replyOk(id, emptyDomains);
      } else {
        replyOk(id, null);
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
  test('a blocked stat-strip query reaches a bounded timeout error', async ({ page }) => {
    test.setTimeout(70_000);

    await installHangingAnalyticsWorker(page);
    await page.goto(`/#/projects/${encodeURIComponent(HANGING_PROJECT)}`);

    // The breadcrumb and filter bar render independent of any query result,
    // so they prove the page mounted before the stat-strip query stalls.
    await expect(page.locator('filter-bar')).toBeVisible({ timeout: 15_000 });

    await expect(page.getByText(/analytics query timed out after 30000ms/)).toBeVisible({
      timeout: 35_000,
    });

    // The error affordance replaces the stat-strip panel itself (not just a
    // floating toast), proving the panel surfaced the bounded timeout
    // instead of an indefinite loading spinner.
    await expect(page.locator('.error', { hasText: 'timed out' })).toBeVisible({
      timeout: 5_000,
    });
  });
});
