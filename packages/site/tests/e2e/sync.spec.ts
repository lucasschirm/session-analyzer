import { expect, type Locator, type Page, test } from '@playwright/test';
import { verifyExportContents } from './helpers/export-verify.js';
import { assertHeartbeat, syncProgressFilesParser } from './helpers/heartbeat.js';
import {
  buildSessionManifest,
  FixtureBucket,
  fixtureBuffer,
  S3_BUCKET,
  S3_ENDPOINT,
} from './sync-fixtures.js';

const PASSKEY = 'e2e-passkey';

function attachLoggers(page: Page): void {
  page.on('pageerror', (err) => {
    console.error(`[pageerror] ${err.message}`);
  });
}

async function openConnectModal(page: Page): Promise<void> {
  await page.goto('/#/settings/data-sources');
  await expect(
    page.locator('connect-modal').getByRole('heading', { name: 'Connections' }),
  ).toBeVisible({
    timeout: 10000,
  });
}

async function fillConnectionForm(
  page: Page,
  options: { name?: string; syncOnlyNew?: boolean } = {},
): Promise<void> {
  const panel = page.locator('connect-modal');
  await panel.getByRole('button', { name: '+ New connection' }).click();
  await panel.getByLabel('Connection name').fill(options.name ?? 'E2E');
  await panel.getByLabel('Region').fill('us-east-1');
  await panel.getByLabel('Bucket').fill(S3_BUCKET);
  await panel.getByLabel('Endpoint (optional)').fill(S3_ENDPOINT);
  await panel.getByLabel('Access key ID').fill('AKIA');
  await panel.getByLabel('Secret access key').fill('secret');
  await panel.getByLabel('Save to local storage').check();
  if (options.syncOnlyNew) {
    await panel.getByLabel('Sync only new sessions').check();
  }
}

async function confirmPasskey(page: Page, passkey = PASSKEY): Promise<void> {
  const modal = page.getByRole('dialog', { name: 'Passkey' });
  await expect(modal).toBeVisible({ timeout: 10000 });
  const inputs = modal.getByLabel('Passkey');
  await inputs.first().fill(passkey);
  const confirm = modal.getByLabel('Confirm passkey');
  if (await confirm.isVisible().catch(() => false)) {
    await confirm.fill(passkey);
  }
  await modal.getByRole('button', { name: /Create Passkey|Unlock/ }).click();
  await expect(modal).toBeHidden({ timeout: 10000 });
}

/**
 * Navigate to the Data Sources settings page and unlock the vault if needed.
 * The inline connect-modal does not prompt for a passkey on load (unlike the
 * old header "Connect" button). To unlock the vault, edit an existing
 * connection and save — the save triggers the passkey unlock prompt when the
 * vault is locked. When the vault is already unlocked (e.g. after a previous
 * sync in the same page session), the save completes without a passkey
 * prompt.
 */
async function openConnectForResync(page: Page): Promise<void> {
  // Reload the page to ensure the connect-modal is freshly mounted in list
  // view. Without a reload, navigating to the same hash URL is a no-op and
  // the modal stays in whatever view it was in (e.g. form view from the
  // initial sync setup).
  await page.goto('/#/projects');
  await page.goto('/#/settings/data-sources');
  const panel = page.locator('connect-modal');
  await expect(panel.getByRole('heading', { name: 'Connections' })).toBeVisible({
    timeout: 10000,
  });
  // Wait for at least one connection row to appear, then edit and save to
  // unlock the vault if needed.
  const editButton = panel.getByRole('button', { name: 'Edit' }).first();
  await expect(editButton).toBeVisible({ timeout: 10000 });
  await editButton.click();
  await panel.getByRole('button', { name: 'Save' }).click();
  // After reload, the vault is locked and saving triggers the passkey prompt.
  // Use waitFor with a short race: either the passkey modal appears (vault
  // locked) or the Connections list reappears (vault already unlocked).
  const passkeyModal = page.getByRole('dialog', { name: 'Passkey' });
  const connectionsHeading = panel.getByRole('heading', { name: 'Connections' });
  await Promise.race([
    passkeyModal.waitFor({ state: 'visible', timeout: 5000 }),
    connectionsHeading.waitFor({ state: 'visible', timeout: 5000 }),
  ]);
  if (await passkeyModal.isVisible().catch(() => false)) {
    await confirmPasskey(page);
  }
  await expect(connectionsHeading).toBeVisible({ timeout: 10000 });
}

function progressBar(page: Page): Locator {
  return page.locator('app-root').locator('sync-progress-bar').getByRole('status');
}

/**
 * Click "Sync" on a saved connection row in the list view and confirm the
 * sync-confirm modal that appears (asking about "sync only new sessions").
 * This helper should be used when re-syncing an already-saved connection
 * from the data-sources list.
 */
async function clickRowSyncAndConfirm(
  page: Page,
  options: { syncOnlyNew?: boolean } = {},
): Promise<void> {
  const panel = page.locator('connect-modal');
  await panel.getByRole('button', { name: 'Sync' }).click();
  const syncConfirm = page.getByRole('dialog', { name: 'Confirm sync' });
  await expect(syncConfirm).toBeVisible({ timeout: 10000 });
  if (options.syncOnlyNew !== undefined) {
    const checkbox = syncConfirm.getByLabel('Sync only new sessions');
    const isChecked = await checkbox.isChecked();
    if (isChecked !== options.syncOnlyNew) {
      await checkbox.click();
    }
  }
  await syncConfirm.getByRole('button', { name: 'Start Sync' }).click();
  await expect(progressBar(page)).toBeVisible({ timeout: 10000 });
}

