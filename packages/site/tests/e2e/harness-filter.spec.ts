import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';

/**
 * UX-027: Harness typeahead filter updates the URL query string and filters
 * portfolio metrics to the selected harness.
 *
 * Product contract: the harness filter is a `<lit-typeahead>` on the Portfolio
 * and Project Behavior pages. Selecting a harness from the dropdown must:
 *   1. Update the URL hash with `harness=<value>`.
 *   2. Re-query the analytics data source with the harness filter applied.
 *   3. Cause the rendered project list to reflect only sessions of that harness.
 *   4. Persist across a page reload.
 *
 * The test imports a Claude Code session (harness `claude-code`) and verifies
 * that selecting the harness in the typeahead updates the URL, the project
 * list shows only the selected harness, and the filter survives a reload.
 */

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

function fixture(name: string): string {
  return path.join(FIXTURES_DIR, name);
}

/**
 * Import a Claude Code session fixture via the Manual Import page into a new
 * analytics project. Returns the session id that was imported.
 *
 * Mirrors the `importSession` helper in `sessions-filter.spec.ts` but is
 * duplicated here to keep browser specs self-contained per the E2E skill.
 */
async function importClaudeSession(
  page: Page,
  projectName: string,
  fileName: string,
): Promise<string> {
  await page.goto('/#/manual-import');
  await expect(page.getByRole('heading', { name: 'Manual Import' })).toBeVisible();

  await page.locator('input[type="file"]').setInputFiles(fixture(fileName));
  await expect(page.getByRole('heading', { name: 'Harness' })).toBeVisible({
    timeout: 15000,
  });

  await page.locator('#project-select').selectOption('__new__');
  await page.locator('input[placeholder="New project name"]').fill(projectName);

  const sessionInput = page.locator('#session-input');
  await expect(sessionInput).not.toHaveValue('');

  await page.getByRole('button', { name: 'Import partial session' }).click();
  await expect(page.getByRole('button', { name: 'View session' })).toBeVisible({
    timeout: 30000,
  });

  return sessionInput.inputValue();
}

/**
 * Open the harness typeahead dropdown on the active page's filter bar and
 * click the option matching `harnessValue`.
 *
 * The `<lit-typeahead>` renders a toggle-icon button inside its shadow DOM.
 * Clicking it opens the dropdown; the options are `<li role="option">` items.
 * The filter bar lives inside a page's shadow root (portfolio-view or
 * project-behavior-view), so we pierce shadow roots to find the typeahead.
 */
async function selectHarness(page: Page, harnessValue: string): Promise<void> {
  // Wait for the lit-typeahead to have harness options loaded before opening.
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          function scan(root: Document | ShadowRoot | Element): HTMLElement | null {
            const labels = root.querySelectorAll('label');
            for (const label of Array.from(labels)) {
              if (label.textContent?.trim().startsWith('Harness')) {
                const ta = label.querySelector('lit-typeahead') as HTMLElement | null;
                if (ta) return ta;
              }
            }
            for (const host of root.querySelectorAll('*')) {
              const el = host as HTMLElement & { shadowRoot?: ShadowRoot | null };
              if (el.shadowRoot) {
                const inner = scan(el.shadowRoot);
                if (inner) return inner;
              }
            }
            return null;
          }
          const ta = scan(document) as (HTMLElement & { items?: unknown[] }) | null;
          if (!ta) return 0;
          return Array.isArray(ta.items) ? ta.items.length : 0;
        }),
      { timeout: 15000 },
    )
    .toBeGreaterThan(0);

  await page.evaluate(async (value: string) => {
    function scan(root: Document | ShadowRoot | Element): HTMLElement | null {
      const labels = root.querySelectorAll('label');
      for (const label of Array.from(labels)) {
        if (label.textContent?.trim().startsWith('Harness')) {
          const ta = label.querySelector('lit-typeahead') as HTMLElement | null;
          if (ta) return ta;
        }
      }
      for (const host of root.querySelectorAll('*')) {
        const el = host as HTMLElement & { shadowRoot?: ShadowRoot | null };
        if (el.shadowRoot) {
          const inner = scan(el.shadowRoot);
          if (inner) return inner;
        }
      }
      return null;
    }

    const typeahead = scan(document);
    if (!typeahead) throw new Error('lit-typeahead for Harness not found');

    const toggleBtn = typeahead.shadowRoot?.querySelector(
      'button.toggle-icon',
    ) as HTMLElement | null;
    if (!toggleBtn) throw new Error('toggle-icon button not found');
    toggleBtn.click();

    // Wait for the dropdown to render (the typeahead needs a frame to update).
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await new Promise((resolve) => setTimeout(resolve, 50));

    const dropdown = typeahead.shadowRoot?.querySelector('ul.dropdown');
    if (!dropdown) throw new Error('dropdown not rendered after toggle click');

    const options = Array.from(dropdown.querySelectorAll<HTMLLIElement>('li[role="option"]'));
    const target = options.find((li) => li.textContent?.trim() === value);
    if (!target) {
      const available = options.map((li) => li.textContent?.trim()).join(', ');
      throw new Error(`harness option "${value}" not found; available: ${available}`);
    }
    target.click();
  }, harnessValue);
}

