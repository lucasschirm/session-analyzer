import type { LitElement } from 'lit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../../src/components/passkey-modal';
import '../../src/components/project-sync-indicator';
import '../../src/components/project-sync-status-modal';
import '../../src/components/session-sync-chip';
import '../../src/components/session-sync-error-modal';
import '../../src/components/sync-progress-bar';
import type { PasskeyModal } from '../../src/components/passkey-modal';
import type { ProjectSyncIndicator } from '../../src/components/project-sync-indicator';
import type { ProjectSyncStatusModal } from '../../src/components/project-sync-status-modal';
import type { SessionSyncChip } from '../../src/components/session-sync-chip';
import type { SessionSyncErrorModal } from '../../src/components/session-sync-error-modal';
import type { SyncProgressBar } from '../../src/components/sync-progress-bar';
import { isUnlocked } from '../../src/sync/credential-crypto';
import type { SyncManager, SyncManagerSnapshot } from '../../src/sync/sync-manager';

const credentialCryptoMock = vi.hoisted(() => ({
  isUnlocked: vi.fn(),
  unlock: vi.fn().mockResolvedValue(true),
  lock: vi.fn(),
  createPasskey: vi.fn().mockResolvedValue(undefined),
  forgetPasskey: vi.fn().mockResolvedValue(undefined),
  encryptField: vi.fn().mockResolvedValue({ iv: '', ct: '' }),
  decryptField: vi.fn().mockResolvedValue(''),
  isWebAuthnPrfSupported: vi.fn().mockResolvedValue(false),
  hasDeviceUnlockCredential: vi.fn().mockResolvedValue(false),
  createWebAuthnCredentialAndWrapKey: vi.fn().mockResolvedValue(false),
  unlockWithWebAuthnDevice: vi.fn().mockResolvedValue(false),
}));

vi.mock('../../src/sync/credential-crypto', () => credentialCryptoMock);

afterEach(() => {
  vi.mocked(isUnlocked).mockReturnValue(true);
});

async function mount<T extends LitElement>(element: T): Promise<T> {
  document.body.appendChild(element);
  await element.updateComplete;
  return element;
}

function shadow(element: LitElement): ShadowRoot {
  expect(element.shadowRoot).not.toBeNull();
  return element.shadowRoot as ShadowRoot;
}

afterEach(() => {
  document.body.innerHTML = '';
});

function makeSnapshot(overrides: Record<string, unknown> = {}): SyncManagerSnapshot {
  return {
    initialized: true,
    readOnly: false,
    projects: [],
    sessions: [],
    warnings: [],
    activeRun: null,
    queuedRuns: [],
    ...overrides,
  } as SyncManagerSnapshot;
}

function makeMockSyncManager(snapshot: SyncManagerSnapshot): SyncManager {
  const manager = new EventTarget();
  return Object.assign(manager, {
    getSnapshot: () => snapshot,
    cancel: vi.fn(),
    isReadOnly: false,
    requestRun: vi.fn(),
    retrySession: vi.fn(),
    init: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
  }) as unknown as SyncManager;
}

describe('session-sync-chip', () => {
  it('renders a failed chip as clickable', async () => {
    const chip = document.createElement('session-sync-chip') as SessionSyncChip;
    chip.status = 'failed';
    chip.details = 'MANIFEST_DOWNLOAD_ERROR: missing file';
    await mount(chip);

    const label = shadow(chip).querySelector('.chip');
    expect(label?.textContent).toContain('failed');
    expect(label?.classList.contains('failed')).toBe(true);
    expect(label?.classList.contains('clickable')).toBe(true);
  });

  it('renders an in_sync chip without a click style', async () => {
    const chip = document.createElement('session-sync-chip') as SessionSyncChip;
    chip.status = 'in_sync';
    await mount(chip);

    const label = shadow(chip).querySelector('.chip');
    expect(label?.textContent).toContain('in sync');
    expect(label?.classList.contains('in_sync')).toBe(true);
    expect(label?.classList.contains('clickable')).toBe(false);
  });

  it('renders a pending chip', async () => {
    const chip = document.createElement('session-sync-chip') as SessionSyncChip;
    chip.status = 'pending';
    await mount(chip);

    const label = shadow(chip).querySelector('.chip');
    expect(label?.textContent).toContain('pending');
    expect(label?.classList.contains('pending')).toBe(true);
    expect(label?.classList.contains('clickable')).toBe(false);
  });

  it('renders a processing chip', async () => {
    const chip = document.createElement('session-sync-chip') as SessionSyncChip;
    chip.status = 'processing';
    await mount(chip);

    const label = shadow(chip).querySelector('.chip');
    expect(label?.textContent).toContain('processing');
    expect(label?.classList.contains('processing')).toBe(true);
    expect(label?.classList.contains('clickable')).toBe(false);
  });

  it('renders a transcript_unavailable chip with a tooltip explaining the missing transcript', async () => {
    const chip = document.createElement('session-sync-chip') as SessionSyncChip;
    chip.status = 'transcript_unavailable';
    await mount(chip);

    const label = shadow(chip).querySelector('.chip');
    expect(label?.textContent).toContain('no transcript');
    expect(label?.classList.contains('transcript_unavailable')).toBe(true);
    expect(label?.getAttribute('title')).toContain('No uploaded transcript exists');
    expect(label?.classList.contains('clickable')).toBe(false);
  });

  it('emits chip-click when a failed chip is clicked', async () => {
    const chip = document.createElement('session-sync-chip') as SessionSyncChip;
    chip.status = 'failed';
    await mount(chip);

    const listener = vi.fn();
    chip.addEventListener('chip-click', listener);

    shadow(chip).querySelector('.chip')?.dispatchEvent(new Event('click'));
    expect(listener).toHaveBeenCalled();
  });
});

