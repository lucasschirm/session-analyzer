import type { LitElement } from 'lit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StorageSessionsPage } from '../../src/pages/storage-sessions-page';
import '../../src/pages/storage-sessions-page';
import type { StorageSessionItem } from '../../src/sync/sync-manager';

const mockSessions: StorageSessionItem[] = [
  {
    projectId: 'proj-1',
    projectName: 'Alpha Project',
    sessionId: 'sess-101',
    title: 'Fix Authentication Flow',
    lastModified: '2026-09-10T10:00:00.000Z',
    modifiedTimestamp: new Date('2026-09-10T10:00:00.000Z').getTime(),
    synced: true,
  },
  {
    projectId: 'proj-1',
    projectName: 'Alpha Project',
    sessionId: 'sess-102',
    title: 'Update Database Migrations',
    lastModified: '2026-09-12T14:00:00.000Z',
    modifiedTimestamp: new Date('2026-09-12T14:00:00.000Z').getTime(),
    synced: false,
  },
  {
    projectId: 'proj-2',
    projectName: 'Beta Service',
    sessionId: 'sess-201',
    title: 'Add S3 Integration',
    lastModified: '2026-09-11T09:00:00.000Z',
    modifiedTimestamp: new Date('2026-09-11T09:00:00.000Z').getTime(),
    synced: false,
  },
  {
    projectId: 'proj-2',
    projectName: 'Beta Service',
    sessionId: 'sess-202',
    title: 'Failed Session Import',
    lastModified: '2026-09-13T08:00:00.000Z',
    modifiedTimestamp: new Date('2026-09-13T08:00:00.000Z').getTime(),
    synced: false,
    syncStatus: 'failed',
    syncDetails: 'INGEST_FAILED: ingestion issues: missing_root_transcript',
  },
];

const mockSyncManager = vi.hoisted(() => {
  const listeners: Record<string, EventListener[]> = {};
  return {
    listeners,
    emit: (type: string, event: Event = new CustomEvent(type)) => {
      for (const l of listeners[type] ?? []) l(event);
    },
    addEventListener: vi.fn((type: string, listener: EventListener) => {
      listeners[type] = listeners[type] ?? [];
      listeners[type].push(listener);
    }),
    removeEventListener: vi.fn((type: string, listener: EventListener) => {
      if (!listeners[type]) return;
      listeners[type] = listeners[type].filter((l) => l !== listener);
    }),
    getConnection: vi.fn(),
    listStorageSessions: vi.fn(),
    refreshStorageSessionStatuses: vi.fn(),
    requestRun: vi.fn(),
    reprocessSession: vi.fn(),
    downloadRawSessionFile: vi.fn(),
  };
});

vi.mock('../../src/sync/sync-manager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/sync/sync-manager')>();
  return { ...actual, syncManager: mockSyncManager };
});

async function mount<T extends LitElement>(element: T): Promise<T> {
  document.body.appendChild(element);
  await element.updateComplete;
  return element;
}

async function flush(element: LitElement): Promise<void> {
  await element.updateComplete;
  await new Promise((resolve) => setTimeout(resolve, 0));
  await element.updateComplete;
}

function shadow(element: LitElement): ShadowRoot {
  expect(element.shadowRoot).not.toBeNull();
  return element.shadowRoot as ShadowRoot;
}

function clickButtonByText(root: ShadowRoot, text: string): void {
  const button = Array.from(root.querySelectorAll('button')).find((b) =>
    b.textContent?.trim().includes(text),
  );
  button?.click();
}

afterEach(() => {
  document.body.innerHTML = '';
});

beforeEach(() => {
  vi.clearAllMocks();
  mockSyncManager.getConnection.mockResolvedValue({
    id: 's3-main',
    name: 'Main S3 Storage',
    storage_type: 's3',
    created_at: 1000,
    updated_at: 1000,
    sync_only_new: false,
  });
  mockSyncManager.listStorageSessions.mockResolvedValue([...mockSessions]);
  mockSyncManager.refreshStorageSessionStatuses.mockResolvedValue([...mockSessions]);
});

