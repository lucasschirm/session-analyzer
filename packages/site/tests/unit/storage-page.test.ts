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
    const dangerButton = root.querySelector('button.danger');
    expect(dangerButton).not.toBeNull();
    expect(dangerButton?.textContent).toContain('Delete All Data');
  });

  it('opens the delete confirmation modal when delete is clicked', async () => {
    const el = await mount();
    const root = el.shadowRoot as ShadowRoot;
    const dangerButton = root.querySelector('button.danger') as HTMLButtonElement;
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
