import { expect, test } from '@playwright/test';

/**
 * UX-014: OPFS-unavailable fallback warning.
 *
 * The sqlite-wasm build recognizes the undocumented `?opfs-disable` URL
 * argument to skip OPFS VFS installation. By appending that argument to every
 * Worker URL before the app loads, the database workers fall back to an
 * in-memory SQLite instance, and the app should surface the "In-Memory"
 * storage indicator instead of the normal "OPFS" persistent-storage badge.
 */

const OPFS_DISABLE_PARAM = 'opfs-disable';

test.describe('OPFS fallback (UX-014)', () => {
  test('warns with an In-Memory storage indicator when OPFS is unavailable', async ({ page }) => {
    await page.addInitScript((param) => {
      const OriginalWorker = window.Worker;

      class PatchedWorker extends OriginalWorker {
        constructor(scriptURL: string | URL, options?: WorkerOptions) {
          const url =
            typeof scriptURL === 'string'
              ? new URL(scriptURL, window.location.href)
              : new URL(scriptURL.toString());

          // Append the sqlite-wasm OPFS disable flag so the worker loads
          // without the OPFS VFS and falls back to an in-memory database.
          url.searchParams.append(param, '');

          super(url, options);
        }
      }

      window.Worker = PatchedWorker as unknown as typeof Worker;
    }, OPFS_DISABLE_PARAM);

    await page.goto('/');

    const badge = page.locator('.storage-badge');
    await expect(badge).toBeVisible({ timeout: 15000 });

    // The fallback indicator must be visible and distinct from the
    // persistent-storage "OPFS" badge shown in the normal code path.
    await expect(badge).toHaveText('In-Memory');
    await expect(badge).not.toHaveText('OPFS');
    await expect(badge).not.toHaveClass(/opfs/);
  });
});
