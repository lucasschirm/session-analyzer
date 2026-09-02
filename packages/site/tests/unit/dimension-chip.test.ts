import type { LitElement } from 'lit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../../src/components/analytics/dimension-chip';
import type { DimensionChip } from '../../src/components/analytics/dimension-chip';

async function mount<T extends LitElement>(element: T): Promise<T> {
  document.body.appendChild(element);
  await element.updateComplete;
  return element;
}

function shadow(element: LitElement): ShadowRoot {
  expect(element.shadowRoot).not.toBeNull();
  return element.shadowRoot as ShadowRoot;
}

describe('dimension-chip', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('lists the given options plus an All option', async () => {
    const el = document.createElement('dimension-chip') as DimensionChip;
    el.label = 'Harness';
    el.options = ['claude', 'codex'];
    await mount(el);

    const select = shadow(el).querySelector('select') as HTMLSelectElement;
    const values = Array.from(select.options).map((o) => o.value);
    expect(values).toEqual(['', 'claude', 'codex']);
  });

  it('lists an option even with zero sessions, since it derives from the domain not the filtered result', async () => {
    const el = document.createElement('dimension-chip') as DimensionChip;
    el.label = 'Harness';
    el.options = ['claude', 'zero-session-harness'];
    await mount(el);

    const select = shadow(el).querySelector('select') as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.value)).toContain('zero-session-harness');
  });

  it('emits value-changed on selection without mutating options', async () => {
    const el = document.createElement('dimension-chip') as DimensionChip;
    el.label = 'Model';
    const options = ['sonnet', 'opus'];
    el.options = options;
    await mount(el);

    const listener = vi.fn();
    el.addEventListener('value-changed', listener);
    const select = shadow(el).querySelector('select') as HTMLSelectElement;
    select.value = 'opus';
    select.dispatchEvent(new Event('change', { bubbles: true }));

    expect(listener).toHaveBeenCalledTimes(1);
    expect((listener.mock.calls[0][0] as CustomEvent).detail).toBe('opus');
    expect(el.options).toBe(options);
    expect(options).toEqual(['sonnet', 'opus']);
  });

  it('renders a locked, non-interactive chip in fixed mode', async () => {
    const el = document.createElement('dimension-chip') as DimensionChip;
    el.label = 'Project';
    el.value = 'my-project';
    el.fixed = true;
    await mount(el);

    expect(shadow(el).querySelector('select')).toBeNull();
    expect(shadow(el).querySelector('.fixed-chip')?.textContent).toContain('my-project');
  });
});
