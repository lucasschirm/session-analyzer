import type { LitElement } from 'lit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../../src/components/toast-container';
import type { ToastContainer } from '../../src/components/toast-container';
import { ToastManager, toastManager } from '../../src/components/toast-container';

async function mount<T extends LitElement>(element: T): Promise<T> {
  document.body.appendChild(element);
  await element.updateComplete;
  return element;
}

function shadow(element: LitElement): ShadowRoot {
  expect(element.shadowRoot).not.toBeNull();
  return element.shadowRoot as ShadowRoot;
}

describe('ToastManager', () => {
  let manager: ToastManager;

  beforeEach(() => {
    manager = new ToastManager();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates an error toast that is sticky by default', () => {
    const id = manager.error('Something went wrong', { message: 'details' });
    const toasts = manager.getToasts();
    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.id).toBe(id);
    expect(toasts[0]?.type).toBe('error');
    expect(toasts[0]?.title).toBe('Something went wrong');
    expect(toasts[0]?.message).toBe('details');
    expect(toasts[0]?.autoDismissMs).toBe(0);
  });

  it('creates a warning toast that auto-dismisses', () => {
    vi.useFakeTimers();
    manager.warning('Heads up');
    expect(manager.getToasts()).toHaveLength(1);
    vi.advanceTimersByTime(8_000);
    expect(manager.getToasts()).toHaveLength(0);
  });

  it('creates a success toast that auto-dismisses quickly', () => {
    vi.useFakeTimers();
    manager.success('Done');
    expect(manager.getToasts()).toHaveLength(1);
    vi.advanceTimersByTime(4_000);
    expect(manager.getToasts()).toHaveLength(0);
  });

  it('dismisses a toast by id', () => {
    const id = manager.error('Error');
    expect(manager.getToasts()).toHaveLength(1);
    manager.dismiss(id);
    expect(manager.getToasts()).toHaveLength(0);
  });

  it('clears all toasts', () => {
    manager.error('A');
    manager.warning('B');
    manager.info('C');
    expect(manager.getToasts()).toHaveLength(3);
    manager.clear();
    expect(manager.getToasts()).toHaveLength(0);
  });

  it('limits the stack to 5 toasts', () => {
    for (let i = 0; i < 7; i++) manager.error(`Error ${i}`);
    expect(manager.getToasts()).toHaveLength(5);
  });

  it('fires a change event when a toast is added', () => {
    const listener = vi.fn();
    manager.addEventListener('change', listener);
    manager.error('Test');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('fires a change event when a toast is dismissed', () => {
    const listener = vi.fn();
    manager.addEventListener('change', listener);
    const id = manager.error('Test');
    listener.mockClear();
    manager.dismiss(id);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('respects a custom autoDismissMs override', () => {
    vi.useFakeTimers();
    manager.error('Sticky normally', { autoDismissMs: 1_000 });
    expect(manager.getToasts()).toHaveLength(1);
    vi.advanceTimersByTime(1_000);
    expect(manager.getToasts()).toHaveLength(0);
  });
});

describe('toast-container', () => {
  beforeEach(() => {
    toastManager.clear();
  });

  afterEach(() => {
    toastManager.clear();
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  it('renders nothing when there are no toasts', async () => {
    const el = document.createElement('toast-container') as ToastContainer;
    await mount(el);
    expect(shadow(el).querySelector('.toast-stack')).toBeNull();
  });

  it('renders an error toast with title, message, and hint', async () => {
    toastManager.error('Sync failed', {
      message: 'HTTP 404 • NoSuchKey • Key not found',
      hint: 'The requested object does not exist in the bucket.',
    });
    const el = document.createElement('toast-container') as ToastContainer;
    await mount(el);

    const toast = shadow(el).querySelector('.toast.error');
    expect(toast).not.toBeNull();
    expect(toast?.textContent).toContain('Sync failed');
    expect(toast?.textContent).toContain('HTTP 404');
    expect(toast?.textContent).toContain('NoSuchKey');
    expect(toast?.textContent).toContain('Hint:');
    expect(toast?.textContent).toContain('does not exist');
  });

  it('renders a link when provided', async () => {
    toastManager.error('CORS error', {
      message: 'Failed to fetch',
      hint: 'Check CORS config.',
      link: 'https://example.com/docs',
      linkLabel: 'CORS docs',
    });
    const el = document.createElement('toast-container') as ToastContainer;
    await mount(el);

    const link = shadow(el).querySelector('.toast-link');
    expect(link).not.toBeNull();
    expect(link?.getAttribute('href')).toBe('https://example.com/docs');
    expect(link?.textContent).toContain('CORS docs');
  });

  it('dismisses a toast when the close button is clicked', async () => {
    toastManager.error('Dismiss me');
    const el = document.createElement('toast-container') as ToastContainer;
    await mount(el);

    expect(toastManager.getToasts()).toHaveLength(1);
    shadow(el)
      .querySelector('.toast-close')
      ?.dispatchEvent(new Event('click', { bubbles: true }));
    expect(toastManager.getToasts()).toHaveLength(0);
  });

  it('dismisses a toast when the toast body is clicked', async () => {
    toastManager.info('Click to dismiss');
    const el = document.createElement('toast-container') as ToastContainer;
    await mount(el);

    expect(toastManager.getToasts()).toHaveLength(1);
    shadow(el)
      .querySelector('.toast')
      ?.dispatchEvent(new Event('click', { bubbles: true }));
    expect(toastManager.getToasts()).toHaveLength(0);
  });

  it('updates when a new toast is added after mount', async () => {
    const el = document.createElement('toast-container') as ToastContainer;
    await mount(el);
    expect(shadow(el).querySelector('.toast-stack')).toBeNull();

    toastManager.warning('New warning');
    await el.updateComplete;

    const stack = shadow(el).querySelector('.toast-stack');
    expect(stack).not.toBeNull();
    expect(stack?.textContent).toContain('New warning');
  });

  it('renders a warning toast with the warning class', async () => {
    toastManager.warning('Careful', { message: 'Something risky' });
    const el = document.createElement('toast-container') as ToastContainer;
    await mount(el);

    const toast = shadow(el).querySelector('.toast.warning');
    expect(toast).not.toBeNull();
    expect(toast?.textContent).toContain('Careful');
    expect(toast?.textContent).toContain('Something risky');
  });

  it('renders an info toast with the info class', async () => {
    toastManager.info('FYI', { message: 'For your information' });
    const el = document.createElement('toast-container') as ToastContainer;
    await mount(el);

    const toast = shadow(el).querySelector('.toast.info');
    expect(toast).not.toBeNull();
    expect(toast?.textContent).toContain('FYI');
  });

  it('renders a success toast with the success class', async () => {
    toastManager.success('All good');
    const el = document.createElement('toast-container') as ToastContainer;
    await mount(el);

    const toast = shadow(el).querySelector('.toast.success');
    expect(toast).not.toBeNull();
    expect(toast?.textContent).toContain('All good');
  });

  it('renders multiple toasts in the stack (newest first)', async () => {
    toastManager.error('First error');
    toastManager.warning('Second warning');
    toastManager.info('Third info');
    const el = document.createElement('toast-container') as ToastContainer;
    await mount(el);

    const toasts = shadow(el).querySelectorAll('.toast');
    expect(toasts).toHaveLength(3);
    // Newest first (unshift)
    expect(toasts[0]?.classList.contains('info')).toBe(true);
    expect(toasts[1]?.classList.contains('warning')).toBe(true);
    expect(toasts[2]?.classList.contains('error')).toBe(true);
  });

  it('does not dismiss a toast when a link inside it is clicked', async () => {
    toastManager.error('Has link', { link: 'https://example.com', linkLabel: 'Docs' });
    const el = document.createElement('toast-container') as ToastContainer;
    await mount(el);

    expect(toastManager.getToasts()).toHaveLength(1);
    shadow(el)
      .querySelector('.toast-link')
      ?.dispatchEvent(new Event('click', { bubbles: true }));
    expect(toastManager.getToasts()).toHaveLength(1);
  });

  it('auto-dismisses a warning toast after the default delay', async () => {
    vi.useFakeTimers();
    toastManager.warning('Temporary');
    expect(toastManager.getToasts()).toHaveLength(1);
    vi.advanceTimersByTime(8_000);
    expect(toastManager.getToasts()).toHaveLength(0);
  });

  it('auto-dismisses an info toast after the default delay', async () => {
    vi.useFakeTimers();
    toastManager.info('Temporary info');
    expect(toastManager.getToasts()).toHaveLength(1);
    vi.advanceTimersByTime(6_000);
    expect(toastManager.getToasts()).toHaveLength(0);
  });

  it('does not auto-dismiss an error toast (sticky)', async () => {
    vi.useFakeTimers();
    toastManager.error('Sticky error');
    vi.advanceTimersByTime(60_000);
    expect(toastManager.getToasts()).toHaveLength(1);
  });

  it('clears the timer when a toast is dismissed before auto-dismiss', async () => {
    vi.useFakeTimers();
    const id = toastManager.warning('Will be dismissed early');
    toastManager.dismiss(id);
    expect(toastManager.getToasts()).toHaveLength(0);
    // Advancing time should not cause errors
    vi.advanceTimersByTime(10_000);
    expect(toastManager.getToasts()).toHaveLength(0);
  });

  it('prunes oldest toasts when exceeding the max stack size', () => {
    for (let i = 0; i < 7; i++) toastManager.error(`Error ${i}`);
    const toasts = toastManager.getToasts();
    expect(toasts).toHaveLength(5);
    // Newest first — Error 6 is first, Error 2 is last (Error 0 and 1 pruned)
    expect(toasts[0]?.title).toBe('Error 6');
    expect(toasts[4]?.title).toBe('Error 2');
  });

  it('renders a toast with message but no hint or link', async () => {
    toastManager.error('Simple error', { message: 'Just a message' });
    const el = document.createElement('toast-container') as ToastContainer;
    await mount(el);

    const toast = shadow(el).querySelector('.toast.error');
    expect(toast).not.toBeNull();
    expect(toast?.textContent).toContain('Simple error');
    expect(toast?.textContent).toContain('Just a message');
    expect(shadow(el).querySelector('.toast-hint')).toBeNull();
    expect(shadow(el).querySelector('.toast-link')).toBeNull();
  });

  it('renders a toast with only a title (no message, hint, or link)', async () => {
    toastManager.success('Just a title');
    const el = document.createElement('toast-container') as ToastContainer;
    await mount(el);

    const toast = shadow(el).querySelector('.toast.success');
    expect(toast).not.toBeNull();
    expect(toast?.textContent).toContain('Just a title');
    expect(shadow(el).querySelector('.toast-message')).toBeNull();
    expect(shadow(el).querySelector('.toast-hint')).toBeNull();
  });
});
