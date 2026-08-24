import { expect, type Locator, type Page, test } from '@playwright/test';
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
  await page.goto('/');
  await page
    .locator('app-root')
    .getByText(/OPFS|In-Memory/)
    .waitFor({ state: 'visible', timeout: 10000 });
  const button = page.getByRole('button', { name: 'Connect' });
  await expect(button).toBeVisible({ timeout: 10000 });
  await button.click();
  await expect(page.getByRole('dialog', { name: 'Connections' })).toBeVisible({ timeout: 10000 });
}

async function fillConnectionForm(
  page: Page,
  options: { name?: string; syncOnlyNew?: boolean } = {},
): Promise<void> {
  const modal = page.getByRole('dialog', { name: 'Connections' });
  await modal.getByRole('button', { name: 'New connection' }).click();
  await modal.getByLabel('Connection name').fill(options.name ?? 'E2E');
  await modal.getByLabel('Region').fill('us-east-1');
  await modal.getByLabel('Bucket').fill(S3_BUCKET);
  await modal.getByLabel('Endpoint (optional)').fill(S3_ENDPOINT);
  await modal.getByLabel('Access key ID').fill('AKIA');
  await modal.getByLabel('Secret access key').fill('secret');
  await modal.getByLabel('Save to local storage').check();
  if (options.syncOnlyNew) {
    await modal.getByLabel('Sync only new sessions').check();
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

function progressBar(page: Page): Locator {
  return page.locator('app-root').locator('sync-progress-bar').getByRole('status');
}

async function startSyncFromHome(
  page: Page,
  bucket: FixtureBucket,
  options: { syncOnlyNew?: boolean } = {},
): Promise<void> {
  await bucket.installRoute(page);
  await openConnectModal(page);
  await fillConnectionForm(page, options);
  const modal = page.getByRole('dialog', { name: 'Connections' });
  await modal.getByRole('button', { name: 'Sync' }).click();
  await confirmPasskey(page);
  await expect(progressBar(page)).toBeVisible({ timeout: 10000 });
}

async function waitForSyncIdle(page: Page, timeout = 30000): Promise<void> {
  await expect(progressBar(page)).toBeHidden({ timeout });
}

async function openProjectByName(page: Page, name: string): Promise<void> {
  await page.goto('/');
  const card = page.getByRole('button', { name });
  await expect(card.first()).toBeVisible({ timeout: 10000 });
  await card.first().click();
  await expect(page.getByRole('heading', { name })).toBeVisible();
}

async function openSessionByTitle(
  page: Page,
  title: string | RegExp,
  tokenCount?: number | string,
): Promise<void> {
  let row = page.getByRole('button', { name: title });
  if (tokenCount !== undefined) {
    row = row.filter({ hasText: new RegExp(String(tokenCount)) });
  }
  await expect(row.first()).toBeVisible();
  await row.first().click();
  await page.waitForURL(/#\/sessions\/.+/);
  await expect(page.getByRole('heading', { name: title })).toBeVisible({ timeout: 10000 });
}

function sessionChip(page: Page, title: string | RegExp): Locator {
  return page.getByRole('button', { name: title }).locator('session-sync-chip');
}

async function openSyncStatusModal(page: Page): Promise<Locator> {
  await progressBar(page).click();
  const modal = page.getByRole('dialog', { name: 'Sync status' });
  await expect(modal).toBeVisible({ timeout: 5000 });
  return modal;
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

  await openProjectByName(page, 'CAS Project');
  await openSessionByTitle(page, 'e2e-claude-session', 265);

  const metricsGrid = page
    .locator('app-root')
    .locator('metrics-card')
    .filter({ hasText: 'Total Tokens' });
  await expect(metricsGrid).toContainText('265', { timeout: 15000 });
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
  await waitForSyncIdle(page);

  await openProjectByName(page, 'CAS Project');
  await expect(page.getByRole('button', { name: 'e2e-claude-session' }).first()).toBeVisible();
  await expect(sessionChip(page, 'e2e-claude-session').first()).toContainText('in sync');

  // No project was created for the rogue global folder.
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'CAS Project' })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'CAS Project' }).first()).toBeVisible();

  // The reserved CAS prefix and rogue global session were listed, but never
  // fetched as manifests or content.
  expect(bucket.getRequests({ method: 'GET', key: 'global/manifest.json' })).toHaveLength(0);
  const globalCasFetches = bucket
    .getRequests({ method: 'GET' })
    .filter((r) => r.key.startsWith('global/cas/'));
  expect(globalCasFetches).toHaveLength(0);
});

