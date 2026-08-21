import { S3Error, S3FetchClient } from '@lucasschirm/sal-sync-core';
import type { LitElement } from 'lit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectModal } from '../../src/components/connect-modal';
import '../../src/components/connect-modal';
import '../../src/components/passkey-modal';
import { encryptField } from '../../src/sync/credential-crypto';
import type { Connection, StoredS3Credentials } from '../../src/types';

const mockDbClient = vi.hoisted(() => ({
  getConnections: vi.fn(),
  getS3Credentials: vi.fn(),
  createConnection: vi.fn(),
  updateConnection: vi.fn(),
  saveS3Credentials: vi.fn(),
  deleteConnection: vi.fn(),
  getPasskeyState: vi.fn(),
  ensureReady: vi.fn(),
}));

vi.mock('../../src/db/db-client', () => ({ dbClient: mockDbClient }));

const mockSyncManager = vi.hoisted(() => {
  const listeners: Record<string, EventListener[]> = {};
  return {
    addEventListener: vi.fn((type: string, listener: EventListener) => {
      listeners[type] = listeners[type] ?? [];
      listeners[type].push(listener);
    }),
    removeEventListener: vi.fn((type: string, listener: EventListener) => {
      if (!listeners[type]) return;
      listeners[type] = listeners[type].filter((l) => l !== listener);
    }),
    requestRun: vi.fn(),
    getSnapshot: vi.fn(() => ({ readOnly: false, activeRun: null, queuedRuns: [] as string[] })),
    emitChange: () => {
      for (const listener of listeners.change ?? []) {
        listener(new Event('change'));
      }
    },
  };
});

vi.mock('../../src/sync/sync-manager', () => ({ syncManager: mockSyncManager }));

const mockCrypto = vi.hoisted(() => ({
  isUnlocked: vi.fn(() => false),
  encryptField: vi.fn((value: string) => Promise.resolve({ iv: `iv-${value}`, ct: `ct-${value}` })),
}));

vi.mock('../../src/sync/credential-crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/sync/credential-crypto')>();
  return { ...actual, ...mockCrypto };
});

async function mount<T extends LitElement>(element: T): Promise<T> {
  document.body.appendChild(element);
  await element.updateComplete;
  return element;
}

async function flush(modal: LitElement): Promise<void> {
  await modal.updateComplete;
  await new Promise((resolve) => setTimeout(resolve, 0));
  await modal.updateComplete;
}

function shadow(modal: LitElement): ShadowRoot {
  expect(modal.shadowRoot).not.toBeNull();
  return modal.shadowRoot as ShadowRoot;
}

function fillInput(root: ShadowRoot, id: string, value: string): void {
  const input = root.querySelector(id) as HTMLInputElement;
  input.value = value;
  input.dispatchEvent(new Event('input'));
}

function clickButtonByText(root: ShadowRoot, text: string): void {
  const button = Array.from(root.querySelectorAll('button')).find((b) =>
    b.textContent?.trim().includes(text),
  );
  button?.click();
}

const savedConnection: Connection = {
  id: 'c1',
  name: 'Saved S3',
  storage_type: 's3',
  sync_only_new: false,
  created_at: 1_700_000_000_000,
  updated_at: 1_700_000_000_000,
};

const savedCredentials: StoredS3Credentials = {
  connection_id: 'c1',
  region: 'us-east-1',
  bucket: 'saved-bucket',
  access_key_id: 'AKIAIOSFODNN7EXAMPLE',
  secret_access_key_ct: 'saved-ct',
  secret_access_key_iv: 'saved-iv',
  created_at: 1_700_000_000_000,
  updated_at: 1_700_000_000_000,
};

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.clearAllMocks();
  mockDbClient.getConnections.mockResolvedValue([]);
  mockDbClient.getS3Credentials.mockResolvedValue(null);
  mockDbClient.createConnection.mockResolvedValue(undefined);
  mockDbClient.updateConnection.mockResolvedValue(undefined);
  mockDbClient.saveS3Credentials.mockResolvedValue(undefined);
  mockDbClient.deleteConnection.mockResolvedValue(undefined);
  mockDbClient.getPasskeyState.mockResolvedValue(null);
  mockSyncManager.getSnapshot.mockReturnValue({ readOnly: false, activeRun: null, queuedRuns: [] });
  mockCrypto.isUnlocked.mockReturnValue(false);
});