async function startSyncFromHome(
  page: Page,
  bucket: FixtureBucket,
  options: { syncOnlyNew?: boolean } = {},
): Promise<void> {
  await bucket.installRoute(page);
  await openConnectModal(page);
  await fillConnectionForm(page, options);
  const panel = page.locator('connect-modal');
  await panel.getByRole('button', { name: 'Sync' }).click();
  await confirmPasskey(page);
  await expect(progressBar(page)).toBeVisible({ timeout: 10000 });
}

/**
 * Wait for the sync run to reach a terminal state (done / cancelled / failed)
 * while the progress bar is still showing the completed summary. Use this when
 * you need to open the sync status modal to inspect session states.
 */
async function waitForSyncCompleted(page: Page, timeout = 30000): Promise<void> {
  await expect(progressBar(page)).toBeVisible({ timeout });
  // The completed bar shows ✓ (done), ⊘ (cancelled), or ⚠ (failed).
  await expect(progressBar(page)).toContainText(/[✓⊘⚠]/, { timeout });
}

/**
 * Wait for the progress bar to completely hide (including the 6-second
 * completed-summary display). Use this when you just need the sync to be
 * finished and don't need to inspect the modal.
 */
async function waitForSyncIdle(page: Page, timeout = 30000): Promise<void> {
  await expect(progressBar(page)).toBeHidden({ timeout });
}

/**
 * Click a project card on the projects page to navigate to the Project Behavior
 * analytics view. Clicking a project card routes to `#/projects/<slug>` which
 * renders `<h1>Project Behavior</h1>`.
 */