// =============================================================================
// Scenario 3: Session with subagent sidecars is merged into the dashboard
// =============================================================================

test('subagent sidecars are merged into the parent session', async ({ page }) => {
  const bucket = new FixtureBucket();
  bucket.addProject('subagent-proj', 'Subagent Project', 'subagent test');
  bucket.addSession('subagent-proj', 'e2e-sub-session', {
    files: [
      {
        scope: 'session',
        relativePath: 'transcript.jsonl',
        content: fixtureBuffer('claude-session.jsonl'),
      },
      {
        scope: 'session',
        relativePath: 'subagents/agent-1.jsonl',
        content: fixtureBuffer('agent-e2esub1.jsonl'),
      },
      {
        scope: 'session',
        relativePath: 'subagents/agent-1.meta.json',
        content: fixtureBuffer('agent-e2esub1.meta.json'),
      },
    ],
  });
  attachLoggers(page);

  await startSyncFromHome(page, bucket);
  await waitForSyncIdle(page);

  await openProjectByName(page, 'Subagent Project');
  await openSessionByTitle(page, 'e2e-sub-session', 295);

  // The subagent's token total (20 input + 10 output) is folded in.
  const metricsGrid = page
    .locator('app-root')
    .locator('metrics-card')
    .filter({ hasText: 'Total Tokens' });
  await expect(metricsGrid).toContainText('295', { timeout: 15000 });

  // The subagent panel shows the agent from the meta sidecar.
  const dashboard = page.locator('app-root').locator('session-dashboard');
  await expect(dashboard.getByRole('heading', { name: 'Subagents' }).first()).toBeVisible();
  await expect(dashboard.getByText('Handle the subtask')).toBeVisible();
  await expect(dashboard.getByText('30')).toBeVisible();
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
  await waitForSyncIdle(page);

  await openProjectByName(page, 'No Transcript Project');
  const chip = sessionChip(page, 'e2e-no-transcript').first();
  await expect(chip).toContainText('no transcript');
  await expect(chip.locator('.chip')).toHaveAttribute('title', /No uploaded transcript/);

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
  await waitForSyncIdle(page);

  await openProjectByName(page, 'Bad Manifest Project');
  await expect(page.getByText('No sessions found')).toBeVisible();
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

  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Good Project' })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Good Project' }).first()).toBeVisible();
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

  await openProjectByName(page, 'Sync Only New Project');
  await expect(sessionChip(page, 'e2e-claude-session').first()).toContainText('in sync');

  // Enable sync-only-new on the existing connection.
  await page
    .locator('app-root')
    .getByText(/OPFS|In-Memory/)
    .waitFor({ state: 'visible', timeout: 10000 });
  await page.getByRole('button', { name: 'Connect' }).click();
  await confirmPasskey(page);
  const modal = page.getByRole('dialog', { name: 'Connections' });
  await expect(modal).toBeVisible({ timeout: 10000 });
  await modal.getByRole('button', { name: 'Edit' }).click();
  await modal.getByLabel('Sync only new sessions').check();
  await modal.getByRole('button', { name: 'Save' }).click();

  bucket.clearRequests();
  await modal.getByRole('button', { name: 'Sync' }).click();
  await waitForSyncIdle(page);

  const manifestGets = bucket
    .getRequests({ method: 'GET' })
    .filter((r) => r.key.endsWith('/manifest.json'));
  expect(manifestGets).toHaveLength(0);
  await expect(sessionChip(page, 'e2e-claude-session').first()).toContainText('in sync');
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

  await openProjectByName(page, 'Unchanged Project');
  await expect(sessionChip(page, 'e2e-claude-session').first()).toContainText('in sync');

  bucket.clearRequests();
  await page
    .locator('app-root')
    .getByText(/OPFS|In-Memory/)
    .waitFor({ state: 'visible', timeout: 10000 });
  await page.getByRole('button', { name: 'Connect' }).click();
  await confirmPasskey(page);
  const modal = page.getByRole('dialog', { name: 'Connections' });
  await expect(modal).toBeVisible({ timeout: 10000 });
  await modal.getByRole('button', { name: 'Sync' }).click();
  await waitForSyncIdle(page);

  const transcriptGets = bucket
    .getRequests({ method: 'GET' })
    .filter((r) => r.key.includes('transcript.jsonl'));
  expect(transcriptGets).toHaveLength(0);
  await expect(sessionChip(page, 'e2e-claude-session').first()).toContainText('in sync');
});

