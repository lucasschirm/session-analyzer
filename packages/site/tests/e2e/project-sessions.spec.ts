import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

function fixture(name: string): string {
  return path.join(FIXTURES_DIR, name);
}

async function waitForAppReady(page: Page): Promise<void> {
  await expect(page.locator('header')).toBeVisible({ timeout: 15000 });
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

async function importSessionIntoProject(
  page: Page,
  projectName: string,
  fileNames: string[],
): Promise<string> {
  await createProject(page, projectName);

  await page.goto('/#/manual-import');
  await waitForAppReady(page);
  await expect(page.getByRole('heading', { name: 'Manual Import' })).toBeVisible();

  const filePaths = fileNames.map((f) => fixture(f));
  await page.locator('input[type="file"]').setInputFiles(filePaths);

  await expect(page.getByRole('heading', { name: 'Harness' })).toBeVisible({ timeout: 15000 });

  const projectSelect = page.locator('#project-select');
  await projectSelect.selectOption('__new__');
  await page.locator('input[placeholder="New project name"]').fill(projectName);

  const sessionInput = page.locator('#session-input');
  await expect(sessionInput).not.toHaveValue('');

  await page.getByRole('button', { name: 'Import partial session' }).click();

  await expect(page.getByRole('button', { name: 'View session' })).toBeVisible({
    timeout: 30000,
  });

  return sessionInput.inputValue();
}

test.describe('Project Sessions Expansion and Navigation (UX-027)', () => {
  test('left-nav expands project sessions and navigates to session detail', async ({ page }) => {
    const projectName = 'NavSessionExpTest';
    await importSessionIntoProject(page, projectName, ['claude-rich-session.jsonl']);

    // Navigate to homepage
    await page.goto('/#/');
    await waitForAppReady(page);

    const leftNav = page.locator('left-nav');
    await expect(leftNav).toBeVisible();

    // Click Projects to expand the projects list
    const projectsItem = leftNav.locator('a.nav-item', { hasText: 'Projects' });
    await projectsItem.click();

    // Find our project group in the navigation
    const projectRow = leftNav.locator('.nav-project-row', { hasText: projectName });
    await expect(projectRow).toBeVisible({ timeout: 10000 });

    // Toggle chevron to expand sessions
    const chevronBtn = projectRow.locator('.project-chevron-btn');
    await chevronBtn.click();
    await expect(chevronBtn).toHaveAttribute('aria-expanded', 'true');

    // Verify session item is displayed
    const sessionItem = leftNav.locator('.nav-session-item');
    await expect(sessionItem.first()).toBeVisible({ timeout: 10000 });

    // Click session item to navigate to session evidence page
    await sessionItem.first().click();
    await expect(page).toHaveURL(/#\/sessions\//);
    await expect(page.locator('session-evidence-view')).toBeVisible({ timeout: 15000 });
  });
});

test.describe('Dedicated Project Sessions Page (UX-028)', () => {
  test('renders dedicated sessions list page with filters and pagination', async ({ page }) => {
    const projectName = 'ProjectSessionsPageTest';
    await importSessionIntoProject(page, projectName, ['claude-rich-session.jsonl']);

    // Navigate to dedicated sessions page
    await page.goto(`/#/projects/${encodeURIComponent(projectName)}/sessions`);
    await waitForAppReady(page);

    const sessionsPage = page.locator('project-sessions-page');
    await expect(sessionsPage).toBeVisible({ timeout: 15000 });

    // Verify human-readable project name in heading
    const heading = sessionsPage.locator('h1');
    await expect(heading).toContainText(projectName);
    await expect(heading).not.toContainText('proj-');

    // Verify breadcrumb links
    const dashboardLink = sessionsPage.locator('.breadcrumbs a', { hasText: '< Dashboard' });
    await expect(dashboardLink).toBeVisible();
    const behaviorLink = sessionsPage.locator('.breadcrumbs a', { hasText: 'Project Behavior' });
    await expect(behaviorLink).toBeVisible();

    // Verify filter bar elements
    await expect(sessionsPage.locator('.filter-bar input[placeholder*="Search"]')).toBeVisible();
    await expect(sessionsPage.locator('.filter-bar input[type="date"]').first()).toBeVisible();
    await expect(sessionsPage.locator('.filter-bar button', { hasText: 'Reset' })).toBeVisible();

    // Search filter interaction
    const searchInput = sessionsPage.locator('.filter-bar input[placeholder*="Search"]');
    await searchInput.fill('NonExistentSessionQuery');
    await expect(sessionsPage.locator('.empty-state')).toBeVisible({ timeout: 5000 });

    // Reset filter
    await sessionsPage.locator('.filter-bar button', { hasText: 'Reset' }).click();
    await expect(sessionsPage.locator('project-sessions-table tbody tr').first()).toBeVisible({
      timeout: 5000,
    });
  });

  test('displays error banner affordance on query failure without masquerading as empty state', async ({
    page,
  }) => {
    const projectName = 'SessionsErrorTest';
    await importSessionIntoProject(page, projectName, ['claude-rich-session.jsonl']);

    await page.goto(`/#/projects/${encodeURIComponent(projectName)}/sessions`);
    await waitForAppReady(page);

    const sessionsPage = page.locator('project-sessions-page');
    await expect(sessionsPage).toBeVisible({ timeout: 15000 });

    // Inject query failure error state into the sessions table component
    await page
      .locator('project-sessions-table')
      .evaluate((el: HTMLElement & { error: string | null }) => {
        el.error = 'Failed to load sessions from database';
      });

    const errorBanner = page.locator('project-sessions-table .error-banner');
    await expect(errorBanner).toBeVisible();
    await expect(errorBanner).toContainText('Failed to load sessions');
    await expect(page.locator('project-sessions-table .empty-state')).not.toBeVisible();
  });
});

test.describe('Project Sessions Table (UX-029)', () => {
  test('displays sessions table columns, non-raw-id titles, and navigates on row click', async ({
    page,
  }) => {
    const projectName = 'SessionsTableTest';
    await importSessionIntoProject(page, projectName, ['claude-rich-session.jsonl']);

    await page.goto(`/#/projects/${encodeURIComponent(projectName)}/sessions`);
    await waitForAppReady(page);

    const table = page.locator('project-sessions-table');
    await expect(table).toBeVisible({ timeout: 15000 });

    // Verify table headers
    const ths = table.locator('th');
    await expect(ths.nth(0)).toHaveText('Title');
    await expect(ths.nth(1)).toHaveText('Start date');
    await expect(ths.nth(2)).toHaveText('Sub agents');

    // Verify session row and title (not raw UUID)
    const firstRow = table.locator('tbody tr').first();
    await expect(firstRow).toBeVisible();
    const titleLink = firstRow.locator('.session-title-link');
    const titleText = await titleLink.textContent();
    expect(titleText?.trim()).not.toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}/i);

    // Verify tooltip does not expose raw UUID
    const tooltipTitle = await titleLink.getAttribute('title');
    expect(tooltipTitle).not.toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}/i);

    // Clicking row navigates to session evidence view
    await firstRow.click();
    await expect(page).toHaveURL(/#\/sessions\//);
    await expect(page.locator('session-evidence-view')).toBeVisible({ timeout: 15000 });
  });
});

