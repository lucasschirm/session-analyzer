import type { LitElement } from 'lit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../../src/pages/app-root';
import { analyticsClient } from '../../src/db/analytics-client';
import type { AppRoot } from '../../src/pages/app-root';

const mockDbClient = vi.hoisted(() => ({
  ensureReady: vi.fn(),
  getConnections: vi.fn(),
  getPasskeyState: vi.fn(),
  getS3Credentials: vi.fn(),
  createConnection: vi.fn(),
  updateConnection: vi.fn(),
  saveS3Credentials: vi.fn(),
  deleteConnection: vi.fn(),
  getProjects: vi.fn(),
  getProjectByReadableId: vi.fn(),
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
      lastCompletedAt: null as number | null,
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
  window.location.hash = '';
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
  mockDbClient.getProjects.mockResolvedValue([]);
  mockDbClient.getProjectByReadableId.mockResolvedValue(null);
  mockSyncManager.getSnapshot.mockReturnValue({
    initialized: true,
    readOnly: false,
    projects: [],
    sessions: [],
    warnings: [],
    activeRun: null,
    queuedRuns: [],
    lastCompletedAt: null,
  });
});

describe('app-root', () => {
  it('renders the SAL logo and header navigation', async () => {
    const app = await mount(document.createElement('app-root') as AppRoot);
    await flush(app);

    const root = app.shadowRoot as ShadowRoot;
    const logo = root.querySelector('.logo');
    expect(logo).not.toBeNull();
    expect(logo?.textContent).toBe('SAL');

    const navLinks = root.querySelectorAll('nav.header-nav a');
    expect(navLinks.length).toBe(2);
    const labels = Array.from(navLinks).map((a) => a.textContent);
    expect(labels).toContain('Dashboard');
    expect(labels).toContain('Artifacts');
  });

  it('renders the settings cog button', async () => {
    const app = await mount(document.createElement('app-root') as AppRoot);
    await flush(app);

    const root = app.shadowRoot as ShadowRoot;
    const settingsButton = root.querySelector('.settings-button');
    expect(settingsButton).not.toBeNull();
    expect(settingsButton?.getAttribute('aria-label')).toBe('Settings');
  });

  it('renders the sync progress bar as always-mounted global chrome, not in the header', async () => {
    // Issue #165: sync-progress-bar must stay always-mounted across run
    // transitions, so it moved out of the header into app-root's global
    // chrome (beside sync-status-bar) where later per-route header
    // removals cannot unmount it or hide live sync progress.
    const app = await mount(document.createElement('app-root') as AppRoot);
    await flush(app);

    const root = app.shadowRoot as ShadowRoot;
    const headerRight = root.querySelector('.header-right');
    const syncChrome = root.querySelector('.sync-chrome');
    const progress = root.querySelector('sync-progress-bar');

    expect(headerRight).not.toBeNull();
    expect(syncChrome).not.toBeNull();
    expect(progress).not.toBeNull();
    expect(headerRight?.contains(progress)).toBe(false);
    expect(syncChrome?.contains(progress)).toBe(true);
  });

  it('does not render the old storage badge or connect button', async () => {
    const app = await mount(document.createElement('app-root') as AppRoot);
    await flush(app);

    const root = app.shadowRoot as ShadowRoot;
    expect(root.querySelector('.storage-badge')).toBeNull();
    expect(root.querySelector('connect-modal')).toBeNull();
  });

  it('renders a passkey modal for sync-triggered vault unlocks', async () => {
    const app = await mount(document.createElement('app-root') as AppRoot);
    await flush(app);

    const root = app.shadowRoot as ShadowRoot;
    const modal = root.querySelector('passkey-modal');
    expect(modal).not.toBeNull();
    // The modal must start closed so it doesn't block the UI on load.
    expect((modal as HTMLElement & { open: boolean }).open).toBe(false);
  });

  it('renders the icon rail on the dashboard route', async () => {
    window.location.hash = '#/';
    const app = await mount(document.createElement('app-root') as AppRoot);
    await flush(app);

    const root = app.shadowRoot as ShadowRoot;
    expect(root.querySelector('icon-rail')).not.toBeNull();
  });

  it('renders the icon rail on settings routes', async () => {
    window.location.hash = '#/settings/data-sources';
    const app = await mount(document.createElement('app-root') as AppRoot);
    await flush(app);

    const root = app.shadowRoot as ShadowRoot;
    expect(root.querySelector('icon-rail')).not.toBeNull();
  });

  it('renders the icon rail as global chrome on routes with no active rail item', async () => {
    // The rail is always mounted, even on routes (like session evidence)
    // that have no matching destination — it just shows no active item.
    window.location.hash = '#/sessions/s1';
    const app = await mount(document.createElement('app-root') as AppRoot);
    await flush(app);

    const root = app.shadowRoot as ShadowRoot;
    expect(root.querySelector('icon-rail')).not.toBeNull();
  });

  it('reprocess overlay shows an error and Close button when reprocess-completed fires ok:false', async () => {
    const app = await mount(document.createElement('app-root') as AppRoot);
    await flush(app);

    // Start reprocessing — overlay appears.
    analyticsClient.dispatchEvent(
      new CustomEvent('reprocess-started', { detail: { reason: 'Test reprocess' } }),
    );
    await flush(app);

    const root = app.shadowRoot as ShadowRoot;
    const overlay = root.querySelector('.reprocess-overlay');
    expect(overlay).not.toBeNull();

    // Complete with failure — error message + Close button appear.
    analyticsClient.dispatchEvent(
      new CustomEvent('reprocess-completed', {
        detail: { ok: false, error: 'Simulated reprocess failure' },
      }),
    );
    await flush(app);

    const errorEl = root.querySelector('.reprocess-error');
    expect(errorEl).not.toBeNull();
    expect(errorEl?.textContent).toContain('Simulated reprocess failure');

    const closeButton = root.querySelector<HTMLButtonElement>('.reprocess-overlay button');
    expect(closeButton).not.toBeNull();
    expect(closeButton?.textContent).toBe('Close');

    // Clicking Close dismisses the overlay.
    closeButton?.click();
    await flush(app);
    expect(root.querySelector('.reprocess-overlay')).toBeNull();
  });
});