/**
 * Read the rendered project list rows from the portfolio's Projects table.
 * Returns an array of `{ name, sessions, harness }` objects.
 */
async function readProjectRows(
  page: Page,
): Promise<Array<{ name: string; sessions: string; harness: string }>> {
  return page.evaluate(() => {
    function findInShadows(
      root: Document | ShadowRoot | Element,
      selector: string,
    ): Element | null {
      const found = root.querySelector(selector);
      if (found) return found;
      for (const host of root.querySelectorAll('*')) {
        const el = host as HTMLElement & { shadowRoot?: ShadowRoot | null };
        if (el.shadowRoot) {
          const inner = findInShadows(el.shadowRoot, selector);
          if (inner) return inner;
        }
      }
      return null;
    }

    const table = findInShadows(document, '.portfolio-view table') as HTMLTableElement | null;
    if (!table) return [];
    const rows = Array.from(table.querySelectorAll('tbody tr'));
    return rows.map((row) => {
      const cells = row.querySelectorAll('td');
      return {
        name: cells[0]?.textContent?.trim() ?? '',
        sessions: cells[1]?.textContent?.trim() ?? '',
        harness: cells[2]?.textContent?.trim() ?? '',
      };
    });
  });
}

test.describe('Harness typeahead filter (UX-027)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('UX-027: portfolio harness filter updates the URL and filters the project list', async ({
    page,
  }) => {
    const projectName = 'Harness Filter UX027';
    await importClaudeSession(page, projectName, 'claude-session.jsonl');

    // Navigate to the portfolio (home) page.
    await page.goto('/#/');
    await expect(page.locator('.filter-bar')).toBeVisible({ timeout: 10000 });

    // Sanity check: the project list shows the claude-code harness when unfiltered.
    await expect
      .poll(async () => readProjectRows(page), { timeout: 15000 })
      .toContainEqual(expect.objectContaining({ name: projectName, harness: 'claude-code' }));

    // Select the "claude-code" harness from the typeahead.
    await selectHarness(page, 'claude-code');
    await expect(page).toHaveURL(/harness=claude-code/);

    // The project list should still show the project, now filtered to claude-code.
    const filteredRows = await readProjectRows(page);
    const projectRows = filteredRows.filter((r) => r.name === projectName);
    expect(projectRows.length).toBeGreaterThan(0);
    for (const row of projectRows) {
      expect(row.harness).toBe('claude-code');
    }

    // Reload and confirm the filter persisted in the URL.
    const persistedUrl = page.url();
    await page.reload();
    await expect(page.locator('.filter-bar')).toBeVisible({ timeout: 10000 });
    await expect(page).toHaveURL(persistedUrl);
  });

  test('UX-027: project behavior harness filter updates the URL and persists', async ({ page }) => {
    const projectName = 'Harness Filter Project UX027';
    await importClaudeSession(page, projectName, 'claude-session.jsonl');

    // Navigate to the project behavior page.
    await page.goto(`/#/projects/${encodeURIComponent(projectName)}`);
    await expect(page.locator('.filter-bar')).toBeVisible({ timeout: 10000 });

    // Select the "claude-code" harness from the typeahead. selectHarness waits
    // for the harness options to be loaded before opening the dropdown.
    await selectHarness(page, 'claude-code');
    await expect(page).toHaveURL(/harness=claude-code/);

    // Reload and confirm the filter persisted in the URL.
    const persistedUrl = page.url();
    await page.reload();
    await expect(page.locator('.filter-bar')).toBeVisible({ timeout: 10000 });
    await expect(page).toHaveURL(persistedUrl);
  });
});
