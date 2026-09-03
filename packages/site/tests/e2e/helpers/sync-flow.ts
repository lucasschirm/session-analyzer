import { expect, type Locator, type Page } from '@playwright/test';
import { S3_BUCKET, S3_ENDPOINT } from '../sync-fixtures.js';

export const PASSKEY = 'e2e-passkey';

export function attachLoggers(page: Page): void {
  page.on('pageerror', (err) => {
    console.error(`[pageerror] ${err.message}`);
  });
}

export async function openConnectModal(page: Page): Promise<void> {
  await page.goto('/#/settings/data-sources');
  await expect(
    page.locator('connect-modal').getByRole('heading', { name: 'Connections' }),
  ).toBeVisible({
    timeout: 10000,
  });
}

export async function fillConnectionForm(
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

export async function confirmPasskey(page: Page, passkey = PASSKEY): Promise<void> {
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

export function progressBar(page: Page): Locator {
  return page.locator('app-root').locator('sync-progress-bar').getByRole('status');
}

export async function startSyncFromHome(
  page: Page,
  bucket: { installRoute(page: Page): Promise<void> },
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

export async function waitForSyncCompleted(page: Page, timeout = 30000): Promise<void> {
  await expect(progressBar(page)).toBeVisible({ timeout });
  // The completed bar shows ✓ (done), ⊘ (cancelled), or ⚠ (failed).
  await expect(progressBar(page)).toContainText(/[✓⊘⚠]/, { timeout });
}

export async function waitForSyncIdle(page: Page, timeout = 30000): Promise<void> {
  await expect(progressBar(page)).toBeHidden({ timeout });
}

export function transcriptFileKey(projectId: string, sessionId: string): string {
  return `${projectId}/${sessionId}/transcript.jsonl`;
}
