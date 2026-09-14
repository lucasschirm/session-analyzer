import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';
import { waitForAppReady } from './helpers/app-ready';
import { assertNoErrorBoundary, expectRenderedGeometry } from './helpers/chart-content';

/**
 * UX-034 / UX-035: session-level analytics correctness on the Session
 * Evidence page — the context-growth chart must render the per-message token
 * buckets derived from the session's model requests, and the component
 * utilization panel must reflect the model-sent tool set (prompt_snapshot)
 * split into used vs. unused by actual tool_use invocations.
 *
 * The fixture declares 5 loaded tools (Read, Write, Bash, Glob, Grep) but
 * invokes only Read, and carries two assistant messages with usage so the
 * context series has real token points.
 */

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

function fixture(name: string): string {
  return path.join(FIXTURES_DIR, name);
}

async function importAndOpenSession(page: Page, projectName: string): Promise<void> {
  await page.goto('/#/manual-import');
  await waitForAppReady(page);
  await expect(page.getByRole('heading', { name: 'Manual Import' })).toBeVisible();

  await page.locator('input[type="file"]').setInputFiles([fixture('claude-tools-context.jsonl')]);
  await expect(page.getByRole('heading', { name: 'Harness' })).toBeVisible({ timeout: 15000 });

  await page.locator('#project-select').selectOption('__new__');
  await page.locator('input[placeholder="New project name"]').fill(projectName);

  await page.getByRole('button', { name: 'Import partial session' }).click();
  await expect(page.getByRole('button', { name: 'View session' })).toBeVisible({ timeout: 30000 });
  await page.getByRole('button', { name: 'View session' }).click();

  await expect(page).toHaveURL(/#\/sessions\//);
  await expect(page.locator('session-evidence-view')).toBeVisible({ timeout: 15000 });
}

test.describe('Session context growth chart correctness (UX-034)', () => {
  test('UX-034: context chart renders per-message token buckets matching the session requests', async ({
    page,
  }) => {
    await importAndOpenSession(page, 'UX-034 Context Chart');

    const contextGrowth = page.locator('session-evidence-view #context-growth');
    await expect(contextGrowth).toBeVisible({ timeout: 15000 });

    const chart = contextGrowth
      .locator('analytics-chart')
      .filter({ has: page.getByRole('heading', { name: 'Context growth across session' }) });
    await expect(chart).toBeVisible({ timeout: 15000 });

    // Real SVG marks — not a legend-only or empty-state render.
    await expectRenderedGeometry(chart, { timeout: 15000 });
    await assertNoErrorBoundary(chart);

    // Data correctness via the accessible table fallback: each assistant
    // request contributes its context (input+cache) and generation tokens,
    // and the context level carries forward to the following message position.
    await chart.locator('summary', { hasText: 'View as table' }).click();
    const rows = chart.locator('tbody tr');
    await expect(rows.first()).toBeVisible({ timeout: 10000 });

    // First request: input 1,000 / output 120 — context level at positions #1–#2.
    await expect(chart.locator('tbody tr', { hasText: 'context 1,000 tokens' })).toHaveCount(2);
    await expect(chart.locator('tbody tr', { hasText: 'generation 120 tokens' })).toHaveCount(1);

    // Second request: input 1,400 / output 80 — context level at #3–#4.
    await expect(chart.locator('tbody tr', { hasText: 'context 1,400 tokens' })).toHaveCount(2);
    await expect(chart.locator('tbody tr', { hasText: 'generation 80 tokens' })).toHaveCount(1);

    // The bucket x-labels index transcript messages for both roles.
    await expect(chart.locator('td', { hasText: '#1 user' }).first()).toBeVisible();
    await expect(chart.locator('td', { hasText: '#4 assistant' }).first()).toBeVisible();
  });
});

test.describe('Session tool availability vs usage (UX-035)', () => {
  test('UX-035: utilization panel shows 5 available tools, 1 used, 4 unused', async ({ page }) => {
    await importAndOpenSession(page, 'UX-035 Tools Used');

    const panel = page.locator('session-evidence-view component-utilization-panel');
    await expect(panel).toBeVisible({ timeout: 15000 });
    await expect(
      panel.getByRole('heading', { name: 'Session Component Availability & Invocations' }),
    ).toBeVisible({ timeout: 15000 });

    // The Tools domain row must reflect the prompt_snapshot tool set (5
    // available) split by actual invocations (Read used once → 1 used,
    // 4 unused). This guards the zero-tool regression where sessions with
    // snapshot components lacked persisted exposures/stats.
    const toolsRow = panel.locator('tbody tr', { hasText: 'Tools' });
    await expect(toolsRow).toBeVisible({ timeout: 15000 });
    const cells = toolsRow.locator('td');
    await expect(cells.nth(1)).toHaveText('5');
    await expect(cells.nth(2)).toHaveText('1');
    await expect(cells.nth(3)).toHaveText('4');

    // The domain tab count agrees with the table.
    await expect(panel.locator('button.domain-tab', { hasText: 'Tools' })).toContainText('(5)');

    // The pill lists name the actual tools — used shows the invoked Read,
    // unused shows the loaded-but-never-invoked set.
    await expect(panel.getByText('Used in this session (1)')).toBeVisible();
    await expect(panel.locator('.pill.used', { hasText: 'Read' })).toHaveCount(1);

    await expect(panel.getByText('Unused in this session (4)')).toBeVisible();
    const unusedPills = panel.locator('.pill.unused');
    await expect(unusedPills).toHaveCount(4);
    for (const name of ['Write', 'Bash', 'Glob', 'Grep']) {
      await expect(unusedPills.filter({ hasText: name })).toHaveCount(1);
    }

    // Missing data must never collapse to a zero/empty affordance.
    await expect(panel.locator('.empty-note')).toHaveCount(0);
  });
});
