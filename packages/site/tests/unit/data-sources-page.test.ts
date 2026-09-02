import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../../src/pages/settings/data-sources-page';
import type { DataSourcesPage } from '../../src/pages/settings/data-sources-page';

vi.mock('../../src/db/db-client', () => ({
  dbClient: {
    ensureReady: vi.fn().mockResolvedValue('memory'),
    getConnections: vi.fn().mockResolvedValue([]),
    getPasskeyState: vi.fn().mockResolvedValue(null),
    getS3Credentials: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock('../../src/sync/sync-manager', () => ({
  syncManager: {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    getSnapshot: vi.fn(() => ({
      initialized: true,
      readOnly: false,
      projects: [],
      sessions: [],
      warnings: [],
      activeRun: null,
      queuedRuns: [],
    })),
  },
}));

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

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('data-sources-page', () => {
  it('renders a heading and description', async () => {
    const el = document.createElement('data-sources-page') as DataSourcesPage;
    document.body.appendChild(el);
    await el.updateComplete;
    const root = el.shadowRoot as ShadowRoot;
    expect(root.querySelector('h1')?.textContent).toBe('Data Sources');
    expect(root.textContent).toContain('S3 connections');
  });

  it('embeds the connect-modal in inline mode', async () => {
    const el = document.createElement('data-sources-page') as DataSourcesPage;
    document.body.appendChild(el);
    await el.updateComplete;
    const root = el.shadowRoot as ShadowRoot;
    const modal = root.querySelector('connect-modal');
    expect(modal).not.toBeNull();
    expect(modal?.hasAttribute('inline')).toBe(true);
  });
});
