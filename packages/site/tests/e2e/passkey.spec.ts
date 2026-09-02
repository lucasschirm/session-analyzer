import { expect, type Page, test } from '@playwright/test';

const PASSKEY = 'ux016-passkey';
const PASSKEY2 = 'ux016-passkey-replacement';

function attachLoggers(page: Page): void {
  page.on('pageerror', (err) => {
    console.error(`[pageerror] ${err.message}`);
  });
}

async function waitForAppReady(page: Page): Promise<void> {
  await page.goto('/#/settings/data-sources');
  await expect(
    page.locator('connect-modal').getByRole('heading', { name: 'Connections' }),
  ).toBeVisible({
    timeout: 10000,
  });
}

async function fillConnectionForm(
  page: Page,
  options: { name: string; bucket: string; accessKeyId: string; secretKey: string },
): Promise<void> {
  const panel = page.locator('connect-modal');
  await panel.getByLabel('Connection name').fill(options.name);
  await panel.getByLabel('Region').fill('us-east-1');
  await panel.getByLabel('Bucket').fill(options.bucket);
  await panel.getByLabel('Access key ID').fill(options.accessKeyId);
  await panel.getByLabel('Secret access key').fill(options.secretKey);
  await panel.getByLabel('Save to local storage').check();
}

async function createPasskeyInModal(page: Page, passkey: string): Promise<void> {
  const passkeyModal = page.getByRole('dialog', { name: 'Passkey' });
  await expect(passkeyModal).toBeVisible({ timeout: 10000 });
  await expect(passkeyModal).toContainText('Create passkey');

  await passkeyModal.getByLabel('Passkey').first().fill(passkey);
  await passkeyModal.getByLabel('Confirm passkey').fill(passkey);
  await passkeyModal.getByRole('button', { name: 'Create Passkey' }).click();
  await expect(passkeyModal).toBeHidden({ timeout: 10000 });
}

/**
 * Set up a passkey-protected vault by saving an S3 connection with the
 * "Save to local storage" option enabled. This creates both a passkey state
 * row and encrypted S3 credentials in the control database.
 */
async function createPasskeyProtectedVault(page: Page, passkey: string): Promise<void> {
  const panel = page.locator('connect-modal');
  await panel.getByRole('button', { name: '+ New connection' }).click();

  await fillConnectionForm(page, {
    name: 'UX-016 Vault',
    bucket: 'ux016-bucket',
    accessKeyId: 'AKIA',
    secretKey: 'ux016-secret',
  });

  await panel.getByRole('button', { name: 'Save' }).click();
  await createPasskeyInModal(page, passkey);

  // Saving the connection returns to the connection list. The subsequent
  // page reload will clear the in-memory vault key.
  await expect(panel).toContainText('UX-016 Vault');
}

test('UX-016: Passkey "Forgot" deletes vault', async ({ page }) => {
  attachLoggers(page);

  // 1. Establish a passkey-protected vault with saved credentials.
  await waitForAppReady(page);
  await createPasskeyProtectedVault(page, PASSKEY);

  // 2. Reload to clear the in-memory derived key, leaving only the encrypted
  //    vault state in persistent storage.
  await page.reload();
  await page.waitForLoadState('networkidle');
  await waitForAppReady(page);

  // 3. The saved credentials require an unlocked vault. The inline
  //    connect-modal does not prompt for a passkey on load (unlike the old
  //    header "Connect" button). Edit the existing connection and save to
  //    trigger the unlock prompt.
  const panel = page.locator('connect-modal');
  await panel.getByRole('button', { name: 'Edit' }).first().click();
  await panel.getByRole('button', { name: 'Save' }).click();
  const passkeyModal = page.getByRole('dialog', { name: 'Passkey' });
  await expect(passkeyModal).toBeVisible({ timeout: 10000 });
  await expect(passkeyModal).toContainText('Unlock vault');

  // 4. Trigger the "Forgot" flow and confirm deletion.
  await passkeyModal.getByRole('button', { name: 'Forgot passkey?' }).click();
  await expect(passkeyModal).toContainText('Forget passkey?');
  await passkeyModal.getByRole('button', { name: 'Delete all saved secrets' }).click();
  await expect(passkeyModal).toBeHidden({ timeout: 10000 });

  // 5. Verify the vault is actually deleted by exercising the re-registration
  //    flow. If the old passkey state persisted, creating a new passkey would
  //    fail with "A passkey is already configured."; only a genuinely empty
  //    vault lets us create a replacement. After forgetting, the edit form is
  //    still showing — cancel back to the connections list, then create a new
  //    connection.
  await panel.getByRole('button', { name: 'Cancel' }).click();
  await panel.getByRole('button', { name: '+ New connection' }).click();

  await fillConnectionForm(page, {
    name: 'UX-016 After',
    bucket: 'ux016-bucket-after',
    accessKeyId: 'AKIA2',
    secretKey: 'ux016-secret2',
  });

  await panel.getByRole('button', { name: 'Save' }).click();

  // The passkey create (not unlock) modal appears because the vault was
  // deleted, which is the re-registration affordance.
  await createPasskeyInModal(page, PASSKEY2);

  // Connection saved successfully after the new passkey is created. The
  // list view is shown again, confirming the re-registration succeeded.
  await expect(panel).toContainText('UX-016 After');
});
