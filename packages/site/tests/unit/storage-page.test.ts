import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../../src/pages/settings/storage-page';
import type { StoragePage } from '../../src/pages/settings/storage-page';

const mockDbClient = vi.hoisted(() => ({
  ensureReady: vi.fn(),
  getControlDatabaseSize: vi.fn(),
  exportControlDatabaseOptimized: vi.fn(),
  vacuum: vi.fn(),
  reset: vi.fn(),
}));

vi.mock('../../src/db/db-client', () => ({ dbClient: mockDbClient }));

const mockAnalyticsClient = vi.hoisted(() => ({
  ensureReady: vi.fn(),
  getBackend: vi.fn(),
  getAnalyticsDatabaseSize: vi.fn(),
  exportAnalyticsDatabaseOptimized: vi.fn(),
  vacuum: vi.fn(),
  close: vi.fn(),
  reset: vi.fn(),
}));

vi.mock('../../src/db/analytics-client', () => ({
  analyticsClient: mockAnalyticsClient,
}));

beforeEach(() => {
  vi.clearAllMocks();
  mockDbClient.ensureReady.mockResolvedValue('opfs');
  mockDbClient.getControlDatabaseSize.mockResolvedValue(1024);
  mockDbClient.exportControlDatabaseOptimized.mockResolvedValue(new Uint8Array(1024));
  mockDbClient.vacuum.mockResolvedValue(undefined);
  mockAnalyticsClient.ensureReady.mockResolvedValue(undefined);
  mockAnalyticsClient.getBackend.mockResolvedValue({
    backendName: 'wasm-opfs',
    durability: 'persistent',
    journalMode: 'wal',
    storage: 'opfs',
  });
  mockAnalyticsClient.getAnalyticsDatabaseSize.mockResolvedValue(2048);
  mockAnalyticsClient.exportAnalyticsDatabaseOptimized.mockResolvedValue(new Uint8Array(2048));
  mockAnalyticsClient.vacuum.mockResolvedValue(undefined);
  mockAnalyticsClient.close.mockResolvedValue(undefined);
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.useRealTimers();
});

async function mount(): Promise<StoragePage> {
  const el = document.createElement('storage-page') as StoragePage;
  document.body.appendChild(el);
  await el.updateComplete;
  await new Promise((r) => setTimeout(r, 10));
  await el.updateComplete;
  return el;
}

function dbRow(root: ShadowRoot, name: string): HTMLTableRowElement {
  const rows = Array.from(root.querySelectorAll('.db-table tbody tr'));
  const row = rows.find((r) => r.textContent?.includes(name));
  expect(row).toBeDefined();
  return row as HTMLTableRowElement;
}

