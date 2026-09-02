import { expect, type Page, test } from '@playwright/test';

/**
 * E2E regression tests for the app shell's icon rail (issue #165:
 * "Redesign 2/11: App shell — icon rail + top bar").
 *
 * Covered changes:
 * - UX-023: Rail navigation journey across the four destinations
 *   (Portfolio, Projects, Artifacts, Settings), including nested-route
 *   active-state mapping, plus keyboard accessibility (Tab order, Enter
 *   activation, visible focus outline).
 * - UX-024: `aria-current="page"` is present only on the active rail item
 *   and absent (not `"false"`) on the other three.
 * - UX-025: The four domain pages (Agents/Skills/Tools/MCP) remain
 *   reachable in the documented interim 2-click path — rail → Artifacts →
 *   domain link row — now that `left-nav` (their only prior link) is gone.
 */

/**
 * `icon-rail` (not `header`) is the app-ready signal: issue #170 swaps the
 * global header for a page-owned title row on the Portfolio route (`/`)
 * only, so `header` is legitimately absent there while `icon-rail` stays
 * mounted on every route once the app finishes booting.
 */
async function waitForAppReady(page: Page): Promise<void> {
  await expect(page.locator('icon-rail')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.app-loading')).toBeHidden({ timeout: 15000 });
}

async function createProject(page: Page, name: string): Promise<void> {
  await page.goto('/#/projects');
  await waitForAppReady(page);
  await page.getByRole('button', { name: '+ New Project' }).click();
  await page.locator('#project-name-input').fill(name);
  await page.getByRole('button', { name: 'Create Project' }).click();
  await expect(page.locator('.project-card', { hasText: name })).toBeVisible({
    timeout: 10000,
  });
}

function railItem(page: Page, label: string) {
  return page.locator('icon-rail').locator(`a.rail-item[aria-label="${label}"]`);
}

test.describe('Icon rail navigation journey (UX-023)', () => {
  test('clicking each destination navigates and highlights the right rail item', async ({
    page,
  }) => {
    await page.goto('/#/');
    await waitForAppReady(page);
    await expect(railItem(page, 'Portfolio')).toHaveClass(/active/);

    await railItem(page, 'Projects').click();
    await expect(page).toHaveURL(/#\/projects$/);
    await expect(railItem(page, 'Projects')).toHaveClass(/active/);
    await expect(railItem(page, 'Portfolio')).not.toHaveClass(/active/);

    await railItem(page, 'Artifacts').click();
    await expect(page).toHaveURL(/#\/artifacts$/);
    await expect(railItem(page, 'Artifacts')).toHaveClass(/active/);
    await expect(page.getByRole('heading', { name: 'Artifact Ecosystem' })).toBeVisible();

    await railItem(page, 'Settings').click();
    await expect(page).toHaveURL(/#\/settings\/data-sources$/);
    await expect(railItem(page, 'Settings')).toHaveClass(/active/);

    await railItem(page, 'Portfolio').click();
    await expect(page).toHaveURL(/#\/$/);
    await expect(railItem(page, 'Portfolio')).toHaveClass(/active/);
  });

  test('a project behavior page (nested /projects/:slug route) keeps Projects active', async ({
    page,
  }) => {
    await createProject(page, 'RailNestedTest');
    await page.locator('.project-card', { hasText: 'RailNestedTest' }).click();
    await expect(page.getByRole('heading', { name: 'Project Behavior' })).toBeVisible({
      timeout: 15000,
    });
    await expect(railItem(page, 'Projects')).toHaveClass(/active/);
  });

  test('/settings/storage keeps Settings active', async ({ page }) => {
    await page.goto('/#/settings/storage');
    await waitForAppReady(page);
    await expect(railItem(page, 'Settings')).toHaveClass(/active/);
  });

  test('keyboard: Tab reaches every rail item, Enter navigates, focus outline is visible', async ({
    page,
  }) => {
    await page.goto('/#/');
    await waitForAppReady(page);

    // Focus the logo mark, then Tab through the four destinations in order.
    await page.locator('icon-rail .logo-mark').focus();
    const labels = ['Portfolio', 'Projects', 'Artifacts', 'Settings'];
    for (const label of labels) {
      await page.keyboard.press('Tab');
      await expect(railItem(page, label)).toBeFocused();
    }

    // The focused (Settings) item shows a visible focus outline.
    const outline = await railItem(page, 'Settings').evaluate((el) => {
      const style = getComputedStyle(el);
      return { style: style.outlineStyle, width: style.outlineWidth };
    });
    expect(outline.style).not.toBe('none');
    expect(Number.parseFloat(outline.width)).toBeGreaterThan(0);

    // Enter activates the focused item and navigates.
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/#\/settings\/data-sources$/);
  });
});

test.describe('Icon rail aria-current semantics (UX-024)', () => {
  const destinations: Array<{ hash: string; active: string }> = [
    { hash: '/#/', active: 'Portfolio' },
    { hash: '/#/projects', active: 'Projects' },
    { hash: '/#/artifacts', active: 'Artifacts' },
    { hash: '/#/settings/data-sources', active: 'Settings' },
  ];

  for (const { hash, active } of destinations) {
    test(`only the active item (${active}) carries aria-current="page" on ${hash}`, async ({
      page,
    }) => {
      await page.goto(hash);
      await waitForAppReady(page);

      const allLabels = ['Portfolio', 'Projects', 'Artifacts', 'Settings'];
      for (const label of allLabels) {
        const item = railItem(page, label);
        if (label === active) {
          await expect(item).toHaveAttribute('aria-current', 'page');
        } else {
          await expect(item).not.toHaveAttribute('aria-current');
        }
      }
    });
  }
});

test.describe('Domain pages reachability via Artifacts (UX-025)', () => {
  const domainPages = ['Agents', 'Skills', 'Tools', 'MCP'];

  for (const label of domainPages) {
    test(`${label} is reachable in two clicks: rail Artifacts -> domain link row`, async ({
      page,
    }) => {
      await page.goto('/#/');
      await waitForAppReady(page);

      await railItem(page, 'Artifacts').click();
      await expect(page).toHaveURL(/#\/artifacts$/);

      await page.locator('.domain-pages-row a', { hasText: label }).click();
      await expect(page).toHaveURL(new RegExp(`#/${label.toLowerCase()}$`));
      await expect(page.getByRole('heading', { name: label })).toBeVisible();
      await expect(page.getByText('Not available yet')).toBeVisible();
    });
  }
});
