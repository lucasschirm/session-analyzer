import { expect, type Locator, type Page, test } from '@playwright/test';
import { verifyExportContents } from './helpers/export-verify.js';

/**
 * UX-025: Storage settings page — per-row Optimize button, the
 * optimize/download overlay state machine (running -> stalled -> success |
 * error), and the Size column's loading/ok/error distinction.
 *
 * Per `.agents/rules/sync-progress-observability.md`, `VACUUM`/`VACUUM INTO`
 * have no page-by-page progress callback, so — unlike UX-005's
 * `assertHeartbeat` — there is no advancing signal to poll here. Coverage is
 * built entirely from terminal-state and phase-transition assertions:
 * terminal success (a real download fires; the Size column refreshes after a
 * successful Optimize), terminal failure (a distinguishable, dismissable
 * error banner, never a silent empty/loading look), the Size column's
 * error-vs-loading-vs-ok distinction, and the ~30s stall-safety-net
 * transition (via Playwright's `page.clock`, not real time).
 *
 * The Control DB row uses the real, unfaked `db-worker` (matches the
 * `app.spec.ts` / `opfs-fallback.spec.ts` convention of asserting real OPFS
 * behavior directly). The Analytics DB row is driven through a fake
 * `analytics-worker` (same technique as `ux-002-empty-error.spec.ts` and
 * `ux-009-query-hang.spec.ts`) so failure and multi-call-sequence scenarios
 * are deterministic instead of racing a real SQLite VACUUM.
 */

interface FakeAnalyticsWorkerConfig {
  /** Successive `getAnalyticsDatabaseSize` results; the last value repeats. */
  sizes: number[];
  sizeShouldFail?: boolean;
  /** Delay before replying to a size query, to make the loading phase observable. */
  sizeDelayMs?: number;
  vacuumShouldFail?: boolean;
  exportShouldFail?: boolean;
  /** Never reply to the export request, simulating a genuine hang. */
  exportShouldHang?: boolean;
}

function fakeAnalyticsWorkerSource(config: FakeAnalyticsWorkerConfig): string {
  return `
    const config = ${JSON.stringify(config)};
    let sizeCallCount = 0;

    function replyOk(id, extra) {
      self.postMessage(Object.assign({ id, ok: true }, extra));
    }
    function replyErr(id, error) {
      self.postMessage({ id, ok: false, error });
    }
    function backendPayload() {
      return {
        backendName: 'wasm-memory',
        durability: 'ephemeral',
        journalMode: 'delete',
        storage: 'memory',
      };
    }

    self.onmessage = (event) => {
      const request = event.data;
      const id = request.id ?? 0;

      switch (request.type) {
        case 'init':
        case 'getBackend':
          replyOk(id, { backend: backendPayload(), storage: 'memory' });
          break;

        case 'getAnalyticsDatabaseSize': {
          const idx = Math.min(sizeCallCount, config.sizes.length - 1);
          sizeCallCount += 1;
          const value = config.sizes[idx];
          const send = () => {
            if (config.sizeShouldFail) {
              replyErr(id, 'Simulated PRAGMA size query failure');
            } else {
              replyOk(id, { result: value });
            }
          };
          if (config.sizeDelayMs) {
            setTimeout(send, config.sizeDelayMs);
          } else {
            send();
          }
          break;
        }

        case 'vacuumAnalyticsDatabase':
          if (config.vacuumShouldFail) {
            replyErr(id, 'Simulated VACUUM failure');
          } else {
            replyOk(id, {});
          }
          break;

        case 'exportAnalyticsDatabaseOptimized':
          if (config.exportShouldHang) {
            // Intentionally never reply — the client-side stall timer is the
            // only observable signal for a genuine hang.
            break;
          }
          if (config.exportShouldFail) {
            replyErr(id, 'Simulated VACUUM INTO export failure');
          } else {
            replyOk(id, { bytes: new Uint8Array(8) });
          }
          break;

        default:
          replyOk(id, {});
      }
    };
  `;
}

/**
 * Replaces the analytics worker with the fake worker above while leaving the
 * control-db and sync workers untouched (same technique as
 * `ux-002-empty-error.spec.ts`).
 */
