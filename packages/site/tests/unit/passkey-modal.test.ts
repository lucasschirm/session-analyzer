import type { LitElement } from 'lit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PasskeyModal } from '../../src/components/passkey-modal';
import '../../src/components/passkey-modal';
import { createPasskey, forgetPasskey, unlock } from '../../src/sync/credential-crypto';

vi.mock('../../src/sync/credential-crypto', () => ({
  createPasskey: vi.fn(),
  unlock: vi.fn(),
  forgetPasskey: vi.fn(),
  isUnlocked: vi.fn(),
  lock: vi.fn(),
  encryptField: vi.fn(),
  decryptField: vi.fn(),
}));

async function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function mount<T extends LitElement>(element: T): Promise<T> {
  document.body.appendChild(element);
  await element.updateComplete;
  return element;
}

function shadow(element: LitElement): ShadowRoot {
  expect(element.shadowRoot).not.toBeNull();
  return element.shadowRoot as ShadowRoot;
}

function fillInput(root: ShadowRoot, id: string, value: string): void {
  const input = root.querySelector(id) as HTMLInputElement;
  input.value = value;
  input.dispatchEvent(new Event('input'));
}

afterEach(() => {
  document.body.innerHTML = '';
});

beforeEach(() => {
  vi.mocked(createPasskey).mockResolvedValue(undefined);
  vi.mocked(unlock).mockResolvedValue(false);
  vi.mocked(forgetPasskey).mockResolvedValue(undefined);
});

describe('passkey-modal', () => {
  it('renders nothing while closed', async () => {
    const modal = await mount(document.createElement('passkey-modal') as PasskeyModal);
    expect(shadow(modal).querySelector('.passkey-modal')).toBeNull();
  });

  it('create mode shows a too-short inline error', async () => {
    const modal = await mount(
      Object.assign(document.createElement('passkey-modal'), {
        open: true,
        mode: 'create',
      }) as PasskeyModal,
    );
    const root = shadow(modal);

    fillInput(root, '#passkey-input', 'short');
    fillInput(root, '#confirm-passkey-input', 'short');
    await modal.updateComplete;

    root.querySelector('form')?.dispatchEvent(new Event('submit', { cancelable: true }));
    await modal.updateComplete;

    expect(root.textContent).toContain('at least 8');
    expect(createPasskey).not.toHaveBeenCalled();
  });

  it('create mode shows a mismatch inline error', async () => {
    const modal = await mount(
      Object.assign(document.createElement('passkey-modal'), {
        open: true,
        mode: 'create',
      }) as PasskeyModal,
    );
    const root = shadow(modal);

    fillInput(root, '#passkey-input', 'longenough');
    fillInput(root, '#confirm-passkey-input', 'different');
    await modal.updateComplete;

    root.querySelector('form')?.dispatchEvent(new Event('submit', { cancelable: true }));
    await modal.updateComplete;

    expect(root.textContent).toContain('do not match');
    expect(createPasskey).not.toHaveBeenCalled();
  });

  it('create mode calls createPasskey and emits passkey-created on success', async () => {
    const modal = await mount(
      Object.assign(document.createElement('passkey-modal'), {
        open: true,
        mode: 'create',
      }) as PasskeyModal,
    );
    const root = shadow(modal);

    fillInput(root, '#passkey-input', 'longenough1');
    fillInput(root, '#confirm-passkey-input', 'longenough1');
    await modal.updateComplete;

    let created = false;
    modal.addEventListener('passkey-created', () => {
      created = true;
    });

    root.querySelector('form')?.dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    await modal.updateComplete;

    expect(created).toBe(true);
    expect(createPasskey).toHaveBeenCalledWith('longenough1');
  });

  it('unlock mode shows an incorrect passkey inline error', async () => {
    vi.mocked(unlock).mockResolvedValueOnce(false);

    const modal = await mount(
      Object.assign(document.createElement('passkey-modal'), {
        open: true,
        mode: 'unlock',
      }) as PasskeyModal,
    );
    const root = shadow(modal);

    fillInput(root, '#passkey-input', 'wrong');
    await modal.updateComplete;

    root.querySelector('form')?.dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    await modal.updateComplete;

    expect(root.textContent).toContain('Incorrect passkey');
    expect(unlock).toHaveBeenCalledWith('wrong');
  });

  it('unlock mode emits passkey-unlocked on success', async () => {
    vi.mocked(unlock).mockResolvedValueOnce(true);

    const modal = await mount(
      Object.assign(document.createElement('passkey-modal'), {
        open: true,
        mode: 'unlock',
      }) as PasskeyModal,
    );
    const root = shadow(modal);

    fillInput(root, '#passkey-input', 'correct');
    await modal.updateComplete;

    let unlocked = false;
    modal.addEventListener('passkey-unlocked', () => {
      unlocked = true;
    });

    root.querySelector('form')?.dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    await modal.updateComplete;

    expect(unlocked).toBe(true);
    expect(unlock).toHaveBeenCalledWith('correct');
  });

  it('switches to forgot mode from the unlock view', async () => {
    const modal = await mount(
      Object.assign(document.createElement('passkey-modal'), {
        open: true,
        mode: 'unlock',
      }) as PasskeyModal,
    );
    const root = shadow(modal);

    (root.querySelector('.link') as HTMLButtonElement).click();
    await flush();
    await modal.updateComplete;

    expect(modal.mode).toBe('forgot');
    expect(root.textContent).toContain('Delete all saved secrets');
  });

  it('forgot mode calls forgetPasskey and emits passkey-forgotten', async () => {
    const modal = await mount(
      Object.assign(document.createElement('passkey-modal'), {
        open: true,
        mode: 'forgot',
      }) as PasskeyModal,
    );
    const root = shadow(modal);

    let forgotten = false;
    modal.addEventListener('passkey-forgotten', () => {
      forgotten = true;
    });

    (root.querySelector('.danger') as HTMLButtonElement).click();
    await flush();
    await modal.updateComplete;

    expect(forgotten).toBe(true);
    expect(forgetPasskey).toHaveBeenCalled();
  });

  it('emits modal-close on cancel, overlay click, and Escape', async () => {
    const modal = await mount(
      Object.assign(document.createElement('passkey-modal'), {
        open: true,
        mode: 'create',
      }) as PasskeyModal,
    );
    const root = shadow(modal);

    let closed = 0;
    modal.addEventListener('modal-close', () => closed++);

    (root.querySelector('button.secondary') as HTMLButtonElement).click();
    expect(closed).toBe(1);

    const overlay = root.querySelector('.passkey-modal') as HTMLDivElement;
    overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(closed).toBe(2);

    overlay.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(closed).toBe(3);
  });
});