describe('project-sync-indicator', () => {
  it('emits indicator-click on click', async () => {
    const indicator = document.createElement('project-sync-indicator') as ProjectSyncIndicator;
    await mount(indicator);

    const listener = vi.fn();
    indicator.addEventListener('indicator-click', listener);

    shadow(indicator).querySelector('.indicator')?.dispatchEvent(new Event('click'));
    expect(listener).toHaveBeenCalled();
  });
});

describe('sync-progress-bar', () => {
  it('stays mounted but hidden when there is no active run', async () => {
    const manager = makeMockSyncManager(makeSnapshot());
    const bar = document.createElement('sync-progress-bar') as SyncProgressBar;
    bar.syncManager = manager;
    await mount(bar);

    const root = shadow(bar).querySelector('.progress-bar');
    expect(root).not.toBeNull();
    expect(root?.classList.contains('hidden')).toBe(true);
  });

  it('shows live counts and the queued suffix when a run is active', async () => {
    const manager = makeMockSyncManager(
      makeSnapshot({
        activeRun: { state: 'running' as const },
        queuedRuns: ['queued-run'],
        projects: [
          {
            projectId: 'proj',
            localProjectId: 'p1',
            status: 'running' as const,
            totalSessions: 10,
            sessionsDone: 5,
            filesFound: 100,
            filesDownloaded: 20,
          },
        ],
      }),
    );
    const bar = document.createElement('sync-progress-bar') as SyncProgressBar;
    bar.syncManager = manager;
    await mount(bar);

    const root = shadow(bar).querySelector('.progress-bar');
    expect(root?.classList.contains('hidden')).toBe(false);
    expect(root?.textContent).toContain('Projects 1/1');
    expect(root?.textContent).toContain('Sessions 5/10');
    expect(root?.textContent).toContain('Files 20/100');
    expect(root?.textContent).toContain('1 queued');
  });

  it('keeps the same progress-bar element across a finished-to-active run transition', async () => {
    const manager = makeMockSyncManager(
      makeSnapshot({
        activeRun: { state: 'done' as const },
        queuedRuns: ['next-run'],
        projects: [
          {
            projectId: 'proj',
            localProjectId: 'p1',
            status: 'done' as const,
            totalSessions: 10,
            sessionsDone: 5,
            filesFound: 100,
            filesDownloaded: 20,
          },
        ],
      }),
    );
    const bar = document.createElement('sync-progress-bar') as SyncProgressBar;
    bar.syncManager = manager;
    await mount(bar);

    const first = shadow(bar).querySelector('.progress-bar');
    expect(first).not.toBeNull();
    expect(first?.textContent).toContain('1 queued');

    manager.dispatchEvent(
      new CustomEvent<SyncManagerSnapshot>('change', {
        detail: makeSnapshot({
          activeRun: { state: 'running' as const },
          queuedRuns: [],
          projects: [
            {
              projectId: 'next',
              localProjectId: 'p2',
              status: 'running' as const,
              totalSessions: 20,
              sessionsDone: 10,
              filesFound: 200,
              filesDownloaded: 100,
            },
          ],
        }),
      }),
    );
    await bar.updateComplete;

    const second = shadow(bar).querySelector('.progress-bar');
    expect(second).toBe(first);
    expect(second?.textContent).toContain('Projects 1/1');
    expect(second?.textContent).toContain('Sessions 10/20');
    expect(second?.textContent).toContain('Files 100/200');
    expect(second?.textContent).not.toContain('queued');
  });

  it('calls syncManager.cancel when the cancel button is clicked', async () => {
    const manager = makeMockSyncManager(makeSnapshot({ activeRun: { state: 'running' as const } }));
    const bar = document.createElement('sync-progress-bar') as SyncProgressBar;
    bar.syncManager = manager;
    await mount(bar);

    shadow(bar).querySelector('.cancel-button')?.dispatchEvent(new Event('click'));
    expect(manager.cancel).toHaveBeenCalled();
  });
});

