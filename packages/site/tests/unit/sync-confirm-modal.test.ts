import type { LitElement } from 'lit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SyncConfirmModal } from '../../src/components/sync-confirm-modal';
import '../../src/components/sync-confirm-modal';

const mockNavigateTo = vi.fn();
vi.mock('../../src/router', () => ({
  navigateTo: (path: string) => mockNavigateTo(path),
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
  localStorage.clear();
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('sync-confirm-modal', () => {
  it('renders correctly when open', async () => {
    const modal = await mount(
      Object.assign(document.createElement('sync-confirm-modal'), {
        open: true,
        connectionId: 'conn-1',
        connectionName: 'My S3 Storage',
      }) as SyncConfirmModal,
    );
    await flush(modal);
    const root = shadow(modal);

    expect(root.textContent).toContain('Sync My S3 Storage');
    expect(root.textContent).toContain('Sync only new sessions');
    expect(root.textContent).toContain('Cherry pick');
    expect(root.textContent).toContain('Start Sync');
    expect(root.textContent).toContain('Cancel');
  });

  it('clicking Cherry pick emits cherry-pick event and navigates to storage sessions page', async () => {
    const modal = await mount(
      Object.assign(document.createElement('sync-confirm-modal'), {
        open: true,
        connectionId: 'conn-test-123',
        connectionName: 'Production S3',
      }) as SyncConfirmModal,
    );
    await flush(modal);
    const root = shadow(modal);

    let cherryPickDetail: { connectionId: string } | null = null;
    modal.addEventListener('cherry-pick', (e) => {
      cherryPickDetail = (e as CustomEvent<{ connectionId: string }>).detail;
    });

    clickButtonByText(root, 'Cherry pick');
    await flush(modal);

    expect(cherryPickDetail).toEqual({ connectionId: 'conn-test-123' });
    expect(mockNavigateTo).toHaveBeenCalledWith('/storage/conn-test-123/sessions');
  });

  it('clicking Start Sync emits sync-confirmed', async () => {
    const modal = await mount(
      Object.assign(document.createElement('sync-confirm-modal'), {
        open: true,
        connectionId: 'conn-2',
        connectionName: 'Staging S3',
      }) as SyncConfirmModal,
    );
    await flush(modal);
    const root = shadow(modal);

    let confirmedDetail: { connectionId: string; syncOnlyNew: boolean } | null = null;
    modal.addEventListener('sync-confirmed', (e) => {
      confirmedDetail = (e as CustomEvent<{ connectionId: string; syncOnlyNew: boolean }>).detail;
    });

    clickButtonByText(root, 'Start Sync');
    await flush(modal);

    expect(confirmedDetail).toEqual({ connectionId: 'conn-2', syncOnlyNew: false });
  });

  it('clicking Cancel emits modal-close', async () => {
    const modal = await mount(
      Object.assign(document.createElement('sync-confirm-modal'), {
        open: true,
        connectionId: 'conn-3',
        connectionName: 'Backup S3',
      }) as SyncConfirmModal,
    );
    await flush(modal);
    const root = shadow(modal);

    let closed = false;
    modal.addEventListener('modal-close', () => {
      closed = true;
    });

    clickButtonByText(root, 'Cancel');
    await flush(modal);

    expect(closed).toBe(true);
  });
});
