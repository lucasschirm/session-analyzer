import { expect, test } from '@playwright/test';

/**
 * UX-014: OPFS-unavailable fallback warning.
 *
 * The sqlite-wasm build recognizes the undocumented `?opfs-disable` URL
 * argument to skip OPFS VFS installation. By appending that argument to every
 * Worker URL before the app loads, the database workers fall back to an
 * in-memory SQLite instance, and the Storage settings page should surface the
 * "In-Memory" backend indicator instead of the normal "OPFS" persistent
 * storage backend. (The header storage badge was removed in the navigation
 * redesign — the backend configuration now lives on the Storage settings page
 * at `#/settings/storage`.)
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

    await page.goto('/#/settings/storage');

    // Wait for the Storage settings page to load — the "Control Database"
    // config card renders once the backend info is available.
    await expect(page.getByText('Control Database')).toBeVisible({ timeout: 15000 });

    // The database table's Backend column shows "In-Memory" instead of "OPFS"
    // when OPFS is unavailable. The table is populated after the backend
    // report resolves, so wait for the fallback indicator to appear.
    const dbTable = page.locator('.db-table');
    await expect(dbTable).toContainText('In-Memory', { timeout: 15000 });

    // The persistent-storage "OPFS" backend must not appear in the table when
    // OPFS is unavailable.
    await expect(dbTable).not.toContainText('OPFS');
  });
});
