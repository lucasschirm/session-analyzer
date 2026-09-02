import type { LitElement } from 'lit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../../src/components/analytics/stat-tile-delta';
import type { StatTileDelta } from '../../src/components/analytics/stat-tile-delta';

async function mount<T extends LitElement>(element: T): Promise<T> {
  document.body.appendChild(element);
  await element.updateComplete;
  return element;
}

function shadow(element: LitElement): ShadowRoot {
  expect(element.shadowRoot).not.toBeNull();
  return element.shadowRoot as ShadowRoot;
}

describe('stat-tile-delta', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders label and value', async () => {
    const el = document.createElement('stat-tile-delta') as StatTileDelta;
    el.label = 'Tool calls';
    el.value = '842';
    await mount(el);
    expect(shadow(el).querySelector('.label')?.textContent).toBe('Tool calls');
    expect(shadow(el).querySelector('.value')?.textContent).toBe('842');
  });

  it('renders an up delta variant', async () => {
    const el = document.createElement('stat-tile-delta') as StatTileDelta;
    el.delta = { direction: 'up', text: '+3' };
    await mount(el);
    expect(shadow(el).querySelector('.delta-chip.up')?.textContent).toContain('+3');
  });

  it('renders a down delta variant', async () => {
    const el = document.createElement('stat-tile-delta') as StatTileDelta;
    el.delta = { direction: 'down', text: '-3' };
    await mount(el);
    expect(shadow(el).querySelector('.delta-chip.down')?.textContent).toContain('-3');
  });

  it('renders no breakdown rows when empty', async () => {
    const el = document.createElement('stat-tile-delta') as StatTileDelta;
    await mount(el);
    expect(shadow(el).querySelector('.breakdown')).toBeNull();
  });

  it('renders a colored-square breakdown row per item', async () => {
    const el = document.createElement('stat-tile-delta') as StatTileDelta;
    el.breakdown = [
      { label: 'Pass', value: '812', color: '#3ecf8e' },
      { label: 'Fail', value: '30', color: '#ff6b6b' },
    ];
    await mount(el);
    const rows = shadow(el).querySelectorAll('.breakdown-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('Pass');
    expect(rows[0]?.textContent).toContain('812');
    expect(rows[0]?.querySelector('.swatch')?.getAttribute('style')).toContain('#3ecf8e');
  });

  it('renders the sample label when provided', async () => {
    const el = document.createElement('stat-tile-delta') as StatTileDelta;
    el.sampleLabel = 'n=842';
    await mount(el);
    expect(shadow(el).querySelector('.caption')?.textContent).toBe('n=842');
  });

  it('dispatches card-click when clicked and clickable', async () => {
    const el = document.createElement('stat-tile-delta') as StatTileDelta;
    el.clickable = true;
    el.label = 'Tool calls';
    await mount(el);

    const listener = vi.fn();
    el.addEventListener('card-click', listener);
    shadow(el)
      .querySelector('button')
      ?.dispatchEvent(new Event('click', { bubbles: true }));

    expect(listener).toHaveBeenCalledTimes(1);
    const event = listener.mock.calls[0]?.[0] as CustomEvent;
    expect(event.detail).toEqual({ label: 'Tool calls' });
  });

  it('does not dispatch card-click when not clickable', async () => {
    const el = document.createElement('stat-tile-delta') as StatTileDelta;
    await mount(el);
    expect(shadow(el).querySelector('button')).toBeNull();
  });
});
