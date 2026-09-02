import { expect, type Locator, type Page, test } from '@playwright/test';
import { FixtureBucket, fixtureBuffer, S3_BUCKET, S3_ENDPOINT } from '../sync-fixtures.js';
import { assertHeartbeat, syncProgressFilesParser } from './heartbeat.js';

const PASSKEY = 'e2e-passkey';

function progressBar(page: Page): Locator {
  return page.locator('app-root').locator('sync-progress-bar').getByRole('status');
}

async function openConnectModal(page: Page): Promise<void> {
  await page.goto('/#/settings/data-sources');
  await expect(
    page.locator('connect-modal').getByRole('heading', { name: 'Connections' }),
  ).toBeVisible({
    timeout: 10000,
  });
}

async function fillConnectionForm(page: Page): Promise<void> {
  const panel = page.locator('connect-modal');
  await panel.getByRole('button', { name: '+ New connection' }).click();
  await panel.getByLabel('Connection name').fill('E2E');
  await panel.getByLabel('Region').fill('us-east-1');
  await panel.getByLabel('Bucket').fill(S3_BUCKET);
  await panel.getByLabel('Endpoint (optional)').fill(S3_ENDPOINT);
  await panel.getByLabel('Access key ID').fill('AKIA');
  await panel.getByLabel('Secret access key').fill('secret');
  await panel.getByLabel('Save to local storage').check();
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

async function startSyncFromHome(page: Page, bucket: FixtureBucket): Promise<void> {
  await bucket.installRoute(page);
  await openConnectModal(page);
  await fillConnectionForm(page);
  const panel = page.locator('connect-modal');
  await panel.getByRole('button', { name: 'Sync' }).click();
  await confirmPasskey(page);
  await expect(progressBar(page)).toBeVisible({ timeout: 10000 });
}

async function waitForSyncIdle(page: Page, timeout = 30000): Promise<void> {
  await expect(progressBar(page)).toBeHidden({ timeout });
}

test('heartbeat advances while a sync file GET is throttled', async ({ page }) => {
  const bucket = new FixtureBucket();
  bucket.addProject('heartbeat-proj', 'Heartbeat Project', '');
  bucket.addSession('heartbeat-proj', 'heartbeat-session', {
    files: [
      {
        scope: 'session',
        relativePath: 'transcript.jsonl',
        content: fixtureBuffer('claude-session.jsonl'),
      },
    ],
  });
  bucket.setDelay('heartbeat-proj/heartbeat-session/transcript.jsonl', 1500);

  await startSyncFromHome(page, bucket);
  const result = await assertHeartbeat(progressBar(page), {
    timeoutMs: 6000,
    parser: syncProgressFilesParser,
    message: 'Sync file-download progress',
  });

  expect(result.distinct.length).toBeGreaterThanOrEqual(2);
  expect(result.series[result.series.length - 1]).toBeGreaterThanOrEqual(result.series[0]);

  await waitForSyncIdle(page);
});

test('heartbeat detects a stalled sync progress', async ({ page }) => {
  const bucket = new FixtureBucket();
  bucket.addProject('stall-proj', 'Stall Project', '');
  bucket.addSession('stall-proj', 'stall-session', {
    files: [
      {
        scope: 'session',
        relativePath: 'transcript.jsonl',
        content: fixtureBuffer('claude-session.jsonl'),
      },
    ],
  });
  bucket.setDelay('stall-proj/stall-session/transcript.jsonl', 120000);

  await startSyncFromHome(page, bucket);
  const promise = assertHeartbeat(progressBar(page), {
    timeoutMs: 1500,
    parser: syncProgressFilesParser,
    message: 'Stalled sync progress',
  });
  await expect(promise).rejects.toThrow(/stalled/);

  const cancelButton = page.locator('sync-progress-bar').getByRole('button', { name: /Cancel/ });
  if (await cancelButton.isVisible().catch(() => false)) {
    await cancelButton.click();
  }
  await waitForSyncIdle(page);
});

test('heartbeat rejects non-monotonic progress', async ({ page }) => {
  await page.setContent(`
    <div id="progress" role="status">Files 0/2</div>
    <script>
      const el = document.getElementById('progress');
      const texts = ['Files 0/2', 'Files 1/2', 'Files 0/2', 'Files 2/2'];
      let i = 0;
      function next() {
        i++;
        if (i < texts.length) {
          el.textContent = texts[i];
          setTimeout(next, 300);
        }
      }
      setTimeout(next, 300);
    </script>
  `);

  const promise = assertHeartbeat(page.locator('#progress'), {
    timeoutMs: 1500,
    intervalMs: 100,
    parser: syncProgressFilesParser,
    message: 'Non-monotonic progress',
  });
  await expect(promise).rejects.toThrow(/monotonic/);
});