async function installFakeAnalyticsWorker(
  page: Page,
  config: FakeAnalyticsWorkerConfig,
): Promise<void> {
  await page.addInitScript((workerScript: string) => {
    const OriginalWorker = window.Worker;

    class PatchedWorker extends OriginalWorker {
      constructor(scriptURL: string | URL, options?: WorkerOptions) {
        const href =
          typeof scriptURL === 'string'
            ? new URL(scriptURL, window.location.href).href
            : scriptURL.href;

        if (href.includes('analytics-worker')) {
          const blob = new Blob([workerScript], { type: 'application/javascript' });
          super(URL.createObjectURL(blob), { type: 'module' });
        } else {
          super(scriptURL, options);
        }
      }
    }

    window.Worker = PatchedWorker as unknown as typeof Worker;
  }, fakeAnalyticsWorkerSource(config));
}

async function waitForStoragePageReady(page: Page): Promise<void> {
  await page.goto('/#/settings/storage');
  await expect(page.getByText('Control Database')).toBeVisible({ timeout: 15000 });
}

function dbRow(page: Page, name: 'Control DB' | 'Analytics DB'): Locator {
  return page.locator('.db-table tbody tr', { hasText: name });
}

function actionButton(row: Locator, label: 'Download' | 'Optimize'): Locator {
  return row.getByRole('button', { name: label });
}

