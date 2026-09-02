import type { LitElement } from 'lit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../../src/components/analytics/filter-bar';
import type { FilterBar } from '../../src/components/analytics/filter-bar';
import type { PortfolioParams } from '../../src/pages/portfolio/portfolio-params';

async function mount<T extends LitElement>(element: T): Promise<T> {
  document.body.appendChild(element);
  await element.updateComplete;
  const children = element.shadowRoot?.querySelectorAll('*') ?? [];
  for (const child of children) {
    const litChild = child as LitElement;
    if (typeof litChild.updateComplete?.then === 'function') {
      await litChild.updateComplete;
    }
  }
  return element;
}

function shadow(element: LitElement): ShadowRoot {
  expect(element.shadowRoot).not.toBeNull();
  return element.shadowRoot as ShadowRoot;
}

describe('filter-bar', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders a wrapper with class matching its tag name (shadow-piercing E2E selector convention)', async () => {
    const el = document.createElement('filter-bar') as FilterBar;
    await mount(el);
    expect(shadow(el).querySelector('.filter-bar')).not.toBeNull();
  });

  it('does not mutate the passed-in filters object when a chip changes', async () => {
    const el = document.createElement('filter-bar') as FilterBar;
    const filters: PortfolioParams = { sessions: 'main' };
    const original = { ...filters };
    el.filters = filters;
    el.harnessOptions = ['claude'];
    await mount(el);

    const listener = vi.fn();
    el.addEventListener('filters-changed', listener);
    const chip = shadow(el).querySelector('dimension-chip[label="Harness"]') as HTMLElement & {
      dispatchEvent: (e: Event) => boolean;
    };
    chip.dispatchEvent(
      new CustomEvent('value-changed', { detail: 'claude', bubbles: true, composed: true }),
    );

    expect(filters).toEqual(original);
    expect(listener).toHaveBeenCalledTimes(1);
    const detail = (listener.mock.calls[0][0] as CustomEvent<PortfolioParams>).detail;
    expect(detail).toEqual({ sessions: 'main', harness: 'claude' });
  });

  it('emits filters-changed with the whole updated object on a range change', async () => {
    const el = document.createElement('filter-bar') as FilterBar;
    el.filters = { sessions: 'main', project: 'p1' };
    await mount(el);

    const listener = vi.fn();
    el.addEventListener('filters-changed', listener);
    const rangeSwitch = shadow(el).querySelector('time-range-switch') as HTMLElement;
    rangeSwitch.dispatchEvent(
      new CustomEvent('range-changed', { detail: 'all', bubbles: true, composed: true }),
    );

    const detail = (listener.mock.calls[0][0] as CustomEvent<PortfolioParams>).detail;
    expect(detail.project).toBe('p1');
    expect(detail.timeStart).toBeUndefined();
    expect(detail.timeEnd).toBeUndefined();
  });

  it('keeps the sessions-scope control inside a label with text "Sessions" for existing E2E selectors', async () => {
    const el = document.createElement('filter-bar') as FilterBar;
    el.filters = { sessions: 'main' };
    await mount(el);

    const label = Array.from(shadow(el).querySelectorAll('.filter-bar label')).find((l) =>
      /^\s*Sessions/.test(l.textContent ?? ''),
    );
    expect(label).toBeTruthy();
    expect(label?.querySelector('select')).not.toBeNull();
  });

  it('emits filters-changed when the sessions-scope select changes', async () => {
    const el = document.createElement('filter-bar') as FilterBar;
    el.filters = { sessions: 'main' };
    await mount(el);

    const listener = vi.fn();
    el.addEventListener('filters-changed', listener);
    const select = shadow(el).querySelector('.sessions-label select') as HTMLSelectElement;
    select.value = 'sub_agents';
    select.dispatchEvent(new Event('change', { bubbles: true }));

    const detail = (listener.mock.calls[0][0] as CustomEvent<PortfolioParams>).detail;
    expect(detail.sessions).toBe('sub_agents');
  });

  it('renders a project chip locked in fixed mode when projectFixed is set', async () => {
    const el = document.createElement('filter-bar') as FilterBar;
    el.filters = { sessions: 'main', project: 'pinned-project' };
    el.projectFixed = true;
    await mount(el);

    const chip = shadow(el).querySelector('dimension-chip[label="Project"]') as FilterBar &
      HTMLElement;
    expect(chip.hasAttribute('fixed')).toBe(true);
  });

  it('renders the Advanced params inside a collapsed-by-default details disclosure', async () => {
    const el = document.createElement('filter-bar') as FilterBar;
    el.filters = { sessions: 'main', mode: 'auto', analysisRelease: 'r1' };
    await mount(el);

    const details = shadow(el).querySelector('details.advanced') as HTMLDetailsElement;
    expect(details).not.toBeNull();
    expect(details.open).toBe(false);
  });

  it('resets to the default sessions=main state, clearing all other params', async () => {
    const el = document.createElement('filter-bar') as FilterBar;
    el.filters = { sessions: 'all', project: 'p1', harness: 'claude', mode: 'auto' };
    await mount(el);

    const listener = vi.fn();
    el.addEventListener('filters-changed', listener);
    (shadow(el).querySelector('button.reset') as HTMLButtonElement).click();

    const detail = (listener.mock.calls[0][0] as CustomEvent<PortfolioParams>).detail;
    expect(detail).toEqual({ sessions: 'main' });
  });
});
