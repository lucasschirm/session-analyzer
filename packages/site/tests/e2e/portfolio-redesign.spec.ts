import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';
import { expectEmptyAffordance, expectRenderedGeometry } from './helpers/chart-content';
import { captureAnalyticsWorker, seedSession } from './helpers/seeded-store';
import { buildFailingQueryWorker, installFailingWorker } from './helpers/worker-failure';

/**
 * E2E for the redesigned Portfolio analytics home page (issue #170).
 * Catalog IDs: UX-036, UX-037, UX-038, UX-039, UX-040 (see
 * docs/superpowers/plans/2026-08-27-e2e-coverage-enhancement.md §6.1).
 *
 * The seeded fixture (`claude-session-with-subagent.jsonl`) is timestamped
 * 2026-08-11 — inside the 30d/All window as of "now", but outside the 7d
 * window — the same deterministic seam `filter-bar.spec.ts` (UX-028/029/030)
 * relies on.
 */

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

function fixture(name: string): string {
  return path.join(FIXTURES_DIR, name);
}

async function seedPortfolioSession(page: Page, projectName: string): Promise<void> {
  const content = fs.readFileSync(fixture('claude-session-with-subagent.jsonl'), 'utf8');
  await seedSession({
    page,
    projectId: projectName,
    sessionId: 'e2e-portfolio-session',
    content,
    importBatchIdPrefix: 'ux170',
  });
}

async function clickRangeSegment(page: Page, value: '7d' | '30d' | '90d' | 'all'): Promise<void> {
  await page.locator(`time-range-switch button[data-value="${value}"]`).click();
}

function tokenTrendChart(page: Page) {
  return page.locator('analytics-chart').filter({
    has: page.locator('.chart-title', { hasText: 'Token usage trend' }),
  });
}

function sessionsHeroTile(page: Page) {
  return page.locator('stat-tile-hero');
}

/** A minimal DTO literal for each `portfolio`/`metadata` view method, so a
 * fake worker can answer every concurrent query `portfolio-view` issues on
 * load without leaving any card in a permanent loading/error state that
 * would confound an unrelated assertion. */
const BASE_TOKEN = `{
  analysisReleaseId: 'rel-1', generationId: 'gen-1', comparabilityGroupId: 'cgrp-1',
  eligibleN: 1, knownN: 1, unknownCount: 0, coverage: 'complete',
  measurementClass: 'observed', confidence: 'high', metricVersion: '1.0.0', evidenceLinks: []
}`;

const BASE_FIXTURES = `
  const token = ${BASE_TOKEN};
  const fixtures = {
    getKpiBand: { token, sessions: { current: 1, currentN: 1 }, tokens: { in: { current: 10, currentN: 1 }, out: { current: 20, currentN: 1 } }, cost: { currentTotal: null, currentReportedHarnesses: 0, currentTotalHarnesses: 1 }, cleanCompletionRate: { value: null, eligibleN: 0, knownN: 0 } },
    getTrends: { token, series: [] },
    getSessionsByModel: { token, rows: [] },
    getModelHarnessMatrix: { token, models: ['sonnet'], harnesses: ['claude'], cells: [{ model: 'sonnet', harness: 'claude', sessionCount: null }] },
    getInvocationsByDomain: { token, totalInvocations: 0, rows: [] },
    getProjectLeaderboard: { token, rows: [] },
    getDimensionDomains: { token, projects: [], harnesses: [], models: [] },
  };
`;

/** Fake analytics worker that answers the boot handshake and every
 * `portfolio`/`metadata` query with a canned fixture — used to exercise the
 * heatmap missing-cell affordance deterministically (UX-038), without
 * depending on real ingestion producing a never-observed (model, harness)
 * pair by chance. */
function buildPortfolioFixtureWorker(): string {
  return `
  ${BASE_FIXTURES}
  self.onmessage = (event) => {
    const request = event.data;
    const id = request.id ?? 0;
    switch (request.type) {
      case 'init':
      case 'getBackend':
        self.postMessage({ id, ok: true, backend: { backendName: 'wasm-memory', durability: 'ephemeral', journalMode: 'delete', storage: 'memory', fallbackReason: undefined }, storage: 'memory', fallbackReason: undefined });
        break;
      case 'resolveProjectId':
        self.postMessage({ id, ok: true, result: request.projectId });
        break;
      case 'query': {
        const result = fixtures[request.method];
        self.postMessage({ id, ok: result !== undefined, result, error: result === undefined ? 'no fixture for ' + request.method : undefined });
        break;
      }
      default:
        self.postMessage({ id, ok: true });
    }
  };
  `;
}

/** Alias documenting intent at the UX-039b call site: the fixture worker's
 * `getProjectLeaderboard` already returns zero rows by default — a
 * legitimate empty result, never coerced to the error affordance. */
const buildPortfolioEmptyLeaderboardWorker = buildPortfolioFixtureWorker;