describe('project-sync-status-modal', () => {
  it('filters sessions to the given project', async () => {
    const snapshot = makeSnapshot({
      projects: [
        {
          projectId: 'proj-a',
          localProjectId: 'p1',
          status: 'running' as const,
          totalSessions: 2,
          sessionsDone: 0,
          filesFound: 0,
          filesDownloaded: 0,
        },
      ],
      sessions: [
        {
          projectId: 'proj-a',
          sessionId: 's1',
          status: 'processing',
          filesFound: 10,
          filesDownloaded: 3,
          filesFailed: 0,
        },
        {
          projectId: 'proj-b',
          sessionId: 's2',
          status: 'pending',
          filesFound: 0,
          filesDownloaded: 0,
          filesFailed: 0,
        },
      ],
    });
    const modal = document.createElement('project-sync-status-modal') as ProjectSyncStatusModal;
    modal.open = true;
    modal.projectId = 'proj-a';
    modal.syncManager = makeMockSyncManager(snapshot);
    await mount(modal);

    const items = shadow(modal).querySelectorAll('.session-item');
    expect(items.length).toBe(1);
    expect(items[0]?.textContent).toContain('s1');
  });

  it('dispatches modal-close on overlay click', async () => {
    const modal = document.createElement('project-sync-status-modal') as ProjectSyncStatusModal;
    modal.open = true;
    modal.syncManager = makeMockSyncManager(makeSnapshot());
    await mount(modal);

    const listener = vi.fn();
    modal.addEventListener('modal-close', listener);

    shadow(modal).querySelector('.modal')?.dispatchEvent(new Event('click'));
    expect(listener).toHaveBeenCalled();
  });
});

describe('session-sync-error-modal', () => {
  it('shows retry for a failed session', async () => {
    const manager = makeMockSyncManager(makeSnapshot());
    const modal = document.createElement('session-sync-error-modal') as SessionSyncErrorModal;
    modal.open = true;
    modal.status = 'failed';
    modal.syncDetails = 'MANIFEST_DOWNLOAD_ERROR: missing file';
    modal.syncManager = manager;
    await mount(modal);

    expect(shadow(modal).querySelector('.primary')).not.toBeNull();
    expect(shadow(modal).textContent).toContain('Retry sync');
  });

  it('hides retry for transcript_unavailable', async () => {
    const modal = document.createElement('session-sync-error-modal') as SessionSyncErrorModal;
    modal.open = true;
    modal.status = 'transcript_unavailable';
    modal.syncManager = makeMockSyncManager(makeSnapshot());
    await mount(modal);

    expect(shadow(modal).querySelector('.primary')).toBeNull();
    expect(shadow(modal).textContent).toContain('No transcript');
  });

  it('hides retry for MANIFEST_UNSUPPORTED_SCHEMA', async () => {
    const modal = document.createElement('session-sync-error-modal') as SessionSyncErrorModal;
    modal.open = true;
    modal.status = 'failed';
    modal.syncDetails = 'MANIFEST_UNSUPPORTED_SCHEMA: schema version not supported';
    modal.syncManager = makeMockSyncManager(makeSnapshot());
    await mount(modal);

    expect(shadow(modal).querySelector('.primary')).toBeNull();
  });

  it('opens the passkey modal when retry is clicked while locked and retries after unlock', async () => {
    const manager = makeMockSyncManager(makeSnapshot());
    const modal = document.createElement('session-sync-error-modal') as SessionSyncErrorModal;
    modal.open = true;
    modal.status = 'failed';
    modal.connectionId = 'conn-1';
    modal.projectId = 'proj-1';
    modal.sessionId = 'session-1';
    modal.syncManager = manager;
    vi.mocked(isUnlocked).mockReturnValue(false);
    await mount(modal);

    shadow(modal).querySelector('.primary')?.dispatchEvent(new Event('click'));
    await modal.updateComplete;

    const passkeyModal = shadow(modal).querySelector('passkey-modal') as PasskeyModal | null;
    expect(passkeyModal).not.toBeNull();
    expect(passkeyModal?.open).toBe(true);
    expect(manager.retrySession).not.toHaveBeenCalled();

    vi.mocked(isUnlocked).mockReturnValue(true);
    passkeyModal?.dispatchEvent(
      new CustomEvent('passkey-unlocked', { bubbles: true, composed: true }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(manager.retrySession).toHaveBeenCalledWith('conn-1', 'proj-1', 'session-1');
  });
});