describe('connect-modal', () => {
  it('renders nothing while closed', async () => {
    const modal = await mount(document.createElement('connect-modal') as ConnectModal);
    expect(shadow(modal).querySelector('.connect-modal')).toBeNull();
  });

  it('lists saved connections when opened', async () => {
    mockDbClient.getConnections.mockResolvedValue([savedConnection]);
    mockDbClient.getS3Credentials.mockResolvedValue(savedCredentials);

    const modal = await mount(document.createElement('connect-modal') as ConnectModal);
    modal.open = true;
    await flush(modal);

    const root = shadow(modal);
    expect(root.textContent).toContain('Saved S3');
    expect(root.textContent).toContain('saved-bucket');
    expect(root.textContent).toContain('S3');
  });

  it('switches to the form when new connection is clicked', async () => {
    const modal = await mount(document.createElement('connect-modal') as ConnectModal);
    modal.open = true;
    await flush(modal);

    const root = shadow(modal);
    (root.querySelector('.primary') as HTMLButtonElement).click();
    await modal.updateComplete;

    expect(root.querySelector('input#connection-name')).not.toBeNull();
  });

  it('saves an in-memory connection when "Save to local storage" is unchecked', async () => {
    const modal = await mount(document.createElement('connect-modal') as ConnectModal);
    modal.open = true;
    await flush(modal);

    const root = shadow(modal);
    (root.querySelector('.primary') as HTMLButtonElement).click();
    await modal.updateComplete;

    fillInput(root, '#connection-name', 'In-Memory S3');
    fillInput(root, '#connection-region', 'us-east-1');
    fillInput(root, '#connection-bucket', 'memory-bucket');
    fillInput(root, '#connection-access-key', 'AKIAIOSFODNN7EXAMPLE');
    fillInput(root, '#connection-secret-key', 'secret-key');

    clickButtonByText(root, 'Save');
    await flush(modal);

    expect(mockDbClient.createConnection).not.toHaveBeenCalled();
    expect(mockDbClient.saveS3Credentials).not.toHaveBeenCalled();
    expect(root.textContent).toContain('In-Memory S3');
    expect(root.textContent).toContain('In-Memory');
  });

  it('prompts for a passkey and saves a persisted connection when checked', async () => {
    mockDbClient.getPasskeyState.mockResolvedValue(null);

    const modal = await mount(document.createElement('connect-modal') as ConnectModal);
    modal.open = true;
    await flush(modal);

    const root = shadow(modal);
    (root.querySelector('.primary') as HTMLButtonElement).click();
    await modal.updateComplete;

    fillInput(root, '#connection-name', 'Persisted S3');
    fillInput(root, '#connection-region', 'us-east-1');
    fillInput(root, '#connection-bucket', 'persisted-bucket');
    fillInput(root, '#connection-access-key', 'AKIAIOSFODNN7EXAMPLE');
    fillInput(root, '#connection-secret-key', 'secret-key');

    const saveCheckbox = root.querySelector('input[type="checkbox"]') as HTMLInputElement;
    saveCheckbox.checked = true;
    saveCheckbox.dispatchEvent(new Event('change'));
    await modal.updateComplete;

    clickButtonByText(root, 'Save');
    await flush(modal);

    expect(mockDbClient.createConnection).not.toHaveBeenCalled();
    const passkeyModal = root.querySelector('passkey-modal') as HTMLElement & { open: boolean };
    expect(passkeyModal.open).toBe(true);

    mockCrypto.isUnlocked.mockReturnValue(true);
    mockCrypto.encryptField.mockResolvedValue({ iv: 'new-iv', ct: 'new-ct' });
    passkeyModal.dispatchEvent(
      new CustomEvent('passkey-created', { bubbles: true, composed: true }),
    );
    await flush(modal);

    expect(mockDbClient.createConnection).toHaveBeenCalledTimes(1);
    const created = mockDbClient.createConnection.mock.calls[0][0] as Connection;
    expect(created.name).toBe('Persisted S3');
    expect(mockDbClient.saveS3Credentials).toHaveBeenCalledTimes(1);
    const savedCreds = mockDbClient.saveS3Credentials.mock.calls[0][0] as StoredS3Credentials;
    expect(savedCreds.bucket).toBe('persisted-bucket');
    expect(savedCreds.secret_access_key_ct).toBe('new-ct');
    expect(savedCreds.secret_access_key_iv).toBe('new-iv');
  });

  it('re-uses the stored secret when editing a saved connection without re-entering it', async () => {
    mockCrypto.isUnlocked.mockReturnValue(true);
    mockDbClient.getConnections.mockResolvedValue([savedConnection]);
    mockDbClient.getS3Credentials.mockResolvedValue(savedCredentials);

    const modal = await mount(document.createElement('connect-modal') as ConnectModal);
    modal.open = true;
    await flush(modal);

    const root = shadow(modal);
    clickButtonByText(root, 'Edit');
    await flush(modal);

    fillInput(root, '#connection-name', 'Updated S3');
    clickButtonByText(root, 'Save');
    await flush(modal);

    expect(mockDbClient.updateConnection).toHaveBeenCalledWith('c1', {
      name: 'Updated S3',
      sync_only_new: false,
    });
    expect(mockDbClient.saveS3Credentials).toHaveBeenCalledWith(
      expect.objectContaining({
        connection_id: 'c1',
        secret_access_key_ct: 'saved-ct',
        secret_access_key_iv: 'saved-iv',
      }),
    );
    expect(encryptField).not.toHaveBeenCalled();
  });

  it('calls S3FetchClient.headBucket and shows a success result', async () => {
    const headBucket = vi.spyOn(S3FetchClient.prototype, 'headBucket').mockResolvedValue(undefined);

    const modal = await mount(document.createElement('connect-modal') as ConnectModal);
    modal.open = true;
    await flush(modal);

    const root = shadow(modal);
    (root.querySelector('.primary') as HTMLButtonElement).click();
    await modal.updateComplete;

    fillInput(root, '#connection-name', 'Test');
    fillInput(root, '#connection-region', 'us-east-1');
    fillInput(root, '#connection-bucket', 'bucket');
    fillInput(root, '#connection-access-key', 'AKIAIOSFODNN7EXAMPLE');
    fillInput(root, '#connection-secret-key', 'secret-key');

    clickButtonByText(root, 'Test connection');
    await flush(modal);

    expect(headBucket).toHaveBeenCalled();
    expect(root.textContent).toContain('Connection OK');
  });

  it('maps a network/CORS failure to the CORS hint and docs link', async () => {
    vi.spyOn(S3FetchClient.prototype, 'headBucket').mockRejectedValue(
      new S3Error({
        status: 0,
        code: 'NetworkError',
        message: 'Failed to fetch',
        kind: 'network',
      }),
    );

    const modal = await mount(document.createElement('connect-modal') as ConnectModal);
    modal.open = true;
    await flush(modal);

    const root = shadow(modal);
    (root.querySelector('.primary') as HTMLButtonElement).click();
    await modal.updateComplete;

    fillInput(root, '#connection-name', 'Test');
    fillInput(root, '#connection-region', 'us-east-1');
    fillInput(root, '#connection-bucket', 'bucket');
    fillInput(root, '#connection-access-key', 'AKIAIOSFODNN7EXAMPLE');
    fillInput(root, '#connection-secret-key', 'secret-key');

    clickButtonByText(root, 'Test connection');
    await flush(modal);

    expect(root.textContent).toContain('CORS misconfiguration');
    expect(root.querySelector('a')?.getAttribute('href')).toContain('cors-configuration');
  });

  it.each([
    ['SignatureDoesNotMatch', 'Check the secret access key and region are correct.'],
    ['NoSuchBucket', 'Check the bucket name and region are correct.'],
    ['AccessDenied', 'Check this key has permission to access the bucket.'],
    ['RequestTimeTooSkewed', 'Check your system clock is accurate.'],
  ])('maps %s to the correct hint', async (code, hint) => {
    vi.spyOn(S3FetchClient.prototype, 'headBucket').mockRejectedValue(
      new S3Error({
        status: 403,
        code,
        message: `${code} error`,
        kind: 's3',
      }),
    );

    const modal = await mount(document.createElement('connect-modal') as ConnectModal);
    modal.open = true;
    await flush(modal);

    const root = shadow(modal);
    (root.querySelector('.primary') as HTMLButtonElement).click();
    await modal.updateComplete;

    fillInput(root, '#connection-name', 'Test');
    fillInput(root, '#connection-region', 'us-east-1');
    fillInput(root, '#connection-bucket', 'bucket');
    fillInput(root, '#connection-access-key', 'AKIAIOSFODNN7EXAMPLE');
    fillInput(root, '#connection-secret-key', 'secret-key');

    clickButtonByText(root, 'Test connection');
    await flush(modal);

    expect(root.textContent).toContain(hint);
  });

  it('syncs a saved connection and closes the modal', async () => {
    mockDbClient.getConnections.mockResolvedValue([savedConnection]);
    mockDbClient.getS3Credentials.mockResolvedValue(savedCredentials);

    const modal = await mount(document.createElement('connect-modal') as ConnectModal);
    let closed = 0;
    modal.addEventListener('modal-close', () => closed++);
    modal.open = true;
    await flush(modal);

    const root = shadow(modal);
    clickButtonByText(root, 'Sync');
    await flush(modal);

    expect(mockSyncManager.requestRun).toHaveBeenCalledWith('c1');
    expect(closed).toBe(1);
  });

  it('disables the sync button when the sync manager is in read-only mode', async () => {
    mockSyncManager.getSnapshot.mockReturnValue({
      readOnly: true,
      activeRun: null,
      queuedRuns: [],
    });
    mockDbClient.getConnections.mockResolvedValue([savedConnection]);
    mockDbClient.getS3Credentials.mockResolvedValue(savedCredentials);

    const modal = await mount(document.createElement('connect-modal') as ConnectModal);
    modal.open = true;
    await flush(modal);

    const root = shadow(modal);
    const syncButton = Array.from(root.querySelectorAll('button')).find((b) =>
      b.textContent?.trim().includes('Sync'),
    ) as HTMLButtonElement;

    expect(syncButton.disabled).toBe(true);
    expect(syncButton.title).toContain('Another tab');
  });

  it('deletes a saved connection after confirmation', async () => {
    vi.stubGlobal(
      'confirm',
      vi.fn(() => true),
    );
    mockDbClient.getConnections.mockResolvedValue([savedConnection]);
    mockDbClient.getS3Credentials.mockResolvedValue(savedCredentials);

    const modal = await mount(document.createElement('connect-modal') as ConnectModal);
    modal.open = true;
    await flush(modal);

    const root = shadow(modal);
    clickButtonByText(root, 'Delete');
    await flush(modal);

    expect(mockDbClient.deleteConnection).toHaveBeenCalledWith('c1');
  });

  it('persists the "sync only new sessions" flag on save', async () => {
    mockCrypto.isUnlocked.mockReturnValue(true);
    mockCrypto.encryptField.mockResolvedValue({ iv: 'iv', ct: 'ct' });

    const modal = await mount(document.createElement('connect-modal') as ConnectModal);
    modal.open = true;
    await flush(modal);

    const root = shadow(modal);
    (root.querySelector('.primary') as HTMLButtonElement).click();
    await modal.updateComplete;

    fillInput(root, '#connection-name', 'Sync New');
    fillInput(root, '#connection-region', 'us-east-1');
    fillInput(root, '#connection-bucket', 'new-bucket');
    fillInput(root, '#connection-access-key', 'AKIAIOSFODNN7EXAMPLE');
    fillInput(root, '#connection-secret-key', 'secret-key');

    const saveCheckbox = root.querySelector('input[type="checkbox"]') as HTMLInputElement;
    saveCheckbox.checked = true;
    saveCheckbox.dispatchEvent(new Event('change'));

    const syncOnlyNew = Array.from(root.querySelectorAll('input[type="checkbox"]')).find((input) =>
      input.nextSibling?.textContent?.includes('Sync only new sessions'),
    ) as HTMLInputElement;
    syncOnlyNew.checked = true;
    syncOnlyNew.dispatchEvent(new Event('change'));

    await modal.updateComplete;
    clickButtonByText(root, 'Save');
    await flush(modal);

    const created = mockDbClient.createConnection.mock.calls[0][0] as Connection;
    expect(created.sync_only_new).toBe(true);
  });
});