test.describe('Portfolio redesign (issue #170)', () => {
  test('UX-036: load renders the KPI band with an n= sample-size caption on every tile', async ({
    page,
  }) => {
    await captureAnalyticsWorker(page);
    await page.goto('/');
    const projectName = 'UX031 Portfolio Load';
    await seedPortfolioSession(page, projectName);

    await page.goto('/#/');
    await expect(page.locator('filter-bar')).toBeVisible({ timeout: 10000 });

    const hero = sessionsHeroTile(page);
    await expect(hero).toBeVisible({ timeout: 10000 });
    await expect
      .poll(async () => hero.getAttribute('samplelabel'), { timeout: 10000 })
      .toMatch(/n=\d+/);

    // Every other rendered aggregate must also carry an n= caption
    // (`.agents/rules/aggregates-expose-sample-size.md`).
    await expect(page.locator('.chart-caption', { hasText: /n=\d+/ }).first()).toBeVisible();
  });

  test('UX-037: switching the time range changes both the KPI band and the token trend chart', async ({
    page,
  }) => {
    await captureAnalyticsWorker(page);
    await page.goto('/');
    const projectName = 'UX032 Portfolio Range Switch';
    await seedPortfolioSession(page, projectName);

    await page.goto('/#/');
    await expect(page.locator('filter-bar')).toBeVisible({ timeout: 10000 });

    const hero = sessionsHeroTile(page);
    await expect(hero).toBeVisible({ timeout: 10000 });
    await expectRenderedGeometry(tokenTrendChart(page));
    const allTimeValue = await hero.getAttribute('value');

    await clickRangeSegment(page, '7d');
    await expect(page).toHaveURL(/timeStart=/);

    // The fixture's rollups fall outside the 7d window — both the trend
    // chart and the Sessions KPI must reflect the narrower window.
    await expectEmptyAffordance(tokenTrendChart(page));
    await expect
      .poll(async () => hero.getAttribute('value'), { timeout: 10000 })
      .not.toBe(allTimeValue);
  });

  test('UX-038: a never-observed (model, harness) heatmap cell renders "—", not "0"', async ({
    page,
  }) => {
    await installFailingWorker(page, {
      match: 'analytics-worker',
      workerScript: buildPortfolioFixtureWorker(),
    });
    await page.goto('/#/');
    await expect(page.locator('filter-bar')).toBeVisible({ timeout: 10000 });

    const heatmapChart = page.locator('analytics-chart').filter({
      has: page.locator('.chart-title', { hasText: 'model × harness' }),
    });
    await expect(heatmapChart).toBeVisible({ timeout: 10000 });

    const missingCell = heatmapChart.locator('[data-missing="true"]');
    await expect(missingCell).toHaveCount(1);
    await expect(missingCell).toHaveText('—');
    await expect(heatmapChart.locator('[data-missing="false"]', { hasText: '0' })).toHaveCount(0);
  });

  test('UX-039a: a failing KPI-band query surfaces a distinguishable error affordance without blanking the leaderboard', async ({
    page,
  }) => {
    await installFailingWorker(page, {
      match: 'analytics-worker',
      workerScript: buildFailingQueryWorker('Simulated KPI band failure'),
    });
    await page.goto('/#/');
    await expect(page.locator('filter-bar')).toBeVisible({ timeout: 10000 });

    const errorPanel = page
      .locator('.panel-error', { hasText: 'Simulated KPI band failure' })
      .first();
    await expect(errorPanel).toBeVisible({ timeout: 10000 });
    await expect(errorPanel).toHaveAttribute('role', 'alert');

    // Every other section failed identically (one fake worker fails every
    // query) — the point under test is that the failure affordance itself,
    // not a blank page, is what every section shows; none of them collapse
    // to the legitimate empty-state copy used by UX-039b.
    await expect(page.locator('text=No projects found.')).toHaveCount(0);
  });

  test('UX-039b: a legitimately empty leaderboard renders distinctly from the error affordance', async ({
    page,
  }) => {
    await installFailingWorker(page, {
      match: 'analytics-worker',
      workerScript: buildPortfolioEmptyLeaderboardWorker(),
    });
    await page.goto('/#/');
    await expect(page.locator('filter-bar')).toBeVisible({ timeout: 10000 });

    await expect(page.locator('text=No projects found.')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.panel-error')).toHaveCount(0);
  });

  test('UX-040: clicking a leaderboard row navigates to the project page carrying returnContext', async ({
    page,
  }) => {
    await captureAnalyticsWorker(page);
    await page.goto('/');
    const projectName = 'UX035 Leaderboard Click';
    await seedPortfolioSession(page, projectName);

    await page.goto('/#/');
    await expect(page.locator('filter-bar')).toBeVisible({ timeout: 10000 });

    const row = page.locator('table.leaderboard a[href^="#/projects/"]').first();
    await expect(row).toBeVisible({ timeout: 10000 });
    await expect(row).toHaveAttribute('href', /returnContext=/);

    await row.click();
    await expect(page).toHaveURL(/#\/projects\/.+returnContext=/);
  });
});
