import type { Page } from '@playwright/test';

/**
 * Shared "patch `window.Worker`" mechanism for injecting a fake/failing worker
 * before the app boots. Generalizes the pattern duplicated across
 * `ux-002-empty-error.spec.ts` (query rejection) and `ux-009-query-hang.spec.ts`
 * (query hang): both replace the real worker script with an inline one, matched
 * by a substring of the constructed worker's script URL, so the app's error /
 * timeout affordances can be exercised without a real backend failure.
 *
 * Used to satisfy `.agents/rules/sync-progress-observability.md`: worker error
 * propagation must never be silently swallowed between the worker and the UI
 * thread, and this helper is how E2E tests prove a failure actually surfaces.
 */

export interface WorkerFailureOptions {
  /**
   * Substring matched against the constructed worker's resolved script URL
   * (e.g. `'analytics-worker'`, `'db-worker'`, `'session-sync.worker'`).
   * Only the first worker whose URL contains this substring is replaced;
   * every other worker construction is left untouched.
   */
  match: string;
  /**
   * Raw JS source for the replacement worker, run as an ES module `Blob`
   * worker. Must handle whatever handshake messages the app sends (`init`,
   * `getBackend`, `resolveProjectId`, ...) so the app can boot, then force
   * the failure under test for the message type(s) that matter.
   */
  workerScript: string;
}

/**
 * Install a fake worker in place of the real one matched by `options.match`,
 * via `page.addInitScript`. Must be called before `page.goto()` so the patch
 * is in place before the app constructs its workers.
 */
export async function installFailingWorker(
  page: Page,
  options: WorkerFailureOptions,
): Promise<void> {
  await page.addInitScript(
    ({ match, workerScript }: { match: string; workerScript: string }) => {
      const OriginalWorker = window.Worker;

      class PatchedWorker extends OriginalWorker {
        constructor(scriptURL: string | URL, workerOptions?: WorkerOptions) {
          const href =
            typeof scriptURL === 'string'
              ? new URL(scriptURL, window.location.href).href
              : scriptURL.href;

          if (href.includes(match)) {
            const blob = new Blob([workerScript], { type: 'application/javascript' });
            super(URL.createObjectURL(blob), { type: 'module' });
          } else {
            super(scriptURL, workerOptions);
          }
        }
      }

      window.Worker = PatchedWorker as unknown as typeof Worker;
    },
    { match: options.match, workerScript: options.workerScript },
  );
}

/** Common handshake replies so a fake worker's `init`/`getBackend`/`resolveProjectId`
 * messages let the app boot as if a real in-memory backend were present. */
const HANDSHAKE_CASES = `
    case 'init':
    case 'getBackend':
      self.postMessage({
        id,
        ok: true,
        backend: {
          backendName: 'wasm-memory',
          durability: 'ephemeral',
          journalMode: 'delete',
          storage: 'memory',
          fallbackReason: undefined,
        },
        storage: 'memory',
        fallbackReason: undefined,
      });
      break;

    case 'resolveProjectId':
      self.postMessage({ id, ok: true, result: request.projectId });
      break;
`;

/**
 * Build a worker script that answers the boot handshake successfully but
 * rejects every `query` message with `errorMessage`. Covers the common case
 * of a query-time worker failure that must propagate to a chart/panel error
 * affordance (see `assertErrorBoundary` / `assertComponentErrorAffordance`
 * in `chart-content.ts`).
 */
export function buildFailingQueryWorker(errorMessage = 'Simulated worker query failure'): string {
  return `
  self.onmessage = (event) => {
    const request = event.data;
    const id = request.id ?? 0;

    switch (request.type) {
      ${HANDSHAKE_CASES}
      case 'query':
        self.postMessage({ id, ok: false, error: ${JSON.stringify(errorMessage)} });
        break;

      default:
        self.postMessage({ id, ok: true });
    }
  };
  `;
}

/**
 * Build a worker script that answers the boot handshake successfully but
 * never responds to a `query` message matching `view`/`method` (when given),
 * or to any `query` message at all (when omitted). Simulates a stalled
 * worker for bounded-timeout regression tests (e.g. UX-009).
 */
export function buildHangingQueryWorker(target?: { view: string; method: string }): string {
  return `
  self.onmessage = (event) => {
    const request = event.data;
    const id = request.id ?? 0;

    switch (request.type) {
      ${HANDSHAKE_CASES}
      case 'query':
        if (${target ? `request.view === ${JSON.stringify(target.view)} && request.method === ${JSON.stringify(target.method)}` : 'true'}) {
          // Intentionally drop the message: no response is ever posted.
          break;
        }
        self.postMessage({ id, ok: true, result: null });
        break;

      default:
        self.postMessage({ id, ok: true });
    }
  };
  `;
}
