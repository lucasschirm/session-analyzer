import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';
import {
  assertNoErrorBoundary,
  expectEmptyAffordance,
  expectRenderedGeometry,
} from './helpers/chart-content';
import { captureAnalyticsWorker, seedSession } from './helpers/seeded-store';

/**
 * E2E for the global filter bar & time-range control (issue #167), mounted
 * on the current Portfolio view. Catalog IDs: UX-028, UX-029, UX-030 (see
 * docs/superpowers/plans/2026-08-27-e2e-coverage-enhancement.md §6.1).
 *
 * The seeded fixture is timestamped 2026-08-11 — inside the 30d/All window
 * as of "now", but outside the 7d window — so switching to the 7d preset
 * deterministically empties the "Session Metrics" trend chart (its daily
 * rollups are time-bucketed) while 30d/All render real geometry, giving
 * each test a real, assertable change.
 *
 * The portfolio Overview metric cards (`getOverview`) are NOT range-scoped
 * by the current `packages/db` implementation — only the trend rollups are
 * — so this suite asserts against the trend chart, the URL hash, and the
 * segmented control's own selection state rather than the metric cards.
 * See the PR description for this documented pre-existing backend gap
 * (out of scope for this UI-mounting issue; the redesigned KPI band lands
 * with the range-scoped metric cards in the sub-issue-7 portfolio rebuild).
 */

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

function fixture(name: string): string {
  return path.join(FIXTURES_DIR, name);
}

async function seedFilterBarSession(page: Page, projectName: string): Promise<void> {
  const content = fs.readFileSync(fixture('claude-session-with-subagent.jsonl'), 'utf8');
  await seedSession({
    page,
    projectId: projectName,
    sessionId: 'e2e-parent-session',
    content,
    importBatchIdPrefix: 'ux028',
  });
}

function trendChart(page: Page) {
  return page.locator('analytics-chart').filter({
    has: page.locator('.chart-title', { hasText: 'Session Metrics' }),
  });
}

async function clickRangeSegment(page: Page, value: '7d' | '30d' | '90d' | 'all'): Promise<void> {
  await page.locator(`time-range-switch button[data-value="${value}"]`).click();
}

test.describe('Global filter bar & time-range control', () => {
  test.beforeEach(async ({ page }) => {
    await captureAnalyticsWorker(page);
    await page.goto('/');
  });

  test('UX-028: selecting 7d changes the trend chart and updates the URL hash', async ({
    page,
  }) => {
    const projectName = 'Filter Bar 7d Change';
    await seedFilterBarSession(page, projectName);

    await page.goto('/#/');
    await expect(page.locator('filter-bar')).toBeVisible({ timeout: 10000 });

    // Default (All) includes the fixture's session — the trend chart
    // renders real geometry from its daily rollups.
    await expectRenderedGeometry(trendChart(page));

    await clickRangeSegment(page, '7d');
    await expect(page).toHaveURL(/timeStart=/);
    await expect(page).toHaveURL(/timeEnd=/);

    // Narrowing to 7d excludes the fixture's (2026-08-11) rollups — a
    // legitimate empty affordance, structurally distinct from an error.
    await expectEmptyAffordance(trendChart(page));
    await assertNoErrorBoundary(trendChart(page));
  });

  test('UX-029: refresh preserves the selected time range', async ({ page }) => {
    const projectName = 'Filter Bar Refresh';
    await seedFilterBarSession(page, projectName);

    await page.goto('/#/');
    await expect(page.locator('filter-bar')).toBeVisible({ timeout: 10000 });

    await clickRangeSegment(page, '30d');
    await expect(page).toHaveURL(/timeStart=/);
    const persistedUrl = page.url();

    await page.reload();
    await expect(page.locator('filter-bar')).toBeVisible({ timeout: 10000 });
    await expect(page).toHaveURL(persistedUrl);
    await expect(page.locator('time-range-switch button[data-value="30d"]')).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expectRenderedGeometry(trendChart(page));
  });

  test('UX-030: back button restores the prior range selection and data', async ({ page }) => {
    const projectName = 'Filter Bar Back Nav';
    await seedFilterBarSession(page, projectName);

    await page.goto('/#/');
    await expect(page.locator('filter-bar')).toBeVisible({ timeout: 10000 });

    await clickRangeSegment(page, '30d');
    await expect(page).toHaveURL(/timeStart=/);
    await expectRenderedGeometry(trendChart(page));

    await clickRangeSegment(page, '7d');
    await expectEmptyAffordance(trendChart(page));

    await page.goBack();
    await expect(page.locator('time-range-switch button[data-value="30d"]')).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expectRenderedGeometry(trendChart(page));
  });
});