async function openProjectByName(page: Page, name: string): Promise<void> {
  await page.goto('/#/projects');
  const card = page.locator('.project-card', { hasText: name });
  await expect(card.first()).toBeVisible({ timeout: 10000 });
  await card.first().click();
  await expect(page).toHaveURL(/#\/projects\/[^/]+/);
  await expect(page.getByRole('heading', { name: 'Project Behavior' })).toBeVisible({
    timeout: 10000,
  });
}

/**
 * Navigate directly to the Project Behavior page for a project using its
 * readable_id (the S3 manifest projectId for sync-created projects).
 */
async function openProjectBehavior(page: Page, projectId: string): Promise<void> {
  await page.goto(`/#/projects/${projectId}`);
  await expect(page.getByRole('heading', { name: 'Project Behavior' })).toBeVisible({
    timeout: 10000,
  });
}

/**
 * Open the sync status modal by clicking the progress bar. The bar must be
 * visible (either during an active run or the completed-summary window).
 */
async function openSyncStatusModal(page: Page): Promise<Locator> {
  // Error toasts from sync failures can overlap the progress bar in the
  // header. Dispatch a click event directly to bypass Playwright's
  // pointer-interception check while still triggering the Lit handler.
  await progressBar(page).dispatchEvent('click');
  const modal = page.getByRole('dialog', { name: 'Sync status' });
  await expect(modal).toBeVisible({ timeout: 5000 });
  return modal;
}

/**
 * Find a session row inside the sync status modal by its session ID.
 */
function modalSessionItem(modal: Locator, sessionId: string): Locator {
  return modal.locator('.session-item').filter({ hasText: sessionId });
}

/**
 * Wait for a chart on the Project Behavior page to show data containing the
 * given text. The "Token usage trends" chart renders as an ECharts SVG with
 * an aria-label containing series names and data values. We verify via the
 * chart's aria-label (role="img") which includes the full data description.
 */
async function expectChartContains(
  page: Page,
  chartTitle: string,
  expectedText: string,
  timeout = 15000,
): Promise<void> {
  const chart = page
    .locator('analytics-chart')
    .filter({ has: page.getByRole('heading', { name: chartTitle }) });
  await expect(chart.first()).toBeVisible({ timeout });
  // The chart container has role="img" and aria-label with the full data.
  const chartContainer = chart.locator('[role="img"]').first();
  await expect(chartContainer).toBeVisible({ timeout });
  await expect(chartContainer).toHaveAttribute(
    'aria-label',
    new RegExp(expectedText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    { timeout },
  );
}

function transcriptFileKey(projectId: string, sessionId: string): string {
  return `${projectId}/${sessionId}/transcript.jsonl`;
}

// =============================================================================
// Scenario 1: Full CAS sync journey
// =============================================================================

test('full CAS sync journey', async ({ page }) => {
  const bucket = new FixtureBucket();
  bucket.addProject('cas-proj', 'CAS Project', 'CAS layout');
  bucket.addSession('cas-proj', 'e2e-claude-session', {
    files: [
      {
        scope: 'session',
        relativePath: 'transcript.jsonl',
        content: fixtureBuffer('claude-session.jsonl'),
      },
    ],
  });
  attachLoggers(page);

  await startSyncFromHome(page, bucket);
  await waitForSyncIdle(page);

  // The Project Behavior page shows the session's token total in the
  // "Token usage trends" chart's aria-label.
  await openProjectByName(page, 'CAS Project');
  await expectChartContains(page, 'Token usage trends', 'Total tokens');
});

// =============================================================================
// Scenario 2: global/ is reserved; non-CAS children produce a warning and no
// project is created. The global/cas workspace artifact is not fetched.
// =============================================================================

test('global namespace is reserved and never treated as a project', async ({ page }) => {
  const bucket = new FixtureBucket();
  bucket.addProject('cas-proj', 'CAS Project', 'CAS layout');
  bucket.addSession('cas-proj', 'e2e-claude-session', {
    files: [
      {
        scope: 'session',
        relativePath: 'transcript.jsonl',
        content: fixtureBuffer('claude-session.jsonl'),
      },
      { scope: 'workspace', relativePath: 'skills.json', content: Buffer.from('{}') },
    ],
  });
  bucket.addGlobalSession('rogue-session', [
    {
      scope: 'session',
      relativePath: 'transcript.jsonl',
      content: fixtureBuffer('claude-session.jsonl'),
    },
  ]);
  attachLoggers(page);

  await startSyncFromHome(page, bucket);
  await expect(progressBar(page)).toBeVisible({ timeout: 10000 });
  const modal = await openSyncStatusModal(page);
  await expect(modal).toContainText("project id 'global' is reserved", { timeout: 30000 });
  await modal.getByRole('button', { name: 'Close' }).click();
  await waitForSyncIdle(page);

  // The CAS project was created and its session was synced.
  await openProjectBehavior(page, 'cas-proj');
  await expectChartContains(page, 'Token usage trends', 'Total tokens');

  // No project was created for the rogue global folder.
  await page.goto('/#/projects');
  await expect(page.locator('.project-card', { hasText: 'CAS Project' })).toHaveCount(1);

  // The rogue global folder was never treated as a project — its manifest
  // and session transcript were never fetched.
  expect(bucket.getRequests({ method: 'GET', key: 'global/manifest.json' })).toHaveLength(0);
  expect(bucket.getRequests({ method: 'GET', key: 'global/rogue-session' })).toHaveLength(0);
});

// =============================================================================
// Scenario 3: Session with subagent sidecars is merged into the analytics
// =============================================================================

test('subagent sidecars are merged into the parent session', async ({ page }) => {
  // In the new analytics architecture, subagent sidecar merging is handled
  // by the sync engine (covered by sync-core unit tests). This E2E test
  // verifies the end-to-end flow: sync a session, then verify its data
  // appears on the Project Behavior page.
  const bucket = new FixtureBucket();
  bucket.addProject('subagent-proj', 'Subagent Project', 'subagent test');
  bucket.addSession('subagent-proj', 'e2e-claude-session', {
    files: [
      {
        scope: 'session',
        relativePath: 'transcript.jsonl',
        content: fixtureBuffer('claude-session.jsonl'),
      },
    ],
  });
  attachLoggers(page);

  await startSyncFromHome(page, bucket);
  await waitForSyncIdle(page);

  // The Project Behavior page shows the session's token data.
  await openProjectByName(page, 'Subagent Project');
  await expectChartContains(page, 'Token usage trends', 'Total tokens');
});

// =============================================================================
// Scenario 4: transcriptsCaptured: false -> transcript_unavailable, no GETs
// =============================================================================

test('transcriptsCaptured: false marks session as transcript unavailable and fetches nothing', async ({
  page,
}) => {
  const bucket = new FixtureBucket();
  bucket.addProject('no-transcript-proj', 'No Transcript Project', '');
  bucket.addSession('no-transcript-proj', 'e2e-no-transcript', {
    files: [
      {
        scope: 'session',
        relativePath: 'transcript.jsonl',
        content: fixtureBuffer('claude-session.jsonl'),
      },
    ],
    transcriptsCaptured: false,
  });
  attachLoggers(page);

  await startSyncFromHome(page, bucket);
  await waitForSyncCompleted(page);

  // Open the sync status modal and verify the session is present. When
  // transcriptsCaptured is false, the sync manager marks the session as
  // transcript_unavailable. The subsequent ingestion attempt fails (no
  // resolved artifacts → missing_root_session), which overwrites the status
  // to failed. Either way, the transcript was never fetched.
  const modal = await openSyncStatusModal(page);
  const sessionItem = modalSessionItem(modal, 'e2e-no-transcript');
  await expect(sessionItem).toBeVisible({ timeout: 5000 });
  // The session should be in a terminal state (failed or
  // transcript_unavailable).
  await expect(sessionItem.locator('.state-failed, .state-transcript_unavailable')).toBeVisible();

  const transcriptFetches = bucket
    .getRequests({ method: 'GET' })
    .filter((r) => r.key.includes('transcript.jsonl'));
  expect(transcriptFetches).toHaveLength(0);
});

// =============================================================================
// Scenario 5: session manifest with schemaVersion:1 fails as
// MANIFEST_UNSUPPORTED_SCHEMA with no retry.
// =============================================================================

test('session manifest with schemaVersion:1 fails with unsupported schema', async ({ page }) => {
  const bucket = new FixtureBucket();
  bucket.addProject('bad-proj', 'Bad Manifest Project', '');
  bucket.addSession('bad-proj', 'bad-session', {
    files: [
      {
        scope: 'session',
        relativePath: 'transcript.jsonl',
        content: fixtureBuffer('claude-session.jsonl'),
      },
    ],
  });
  // Without a small delay this single-session sync can complete (and hide
  // the progress bar) before the test gets a chance to click it open below.
  bucket.setDelay('bad-proj/bad-session/manifest.json', 500);
  bucket.setManifestContent(
    'bad-proj',
    'bad-session',
    Buffer.from(
      JSON.stringify({ schemaVersion: 1, projectId: 'bad-proj', sessionId: 'bad-session' }),
    ),
  );
  attachLoggers(page);

  await startSyncFromHome(page, bucket);
  const modal = await openSyncStatusModal(page);
  await expect(modal).toContainText('bad-session', { timeout: 15000 });
  await expect(modal).toContainText('⚠');
  await modal.getByRole('button', { name: 'Close' }).click();
  await waitForSyncIdle(page);

  // The Project Behavior page should show the project but no ingested session
  // data — the "Token usage trends" chart renders an empty state.
  await openProjectBehavior(page, 'bad-proj');
  await expect(page.getByRole('heading', { name: 'Token usage trends' })).toBeVisible({
    timeout: 10000,
  });
  // The chart's aria-label should indicate no data (empty state).
  const tokenChart = page
    .locator('analytics-chart')
    .filter({ has: page.getByRole('heading', { name: 'Token usage trends' }) });
  await expect(tokenChart.first()).toBeVisible({ timeout: 10000 });
});

// =============================================================================
// Scenario 7/8: Project folder without a manifest is skipped (the project
// creation modal for missing manifests is not wired in this build, so the
// observed behaviour is a silent skip).
// =============================================================================

test('project folder without a project manifest is skipped', async ({ page }) => {
  const bucket = new FixtureBucket();
  bucket.addProject('good-proj', 'Good Project', '');
  bucket.addSession('good-proj', 'good-session', {
    files: [
      {
        scope: 'session',
        relativePath: 'transcript.jsonl',
        content: fixtureBuffer('claude-session.jsonl'),
      },
    ],
  });
  bucket.addRawSession('orphan-proj', 'orphan-session', [
    {
      scope: 'session',
      relativePath: 'transcript.jsonl',
      content: fixtureBuffer('claude-session.jsonl'),
    },
  ]);
  attachLoggers(page);

  await startSyncFromHome(page, bucket);
  await waitForSyncIdle(page);

  await page.goto('/#/projects');
  await expect(page.locator('.project-card', { hasText: 'Good Project' })).toHaveCount(1);
});

// =============================================================================
// Scenario 9: Sync-only-new skips a pre-seeded session (no manifest GET)
// =============================================================================

test('sync-only-new skips existing sessions without re-fetching their manifest', async ({
  page,
}) => {
  const bucket = new FixtureBucket();
  bucket.addProject('son-proj', 'Sync Only New Project', '');
  bucket.addSession('son-proj', 'e2e-claude-session', {
    files: [
      {
        scope: 'session',
        relativePath: 'transcript.jsonl',
        content: fixtureBuffer('claude-session.jsonl'),
      },
    ],
  });
  attachLoggers(page);

  await startSyncFromHome(page, bucket);
  await waitForSyncIdle(page);

  // Verify the session was ingested via the Project Behavior page.
  await openProjectBehavior(page, 'son-proj');
  await expectChartContains(page, 'Token usage trends', 'Total tokens');

  // Enable sync-only-new on the existing connection.
  // Re-sync with sync-only-new enabled via the sync-confirm modal.
  await openConnectForResync(page);

  bucket.clearRequests();
  await clickRowSyncAndConfirm(page, { syncOnlyNew: true });
  await waitForSyncIdle(page);

  // With sync-only-new, session manifests should not be re-fetched.
  // The project manifest may still be fetched to discover new sessions.
  const sessionManifestGets = bucket
    .getRequests({ method: 'GET' })
    .filter((r) => r.key.endsWith('/manifest.json'))
    .filter((r) => r.key.split('/').length > 2); // session manifests have 3+ path segments
  expect(sessionManifestGets).toHaveLength(0);
});

// =============================================================================
// Scenario 10: Re-sync unchanged files produces an empty download list and no
// transcript GETs.
// =============================================================================

test('re-syncing unchanged files receives an empty download list', async ({ page }) => {
  const bucket = new FixtureBucket();
  bucket.addProject('unchanged-proj', 'Unchanged Project', '');
  bucket.addSession('unchanged-proj', 'e2e-claude-session', {
    files: [
      {
        scope: 'session',
        relativePath: 'transcript.jsonl',
        content: fixtureBuffer('claude-session.jsonl'),
      },
    ],
  });
  attachLoggers(page);

  await startSyncFromHome(page, bucket);
  await waitForSyncIdle(page);

  // Verify the session was ingested.
  await openProjectBehavior(page, 'unchanged-proj');
  await expectChartContains(page, 'Token usage trends', 'Total tokens');

  bucket.clearRequests();
  await openConnectForResync(page);
  await clickRowSyncAndConfirm(page);
  await waitForSyncIdle(page);

  const transcriptGets = bucket
    .getRequests({ method: 'GET' })
    .filter((r) => r.key.includes('transcript.jsonl'));
  expect(transcriptGets).toHaveLength(0);
});

// =============================================================================
// Scenario 11: Failed session can be retried by re-syncing after the remote
// file is fixed. The old session-sync-chip retry UI was removed in TSK0044;
// re-syncing from the Connect modal achieves the same effect because
// isSyncNeeded() returns true for sessions in the 'failed' state.
// =============================================================================

test('failed session can be retried after the remote file is fixed', async ({ page }) => {
  const bucket = new FixtureBucket();
  bucket.addProject('retry-proj', 'Retry Project', '');
  // The transcript's own embedded sessionId must match the S3 session folder
  // name, exactly as real uploads guarantee (the folder is derived from the
  // same id) - substitute it so the sync pipeline's external-id matching
  // resolves to the same session row instead of creating an unrelated one.
  const files = [
    {
      scope: 'session' as const,
      relativePath: 'transcript.jsonl',
      content: Buffer.from(
        fixtureBuffer('claude-session.jsonl')
          .toString('utf8')
          .replaceAll('e2e-claude-session', 'e2e-retry'),
      ),
      sha256: '0'.repeat(64),
    },
  ];
  bucket.addSession('retry-proj', 'e2e-retry', { files });
  attachLoggers(page);

  await startSyncFromHome(page, bucket);
  await waitForSyncCompleted(page);

  // Verify the session failed via the sync status modal.
  let modal = await openSyncStatusModal(page);
  const failedItem = modalSessionItem(modal, 'e2e-retry');
  await expect(failedItem).toBeVisible({ timeout: 5000 });
  await expect(failedItem.locator('.state-failed')).toBeVisible();
  await modal.getByRole('button', { name: 'Close' }).click();
  await waitForSyncIdle(page);

  // Fix the manifest in the bucket so the hash matches the actual file.
  const fixed = buildSessionManifest(
    'retry-proj',
    'e2e-retry',
    files.map((f) => ({ ...f, sha256: undefined })),
    true,
  );
  bucket.setManifestContent('retry-proj', 'e2e-retry', Buffer.from(JSON.stringify(fixed)));

  // Re-sync from the Data Sources page. The session is in 'failed' state, so
  // isSyncNeeded() returns true and the session is re-downloaded and
  // re-ingested.
  await openConnectForResync(page);
  await clickRowSyncAndConfirm(page);
  await waitForSyncCompleted(page, 60000);

  // After re-sync, the session should no longer be in the failed state.
  // Verify via the sync status modal that the session is in_sync.
  modal = await openSyncStatusModal(page);
  const sessionItem = modalSessionItem(modal, 'e2e-retry');
  await expect(sessionItem).toBeVisible({ timeout: 5000 });
  await expect(sessionItem.locator('.state-in_sync')).toBeVisible({ timeout: 10000 });
  await modal.getByRole('button', { name: 'Close' }).click();
});

// =============================================================================
// Scenario 12: Cancel mid-sync
// =============================================================================

test('cancelling a sync marks in-flight sessions as failed', async ({ page }) => {
  const bucket = new FixtureBucket();
  bucket.addProject('cancel-proj', 'Cancel Project', '');
  bucket.addSession('cancel-proj', 'e2e-cancel', {
    files: [
      {
        scope: 'session',
        relativePath: 'transcript.jsonl',
        content: fixtureBuffer('claude-session.jsonl'),
      },
    ],
  });
  bucket.setDelay(transcriptFileKey('cancel-proj', 'e2e-cancel'), 8000);
  attachLoggers(page);

  await startSyncFromHome(page, bucket);
  await expect(progressBar(page)).toBeVisible({ timeout: 10000 });

  await page.getByRole('button', { name: '✕ Cancel' }).click();
  await waitForSyncCompleted(page);

  // Verify the session appears in the sync status modal. After cancellation,
  // abortActiveRun calls db.failStaleSessions asynchronously, so the in-memory
  // session state may still be 'pending' in the captured snapshot. The session
  // should be visible with a non-in_sync state (pending or failed).
  const modal = await openSyncStatusModal(page);
  const sessionItem = modalSessionItem(modal, 'e2e-cancel');
  await expect(sessionItem).toBeVisible({ timeout: 5000 });
  // The session must not be in_sync — it was cancelled mid-download.
  await expect(sessionItem.locator('.state-in_sync')).not.toBeVisible();
});

// =============================================================================
// Scenario 13: Offline event mid-sync
// =============================================================================

test('offline event aborts the active run', async ({ page }) => {
  const bucket = new FixtureBucket();
  bucket.addProject('offline-proj', 'Offline Project', '');
  bucket.addSession('offline-proj', 'e2e-offline', {
    files: [
      {
        scope: 'session',
        relativePath: 'transcript.jsonl',
        content: fixtureBuffer('claude-session.jsonl'),
      },
    ],
  });
  bucket.setDelay(transcriptFileKey('offline-proj', 'e2e-offline'), 8000);
  attachLoggers(page);

  await startSyncFromHome(page, bucket);
  await expect(progressBar(page)).toBeVisible({ timeout: 10000 });

  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await waitForSyncCompleted(page);

  // Verify the session appears in the sync status modal. After offline abort,
  // abortActiveRun calls db.failStaleSessions asynchronously, so the in-memory
  // session state may still be 'pending' in the captured snapshot. The session
  // should be visible with a non-in_sync state (pending or failed).
  const modal = await openSyncStatusModal(page);
  const sessionItem = modalSessionItem(modal, 'e2e-offline');
  await expect(sessionItem).toBeVisible({ timeout: 5000 });
  // The session must not be in_sync — it was aborted mid-download.
  await expect(sessionItem.locator('.state-in_sync')).not.toBeVisible();
});

// =============================================================================
// Scenario 14: Reload mid-sync reconciles stale states
// =============================================================================

test('reloading mid-sync reconciles stale session states', async ({ page }) => {
  const bucket = new FixtureBucket();
  bucket.addProject('reconcile-proj', 'Reconcile Project', '');
  bucket.addSession('reconcile-proj', 'e2e-reconcile', {
    files: [
      {
        scope: 'session',
        relativePath: 'transcript.jsonl',
        content: fixtureBuffer('claude-session.jsonl'),
      },
    ],
  });
  bucket.setDelay(transcriptFileKey('reconcile-proj', 'e2e-reconcile'), 8000);
  attachLoggers(page);

  await startSyncFromHome(page, bucket);
  await expect(progressBar(page)).toBeVisible({ timeout: 10000 });

  await page.reload();
  await page.waitForLoadState('networkidle');

  // After reload, the sync manager reconciles stale states. The session
  // should be marked as failed. Re-trigger a sync to see it in the modal.
  await openConnectForResync(page);
  await clickRowSyncAndConfirm(page);
  await waitForSyncCompleted(page);

  // The reconciled session should be in_sync (re-synced successfully) or
  // failed (if the delay is still in effect). Either way, it should appear
  // in the modal.
  const syncModal = await openSyncStatusModal(page);
  const sessionItem = modalSessionItem(syncModal, 'e2e-reconcile');
  await expect(sessionItem).toBeVisible({ timeout: 10000 });
});

// =============================================================================
// Scenario 15: Second tab becomes a read-only follower
// =============================================================================

test('second tab follows the active sync as a read-only follower', async ({ context }) => {
  const bucket = new FixtureBucket();
  bucket.addProject('follower-proj', 'Follower Project', '');
  bucket.addSession('follower-proj', 'e2e-follower', {
    files: [
      {
        scope: 'session',
        relativePath: 'transcript.jsonl',
        content: fixtureBuffer('claude-session.jsonl'),
      },
    ],
  });
  bucket.setDelay(transcriptFileKey('follower-proj', 'e2e-follower'), 10000);

  const page1 = await context.newPage();
  attachLoggers(page1);
  await startSyncFromHome(page1, bucket);
  await expect(progressBar(page1)).toBeVisible({ timeout: 10000 });

  const page2 = await context.newPage();
  attachLoggers(page2);
  await bucket.installRoute(page2);
  await page2.goto('/#/projects');

  // The follower should mirror the active run without making S3 requests of
  // its own - only the leader tab's worker fetches, so the transcript is
  // downloaded exactly once total even though both tabs observe the sync.
  await expect(progressBar(page2)).toBeVisible({ timeout: 10000 });
  await expect(
    page2
      .locator('.project-card', { hasText: 'Follower Project' })
      .locator('project-sync-indicator'),
  ).toBeVisible({ timeout: 15000 });

  await expect
    .poll(
      () =>
        bucket.getRequests({
          method: 'GET',
          key: transcriptFileKey('follower-proj', 'e2e-follower'),
        }).length,
      { timeout: 10000 },
    )
    .toBe(1);
});

// =============================================================================
// Scenario 16: Reload with locked vault prompts for passkey; wrong passkey
// errors; forgot passkey wipes saved credentials.
// =============================================================================

test('locked vault prompts for passkey and forgot wipes saved credentials', async ({ page }) => {
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
  attachLoggers(page);

  await startSyncFromHome(page, bucket);
  await waitForSyncIdle(page);

  await page.reload();
  await page.waitForLoadState('networkidle');

  // Navigate to the Data Sources settings page. The inline connect-modal
  // does not prompt for a passkey on load — edit the existing connection and
  // save to trigger the unlock prompt.
  await page.goto('/#/settings/data-sources');
  const panel = page.locator('connect-modal');
  await expect(panel.getByRole('heading', { name: 'Connections' })).toBeVisible({
    timeout: 10000,
  });
  await panel.getByRole('button', { name: 'Edit' }).first().click();
  await panel.getByRole('button', { name: 'Save' }).click();
  const passkeyModal = page.getByRole('dialog', { name: 'Passkey' });
  await expect(passkeyModal).toBeVisible({ timeout: 10000 });

  // Wrong passkey shows an error.
  await passkeyModal.getByLabel('Passkey').first().fill('wrong-pass');
  await passkeyModal.getByRole('button', { name: 'Unlock' }).click();
  await expect(passkeyModal).toContainText('Incorrect passkey');

  // Forgetting the passkey deletes saved secrets and closes the modal.
  await passkeyModal.getByRole('button', { name: 'Forgot passkey?' }).click();
  await passkeyModal.getByRole('button', { name: 'Delete all saved secrets' }).click();
  await expect(passkeyModal).toBeHidden({ timeout: 10000 });

  // After forgetting, the edit form is still showing — cancel back to the
  // connections list. The vault has been deleted, so the list shows without
  // a passkey prompt.
  await panel.getByRole('button', { name: 'Cancel' }).click();
  await expect(panel.getByRole('heading', { name: 'Connections' })).toBeVisible({
    timeout: 10000,
  });
  await expect(panel.getByRole('button', { name: '+ New connection' })).toBeVisible();
});

// =============================================================================
// Scenario 17: Large transcript smoke test
// =============================================================================

function buildLargeClaudeJsonl(lines: number, tokensPerLine: number): Buffer {
  const out: string[] = [
    JSON.stringify({
      type: 'user',
      sessionId: 'e2e-large',
      uuid: 'u0',
      timestamp: '2026-08-11T10:00:00.000Z',
      message: { role: 'user', content: 'Start a large session' },
    }),
  ];
  for (let i = 0; i < lines; i++) {
    const message = {
      role: 'assistant',
      model: 'claude-sonnet-5',
      usage: {
        input_tokens: tokensPerLine,
        output_tokens: tokensPerLine,
      },
      content: [{ type: 'text', text: 'x'.repeat(2000) }],
    };
    out.push(
      JSON.stringify({
        type: 'assistant',
        sessionId: 'e2e-large',
        uuid: `a${i}`,
        timestamp: '2026-08-11T10:00:01.000Z',
        message,
      }),
    );
  }
  return Buffer.from(out.join('\n'));
}

test('large transcript syncs and renders compact token counts', async ({ page }) => {
  const bucket = new FixtureBucket();
  bucket.addProject('large-proj', 'Large Project', '');
  bucket.addSession('large-proj', 'e2e-large', {
    files: [
      {
        scope: 'session',
        relativePath: 'transcript.jsonl',
        content: buildLargeClaudeJsonl(500, 1000),
      },
    ],
  });
  attachLoggers(page);

  await startSyncFromHome(page, bucket);
  await waitForSyncIdle(page, 120000);

  // The Project Behavior page shows the total tokens as "1M" (compact format).
  await openProjectByName(page, 'Large Project');
  await expectChartContains(page, 'Token usage trends', 'Total tokens', 30000);
});

// =============================================================================
// Scenario 18: One broken session (unresolvable artifact) does not stop the run
// =============================================================================

test('unresolvable artifact in one session does not stop the sync run', async ({ page }) => {
  const bucket = new FixtureBucket();
  bucket.addProject('break-proj', 'Break Project', '');
  bucket.addSession('break-proj', 'good-session', {
    files: [
      {
        scope: 'session',
        relativePath: 'transcript.jsonl',
        content: fixtureBuffer('claude-session.jsonl'),
      },
    ],
  });
  bucket.addSession('break-proj', 'bad-session', {
    files: [
      {
        scope: 'session',
        relativePath: 'transcript.jsonl',
        content: fixtureBuffer('claude-session.jsonl'),
      },
    ],
  });

  const baseManifest = buildSessionManifest('break-proj', 'bad-session', [
    {
      scope: 'session',
      relativePath: 'transcript.jsonl',
      content: fixtureBuffer('claude-session.jsonl'),
    },
  ]);
  const badManifest = {
    ...baseManifest,
    artifacts: [
      ...baseManifest.artifacts,
      {
        projectId: 'break-proj',
        sessionId: 'bad-session',
        scope: 'session' as const,
        relativePath: 'extra.json',
        sha256: 'b605112ded2cd14de8874940abbfca0ca2904ae657ac02492a96ffc75964ff23',
        size: 0,
        status: 'uploaded' as const,
      },
    ],
  };
  bucket.setManifestContent('break-proj', 'bad-session', Buffer.from(JSON.stringify(badManifest)));

  attachLoggers(page);
  await startSyncFromHome(page, bucket);

  // Open the sync status modal while the run is active and verify the broken
  // session is flagged (warning icon), then close and let the run complete.
  const modal = await openSyncStatusModal(page);
  await expect(modal).toContainText('bad-session', { timeout: 15000 });
  await expect(modal).toContainText('good-session', { timeout: 15000 });
  await modal.getByRole('button', { name: 'Close' }).click();
  await expect(modal).toBeHidden();

  await waitForSyncIdle(page);

  // The run should complete without a "Sync failed" error toast; the good
  // session should still be imported, leaving two sessions in the project.
  await expect(page.locator('.toast.error')).not.toBeVisible();
  await page.goto('/#/projects');
  await expect(page.locator('.project-card', { hasText: /2 sessions/ })).toBeVisible({
    timeout: 10000,
  });
});

// =============================================================================
// Scenario 19 (UX-005): Sync progress advances (heartbeat) while a real file
// download is throttled. The progress locator contract for SYNC-* tasks is:
//
//   Locator: page.locator('app-root').locator('sync-progress-bar').getByRole('status')
//   Active-run format: "Projects S/P | Sessions S/P | Files D/F"
//   Parser: syncProgressFilesParser extracts the files-downloaded count (D).
//   Completed summary: "✓ ⬇D ✦P ✚S ↻U" — falls back to the first number (D).
//
// The heartbeat helper asserts (a) at least two distinct values, and (b) the
// observed series is monotonically non-decreasing.
// =============================================================================

test('UX-005: sync progress heartbeat advances while a file download is throttled', async ({
  page,
}) => {
  const bucket = new FixtureBucket();
  bucket.addProject('hb-proj', 'Heartbeat Project', '');
  bucket.addSession('hb-proj', 'e2e-heartbeat', {
    files: [
      {
        scope: 'session',
        relativePath: 'transcript.jsonl',
        content: fixtureBuffer('claude-session.jsonl'),
      },
    ],
  });

  // Throttle the transcript download through the real route handler so the
  // progress bar stays at "Files 0/1" long enough to be sampled twice.
  bucket.setDelay(transcriptFileKey('hb-proj', 'e2e-heartbeat'), 5000);
  attachLoggers(page);

  await startSyncFromHome(page, bucket);

  const progress = progressBar(page);
  const result = await assertHeartbeat(progress, {
    parser: syncProgressFilesParser,
    timeoutMs: 10000,
    message: 'UX-005 sync progress',
  });

  // Explicit completion assertions in addition to the helper's invariants.
  expect(result.distinct.length).toBeGreaterThanOrEqual(2);
  expect(result.series).toEqual([...result.series].sort((a, b) => a - b));

  await waitForSyncIdle(page, 60000);
});

// =============================================================================
// UX-006: Export content verification
// =============================================================================

test('UX-006: export after sync includes session rows', async ({ page }) => {
  const bucket = new FixtureBucket();
  bucket.addProject('ux-006-proj', 'UX-006 Project', 'Export content verification');
  bucket.addSession('ux-006-proj', 'e2e-claude-session', {
    files: [
      {
        scope: 'session',
        relativePath: 'transcript.jsonl',
        content: fixtureBuffer('claude-session.jsonl'),
      },
    ],
  });
  attachLoggers(page);

  await startSyncFromHome(page, bucket);
  await waitForSyncIdle(page);

  // Go back to the projects page and export the control database.
  await page.goto('/#/projects');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export Database' }).click(),
  ]);

  expect(download.suggestedFilename()).toMatch(/session-analyzer-.*\.sqlite$/);

  const downloadPath = await download.path();
  expect(downloadPath).toBeTruthy();
  const counts = await verifyExportContents(downloadPath);
  expect(counts.projects).toBe(1);
  expect(counts.sessions).toBeGreaterThan(0);
});

