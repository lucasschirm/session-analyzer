import type { LitElement } from 'lit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeleteConfirmationModal } from '../../src/components/delete-confirmation-modal';
import '../../src/components/delete-confirmation-modal';

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
});

describe('delete-confirmation-modal', () => {
  it('renders nothing while closed', async () => {
    const modal = await mount(
      document.createElement('delete-confirmation-modal') as DeleteConfirmationModal,
    );
    expect(shadow(modal).querySelector('.delete-confirmation-modal')).toBeNull();
  });

  it('renders the title and message when open', async () => {
    const modal = await mount(
      Object.assign(document.createElement('delete-confirmation-modal'), {
        open: true,
        titleText: 'Delete project?',
        message: 'Delete project "Demo"? All of its sessions will be removed as well.',
      }) as DeleteConfirmationModal,
    );
    const root = shadow(modal);

    expect(root.textContent).toContain('Delete project?');
    expect(root.textContent).toContain('Delete project "Demo"?');
    expect(root.textContent).toContain('Cancel');
    expect(root.textContent).toContain('Delete');
  });

  it('dispatches delete-confirmed when the confirm button is clicked', async () => {
    const modal = await mount(
      Object.assign(document.createElement('delete-confirmation-modal'), {
        open: true,
      }) as DeleteConfirmationModal,
    );
    const root = shadow(modal);

    let confirmed = false;
    let closed = 0;
    modal.addEventListener('delete-confirmed', () => {
      confirmed = true;
    });
    modal.addEventListener('modal-close', () => {
      closed++;
    });

    clickButtonByText(root, 'Delete');
    await flush(modal);

    expect(confirmed).toBe(true);
    expect(closed).toBe(0);
  });

  it('dispatches modal-close and not delete-confirmed when canceled', async () => {
    const modal = await mount(
      Object.assign(document.createElement('delete-confirmation-modal'), {
        open: true,
      }) as DeleteConfirmationModal,
    );
    const root = shadow(modal);

    let confirmed = false;
    let closed = 0;
    modal.addEventListener('delete-confirmed', () => {
      confirmed = true;
    });
    modal.addEventListener('modal-close', () => {
      closed++;
    });

    clickButtonByText(root, 'Cancel');
    await flush(modal);

    expect(confirmed).toBe(false);
    expect(closed).toBe(1);
  });

  it('dispatches modal-close and not delete-confirmed on Escape', async () => {
    const modal = await mount(
      Object.assign(document.createElement('delete-confirmation-modal'), {
        open: true,
      }) as DeleteConfirmationModal,
    );
    const root = shadow(modal);

    let confirmed = false;
    let closed = 0;
    modal.addEventListener('delete-confirmed', () => {
      confirmed = true;
    });
    modal.addEventListener('modal-close', () => {
      closed++;
    });

    const overlay = root.querySelector('.delete-confirmation-modal') as HTMLDivElement;
    overlay.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flush(modal);

    expect(confirmed).toBe(false);
    expect(closed).toBe(1);
  });

  it('dispatches modal-close and not delete-confirmed on overlay click', async () => {
    const modal = await mount(
      Object.assign(document.createElement('delete-confirmation-modal'), {
        open: true,
      }) as DeleteConfirmationModal,
    );
    const root = shadow(modal);

    let confirmed = false;
    let closed = 0;
    modal.addEventListener('delete-confirmed', () => {
      confirmed = true;
    });
    modal.addEventListener('modal-close', () => {
      closed++;
    });

    const overlay = root.querySelector('.delete-confirmation-modal') as HTMLDivElement;
    overlay.click();
    await flush(modal);

    expect(confirmed).toBe(false);
    expect(closed).toBe(1);
  });

  it('moves focus to the first focusable element when opened', async () => {
    const trigger = document.createElement('button');
    trigger.textContent = 'Open';
    document.body.appendChild(trigger);
    trigger.focus();

    const modal = await mount(
      Object.assign(document.createElement('delete-confirmation-modal'), {
        open: true,
        trigger,
      }) as DeleteConfirmationModal,
    );
    await flush(modal);

    const root = shadow(modal);
    const cancel = root.querySelector('button.secondary') as HTMLButtonElement;
    expect(root.activeElement).toBe(cancel);
  });

  it('returns focus to the trigger element when closed', async () => {
    const trigger = document.createElement('button');
    trigger.textContent = 'Open';
    document.body.appendChild(trigger);
    trigger.focus();

    const modal = await mount(
      Object.assign(document.createElement('delete-confirmation-modal'), {
        open: true,
        trigger,
      }) as DeleteConfirmationModal,
    );
    await flush(modal);

    modal.open = false;
    await flush(modal);

    expect(document.activeElement).toBe(trigger);
  });

  it('traps Tab focus within the dialog', async () => {
    const modal = await mount(
      Object.assign(document.createElement('delete-confirmation-modal'), {
        open: true,
      }) as DeleteConfirmationModal,
    );
    const root = shadow(modal);
    const overlay = root.querySelector('.delete-confirmation-modal') as HTMLDivElement;
    const cancel = root.querySelector('button.secondary') as HTMLButtonElement;
    const confirm = root.querySelector('button.danger') as HTMLButtonElement;

    await flush(modal);
    expect(root.activeElement).toBe(cancel);

    overlay.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    await flush(modal);
    expect(root.activeElement).toBe(confirm);

    overlay.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    await flush(modal);
    expect(root.activeElement).toBe(cancel);

    overlay.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }),
    );
    await flush(modal);
    expect(root.activeElement).toBe(confirm);
  });
});