test.describe('Session Context Growth Chart and Detail Drawer (UX-030)', () => {
  test('interacts with context growth chart, opens drawer, traps focus, and closes on Escape', async ({
    page,
  }) => {
    const projectName = 'ContextGrowthDrawerTest';
    await importSessionIntoProject(page, projectName, ['claude-rich-session.jsonl']);

    // Navigate to the session evidence view via project behavior
    await page.goto(`/#/projects/${encodeURIComponent(projectName)}`);
    await waitForAppReady(page);

    const sessionLink = page.locator('project-sessions-table .session-title-link').first();
    await sessionLink.click();
    await expect(page).toHaveURL(/#\/sessions\//);

    const evidenceView = page.locator('session-evidence-view');
    await expect(evidenceView).toBeVisible({ timeout: 15000 });

    // Verify context growth section is present
    const contextGrowth = evidenceView.locator('#context-growth');
    await expect(contextGrowth).toBeVisible({ timeout: 10000 });

    const chart = contextGrowth.locator('analytics-chart');
    await expect(chart).toBeVisible();

    // The drawer element is present in the DOM
    const drawer = evidenceView.locator('session-context-drawer');
    await expect(drawer).toBeAttached();

    // Verify drawer is initially closed
    await expect(drawer.locator('.drawer-panel')).not.toBeVisible();

    // Wait for the chart data to be fully loaded and rendered
    await expect(contextGrowth.locator('.summary-toggle')).toBeVisible({ timeout: 15000 });

    // Click the first message via the accessible table fallback row
    await chart.locator('summary', { hasText: 'View as table' }).click();
    await chart.locator('tbody tr').first().click();

    // Drawer should open with message details
    const drawerPanel = drawer.locator('.drawer-panel');
    await expect(drawerPanel).toBeVisible({ timeout: 5000 });
    await expect(drawerPanel).toHaveAttribute('role', 'dialog');
    await expect(drawerPanel).toHaveAttribute('aria-modal', 'true');

    // Close button should be focused
    const closeBtn = drawerPanel.locator('.close-button');
    await expect(closeBtn).toBeFocused();

    // Press Escape to close drawer
    await page.keyboard.press('Escape');
    await expect(drawerPanel).not.toBeVisible({ timeout: 5000 });
  });
});
