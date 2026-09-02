import { expect, type Page, test } from '@playwright/test';
import {
  buildSessionManifest,
  FixtureBucket,
  fixtureBuffer,
  S3_BUCKET,
  S3_ENDPOINT,
} from './sync-fixtures.js';

const PASSKEY = 'e2e-passkey';

/**
 * E2E regression tests for the design-fixes PR. Each test guards a specific
 * UX change so future refactors cannot silently revert the fix.
 *
 * Covered changes:
 * - UX-017: Header nav active state (2px solid white border-bottom)
 * - UX-018: Left-nav Projects collapsed on /projects list, expanded on
 *   specific project routes, with per-project stats
 * - UX-019: Sync-confirm modal appears when syncing a saved connection,
 *   and a locked vault prompts for passkey before proceeding
 * - UX-020: Data-sources edit updates the URL hash
 * - UX-021: Loading state is visible before the app is ready
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// UX-017: Header navigation active state
// ---------------------------------------------------------------------------

test.describe('Header navigation active state (UX-017)', () => {
  test('Dashboard link is active on /', async ({ page }) => {
    await page.goto('/#/');
    await waitForAppReady(page);
    const dashboardLink = page.locator('nav.header-nav a', { hasText: 'Dashboard' });
    const artifactsLink = page.locator('nav.header-nav a', { hasText: 'Artifacts' });
    await expect(dashboardLink).toHaveClass(/active/);
    await expect(artifactsLink).not.toHaveClass(/active/);
  });

  test('Dashboard link is active on /projects', async ({ page }) => {
    await page.goto('/#/projects');
    await waitForAppReady(page);
    const dashboardLink = page.locator('nav.header-nav a', { hasText: 'Dashboard' });
    await expect(dashboardLink).toHaveClass(/active/);
  });

  test('Dashboard link is active on /portfolio', async ({ page }) => {
    await page.goto('/#/portfolio');
    await waitForAppReady(page);
    const dashboardLink = page.locator('nav.header-nav a', { hasText: 'Dashboard' });
    await expect(dashboardLink).toHaveClass(/active/);
  });

  test('Artifacts link is active on /artifacts', async ({ page }) => {
    await page.goto('/#/artifacts');
    await waitForAppReady(page);
    const artifactsLink = page.locator('nav.header-nav a', { hasText: 'Artifacts' });
    const dashboardLink = page.locator('nav.header-nav a', { hasText: 'Dashboard' });
    await expect(artifactsLink).toHaveClass(/active/);
    await expect(dashboardLink).not.toHaveClass(/active/);
  });

  test('Artifacts link is active on /artifact-diff', async ({ page }) => {
    await page.goto('/#/artifact-diff');
    await waitForAppReady(page);
    const artifactsLink = page.locator('nav.header-nav a', { hasText: 'Artifacts' });
    await expect(artifactsLink).toHaveClass(/active/);
  });
});

// ---------------------------------------------------------------------------
// UX-018: Left-nav Projects section
// ---------------------------------------------------------------------------

test.describe('Left-nav Projects section (UX-018)', () => {
  test('Projects section is collapsed on /projects list page', async ({ page }) => {
    await page.goto('/#/projects');
    await waitForAppReady(page);
    const projectsItem = page.locator('left-nav').locator('a.nav-item', { hasText: 'Projects' });
    await expect(projectsItem).not.toHaveClass(/expanded/);
  });

  test('Projects section auto-expands on a specific project route', async ({ page }) => {
    await createProject(page, 'NavExpandTest');
    // Navigate to the project behavior page by clicking the card
    await page.locator('.project-card', { hasText: 'NavExpandTest' }).click();
    await expect(page.getByRole('heading', { name: 'Project Behavior' })).toBeVisible({
      timeout: 15000,
    });
    const projectsItem = page.locator('left-nav').locator('a.nav-item', { hasText: 'Projects' });
    await expect(projectsItem).toHaveClass(/expanded/);
  });

  test('project child links show session count stats', async ({ page }) => {
    await createProject(page, 'NavStatsTest');
    // Reload to ensure the left-nav picks up the new project from the DB.
    await page.reload();
    await waitForAppReady(page);
    // Navigate to the project behavior page
    await page.goto('/#/projects');
    await page.locator('.project-card', { hasText: 'NavStatsTest' }).click();
    await expect(page.getByRole('heading', { name: 'Project Behavior' })).toBeVisible({
      timeout: 15000,
    });
    // The expanded Projects section should show child links with stats
    const childStats = page.locator('left-nav .nav-child-stats');
    await expect(childStats.first()).toBeVisible({ timeout: 10000 });
    // Stats should contain "session" text
    await expect(childStats.first()).toContainText(/session/i);
  });
});

// ---------------------------------------------------------------------------
// UX-019: Sync-confirm modal
// ---------------------------------------------------------------------------

test.describe('Sync-confirm modal (UX-019)', () => {
  test('sync-confirm modal appears when syncing a saved connection', async ({ page }) => {
    const bucket = new FixtureBucket();
    bucket.addProject('confirm-proj', 'Confirm Project', '');
    bucket.addSession('confirm-proj', 'e2e-claude-session', {
      files: [
        {
          scope: 'session',
          relativePath: 'transcript.jsonl',
          content: fixtureBuffer('claude-session.jsonl'),
        },
      ],
    });
    await bucket.installRoute(page);

    // Navigate directly to the new-connection form via the route.
    // This avoids the form-detachment issue that occurs when clicking
    // "+ New connection" changes the hash mid-interaction.
    await page.goto('/#/settings/data-sources/new');
    await waitForAppReady(page);
    const panel = page.locator('connect-modal');
    await expect(panel.getByLabel('Connection name')).toBeVisible({ timeout: 10000 });

    // Fill the new connection form
    await panel.getByLabel('Connection name').fill('ConfirmTest');
    await panel.getByLabel('Region').fill('us-east-1');
    await panel.getByLabel('Bucket').fill(S3_BUCKET);
    await panel.getByLabel('Endpoint (optional)').fill(S3_ENDPOINT);
    await panel.getByLabel('Access key ID').fill('AKIA');
    await panel.getByLabel('Secret access key').fill('secret');
    await panel.getByLabel('Save to local storage').check();

    // Save the connection (triggers passkey creation)
    await panel.getByRole('button', { name: 'Save' }).click();
    const passkeyModal = page.getByRole('dialog', { name: 'Passkey' });
    await expect(passkeyModal).toBeVisible({ timeout: 10000 });
    await passkeyModal.getByLabel('Passkey').first().fill(PASSKEY);
    const confirm = passkeyModal.getByLabel('Confirm passkey');
    if (await confirm.isVisible().catch(() => false)) {
      await confirm.fill(PASSKEY);
    }
    await passkeyModal.getByRole('button', { name: /Create Passkey/ }).click();
    await expect(passkeyModal).toBeHidden({ timeout: 10000 });

    // Wait for the connection list to show the saved connection
    await expect(panel.getByText('ConfirmTest')).toBeVisible({ timeout: 10000 });

    // Click Sync on the saved connection row — should open the sync-confirm modal
    await panel.getByRole('button', { name: 'Sync' }).click();

    const syncConfirm = page.getByRole('dialog', { name: 'Confirm sync' });
    await expect(syncConfirm).toBeVisible({ timeout: 10000 });
    // The modal should have the "Sync only new sessions" checkbox
    await expect(syncConfirm.getByLabel('Sync only new sessions')).toBeVisible();
    // The modal should have a "Start Sync" button
    await expect(syncConfirm.getByRole('button', { name: 'Start Sync' })).toBeVisible();
  });

  test('syncing a saved connection with a locked vault prompts for passkey then proceeds', async ({
    page,
  }) => {
    const bucket = new FixtureBucket();
    bucket.addProject('passkey-proj', 'Passkey Project', '');
    bucket.addSession('passkey-proj', 'e2e-passkey-session', {
      files: [
        {
          scope: 'session',
          relativePath: 'transcript.jsonl',
          content: fixtureBuffer('claude-session.jsonl'),
        },
      ],
    });
    await bucket.installRoute(page);

    // Create + save a connection with a passkey (same flow as above).
    await page.goto('/#/settings/data-sources/new');
    await waitForAppReady(page);
    const panel = page.locator('connect-modal');
    await expect(panel.getByLabel('Connection name')).toBeVisible({ timeout: 10000 });
    await panel.getByLabel('Connection name').fill('PasskeySync');
    await panel.getByLabel('Region').fill('us-east-1');
    await panel.getByLabel('Bucket').fill(S3_BUCKET);
    await panel.getByLabel('Endpoint (optional)').fill(S3_ENDPOINT);
    await panel.getByLabel('Access key ID').fill('AKIA');
    await panel.getByLabel('Secret access key').fill('secret');
    await panel.getByLabel('Save to local storage').check();
    await panel.getByRole('button', { name: 'Save' }).click();
    const createModal = page.getByRole('dialog', { name: 'Passkey' });
    await expect(createModal).toBeVisible({ timeout: 10000 });
    await createModal.getByLabel('Passkey').first().fill(PASSKEY);
    const confirm = createModal.getByLabel('Confirm passkey');
    if (await confirm.isVisible().catch(() => false)) {
      await confirm.fill(PASSKEY);
    }
    await createModal.getByRole('button', { name: /Create Passkey/ }).click();
    await expect(createModal).toBeHidden({ timeout: 10000 });
    await expect(panel.getByText('PasskeySync')).toBeVisible({ timeout: 10000 });

    // Reload so the vault is locked again.
    await page.reload();
    await waitForAppReady(page);
    await page.goto('/#/settings/data-sources');
    await expect(panel.getByRole('heading', { name: 'Connections' })).toBeVisible({
      timeout: 10000,
    });
    await expect(panel.getByText('PasskeySync')).toBeVisible({ timeout: 10000 });

    // Click Sync on the saved row → sync-confirm modal → Start Sync.
    // The vault is locked, so the passkey prompt (driven by setPasskeyPrompt
    // in app-root) should open. This is the code path the review flagged as
    // untested: sync a saved connection with a locked vault.
    await panel.getByRole('button', { name: 'Sync' }).click();
    const syncConfirm = page.getByRole('dialog', { name: 'Confirm sync' });
    await expect(syncConfirm).toBeVisible({ timeout: 10000 });
    await syncConfirm.getByRole('button', { name: 'Start Sync' }).click();

    // The passkey unlock modal should appear (vault is locked).
    const unlockModal = page.getByRole('dialog', { name: 'Passkey' });
    await expect(unlockModal).toBeVisible({ timeout: 10000 });
    await unlockModal.getByLabel('Passkey').first().fill(PASSKEY);
    await unlockModal.getByRole('button', { name: 'Unlock' }).click();
    await expect(unlockModal).toBeHidden({ timeout: 10000 });

    // The sync should proceed — wait for the progress bar.
    await expect(
      page.locator('app-root').locator('sync-progress-bar').getByRole('status'),
    ).toBeVisible({
      timeout: 10000,
    });
  });
});

// ---------------------------------------------------------------------------
// UX-020: Data-sources edit URL
// ---------------------------------------------------------------------------

test.describe('Data-sources edit URL (UX-020)', () => {
  test('data-sources page renders on /settings/data-sources', async ({ page }) => {
    await page.goto('/#/settings/data-sources');
    await waitForAppReady(page);
    await expect(page.getByRole('heading', { name: 'Data Sources' })).toBeVisible({
      timeout: 15000,
    });
  });

  test('navigating to /settings/data-sources/new opens the new connection form', async ({
    page,
  }) => {
    await page.goto('/#/settings/data-sources/new');
    await waitForAppReady(page);
    // The Data Sources heading should be visible
    await expect(page.getByRole('heading', { name: 'Data Sources' })).toBeVisible({
      timeout: 15000,
    });
    const panel = page.locator('connect-modal');
    // The form should be visible with the Connection name input
    await expect(panel.getByLabel('Connection name')).toBeVisible({ timeout: 10000 });
    // The URL should contain /settings/data-sources/new
    await expect(page).toHaveURL(/#\/settings\/data-sources\/new/);
  });

  test('clicking New connection updates the URL hash to /settings/data-sources/new', async ({
    page,
  }) => {
    await page.goto('/#/settings/data-sources');
    await waitForAppReady(page);
    const panel = page.locator('connect-modal');
    await expect(panel.getByRole('heading', { name: 'Connections' })).toBeVisible({
      timeout: 10000,
    });
    await panel.getByRole('button', { name: '+ New connection' }).click();
    // The form should be visible and the URL should contain /new
    await expect(panel.getByLabel('Connection name')).toBeVisible({ timeout: 10000 });
    await expect(page).toHaveURL(/#\/settings\/data-sources\/new/, { timeout: 5000 });
  });
});

// ---------------------------------------------------------------------------
// UX-021: Loading state
// ---------------------------------------------------------------------------

test.describe('Loading state (UX-021)', () => {
  test('app eventually loads and loading state disappears', async ({ page }) => {
    await page.goto('/#/');
    // Wait for the header to appear (app is ready)
    await expect(page.locator('header')).toBeVisible({ timeout: 15000 });
    // The loading state should be gone
    await expect(page.locator('.app-loading')).not.toBeVisible();
  });
});
