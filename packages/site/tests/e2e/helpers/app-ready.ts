import { expect, type Page } from '@playwright/test';

/**
 * Wait for the application shell to finish initializing and for the loading
 * overlay to disappear.
 */
export async function waitForAppReady(page: Page): Promise<void> {
  await expect(page.locator('header')).toBeVisible();
  await expect(page.locator('.app-loading')).toBeHidden();
}