describe('storage-sessions-page', () => {
  it('renders loading state initially', async () => {
    let resolveSessions: (val: StorageSessionItem[]) => void = () => {};
    mockSyncManager.listStorageSessions.mockReturnValue(
      new Promise((res) => {
        resolveSessions = res;
      }),
    );

    const page = document.createElement('storage-sessions-page') as StorageSessionsPage;
    page.storage = 's3-main';
    document.body.appendChild(page);
    await page.updateComplete;

    const root = shadow(page);
    expect(root.textContent).toContain('Loading sessions from storage...');

    resolveSessions?.(mockSessions);
    await flush(page);
    expect(root.textContent).not.toContain('Loading sessions from storage...');
  });

  it('renders error banner when loading fails and allows retry', async () => {
    mockSyncManager.listStorageSessions.mockRejectedValueOnce(
      new Error('Failed to connect to storage bucket'),
    );

    const page = document.createElement('storage-sessions-page') as StorageSessionsPage;
    page.storage = 's3-main';
    await mount(page);
    await flush(page);

    const root = shadow(page);
    expect(root.textContent).toContain('Failed to connect to storage bucket');
    expect(root.querySelector('.error-banner')).not.toBeNull();

    // Clicking retry loads sessions successfully
    mockSyncManager.listStorageSessions.mockResolvedValueOnce([...mockSessions]);
    clickButtonByText(root, 'Retry');
    await flush(page);

    expect(root.querySelector('.error-banner')).toBeNull();
    expect(root.textContent).toContain('Fix Authentication Flow');
  });

  it('renders empty state when storage has zero sessions', async () => {
    mockSyncManager.listStorageSessions.mockResolvedValueOnce([]);

    const page = document.createElement('storage-sessions-page') as StorageSessionsPage;
    page.storage = 's3-main';
    await mount(page);
    await flush(page);

    const root = shadow(page);
    expect(root.textContent).toContain('No sessions found in this storage.');
  });

  it('renders session rows with titles, projects, dates, and status badges', async () => {
    const page = document.createElement('storage-sessions-page') as StorageSessionsPage;
    page.storage = 's3-main';
    await mount(page);
    await flush(page);

    const root = shadow(page);
    expect(root.textContent).toContain('Fix Authentication Flow');
    expect(root.textContent).toContain('Alpha Project');
    expect(root.textContent).toContain('Add S3 Integration');
    expect(root.textContent).toContain('Beta Service');

    const rows = root.querySelectorAll('tbody tr');
    expect(rows.length).toBe(4);

    const badges = root.querySelectorAll('.badge');
    expect(badges[0].textContent?.trim()).toBe('Failed'); // latest is sess-202 (Sep 13, failed)
  });

  it('filters by project', async () => {
    const page = document.createElement('storage-sessions-page') as StorageSessionsPage;
    page.storage = 's3-main';
    await mount(page);
    await flush(page);

    const root = shadow(page);
    const select = root.querySelector('#project-filter') as HTMLSelectElement;
    expect(select).not.toBeNull();

    // Change filter to proj-2
    select.value = 'proj-2';
    select.dispatchEvent(new Event('change'));
    await flush(page);

    const rows = root.querySelectorAll('tbody tr');
    expect(rows.length).toBe(2);
    expect(root.textContent).toContain('Add S3 Integration');
    expect(root.textContent).toContain('Failed Session Import');
    expect(root.textContent).toContain('Beta Service');
    expect(root.textContent).not.toContain('Fix Authentication Flow');
  });

  it('orders by modified date ASC and DESC', async () => {
    const page = document.createElement('storage-sessions-page') as StorageSessionsPage;
    page.storage = 's3-main';
    await mount(page);
    await flush(page);

    const root = shadow(page);
    const sortSelect = root.querySelector('#sort-order') as HTMLSelectElement;

    // Default is desc: newest first (sess-202 on Sep 13, sess-102 on Sep 12, sess-201 on Sep 11, sess-101 on Sep 10)
    let rows = root.querySelectorAll('tbody tr');
    expect(rows[0].textContent).toContain('Failed Session Import');
    expect(rows[3].textContent).toContain('Fix Authentication Flow');

    // Switch to asc
    sortSelect.value = 'asc';
    sortSelect.dispatchEvent(new Event('change'));
    await flush(page);

    rows = root.querySelectorAll('tbody tr');
    expect(rows[0].textContent).toContain('Fix Authentication Flow'); // oldest first (Sep 10)
    expect(rows[3].textContent).toContain('Failed Session Import'); // newest last (Sep 13)
  });

  it('hides already synced sessions when checkbox is checked', async () => {
    const page = document.createElement('storage-sessions-page') as StorageSessionsPage;
    page.storage = 's3-main';
    await mount(page);
    await flush(page);

    const root = shadow(page);
    const hideCheckbox = root.querySelector('#hide-synced') as HTMLInputElement;

    expect(root.querySelectorAll('tbody tr').length).toBe(4);

    hideCheckbox.checked = true;
    hideCheckbox.dispatchEvent(new Event('change'));
    await flush(page);

    const rows = root.querySelectorAll('tbody tr');
    expect(rows.length).toBe(3);
    expect(root.textContent).not.toContain('Fix Authentication Flow'); // sess-101 was synced
    expect(root.textContent).toContain('Update Database Migrations');
    expect(root.textContent).toContain('Add S3 Integration');
    expect(root.textContent).toContain('Failed Session Import');
  });

  it('changing filter should not unselect already picked sessions (Critical Invariant)', async () => {
    const page = document.createElement('storage-sessions-page') as StorageSessionsPage;
    page.storage = 's3-main';
    await mount(page);
    await flush(page);

    const root = shadow(page);
    let rows = root.querySelectorAll('tbody tr');

    // Select sess-101 (synced, proj-1) and sess-201 (not synced, proj-2)
    // rows currently (desc): [0] sess-202, [1] sess-102, [2] sess-201, [3] sess-101
    const checkbox201 = rows[2].querySelector('input[type="checkbox"]') as HTMLInputElement;
    const checkbox101 = rows[3].querySelector('input[type="checkbox"]') as HTMLInputElement;

    checkbox201.click();
    checkbox101.click();
    await flush(page);

    expect(root.querySelector('.selection-count')?.textContent).toContain('2 selected');

    // Now filter by project: proj-1 only (sess-201 and sess-202 are now hidden from the table)
    const projectSelect = root.querySelector('#project-filter') as HTMLSelectElement;
    projectSelect.value = 'proj-1';
    projectSelect.dispatchEvent(new Event('change'));
    await flush(page);

    // Filtered rows should only be proj-1 (sess-102 and sess-101)
    expect(root.querySelectorAll('tbody tr').length).toBe(2);
    // CRITICAL: Total selection count MUST still be 2!
    expect(root.querySelector('.selection-count')?.textContent).toContain('2 selected');

    // Toggle "Hide already synced" (sess-101 is now hidden too!)
    const hideCheckbox = root.querySelector('#hide-synced') as HTMLInputElement;
    hideCheckbox.checked = true;
    hideCheckbox.dispatchEvent(new Event('change'));
    await flush(page);

    // Only sess-102 is visible now (not selected)
    expect(root.querySelectorAll('tbody tr').length).toBe(1);
    expect(root.querySelector('.selection-count')?.textContent).toContain('2 selected');

    // Change sort order to asc
    const sortSelect = root.querySelector('#sort-order') as HTMLSelectElement;
    sortSelect.value = 'asc';
    sortSelect.dispatchEvent(new Event('change'));
    await flush(page);

    expect(root.querySelector('.selection-count')?.textContent).toContain('2 selected');

    // Reset filters back to all
    projectSelect.value = 'all';
    projectSelect.dispatchEvent(new Event('change'));
    hideCheckbox.checked = false;
    hideCheckbox.dispatchEvent(new Event('change'));
    await flush(page);

    rows = root.querySelectorAll('tbody tr');
    expect(rows.length).toBe(4);
    expect(root.querySelector('.selection-count')?.textContent).toContain('2 selected');

    // Check that the checkboxes for sess-101 and sess-201 are still checked!
    // in asc order: [0] sess-101, [1] sess-201, [2] sess-102, [3] sess-202
    expect((rows[0].querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(
      true,
    );
    expect((rows[1].querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(
      true,
    );
    expect((rows[2].querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(
      false,
    );
  });

  it('selects multiple sessions and triggers sync for selected target sessions', async () => {
    const page = document.createElement('storage-sessions-page') as StorageSessionsPage;
    page.storage = 's3-main';
    await mount(page);
    await flush(page);

    const root = shadow(page);
    const syncButton = root.querySelector('.sync-selected-btn') as HTMLButtonElement;
    expect(syncButton.disabled).toBe(true);

    // Select all visible sessions
    clickButtonByText(root, 'Select visible');
    await flush(page);

    expect(root.querySelector('.selection-count')?.textContent).toContain('4 selected');
    expect(syncButton.disabled).toBe(false);
    expect(syncButton.textContent).toContain('Sync (4) Selected');

    // Click sync button
    syncButton.click();
    await flush(page);

    expect(mockSyncManager.requestRun).toHaveBeenCalledWith('s3-main', {
      targetSessions: [
        { projectId: 'proj-1', sessionId: 'sess-101' },
        { projectId: 'proj-1', sessionId: 'sess-102' },
        { projectId: 'proj-2', sessionId: 'sess-201' },
        { projectId: 'proj-2', sessionId: 'sess-202' },
      ],
    });

    expect(root.querySelector('.feedback-banner')?.textContent).toContain(
      'Sync queued for 4 sessions',
    );
  });

  it('clears selection when Clear is clicked', async () => {
    const page = document.createElement('storage-sessions-page') as StorageSessionsPage;
    page.storage = 's3-main';
    await mount(page);
    await flush(page);

    const root = shadow(page);
    clickButtonByText(root, 'Select visible');
    await flush(page);
    expect(root.querySelector('.selection-count')?.textContent).toContain('4 selected');

    clickButtonByText(root, 'Clear');
    await flush(page);
    expect(root.querySelector('.selection-count')?.textContent).toContain('0 selected');
    expect((root.querySelector('.sync-selected-btn') as HTMLButtonElement).disabled).toBe(true);
  });

  it('refreshes sync statuses via refreshStorageSessionStatuses on syncManager change event', async () => {
    const page = document.createElement('storage-sessions-page') as StorageSessionsPage;
    page.storage = 's3-main';
    await mount(page);
    await flush(page);

    expect(mockSyncManager.listStorageSessions).toHaveBeenCalledTimes(1);

    const updatedSessions = mockSessions.map((s) =>
      s.sessionId === 'sess-102' ? { ...s, synced: true } : s,
    );
    mockSyncManager.refreshStorageSessionStatuses.mockResolvedValueOnce(updatedSessions);

    // Trigger syncManager change listener
    mockSyncManager.emit('change');
    await flush(page);

    expect(mockSyncManager.refreshStorageSessionStatuses).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ sessionId: 'sess-101' })]),
    );
    // listStorageSessions should NOT have been called again
    expect(mockSyncManager.listStorageSessions).toHaveBeenCalledTimes(1);

    const root = shadow(page);
    const badges = root.querySelectorAll('.badge-synced');
    expect(badges.length).toBe(2);
  });

  it('renders View and Reprocess buttons for synced sessions, and raw button for all sessions', async () => {
    const page = document.createElement('storage-sessions-page') as StorageSessionsPage;
    page.storage = 's3-main';
    await mount(page);
    await flush(page);

    const root = shadow(page);
    const viewButtons = root.querySelectorAll('.view-btn');
    const reprocessButtons = root.querySelectorAll('.reprocess-btn');
    const rawButtons = root.querySelectorAll('.raw-btn');

    // sess-101 is synced (1 synced session)
    expect(viewButtons.length).toBe(1);
    expect(reprocessButtons.length).toBe(1);
    expect(viewButtons[0].getAttribute('data-session-id')).toBe('sess-101');
    expect(reprocessButtons[0].getAttribute('data-session-id')).toBe('sess-101');

    // All sessions (synced and unsynced) have a raw button
    expect(rawButtons.length).toBe(4);
    expect(rawButtons[0].textContent?.trim()).toBe('raw');
    expect(rawButtons[0].getAttribute('data-session-id')).toBe('sess-202');
    expect(rawButtons[1].getAttribute('data-session-id')).toBe('sess-102');
    expect(rawButtons[2].getAttribute('data-session-id')).toBe('sess-201');
    expect(rawButtons[3].getAttribute('data-session-id')).toBe('sess-101');

    // All sessions (synced and unsynced) have a download button
    const downloadButtons = root.querySelectorAll('.download-btn');
    expect(downloadButtons.length).toBe(4);
    expect(downloadButtons[0].textContent?.trim()).toBe('download');
    expect(downloadButtons[0].getAttribute('data-session-id')).toBe('sess-202');
    expect(downloadButtons[1].getAttribute('data-session-id')).toBe('sess-102');
    expect(downloadButtons[2].getAttribute('data-session-id')).toBe('sess-201');
    expect(downloadButtons[3].getAttribute('data-session-id')).toBe('sess-101');
  });

  it('navigates to session page when View button is clicked', async () => {
    const page = document.createElement('storage-sessions-page') as StorageSessionsPage;
    page.storage = 's3-main';
    await mount(page);
    await flush(page);

    const root = shadow(page);
    const viewBtn = root.querySelector('.view-btn') as HTMLButtonElement;
    expect(viewBtn).not.toBeNull();

    window.location.hash = '';
    viewBtn.click();
    expect(window.location.hash).toBe('#/sessions/sess-101');
  });

  it('calls reprocessSession and shows feedback when Reprocess is clicked', async () => {
    mockSyncManager.reprocessSession.mockResolvedValue(undefined);

    const page = document.createElement('storage-sessions-page') as StorageSessionsPage;
    page.storage = 's3-main';
    await mount(page);
    await flush(page);

    const root = shadow(page);
    const reprocessBtn = root.querySelector('.reprocess-btn') as HTMLButtonElement;
    expect(reprocessBtn).not.toBeNull();

    reprocessBtn.click();
    await flush(page);

    expect(mockSyncManager.reprocessSession).toHaveBeenCalledWith('s3-main', 'proj-1', 'sess-101');
    expect(root.querySelector('.feedback-banner')?.textContent).toContain(
      'Reprocessing started for "Fix Authentication Flow"',
    );
  });

  it('calls downloadRawSessionFile and opens tab when raw is clicked on an imported session', async () => {
    mockSyncManager.downloadRawSessionFile.mockResolvedValue({
      filename: 'transcript.jsonl',
      content: '{"type":"message"}',
    });

    const mockTab = {
      location: { href: '' },
      document: { body: { innerText: '' } },
      closed: false,
    } as unknown as Window;
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(mockTab);

    const page = document.createElement('storage-sessions-page') as StorageSessionsPage;
    page.storage = 's3-main';
    await mount(page);
    await flush(page);

    const root = shadow(page);
    const rawBtn = root.querySelector('.raw-btn[data-session-id="sess-101"]') as HTMLButtonElement;
    expect(rawBtn).not.toBeNull();
    expect(rawBtn.textContent?.trim()).toBe('raw');

    rawBtn.click();
    await flush(page);

    expect(mockSyncManager.downloadRawSessionFile).toHaveBeenCalledWith(
      's3-main',
      'proj-1',
      'sess-101',
    );
    expect(openSpy).toHaveBeenCalledWith('about:blank', '_blank');
    expect(mockTab.location.href).toContain('blob:');

    openSpy.mockRestore();
  });

  it('calls downloadRawSessionFile and triggers file download when download button is clicked', async () => {
    mockSyncManager.downloadRawSessionFile.mockResolvedValue({
      filename: 'transcript-sess-101.jsonl',
      content: '{"type":"message","id":"1"}',
    });

    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    const page = document.createElement('storage-sessions-page') as StorageSessionsPage;
    page.storage = 's3-main';
    await mount(page);
    await flush(page);

    const root = shadow(page);
    const downloadBtn = root.querySelector(
      '.download-btn[data-session-id="sess-101"]',
    ) as HTMLButtonElement;
    expect(downloadBtn).not.toBeNull();
    expect(downloadBtn.textContent?.trim()).toBe('download');

    downloadBtn.click();
    await flush(page);

    expect(mockSyncManager.downloadRawSessionFile).toHaveBeenCalledWith(
      's3-main',
      'proj-1',
      'sess-101',
    );
    expect(clickSpy).toHaveBeenCalled();

    clickSpy.mockRestore();
  });

  it('displays error banner when download fails', async () => {
    mockSyncManager.downloadRawSessionFile.mockRejectedValue(new Error('S3 network failure'));

    const page = document.createElement('storage-sessions-page') as StorageSessionsPage;
    page.storage = 's3-main';
    await mount(page);
    await flush(page);

    const root = shadow(page);
    const downloadBtn = root.querySelector(
      '.download-btn[data-session-id="sess-101"]',
    ) as HTMLButtonElement;
    expect(downloadBtn).not.toBeNull();

    downloadBtn.click();
    await flush(page);

    expect(root.querySelector('.error-banner')?.textContent).toContain(
      'Could not download session: S3 network failure',
    );
  });

  it('renders failed rows with light red background and Failed badge', async () => {
    const page = document.createElement('storage-sessions-page') as StorageSessionsPage;
    page.storage = 's3-main';
    await mount(page);
    await flush(page);

    const root = shadow(page);
    const failedRows = root.querySelectorAll('tbody tr.row-failed');
    expect(failedRows.length).toBe(1);
    expect(failedRows[0].getAttribute('data-key')).toBe('proj-2:sess-202');

    const failedBadge = failedRows[0].querySelector('.badge-failed');
    expect(failedBadge).not.toBeNull();
    expect(failedBadge?.textContent?.trim()).toBe('Failed');
  });

  it('shows View error button only for failed sessions', async () => {
    const page = document.createElement('storage-sessions-page') as StorageSessionsPage;
    page.storage = 's3-main';
    await mount(page);
    await flush(page);

    const root = shadow(page);
    const errorButtons = root.querySelectorAll('.error-viewer-btn');
    expect(errorButtons.length).toBe(1);
    expect(errorButtons[0].getAttribute('data-session-id')).toBe('sess-202');
    expect(errorButtons[0].textContent?.trim()).toBe('View error');
  });

  it('opens error modal with sync_details when View error is clicked', async () => {
    const page = document.createElement('storage-sessions-page') as StorageSessionsPage;
    page.storage = 's3-main';
    await mount(page);
    await flush(page);

    const root = shadow(page);
    const modalEl = root.querySelector('session-error-modal') as LitElement;
    expect(modalEl).not.toBeNull();
    expect(modalEl.hasAttribute('open')).toBe(false);

    const errorBtn = root.querySelector('.error-viewer-btn') as HTMLButtonElement;
    errorBtn.click();
    await flush(page);

    expect(modalEl.hasAttribute('open')).toBe(true);
    const modalRoot = modalEl.shadowRoot as ShadowRoot;
    expect(modalRoot.textContent).toContain('Sync error: Failed Session Import');
    expect(modalRoot.textContent).toContain(
      'INGEST_FAILED: ingestion issues: missing_root_transcript',
    );

    // Close button dismisses the modal
    const closeBtn = modalRoot.querySelector('button') as HTMLButtonElement;
    closeBtn.click();
    await flush(page);
    expect(modalEl.hasAttribute('open')).toBe(false);
  });

  it('closes the error modal via Escape key', async () => {
    const page = document.createElement('storage-sessions-page') as StorageSessionsPage;
    page.storage = 's3-main';
    await mount(page);
    await flush(page);

    const root = shadow(page);
    const modalEl = root.querySelector('session-error-modal') as LitElement;
    const errorBtn = root.querySelector('.error-viewer-btn') as HTMLButtonElement;
    errorBtn.click();
    await flush(page);
    expect(modalEl.hasAttribute('open')).toBe(true);

    const modalRoot = modalEl.shadowRoot as ShadowRoot;
    modalRoot
      .querySelector('.modal')
      ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flush(page);
    expect(modalEl.hasAttribute('open')).toBe(false);
  });
});