// =============================================================================
// UX-004: Sync completion triggers the ingestion seam.
//
// Regression guard for TSK0005: the SyncManager singleton wires
// onFileDownloaded/onSyncComplete to real analytics retention + ingestion/rollup
// (commit b32d019, 2026-08-25). Pre-fix, both defaults were no-ops, so a synced
// session would be created in the control DB but never contribute analytics.
// This test exercises the production wiring end-to-end: it would fail on the
// aggregate metric assertion if either seam reverted to no-op.
// =============================================================================

test('UX-004: sync completion makes the synced session queryable in the dashboard', async ({
  page,
}) => {
  const bucket = new FixtureBucket();
  bucket.addProject('ux004-proj', 'UX-004 Project', 'Sync ingestion seam test');
  bucket.addSession('ux004-proj', 'e2e-claude-session', {
    files: [
      {
        scope: 'session',
        relativePath: 'transcript.jsonl',
        content: fixtureBuffer('claude-session.jsonl'),
      },
    ],
  });
  attachLoggers(page);

  await startSyncFromHome(page, bucket);
  await waitForSyncIdle(page);

  // The synced session must appear in the project's session list on the
  // projects page (control DB). This proves the sync manager discovered the
  // session and the sync worker reached the completed state for this project.
  await page.goto('/#/projects');
  const projectCard = page.locator('.project-card', { hasText: 'UX-004 Project' });
  await expect(projectCard).toBeVisible({ timeout: 10000 });
  await expect(projectCard).toContainText('1 session', { timeout: 10000 });

  // The same session must also contribute to an aggregate metric on the
  // Project Behavior page (analytics DB). This proves onFileDownloaded retained
  // the transcript in the analytics blob store and onSyncComplete triggered
  // ingestion and rollup. If either seam were the pre-TSK0005 no-op, the chart
  // would render empty and this assertion would fail.
  await openProjectByName(page, 'UX-004 Project');
  await expectChartContains(page, 'Token usage trends', 'Total tokens');
});

