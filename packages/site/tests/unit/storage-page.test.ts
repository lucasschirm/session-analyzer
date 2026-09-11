import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../../src/pages/settings/storage-page';
import type { StoragePage } from '../../src/pages/settings/storage-page';

const mockDbClient = vi.hoisted(() => ({
  ensureReady: vi.fn(),
  exportControlDatabase: vi.fn(),
  exportAndDownload: vi.fn(),
  reset: vi.fn(),
}));

vi.mock('../../src/db/db-client', () => ({ dbClient: mockDbClient }));

const mockAnalyticsClient = vi.hoisted(() => ({
  ensureReady: vi.fn(),
  getBackend: vi.fn(),
  exportAnalyticsDatabase: vi.fn(),
  close: vi.fn(),
  reset: vi.fn(),
}));

vi.mock('../../src/db/analytics-client', () => ({
  analyticsClient: mockAnalyticsClient,
}));

beforeEach(() => {
  vi.clearAllMocks();
  mockDbClient.ensureReady.mockResolvedValue('opfs');
  mockDbClient.exportControlDatabase.mockResolvedValue(new Uint8Array(1024));
  mockAnalyticsClient.ensureReady.mockResolvedValue(undefined);
  mockAnalyticsClient.getBackend.mockResolvedValue({
    backendName: 'wasm-opfs',
    durability: 'persistent',
    journalMode: 'wal',
    storage: 'opfs',
  });
  mockAnalyticsClient.exportAnalyticsDatabase.mockResolvedValue(new Uint8Array(2048));
  mockAnalyticsClient.close.mockResolvedValue(undefined);
});

afterEach(() => {
  document.body.innerHTML = '';
});

async function mount(): Promise<StoragePage> {
  const el = document.createElement('storage-page') as StoragePage;
  document.body.appendChild(el);
  await el.updateComplete;
  await new Promise((r) => setTimeout(r, 10));
  await el.updateComplete;
  return el;
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
      expect(buttons.length).toBe(2);
      expect(buttons[0]?.textContent?.trim()).toBe('Download');
      expect(buttons[1]?.textContent?.trim()).toBe('Delete');
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
});
