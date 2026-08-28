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
 * Set a value on a filter control inside the active page's shadow DOM filter bar.
 *
 * This dispatches a `change` event on the real DOM control, so it exercises the
 * same code path as a user interacting with the filter UI and triggers the hash
 * update via `navigateTo`.
 */
async function setFilterControl(page: Page, labelText: string, value: string): Promise<void> {
  const control = page
    .locator('.filter-bar label', { hasText: new RegExp(`^\\s*${labelText}`) })
    .locator('select, input');
  await control.evaluate((el, val: string) => {
    const input = el as HTMLInputElement | HTMLSelectElement;
    input.value = val;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

/**
 * Read the current value of a filter control inside the active page's shadow
 * DOM filter bar.
 */
async function getFilterControlValue(page: Page, labelText: string): Promise<string> {
  const control = page
    .locator('.filter-bar label', { hasText: new RegExp(`^\\s*${labelText}`) })
    .locator('select, input');
  return control.evaluate((el) => (el as HTMLInputElement | HTMLSelectElement).value);
}

test.describe('Sessions scope filter', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('portfolio: scope filter UI updates the URL', async ({ page }) => {
    await importSession(page, 'Sessions Filter Portfolio', ['claude-session-with-subagent.jsonl']);

    await page.goto('/#/portfolio');
    await expect(page.locator('.filter-bar')).toBeVisible({ timeout: 10000 });

    // Use the filter UI to switch the sessions scope.
    await setFilterControl(page, 'Sessions', 'sub_agents');
    await expect(page).toHaveURL(/sessions=sub_agents/);

    await setFilterControl(page, 'Sessions', 'all');
    await expect(page).toHaveURL(/sessions=all/);
  });

  test('project behavior: scope filter UI updates the URL', async ({ page }) => {
    const projectName = 'Sessions Filter Project';
    await importSession(page, projectName, ['claude-session-with-subagent.jsonl']);

    // Navigate directly to the project behavior page using the project name
    // (which is also the native project id). Playwright encodes spaces for us.
    await page.goto(`/#/projects/${projectName}/behavior`);
    await expect(page.locator('.filter-bar')).toBeVisible({ timeout: 10000 });

    // Use the filter UI to switch the sessions scope.
    await setFilterControl(page, 'Sessions', 'sub_agents');
    await expect(page).toHaveURL(/sessions=sub_agents/);

    await setFilterControl(page, 'Sessions', 'all');
    await expect(page).toHaveURL(/sessions=all/);
  });

  /**
   * UX-010: Filter persistence across reload.
   *
   * Product contract: filters are encoded in the URL hash on every change and
   * re-parsed from the hash on load / hashchange. This is deliberate; the only
   * way to reset filters is the explicit "Reset" button. The invariants in
   * `portfolio/AGENTS.md` and `project-behavior/AGENTS.md` explicitly state
   * that URL filter context "survives refresh and back navigation".
   */
  test('UX-010: portfolio filter state persists across a page reload', async ({ page }) => {
    await importSession(page, 'Filter Persistence Portfolio', [
      'claude-session-with-subagent.jsonl',
    ]);

    await page.goto('/#/portfolio');
    await expect(page.locator('.filter-bar')).toBeVisible({ timeout: 10000 });

    // Use the filter UI (not URL manipulation) to switch sessions scope to "All".
    await setFilterControl(page, 'Sessions', 'all');
    await expect(page).toHaveURL(/sessions=all/);
    const persistedUrl = page.url();

    // Reload the page and confirm the URL and the filter control both retain the value.
    await page.reload();
    await expect(page.locator('.filter-bar')).toBeVisible({ timeout: 10000 });
    await expect(page).toHaveURL(persistedUrl);
    await expect.poll(async () => getFilterControlValue(page, 'Sessions')).toBe('all');
  });

  test('UX-010: project behavior filter state persists across a page reload', async ({ page }) => {
    const projectName = 'Filter Persistence Project';
    await importSession(page, projectName, ['claude-session-with-subagent.jsonl']);

    // Navigate directly to the project behavior page using the project name.
    await page.goto(`/#/projects/${projectName}/behavior`);
    await expect(page.locator('.filter-bar')).toBeVisible({ timeout: 10000 });

    // Use the filter UI to switch sessions scope to "Sub Agents".
    await setFilterControl(page, 'Sessions', 'sub_agents');
    await expect(page).toHaveURL(/sessions=sub_agents/);
    const persistedUrl = page.url();

    // Reload the page and confirm the URL and the filter control both retain the value.
    await page.reload();
    await expect(page.locator('.filter-bar')).toBeVisible({ timeout: 10000 });
    await expect(page).toHaveURL(persistedUrl);
    await expect.poll(async () => getFilterControlValue(page, 'Sessions')).toBe('sub_agents');
  });
});