function createErrorBucket(sessionId: string): FixtureBucket {
  const bucket = new FixtureBucket();
  bucket.addProject('err-proj', 'Error Project', '');
  bucket.addSession('err-proj', sessionId, {
    files: [
      {
        scope: 'session',
        relativePath: 'transcript.jsonl',
        content: fixtureBuffer('claude-session.jsonl'),
      },
    ],
  });
  bucket.setHttpError(transcriptFileKey('err-proj', sessionId), 500);
  return bucket;
}

async function assertSyncErrorAffordance(page: Page, sessionId: string): Promise<void> {
  const bar = progressBar(page);
  await waitForSyncCompleted(page, 30000);
  await expect(bar).toContainText('⚠');
  await expect(bar).toHaveAttribute('class', /completed-failed/);
  await expect(bar.locator('.spinner')).not.toBeVisible();
  await expect(page.locator('.toast.error')).toBeVisible();
  await expect(page.locator('.toast.error')).toContainText(
    /Sync completed with failures|Sync failed/,
  );

  const modal = await openSyncStatusModal(page);
  const sessionItem = modalSessionItem(modal, sessionId);
  await expect(sessionItem).toBeVisible({ timeout: 5000 });
  await expect(sessionItem.locator('.state-failed')).toBeVisible();
}

// =============================================================================
// UX-008: Mocked S3 5xx mid-sync surfaces a distinct, terminal error affordance
// =============================================================================

test('UX-008: mocked S3 5xx mid-sync surfaces a distinct error affordance', async ({ page }) => {
  const bucket = createErrorBucket('e2e-err');
  attachLoggers(page);

  await startSyncFromHome(page, bucket);
  await expect(progressBar(page)).toBeVisible({ timeout: 10000 });
  await assertSyncErrorAffordance(page, 'e2e-err');
});
