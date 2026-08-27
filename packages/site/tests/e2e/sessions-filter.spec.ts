import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';

/**
 * E2E tests for the Sessions scope filter (Main / All / Sub Agents) on the
 * Portfolio and Project Behavior pages.  Verifies that switching the filter
 * updates the chart legends and values to reflect the selected scope.
 */

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

function fixture(name: string): string {
  return path.join(FIXTURES_DIR, name);
}

async function createProject(page: Page, name: string, description = ''): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: '+ New Project' }).click();
  await page.locator('#project-name-input').fill(name);
  if (description) {
    await page.locator('#project-description-input').fill(description);
  }
  await page.getByRole('button', { name: 'Create Project' }).click();
  await expect(page.locator('.project-card', { hasText: name })).toBeVisible();
}

async function openProject(page: Page, name: string): Promise<void> {
  await page.goto('/');
  await page.locator('.project-card', { hasText: name }).click();
  await expect(page.getByRole('heading', { name })).toBeVisible();
}

async function dropFixtures(page: Page, fileNames: string[]): Promise<void> {
  const files = fileNames.map((name) => ({
    name,
    content: fs.readFileSync(fixture(name), 'utf8'),
  }));
  const dataTransfer = await page.evaluateHandle((entries) => {
    const dt = new DataTransfer();
    for (const entry of entries) {
      dt.items.add(new File([entry.content], entry.name, { type: 'application/json' }));
    }
    return dt;
  }, files);
  await page.locator('upload-zone div.upload-zone').dispatchEvent('drop', { dataTransfer });
}

/**
 * Reads all legend item texts from every analytics-chart on the page.
 * Pierces shadow DOM boundaries to reach the ECharts SVG text elements.
 */
async function getChartLegendTexts(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const root = document.querySelector('app-root') as Element & { shadowRoot: ShadowRoot };
    const view =
      root.shadowRoot.querySelector('portfolio-view') ??
      root.shadowRoot.querySelector('project-behavior-view');
    if (!view) return [];
    const vShadow = (view as Element & { shadowRoot: ShadowRoot }).shadowRoot;
    const charts = vShadow.querySelectorAll('analytics-chart');
    const texts: string[] = [];
    for (const chart of charts) {
      const cShadow = (chart as Element & { shadowRoot: ShadowRoot }).shadowRoot;
      const echarts = cShadow.querySelector('echarts-base');
      if (!echarts) continue;
      const eShadow = (echarts as Element & { shadowRoot: ShadowRoot }).shadowRoot;
      const container = eShadow.querySelector('.chart-container');
      if (!container) continue;
      container.querySelectorAll('text, tspan').forEach((el) => {
        const t = (el.textContent ?? '').trim();
        if (t.length > 3 && t.length < 60) texts.push(t);
      });
    }
    return texts;
  });
}

/**
 * Selects the Sessions filter <select> inside the given view's filter bar.
 */
async function selectSessionsFilter(
  page: Page,
  value: 'main' | 'all' | 'sub_agents',
): Promise<void> {
  await page.evaluate((val) => {
    const root = document.querySelector('app-root') as Element & { shadowRoot: ShadowRoot };
    const view =
      root.shadowRoot.querySelector('portfolio-view') ??
      root.shadowRoot.querySelector('project-behavior-view');
    if (!view) return;
    const vShadow = (view as Element & { shadowRoot: ShadowRoot }).shadowRoot;
    const filterBar = vShadow.querySelector('.filter-bar');
    if (!filterBar) return;
    const selects = filterBar.querySelectorAll('select');
    const sessionsSelect = Array.from(selects).find(
      (s) => s.value === 'main' || s.value === 'all' || s.value === 'sub_agents',
    );
    if (!sessionsSelect) return;
    sessionsSelect.value = val;
    sessionsSelect.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
  // Wait for the URL hash to update and data to reload.
  await page.waitForTimeout(2000);
}

test.describe('Sessions scope filter', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('portfolio: switching from Main to Sub Agents updates chart legends', async ({ page }) => {
    await createProject(page, 'Sessions Filter Portfolio', 'E2E sessions filter test');
    await openProject(page, 'Sessions Filter Portfolio');

    // Upload a session with subagent data so root_only ≠ inclusive.
    await dropFixtures(page, [
      'claude-session-with-subagent.jsonl',
      'agent-e2esub1.jsonl',
      'agent-e2esub1.meta.json',
    ]);

    // Wait for ingestion to complete.
    await expect(page.locator('.session-item')).toHaveCount(1);

    // Navigate to the portfolio page.
    await page.goto('/#/portfolio');
    await page.waitForTimeout(3000);

    // Default scope is "Main" — legends should show (root-only) suffix.
    const mainTexts = await getChartLegendTexts(page);
    expect(mainTexts.some((t) => t.includes('root-only'))).toBe(true);
    expect(mainTexts.some((t) => t.includes('sub-agents'))).toBe(false);

    // Switch to "Sub Agents" — legends should show (sub-agents) suffix.
    await selectSessionsFilter(page, 'sub_agents');
    await expect(page).toHaveURL(/sessions=sub_agents/);

    const subAgentTexts = await getChartLegendTexts(page);
    expect(subAgentTexts.some((t) => t.includes('sub-agents'))).toBe(true);
    expect(subAgentTexts.some((t) => t.includes('root-only'))).toBe(false);

    // Switch to "All" — legends should show (inclusive) suffix.
    await selectSessionsFilter(page, 'all');
    await expect(page).toHaveURL(/sessions=all/);

    const allTexts = await getChartLegendTexts(page);
    expect(allTexts.some((t) => t.includes('inclusive'))).toBe(true);
    expect(allTexts.some((t) => t.includes('root-only'))).toBe(false);
    expect(allTexts.some((t) => t.includes('sub-agents'))).toBe(false);
  });

  test('project behavior: switching from Main to Sub Agents updates chart legends', async ({
    page,
  }) => {
    await createProject(page, 'Sessions Filter Project', 'E2E project sessions filter');
    await openProject(page, 'Sessions Filter Project');

    await dropFixtures(page, [
      'claude-session-with-subagent.jsonl',
      'agent-e2esub1.jsonl',
      'agent-e2esub1.meta.json',
    ]);

    await expect(page.locator('.session-item')).toHaveCount(1);

    // Navigate to the project behavior page.
    await page.goto('/#/projects/sessions-filter-project/behavior');
    await page.waitForTimeout(3000);

    // Default scope is "Main" — legends should show (root-only) suffix.
    const mainTexts = await getChartLegendTexts(page);
    expect(mainTexts.some((t) => t.includes('root-only'))).toBe(true);
    expect(mainTexts.some((t) => t.includes('sub-agents'))).toBe(false);

    // Switch to "Sub Agents".
    await selectSessionsFilter(page, 'sub_agents');
    await expect(page).toHaveURL(/sessions=sub_agents/);

    const subAgentTexts = await getChartLegendTexts(page);
    expect(subAgentTexts.some((t) => t.includes('sub-agents'))).toBe(true);
    expect(subAgentTexts.some((t) => t.includes('root-only'))).toBe(false);

    // Switch to "All".
    await selectSessionsFilter(page, 'all');
    await expect(page).toHaveURL(/sessions=all/);

    const allTexts = await getChartLegendTexts(page);
    expect(allTexts.some((t) => t.includes('inclusive'))).toBe(true);
    expect(allTexts.some((t) => t.includes('root-only'))).toBe(false);
  });
});