// =============================================================================
// Scenario 11: Failed session shows an error icon, details modal, and can be
// retried once the remote file is fixed.
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
  await waitForSyncIdle(page);

  await openProjectByName(page, 'Retry Project');
  const chip = sessionChip(page, 'e2e-retry').last();
  await expect(chip).toContainText('failed');
  await chip.locator('.chip').click();

  const errorModal = page.getByRole('dialog', { name: 'Sync error' });
  await expect(errorModal).toBeVisible();
  await expect(errorModal).toContainText('HASH_MISMATCH');
  await expect(errorModal.getByRole('button', { name: 'Retry sync' })).toBeVisible();

  // Fix the manifest in the bucket so the hash matches the actual file.
  const fixed = buildSessionManifest(
    'retry-proj',
    'e2e-retry',
    files.map((f) => ({ ...f, sha256: undefined })),
    true,
  );
  bucket.setManifestContent('retry-proj', 'e2e-retry', Buffer.from(JSON.stringify(fixed)));

  await errorModal.getByRole('button', { name: 'Retry sync' }).click();
  await confirmPasskey(page);
  await waitForSyncIdle(page);

  await expect(sessionChip(page, 'e2e-retry').first()).toContainText('in sync', { timeout: 30000 });
  await openSessionByTitle(page, 'e2e-retry', 265);
  await expect(
    page.locator('app-root').locator('metrics-card').filter({ hasText: 'Total Tokens' }),
  ).toContainText('265', { timeout: 15000 });
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

  await page.getByRole('button', { name: 'Cancel' }).first().click();
  await waitForSyncIdle(page);

  await openProjectByName(page, 'Cancel Project');
  const chip = sessionChip(page, 'e2e-cancel').last();
  await expect(chip).toContainText('failed');
  await expect(chip.locator('.chip')).toHaveAttribute('title', /Sync cancelled by user/);
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
  await waitForSyncIdle(page);

  await openProjectByName(page, 'Offline Project');
  const chip = sessionChip(page, 'e2e-offline').last();
  await expect(chip).toContainText('failed');
  await expect(chip.locator('.chip')).toHaveAttribute('title', /NETWORK_OFFLINE/);
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

  await openProjectByName(page, 'Reconcile Project');
  const chip = sessionChip(page, 'e2e-reconcile').last();
  await expect(chip).toContainText('failed');
  await expect(chip.locator('.chip')).toHaveAttribute('title', /Sync interrupted \(page closed\)/);
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
  await page2.goto('/');

  // The follower should mirror the active run without making S3 requests of
  // its own - only the leader tab's worker fetches, so the transcript is
  // downloaded exactly once total even though both tabs observe the sync.
  await expect(progressBar(page2)).toBeVisible({ timeout: 10000 });
  await expect(
    page2.getByRole('button', { name: 'Follower Project' }).locator('project-sync-indicator'),
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
  await page
    .locator('app-root')
    .getByText(/OPFS|In-Memory/)
    .waitFor({ state: 'visible', timeout: 10000 });

  await page.getByRole('button', { name: 'Connect' }).click();
  const passkeyModal = page.getByRole('dialog', { name: 'Passkey' });
  await expect(passkeyModal).toBeVisible();

  // Wrong passkey shows an error.
  await passkeyModal.getByLabel('Passkey').first().fill('wrong-pass');
  await passkeyModal.getByRole('button', { name: 'Unlock' }).click();
  await expect(passkeyModal).toContainText('Incorrect passkey');

  // Forgetting the passkey deletes saved secrets and closes the modal.
  await passkeyModal.getByRole('button', { name: 'Forgot passkey?' }).click();
  await passkeyModal.getByRole('button', { name: 'Delete all saved secrets' }).click();
  await expect(passkeyModal).toBeHidden({ timeout: 10000 });

  // Connect now opens the connection form, not the passkey modal, because the
  // vault has been deleted.
  await page.getByRole('button', { name: 'Connect' }).click();
  const connectModal = page.getByRole('dialog', { name: 'Connections' });
  await expect(connectModal).toBeVisible({ timeout: 10000 });
  await expect(connectModal.getByRole('button', { name: 'New connection' })).toBeVisible();
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

  await openProjectByName(page, 'Large Project');
  await openSessionByTitle(page, 'e2e-large', '1M');

  const metricsGrid = page
    .locator('app-root')
    .locator('metrics-card')
    .filter({ hasText: 'Total Tokens' });
  // 500 assistant turns * 2000 tokens = 1,000,000, rendered as "1M".
  await expect(metricsGrid).toContainText('1M', { timeout: 30000 });
});
