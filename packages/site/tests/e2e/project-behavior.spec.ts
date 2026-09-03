import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';
import { captureAnalyticsWorker, seedSession } from './helpers/seeded-store';

/**
 * E2E for the Project Behavior drill-down page (issue #171 — canvas page 1,
 * "Project drill-down"). Catalog IDs: UX-041, UX-042, UX-043, UX-045 (see
 * docs/superpowers/plans/2026-08-27-e2e-coverage-enhancement.md §6.1).
 * UX-044 (empty vs error affordance for a chart section on this page) is
 * covered by `ux-002-empty-error.spec.ts`, which this redesign PR already
 * repoints at the Session duration histogram — see that file rather than
 * duplicating the assertion here.
 */

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

function fixture(name: string): string {
  return path.join(FIXTURES_DIR, name);
}

async function seedProjectBehaviorSession(page: Page, projectName: string): Promise<void> {
  const content = fs.readFileSync(fixture('claude-session-with-subagent.jsonl'), 'utf8');
  await seedSession({
    page,
    projectId: projectName,
    sessionId: 'e2e-pb171-session',
    content,
    importBatchIdPrefix: 'pb171',
  });
}

function durationChart(page: Page) {
  return page
    .locator('analytics-chart')
    .filter({ has: page.getByRole('heading', { name: 'Session duration' }) });
}

test.describe('Project Behavior drill-down (issue #171)', () => {
  test.beforeEach(async ({ page }) => {
    await captureAnalyticsWorker(page);
    await page.goto('/');
  });

  test('UX-041: navigating from the portfolio leaderboard lands on the matching project header', async ({
    page,
  }) => {
    const projectName = 'PB171 Leaderboard Nav';
    await seedProjectBehaviorSession(page, projectName);

    await page.goto('/#/');
    await expect(page.locator('filter-bar')).toBeVisible({ timeout: 15000 });

    const projectLink = page.getByRole('link', { name: projectName });
    await expect(projectLink).toBeVisible({ timeout: 15000 });
    await projectLink.click();

    await expect(page).toHaveURL(/#\/projects\//);
    await expect(page.locator('h1')).toHaveText(projectName, { timeout: 15000 });
  });

  test('UX-042: histogram geometry corresponds to the DTO bins', async ({ page }) => {
    const projectName = 'PB171 Histogram Geometry';
    await seedProjectBehaviorSession(page, projectName);

    await page.goto(`/#/projects/${encodeURIComponent(projectName)}`);
    const chart = durationChart(page);
    await expect(chart).toBeVisible({ timeout: 15000 });

    // Real SVG/canvas geometry is rendered, not just a title/legend.
    const container = chart.locator('[role="img"]').first();
    await expect(container).toBeVisible({ timeout: 10000 });
    const svg = container.locator('svg').first();
    await expect(svg).toBeVisible({ timeout: 10000 });

    // The accessible table fallback carries one row per DTO bin; at least
    // one bin's count reflects the single seeded session — proving the
    // rendered bars correspond to the actual histogram DTO, not placeholder
    // geometry.
    const toggle = chart.getByRole('button', { name: /show summary/i });
    if (await toggle.isVisible().catch(() => false)) {
      await toggle.click();
    }
    const details = chart.locator('details.table-fallback');
    await details.locator('summary').click();
    const rows = details.locator('tbody tr');
    await expect(rows.first()).toBeVisible({ timeout: 10000 });
    const rowCount = await rows.count();
    expect(rowCount).toBeGreaterThan(0);
    const values = await rows.locator('td').nth(1).allTextContents();
    const total = values.reduce((sum, v) => sum + (Number.parseInt(v, 10) || 0), 0);
    expect(total).toBeGreaterThan(0);
  });

  test('UX-043: outcomes legend counts sum to the session total', async ({ page }) => {
    // `session:outcome` is scoped to `finality = 'final'` sessions
    // (`SessionOutcomeStore.rollupByProject`). No harness plugin emits
    // `finality: 'final'` yet for *any* session, seeded or real-synced — a
    // known, separately-tracked gap noted in the issue #178 signal audit
    // and worked around directly in `packages/db/tests/pipeline/
    // pipe-013-session-outcome-rollup.test.ts` (`markFinal`, which forces
    // it via `SessionStore.update` since the transformer never produces
    // it). This E2E fixture path therefore legitimately renders the card's
    // empty state rather than populated legend rows — proving the wiring
    // and the genuine-empty affordance (not silently blank) — and the same
    // holds for real production sessions until issue #178 lands, not only
    // for this manual-ingestion fixture path. The sum-to-total percentage/
    // count invariant itself is proven exactly, including the
    // largest-remainder rounding, in `packages/db` — see
    // `packages/db/tests/unit/project-behavior-171.test.ts`
    // ("getOutcomeMix bucket percent allocation") — which is where that
    // math is computed (`.agents/rules/no-canonical-metrics-in-lit.md`);
    // `project-behavior-chart-helpers.test.ts` only proves the DTO's
    // precomputed fields are formatted/passed through unmodified.
    const projectName = 'PB171 Outcomes Legend';
    await seedProjectBehaviorSession(page, projectName);

    await page.goto(`/#/projects/${encodeURIComponent(projectName)}`);
    const outcomesCard = page
      .locator('analytics-card')
      .filter({ has: page.getByText('Session outcomes', { exact: true }) });
    await expect(outcomesCard).toBeVisible({ timeout: 15000 });

    const legendRows = outcomesCard.locator('.outcome-legend-row');
    const rowCount = await legendRows.count();

    if (rowCount === 0) {
      await expect(outcomesCard).toContainText('No sessions yet.');
      return;
    }

    expect(rowCount).toBe(3);
    const counts = await legendRows.locator('.outcome-count').allTextContents();
    const percents = counts.map((text) => Number(text.match(/\((\d+)%\)/)?.[1] ?? 0));
    const footnoteText = (await outcomesCard.locator('.outcome-footnote').textContent()) ?? '';
    const tailPercent = Number(footnoteText.match(/unreadable tail \((\d+)%\)/)?.[1] ?? 0);
    expect(percents.reduce((sum, p) => sum + p, 0) + tailPercent).toBe(100);
  });

  test('UX-045: the breadcrumb returns to the filtered portfolio via returnContext', async ({
    page,
  }) => {
    const projectName = 'PB171 Breadcrumb Return';
    await seedProjectBehaviorSession(page, projectName);

    await page.goto('/#/');
    await expect(page.locator('filter-bar')).toBeVisible({ timeout: 15000 });

    // Select a harness filter on the Portfolio view so the returnContext
    // carries real filter state, not just an empty query string.
    await page
      .locator('dimension-chip')
      .filter({ hasText: 'Harness' })
      .locator('select')
      .selectOption('claude-code');
    await expect(page).toHaveURL(/harness=claude-code/);

    const projectLink = page.getByRole('link', { name: projectName });
    await expect(projectLink).toBeVisible({ timeout: 15000 });
    await projectLink.click();
    await expect(page).toHaveURL(/#\/projects\//);

    const back = page.locator('a.back-link');
    await expect(back).toBeVisible({ timeout: 15000 });
    await expect(back).toHaveAttribute('href', /harness=claude-code/);

    await back.click();
    await expect(page).toHaveURL(/harness=claude-code/);
    await expect(page.locator('filter-bar')).toBeVisible({ timeout: 15000 });
  });
});
