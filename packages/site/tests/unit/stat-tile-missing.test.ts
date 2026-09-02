import type { LitElement } from 'lit';
import { afterEach, describe, expect, it } from 'vitest';
import '../../src/components/analytics/stat-tile-missing';
import type { StatTileMissing } from '../../src/components/analytics/stat-tile-missing';

async function mount<T extends LitElement>(element: T): Promise<T> {
  document.body.appendChild(element);
  await element.updateComplete;
  return element;
}

function shadow(element: LitElement): ShadowRoot {
  expect(element.shadowRoot).not.toBeNull();
  return element.shadowRoot as ShadowRoot;
}

describe('stat-tile-missing', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders an em-dash as the value, never a numeric 0', async () => {
    const el = document.createElement('stat-tile-missing') as StatTileMissing;
    el.label = 'Avg. cost';
    el.reason = 'Harness does not report cost natively.';
    await mount(el);

    const value = shadow(el).querySelector('.value');
    expect(value?.textContent).toBe('—');
    expect(value?.textContent).not.toBe('0');
    expect(el.shadowRoot?.textContent).not.toContain('0');
  });

  it('renders the reason line', async () => {
    const el = document.createElement('stat-tile-missing') as StatTileMissing;
    el.reason = 'Harness does not report cost natively.';
    await mount(el);
    expect(shadow(el).querySelector('.reason')?.textContent).toBe(
      'Harness does not report cost natively.',
    );
  });

  it('renders the fixed policy line', async () => {
    const el = document.createElement('stat-tile-missing') as StatTileMissing;
    await mount(el);
    expect(shadow(el).querySelector('.policy')?.textContent).toBe(
      'Never estimated · shown only when native',
    );
  });

  it('renders the dashed border variant chrome', async () => {
    const el = document.createElement('stat-tile-missing') as StatTileMissing;
    await mount(el);
    expect(shadow(el).querySelector('.stat-tile-missing')).not.toBeNull();
  });

  it('renders the info icon', async () => {
    const el = document.createElement('stat-tile-missing') as StatTileMissing;
    await mount(el);
    expect(shadow(el).querySelector('.info-icon')).not.toBeNull();
  });

  it('renders the label', async () => {
    const el = document.createElement('stat-tile-missing') as StatTileMissing;
    el.label = 'Avg. cost';
    await mount(el);
    expect(shadow(el).querySelector('.label')?.textContent).toBe('Avg. cost');
  });

  it('omits the reason line when not provided', async () => {
    const el = document.createElement('stat-tile-missing') as StatTileMissing;
    await mount(el);
    expect(shadow(el).querySelector('.reason')).toBeNull();
  });
});
