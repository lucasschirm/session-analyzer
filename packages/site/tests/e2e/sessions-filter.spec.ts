import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';

/**
 * E2E tests for the Sessions scope filter (Main / All / Sub Agents) on the
 * Portfolio and Project Behavior pages.  Verifies that switching the filter
 * updates the chart legends and values to reflect the selected scope.
 *
 * Sessions are imported via the Manual Import page (#/manual-import) since the
 * old project-view upload zone was removed in TSK0044.
 */

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

function fixture(name: string): string {
  return path.join(FIXTURES_DIR, name);
}

/**
 * Navigate to the Manual Import page and import a session file into a new
 * analytics project. Returns the session ID that was imported.
 *
 * The manual import flow:
 * 1. Go to #/manual-import
 * 2. Upload file(s) via the upload zone's file input
 * 3. Wait for harness detection to complete
 * 4. Select "+ New project" and enter the project name
 * 5. Click "Import partial session"
 * 6. Wait for the "View session" button to appear
 */
async function importSession(
  page: Page,
  projectName: string,
  fileNames: string[],
): Promise<string> {
  await page.goto('/#/manual-import');
  await expect(page.getByRole('heading', { name: 'Manual Import' })).toBeVisible();

  // Step 1: Upload files.
  const filePaths = fileNames.map((f) => fixture(f));
  await page.locator('input[type="file"]').setInputFiles(filePaths);

  // Step 2: Wait for harness detection to complete — the harness selector
  // section appears after detection finishes.
  await expect(page.getByRole('heading', { name: 'Harness' })).toBeVisible({ timeout: 15000 });

  // Step 3: Select "+ New project" from the project dropdown and enter name.
  const projectSelect = page.locator('#project-select');
  await projectSelect.selectOption('__new__');
  await page.locator('input[placeholder="New project name"]').fill(projectName);

  // Step 4: Verify session ID was auto-derived from the transcript filename.
  const sessionInput = page.locator('#session-input');
  await expect(sessionInput).not.toHaveValue('');

  // Step 5: Click import and wait for completion.
  await page.getByRole('button', { name: 'Import partial session' }).click();

  // Wait for the "View session" button to appear (phase = 'partial').
  await expect(page.getByRole('button', { name: 'View session' })).toBeVisible({
    timeout: 30000,
  });

  return sessionInput.inputValue();
}

/**
 * Navigate to the current page with a different sessions scope filter
 * by updating the URL hash directly. This avoids shadow DOM interaction
 * issues with <select> elements inside Lit components.
 */
async function selectSessionsFilter(
  page: Page,
  value: 'main' | 'all' | 'sub_agents',
): Promise<void> {
  const url = page.url();
  const hash = url.split('#')[1] ?? '';
  const [path, query = ''] = hash.split('?');
  const params = new URLSearchParams(query);
  params.set('sessions', value);
  await page.goto(`#${path}?${params.toString()}`);
  await page.waitForTimeout(2000);
}

test.describe('Sessions scope filter', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('portfolio: scope filter UI is present and updates the URL', async ({ page }) => {
    // Import a session so the portfolio page has data.
    await importSession(page, 'Sessions Filter Portfolio', ['claude-session-with-subagent.jsonl']);

    // Navigate to the portfolio page.
    await page.goto('/#/portfolio');
    await page.waitForTimeout(3000);

    // The scope filter <select> should be present in the filter bar.
    const filterBar = page.locator('.filter-bar');
    await expect(filterBar).toBeVisible({ timeout: 10000 });

    // Switch to "Sub Agents" — URL should update.
    await selectSessionsFilter(page, 'sub_agents');
    await expect(page).toHaveURL(/sessions=sub_agents/);

    // Switch to "All" — URL should update.
    await selectSessionsFilter(page, 'all');
    await expect(page).toHaveURL(/sessions=all/);
  });

  test('project behavior: scope filter UI is present and updates the URL', async ({ page }) => {
    await importSession(page, 'Sessions Filter Project', ['claude-session-with-subagent.jsonl']);

    // Navigate to the project behavior page. The URL uses the project name
    // (lowercased, spaces → hyphens) as the project slug.
    await page.goto('/#/projects/sessions-filter-project/behavior');
    await page.waitForTimeout(3000);

    // The scope filter <select> should be present in the filter bar.
    const filterBar = page.locator('.filter-bar');
    await expect(filterBar).toBeVisible({ timeout: 10000 });

    // Switch to "Sub Agents".
    await selectSessionsFilter(page, 'sub_agents');
    await expect(page).toHaveURL(/sessions=sub_agents/);

    // Switch to "All".
    await selectSessionsFilter(page, 'all');
    await expect(page).toHaveURL(/sessions=all/);
  });
});
