import type { LitElement } from 'lit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../../src/pages/app-root';
import type { AppRoot } from '../../src/pages/app-root';
import type { Connection } from '../../src/types';

const savedConnection: Connection = {
  id: 'c1',
  name: 'Saved S3',
  storage_type: 's3',
  sync_only_new: false,
  created_at: 1_700_000_000_000,
  updated_at: 1_700_000_000_000,
};

const mockDbClient = vi.hoisted(() => ({
  ensureReady: vi.fn(),
  getConnections: vi.fn(),
  getPasskeyState: vi.fn(),
  getS3Credentials: vi.fn(),
  createConnection: vi.fn(),
  updateConnection: vi.fn(),
  saveS3Credentials: vi.fn(),
  deleteConnection: vi.fn(),
}));

vi.mock('../../src/db/db-client', () => ({ dbClient: mockDbClient }));

const mockSyncManager = vi.hoisted(() => {
  const listeners: Record<string, EventListener[]> = {};
  return {
    init: vi.fn(),
    addEventListener: vi.fn((type: string, listener: EventListener) => {
      listeners[type] = listeners[type] ?? [];
      listeners[type].push(listener);
    }),
    removeEventListener: vi.fn((type: string, listener: EventListener) => {
      if (!listeners[type]) return;
      listeners[type] = listeners[type].filter((l) => l !== listener);
    }),
    requestRun: vi.fn(),
    getSnapshot: vi.fn(() => ({
      initialized: true,
      readOnly: false,
      projects: [] as unknown[],
      sessions: [] as unknown[],
      warnings: [] as string[],
      activeRun: null,
      queuedRuns: [] as unknown[],
    })),
    emitChange: () => {
      for (const listener of listeners.change ?? []) {
        listener(new Event('change'));
      }
    },
  };
});

vi.mock('../../src/sync/sync-manager', () => ({ syncManager: mockSyncManager }));

vi.mock('../../src/sync/credential-crypto', () => ({
  isUnlocked: vi.fn(() => false),
  createPasskey: vi.fn(),
  forgetPasskey: vi.fn(),
  unlock: vi.fn(),
  lock: vi.fn(),
  encryptField: vi.fn(),
  decryptField: vi.fn(),
  isWebAuthnPrfSupported: vi.fn().mockResolvedValue(false),
  hasDeviceUnlockCredential: vi.fn().mockResolvedValue(false),
  createWebAuthnCredentialAndWrapKey: vi.fn().mockResolvedValue(false),
  unlockWithWebAuthnDevice: vi.fn().mockResolvedValue(false),
}));

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

afterEach(() => {
  document.body.innerHTML = '';
});

beforeEach(() => {
  vi.clearAllMocks();
  mockDbClient.ensureReady.mockResolvedValue('memory');
  mockDbClient.getConnections.mockResolvedValue([]);
  mockDbClient.getPasskeyState.mockResolvedValue(null);
  mockDbClient.getS3Credentials.mockResolvedValue(null);
  mockDbClient.createConnection.mockResolvedValue(undefined);
  mockDbClient.updateConnection.mockResolvedValue(undefined);
  mockDbClient.saveS3Credentials.mockResolvedValue(undefined);
  mockDbClient.deleteConnection.mockResolvedValue(undefined);
  mockSyncManager.getSnapshot.mockReturnValue({
    initialized: true,
    readOnly: false,
    projects: [],
    sessions: [],
    warnings: [],
    activeRun: null,
    queuedRuns: [],
  });
});

describe('app-root', () => {
  it('renders the sync progress slot before the storage badge', async () => {
    const app = await mount(document.createElement('app-root') as AppRoot);
    await flush(app);

    const root = app.shadowRoot as ShadowRoot;
    const headerRight = root.querySelector('.header-right');
    const progress = root.querySelector('sync-progress-bar');
    const badge = root.querySelector('.storage-badge');

    expect(headerRight).not.toBeNull();
    expect(progress).not.toBeNull();
    expect(badge).not.toBeNull();

    const children = Array.from(headerRight?.children ?? []);
    const progressIndex = children.indexOf(progress as HTMLElement);
    const badgeIndex = children.indexOf(badge as HTMLElement);
    expect(progressIndex).toBeLessThan(badgeIndex);
  });

  it('refreshes security state when the connect modal closes', async () => {
    const getConnections = vi.fn().mockResolvedValue([savedConnection]);
    mockDbClient.getConnections = getConnections;

    const app = await mount(document.createElement('app-root') as AppRoot);
    await flush(app);

    expect(getConnections).toHaveBeenCalledTimes(1);

    (app as unknown as { handleConnectClose: () => void }).handleConnectClose();
    await flush(app);

    expect(getConnections).toHaveBeenCalledTimes(2);
  });
});
