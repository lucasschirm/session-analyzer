import type { LitElement } from 'lit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../../src/components/analytics/time-range-switch';
import type { TimeRangeSwitch } from '../../src/components/analytics/time-range-switch';

async function mount<T extends LitElement>(element: T): Promise<T> {
  document.body.appendChild(element);
  await element.updateComplete;
  return element;
}

function shadow(element: LitElement): ShadowRoot {
  expect(element.shadowRoot).not.toBeNull();
  return element.shadowRoot as ShadowRoot;
}

function buttons(el: LitElement): HTMLButtonElement[] {
  return Array.from(shadow(el).querySelectorAll('button'));
}

describe('time-range-switch', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('marks the selected segment with aria-selected and tabindex 0', async () => {
    const el = document.createElement('time-range-switch') as TimeRangeSwitch;
    el.selection = '30d';
    await mount(el);

    const selected = buttons(el).find((b) => b.dataset.value === '30d');
    expect(selected?.getAttribute('aria-selected')).toBe('true');
    expect(selected?.tabIndex).toBe(0);

    const others = buttons(el).filter((b) => b.dataset.value !== '30d');
    for (const b of others) {
      expect(b.getAttribute('aria-selected')).toBe('false');
      expect(b.tabIndex).toBe(-1);
    }
  });

  it('emits range-changed with the clicked preset', async () => {
    const el = document.createElement('time-range-switch') as TimeRangeSwitch;
    el.selection = '30d';
    await mount(el);

    const listener = vi.fn();
    el.addEventListener('range-changed', listener);
    buttons(el)
      .find((b) => b.dataset.value === '7d')
      ?.click();

    expect(listener).toHaveBeenCalledTimes(1);
    expect((listener.mock.calls[0][0] as CustomEvent).detail).toBe('7d');
  });

  it('roving tabindex: ArrowRight moves selection to the next segment and emits it', async () => {
    const el = document.createElement('time-range-switch') as TimeRangeSwitch;
    el.selection = '7d';
    await mount(el);

    const listener = vi.fn();
    el.addEventListener('range-changed', listener);
    const current = buttons(el).find((b) => b.dataset.value === '7d') as HTMLButtonElement;
    current.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));

    expect(listener).toHaveBeenCalledTimes(1);
    expect((listener.mock.calls[0][0] as CustomEvent).detail).toBe('30d');
  });

  it('roving tabindex: ArrowLeft wraps from the first segment to the last', async () => {
    const el = document.createElement('time-range-switch') as TimeRangeSwitch;
    el.selection = '7d';
    await mount(el);

    const listener = vi.fn();
    el.addEventListener('range-changed', listener);
    const current = buttons(el).find((b) => b.dataset.value === '7d') as HTMLButtonElement;
    current.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));

    expect((listener.mock.calls[0][0] as CustomEvent).detail).toBe('all');
  });

  it('renders a disabled Custom segment when selection is custom, without emitting a preset', async () => {
    const el = document.createElement('time-range-switch') as TimeRangeSwitch;
    el.selection = 'custom';
    await mount(el);

    const custom = shadow(el).querySelector('button.is-custom') as HTMLButtonElement;
    expect(custom).not.toBeNull();
    expect(custom.disabled).toBe(true);
    expect(custom.getAttribute('aria-selected')).toBe('true');
  });
});