test.describe('UX-025: Storage page Optimize / Download / Size column', () => {
  test('terminal success: Download triggers a real, valid SQLite export', async ({ page }) => {
    await waitForStoragePageReady(page);

    const controlRow = dbRow(page, 'Control DB');
    await expect(controlRow).not.toContainText('Calculating…', { timeout: 15000 });
    await expect(controlRow.locator('.size-error')).toHaveCount(0);

    await actionButton(controlRow, 'Download').click();

    // The overlay engages synchronously on click, before the export settles.
    await expect(page.locator('.storage-overlay')).toBeVisible({ timeout: 2000 });

    const download = await page.waitForEvent('download', { timeout: 15000 });
    expect(download.suggestedFilename()).toMatch(/session-analyzer-.*\.sqlite$/);

    const downloadPath = await download.path();
    expect(downloadPath).toBeTruthy();
    const counts = await verifyExportContents(downloadPath as string);
    // A fresh app has no projects/sessions yet; the point of this assertion
    // is that the bytes are a genuine, queryable SQLite file (matches
    // UX-006's `verifyExportContents` pattern), not merely that a download
    // fired.
    expect(counts.projects).toBe(0);

    await expect(page.locator('.storage-overlay')).toBeHidden({ timeout: 3000 });

    // NOTE: unlike Optimize, a successful Download does not re-query the
    // Size column. `runOverlay()` in storage-page.ts only calls
    // `loadSize(dbId)` when `mode === 'optimize'` — a `VACUUM INTO` export
    // reads the database without changing its page count, so there is
    // nothing for a post-download size refresh to observe. The Size-refresh
    // assertion below covers the Optimize flow, which is where the
    // implementation actually performs it.
  });

  test('terminal success: Optimize refreshes the Size column after VACUUM', async ({ page }) => {
    await installFakeAnalyticsWorker(page, { sizes: [2048, 4096] });
    await waitForStoragePageReady(page);

    const analyticsRow = dbRow(page, 'Analytics DB');
    await expect(analyticsRow).toContainText('2.0 KB', { timeout: 15000 });

    await actionButton(analyticsRow, 'Optimize').click();

    const overlay = page.locator('.storage-overlay');
    await expect(overlay).toContainText('Optimizing Analytics DB', { timeout: 2000 });
    await expect(overlay).toContainText('Optimization complete.', { timeout: 5000 });
    await expect(overlay).toBeHidden({ timeout: 3000 });

    // The fake worker returns a different byte count on the second
    // `getAnalyticsDatabaseSize` call, so the displayed value changing from
    // the initial load proves a genuine re-query, not a stale cached render.
    await expect(analyticsRow).toContainText('4.0 KB', { timeout: 5000 });
  });

  test('terminal failure: a failed Download surfaces a dismissable error, distinct from a Size failure', async ({
    page,
  }) => {
    await installFakeAnalyticsWorker(page, { sizes: [2048], exportShouldFail: true });
    await waitForStoragePageReady(page);

    const analyticsRow = dbRow(page, 'Analytics DB');
    await expect(analyticsRow).toContainText('2.0 KB', { timeout: 15000 });

    await actionButton(analyticsRow, 'Download').click();

    // Not a silent empty/loading look: a distinct, dismissable banner names
    // the failure (per no-silent-empty-states.md).
    const overlay = page.locator('.storage-overlay');
    await expect(overlay).toContainText('Failed: Simulated VACUUM INTO export failure', {
      timeout: 10000,
    });
    const dismissButton = overlay.getByRole('button', { name: 'Dismiss' });
    await expect(dismissButton).toBeVisible();

    // The export rejected before `triggerDownload()` ran, so no browser
    // download ever fires.
    const download = await page.waitForEvent('download', { timeout: 1500 }).catch(() => null);
    expect(download).toBeNull();

    // A Download failure is scoped to the overlay: it does not flip the Size
    // column into its own error state (only an Optimize failure re-queries
    // size), so the two failure surfaces stay distinguishable from each
    // other rather than collapsing into one generic "broken" look.
    await expect(analyticsRow).toContainText('2.0 KB');
    await expect(analyticsRow.locator('.size-error')).toHaveCount(0);

    await dismissButton.click();
    await expect(overlay).toBeHidden();
  });

  test('Size column: loading, ok, and error are structurally distinct states', async ({ page }) => {
    await installFakeAnalyticsWorker(page, {
      sizes: [4096],
      sizeShouldFail: true,
      sizeDelayMs: 600,
    });
    await waitForStoragePageReady(page);

    const controlRow = dbRow(page, 'Control DB');
    const analyticsRow = dbRow(page, 'Analytics DB');

    // Control DB uses the real, unfaked db-worker: a genuine 'ok' state —
    // a formatted byte value, no error styling.
    await expect(controlRow).not.toContainText('Calculating…', { timeout: 15000 });
    await expect(controlRow.locator('.size-error')).toHaveCount(0);

    // Analytics DB: the fake worker's delayed response gives a real window
    // to observe the transient 'loading' state before it resolves.
    await expect(analyticsRow).toContainText('Calculating…', { timeout: 2000 });
    await expect(analyticsRow.locator('.size-error')).toHaveCount(0);

    // Once the delayed failure lands, the row moves to a structurally
    // distinct 'error' state — the dedicated `.size-error` class — never the
    // same "—"/"Calculating…" rendering a legitimate loading/empty size
    // would use (missing-is-never-zero.md, no-silent-empty-states.md).
    const sizeError = analyticsRow.locator('.size-error');
    await expect(sizeError).toBeVisible({ timeout: 5000 });
    await expect(sizeError).toHaveText('Error');
    await expect(analyticsRow).not.toContainText('Calculating…');
  });

  test('stall safety net: the overlay reports "taking longer than expected" after ~30s', async ({
    page,
  }) => {
    await installFakeAnalyticsWorker(page, { sizes: [2048], exportShouldHang: true });
    await waitForStoragePageReady(page);

    const analyticsRow = dbRow(page, 'Analytics DB');
    await expect(analyticsRow).toContainText('2.0 KB', { timeout: 15000 });

    // Install the fake clock only after boot: sync-manager's real
    // leader-election/heartbeat timers were already scheduled against the
    // real clock during page load and keep ticking untouched on the native
    // engine. Only *new* timers registered from this point on — i.e. the
    // overlay's own OVERLAY_STALL_MS timer, armed inside the click handler
    // below — are driven by the fake clock, so a 30s stall can be jumped
    // instantly instead of waiting on the wall clock, with no test-only
    // seam added to the component. The equivalent transition is also
    // covered at the unit level in storage-page.test.ts ("flips to a
    // 'taking longer than expected' state after the stall timeout while
    // still running"), using vitest's fake timers; this test proves the
    // same transition renders correctly through the real Lit component tree.
    await page.clock.install();

    await actionButton(analyticsRow, 'Download').click();

    const overlay = page.locator('.storage-overlay');
    await expect(overlay).toContainText('Preparing Analytics DB download', { timeout: 2000 });
    await expect(overlay).not.toContainText('taking longer than expected');

    await page.clock.fastForward(30_000); // OVERLAY_STALL_MS in storage-page.ts

    await expect(overlay).toContainText('taking longer than expected', { timeout: 2000 });
    // The export never resolves in this scenario, so the overlay stays open
    // in the stalled phase instead of silently completing or erroring.
    await expect(overlay).toBeVisible();
  });
});