describe('storage-page', () => {
  it('renders a heading and description', async () => {
    const el = await mount();
    const root = el.shadowRoot as ShadowRoot;
    expect(root.querySelector('h1')?.textContent).toBe('Storage');
    expect(root.textContent).toContain('SQLite');
  });

  it('renders a configuration section with control and analytics backends', async () => {
    const el = await mount();
    const root = el.shadowRoot as ShadowRoot;
    const configCards = root.querySelectorAll('.config-card');
    expect(configCards.length).toBe(2);
    expect(root.textContent).toContain('Control Database');
    expect(root.textContent).toContain('Analytics Database');
  });

  it('renders a databases table with both DBs', async () => {
    const el = await mount();
    const root = el.shadowRoot as ShadowRoot;
    const rows = root.querySelectorAll('.db-table tbody tr');
    expect(rows.length).toBe(2);
    expect(root.textContent).toContain('Control DB');
    expect(root.textContent).toContain('Analytics DB');
  });

  it('renders a danger zone with a delete button', async () => {
    const el = await mount();
    const root = el.shadowRoot as ShadowRoot;
    const dangerButton = root.querySelector('.section:last-of-type button.danger');
    expect(dangerButton).not.toBeNull();
    expect(dangerButton?.textContent).toContain('Delete All Data');
  });

  it('renders a per-row Delete button next to each Download button', async () => {
    const el = await mount();
    const root = el.shadowRoot as ShadowRoot;
    const rows = root.querySelectorAll('.db-table tbody tr');
    expect(rows.length).toBe(2);
    for (const row of rows) {
      const buttons = row.querySelectorAll('td.actions button');
      expect(buttons.length).toBe(3);
      expect(buttons[0]?.textContent?.trim()).toBe('Download');
      expect(buttons[1]?.textContent?.trim()).toBe('Optimize');
      expect(buttons[2]?.textContent?.trim()).toBe('Delete');
    }
  });

  it('opens the single-DB confirmation modal when a row Delete is clicked', async () => {
    const el = await mount();
    const root = el.shadowRoot as ShadowRoot;
    const modals = root.querySelectorAll('delete-confirmation-modal');
    expect(modals.length).toBe(2);

    const firstRowDelete = root.querySelector(
      '.db-table tbody tr td.actions button.danger',
    ) as HTMLButtonElement;
    firstRowDelete.click();
    await el.updateComplete;

    const singleModal = modals[1];
    expect(singleModal.open).toBe(true);
    expect(singleModal.titleText).toContain('Delete');
  });

  it('calls dbClient.reset when confirming a Control DB delete', async () => {
    const reloadSpy = vi.spyOn(window.location, 'reload').mockImplementation(() => undefined);
    const el = await mount();
    const root = el.shadowRoot as ShadowRoot;

    const firstRowDelete = root.querySelector(
      '.db-table tbody tr td.actions button.danger',
    ) as HTMLButtonElement;
    firstRowDelete.click();
    await el.updateComplete;

    const modals = root.querySelectorAll('delete-confirmation-modal');
    const singleModal = modals[1];
    singleModal.dispatchEvent(new CustomEvent('delete-confirmed'));
    await new Promise((r) => setTimeout(r, 10));

    expect(mockDbClient.reset).toHaveBeenCalledTimes(1);
    expect(mockAnalyticsClient.reset).not.toHaveBeenCalled();
    reloadSpy.mockRestore();
  });

  it('calls analyticsClient.reset when confirming an Analytics DB delete', async () => {
    const reloadSpy = vi.spyOn(window.location, 'reload').mockImplementation(() => undefined);
    const el = await mount();
    const root = el.shadowRoot as ShadowRoot;

    const rows = root.querySelectorAll('.db-table tbody tr');
    const analyticsRowDelete = rows[1].querySelector(
      'td.actions button.danger',
    ) as HTMLButtonElement;
    analyticsRowDelete.click();
    await el.updateComplete;

    const modals = root.querySelectorAll('delete-confirmation-modal');
    const singleModal = modals[1];
    singleModal.dispatchEvent(new CustomEvent('delete-confirmed'));
    await new Promise((r) => setTimeout(r, 10));

    expect(mockAnalyticsClient.reset).toHaveBeenCalledTimes(1);
    expect(mockDbClient.reset).not.toHaveBeenCalled();
    reloadSpy.mockRestore();
  });

  it('opens the delete confirmation modal when delete is clicked', async () => {
    const el = await mount();
    const root = el.shadowRoot as ShadowRoot;
    const dangerButton = root.querySelector(
      '.section:last-of-type button.danger',
    ) as HTMLButtonElement;
    dangerButton.click();
    await el.updateComplete;
    const modal = root.querySelector('delete-confirmation-modal');
    expect(modal).not.toBeNull();
  });

  it('shows a warning banner when backend is ephemeral', async () => {
    mockDbClient.ensureReady.mockResolvedValue('memory');
    const el = await mount();
    const root = el.shadowRoot as ShadowRoot;
    const banner = root.querySelector('.warning-banner');
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain('in-memory');
  });

  describe('Size column', () => {
    it('renders the resolved size via the lightweight PRAGMA-based RPC, not export', async () => {
      const el = await mount();
      const root = el.shadowRoot as ShadowRoot;
      expect(mockDbClient.getControlDatabaseSize).toHaveBeenCalled();
      expect(mockAnalyticsClient.getAnalyticsDatabaseSize).toHaveBeenCalled();
      const controlRow = dbRow(root, 'Control DB');
      expect(controlRow.textContent).toContain('1.0 KB');
      const analyticsRow = dbRow(root, 'Analytics DB');
      expect(analyticsRow.textContent).toContain('2.0 KB');
    });

    it('shows a loading placeholder before the size resolves', async () => {
      let resolveSize: (value: number) => void = () => {};
      mockDbClient.getControlDatabaseSize.mockReturnValue(
        new Promise((resolve) => {
          resolveSize = resolve;
        }),
      );
      const el = document.createElement('storage-page') as StoragePage;
      document.body.appendChild(el);
      await el.updateComplete;
      await new Promise((r) => setTimeout(r, 0));
      await el.updateComplete;

      const root = el.shadowRoot as ShadowRoot;
      const controlRow = dbRow(root, 'Control DB');
      expect(controlRow.textContent).toContain('Calculating…');
      expect(controlRow.querySelector('.size-error')).toBeNull();

      resolveSize(1024);
      await new Promise((r) => setTimeout(r, 0));
      await el.updateComplete;
    });

    it('renders a distinguishable error affordance (not "—") when the size query fails', async () => {
      mockDbClient.getControlDatabaseSize.mockRejectedValue(new Error('PRAGMA failed'));
      const el = await mount();
      const root = el.shadowRoot as ShadowRoot;
      const controlRow = dbRow(root, 'Control DB');
      const errorEl = controlRow.querySelector('.size-error');
      expect(errorEl).not.toBeNull();
      expect(errorEl?.textContent).not.toBe('—');
      expect(controlRow.textContent).not.toContain('Calculating…');
    });
  });

  describe('Optimize button', () => {
    it('renders an Optimize button per row', async () => {
      const el = await mount();
      const root = el.shadowRoot as ShadowRoot;
      const buttons = Array.from(root.querySelectorAll('button.secondary'));
      const labels = buttons.map((b) => b.textContent?.trim());
      expect(labels.filter((l) => l === 'Optimize')).toHaveLength(2);
    });

    it('calls dbClient.vacuum() and refreshes the control DB size on success', async () => {
      const el = await mount();
      const root = el.shadowRoot as ShadowRoot;
      mockDbClient.getControlDatabaseSize.mockClear();
      mockDbClient.getControlDatabaseSize.mockResolvedValue(512);

      const controlRow = dbRow(root, 'Control DB');
      const optimizeButton = Array.from(controlRow.querySelectorAll('button')).find(
        (b) => b.textContent?.trim() === 'Optimize',
      ) as HTMLButtonElement;
      optimizeButton.click();
      await el.updateComplete;

      expect(mockDbClient.vacuum).toHaveBeenCalledTimes(1);
      await new Promise((r) => setTimeout(r, 0));
      await el.updateComplete;
      expect(mockDbClient.getControlDatabaseSize).toHaveBeenCalled();
    });

    it('calls analyticsClient.vacuum() and refreshes the analytics DB size on failure', async () => {
      mockAnalyticsClient.vacuum.mockRejectedValue(new Error('vacuum busy'));
      const el = await mount();
      const root = el.shadowRoot as ShadowRoot;
      mockAnalyticsClient.getAnalyticsDatabaseSize.mockClear();

      const analyticsRow = dbRow(root, 'Analytics DB');
      const optimizeButton = Array.from(analyticsRow.querySelectorAll('button')).find(
        (b) => b.textContent?.trim() === 'Optimize',
      ) as HTMLButtonElement;
      optimizeButton.click();
      await el.updateComplete;

      expect(mockAnalyticsClient.vacuum).toHaveBeenCalledTimes(1);
      await new Promise((r) => setTimeout(r, 0));
      await el.updateComplete;
      // Size is refreshed even on failure, since a partial VACUUM can still change page count.
      expect(mockAnalyticsClient.getAnalyticsDatabaseSize).toHaveBeenCalled();
    });
  });

  describe('Cross-row busy gating', () => {
    it('disables every row while one row has an operation in flight, not just its own row', async () => {
      let resolveVacuum: () => void = () => {};
      mockDbClient.vacuum.mockReturnValue(
        new Promise<void>((resolve) => {
          resolveVacuum = resolve;
        }),
      );

      const el = await mount();
      const root = el.shadowRoot as ShadowRoot;
      const controlRow = dbRow(root, 'Control DB');
      const analyticsRow = dbRow(root, 'Analytics DB');
      const controlOptimize = Array.from(controlRow.querySelectorAll('button')).find(
        (b) => b.textContent?.trim() === 'Optimize',
      ) as HTMLButtonElement;

      controlOptimize.click();
      await el.updateComplete;

      // The overlay belongs to the control-DB row, but with no focus trap on
      // this full-page overlay, a different row's buttons must not become
      // keyboard-reachable/clickable while it's up — otherwise a second
      // operation there would overwrite the single shared overlay state out
      // from under the first (see wild-popping-sundae Phase 1 PR review).
      for (const button of Array.from(analyticsRow.querySelectorAll('button'))) {
        expect((button as HTMLButtonElement).disabled).toBe(true);
      }
      expect(controlOptimize.disabled).toBe(true);

      resolveVacuum();
      await new Promise((r) => setTimeout(r, 0));
      // Success phase is still shown (auto-dismiss timer pending) — still busy.
      for (const button of Array.from(analyticsRow.querySelectorAll('button'))) {
        expect((button as HTMLButtonElement).disabled).toBe(true);
      }
    });
  });

  describe('Download flow', () => {
    it('shows a running overlay, then triggers a download and auto-closes on success', async () => {
      const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
      const createObjectURLSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock-url');
      const revokeObjectURLSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});

      let resolveExport: (value: Uint8Array) => void = () => {};
      mockDbClient.exportControlDatabaseOptimized.mockReturnValue(
        new Promise((resolve) => {
          resolveExport = resolve;
        }),
      );

      const el = await mount();
      const root = el.shadowRoot as ShadowRoot;
      const controlRow = dbRow(root, 'Control DB');
      const downloadButton = Array.from(controlRow.querySelectorAll('button')).find(
        (b) => b.textContent?.trim() === 'Download',
      ) as HTMLButtonElement;
      downloadButton.click();
      await el.updateComplete;

      let overlay = root.querySelector('.storage-overlay');
      expect(overlay).not.toBeNull();
      expect(overlay?.textContent).toContain('Preparing Control DB download…');

      resolveExport(new Uint8Array(64));
      await new Promise((r) => setTimeout(r, 0));
      await el.updateComplete;

      expect(clickSpy).toHaveBeenCalledTimes(1);
      expect(createObjectURLSpy).toHaveBeenCalledTimes(1);
      expect(revokeObjectURLSpy).toHaveBeenCalledTimes(1);
      overlay = root.querySelector('.storage-overlay');
      expect(overlay?.textContent).toContain('Download ready.');

      clickSpy.mockRestore();
      createObjectURLSpy.mockRestore();
      revokeObjectURLSpy.mockRestore();
    });

    it('shows a dismissable error banner (not silent) when export fails, and stays open', async () => {
      mockAnalyticsClient.exportAnalyticsDatabaseOptimized.mockRejectedValue(
        new Error('VACUUM INTO failed'),
      );
      const el = await mount();
      const root = el.shadowRoot as ShadowRoot;
      const analyticsRow = dbRow(root, 'Analytics DB');
      const downloadButton = Array.from(analyticsRow.querySelectorAll('button')).find(
        (b) => b.textContent?.trim() === 'Download',
      ) as HTMLButtonElement;
      downloadButton.click();
      await el.updateComplete;
      await new Promise((r) => setTimeout(r, 0));
      await el.updateComplete;

      const overlay = root.querySelector('.storage-overlay');
      expect(overlay).not.toBeNull();
      expect(overlay?.textContent).toContain('Failed: VACUUM INTO failed');

      const dismissButton = overlay?.querySelector('button') as HTMLButtonElement;
      expect(dismissButton.textContent).toContain('Dismiss');
      dismissButton.click();
      await el.updateComplete;
      expect(root.querySelector('.storage-overlay')).toBeNull();
    });

    it('flips to a "taking longer than expected" state after the stall timeout while still running', async () => {
      vi.useFakeTimers();
      let resolveExport: (value: Uint8Array) => void = () => {};
      mockDbClient.exportControlDatabaseOptimized.mockReturnValue(
        new Promise((resolve) => {
          resolveExport = resolve;
        }),
      );

      const el = document.createElement('storage-page') as StoragePage;
      document.body.appendChild(el);
      await el.updateComplete;
      await vi.advanceTimersByTimeAsync(10);
      await el.updateComplete;

      const root = el.shadowRoot as ShadowRoot;
      const controlRow = dbRow(root, 'Control DB');
      const downloadButton = Array.from(controlRow.querySelectorAll('button')).find(
        (b) => b.textContent?.trim() === 'Download',
      ) as HTMLButtonElement;
      downloadButton.click();
      await el.updateComplete;

      expect(root.querySelector('.storage-overlay')?.textContent).not.toContain(
        'taking longer than expected',
      );

      await vi.advanceTimersByTimeAsync(30_000);
      await el.updateComplete;

      expect(root.querySelector('.storage-overlay')?.textContent).toContain(
        'taking longer than expected',
      );

      // Resolving after the stall still completes the operation cleanly.
      resolveExport(new Uint8Array(8));
      await vi.advanceTimersByTimeAsync(1_000);
      await el.updateComplete;
      expect(root.querySelector('.storage-overlay')).toBeNull();
    });

    it('does not trigger a download or mutate state if the page navigates away before export resolves', async () => {
      const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
      vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock-url');
      vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});

      let resolveExport: (value: Uint8Array) => void = () => {};
      mockDbClient.exportControlDatabaseOptimized.mockReturnValue(
        new Promise((resolve) => {
          resolveExport = resolve;
        }),
      );

      const el = await mount();
      const root = el.shadowRoot as ShadowRoot;
      const controlRow = dbRow(root, 'Control DB');
      const downloadButton = Array.from(controlRow.querySelectorAll('button')).find(
        (b) => b.textContent?.trim() === 'Download',
      ) as HTMLButtonElement;
      downloadButton.click();
      await el.updateComplete;
      expect(root.querySelector('.storage-overlay')).not.toBeNull();

      // Simulate navigating away (component disconnected) before the export
      // RPC resolves — the overlay/database state must not be mutated and no
      // surprise download must fire once the promise settles later.
      el.remove();
      resolveExport(new Uint8Array(64));
      await new Promise((r) => setTimeout(r, 0));

      expect(clickSpy).not.toHaveBeenCalled();

      clickSpy.mockRestore();
    });
  });
});
