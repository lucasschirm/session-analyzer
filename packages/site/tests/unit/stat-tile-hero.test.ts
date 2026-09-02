import type { LitElement } from 'lit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../../src/components/analytics/stat-tile-hero';
import type { StatTileHero } from '../../src/components/analytics/stat-tile-hero';

async function mount<T extends LitElement>(element: T): Promise<T> {
  document.body.appendChild(element);
  await element.updateComplete;
  return element;
}

function shadow(element: LitElement): ShadowRoot {
  expect(element.shadowRoot).not.toBeNull();
  return element.shadowRoot as ShadowRoot;
}

describe('stat-tile-hero', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders label and value', async () => {
    const el = document.createElement('stat-tile-hero') as StatTileHero;
    el.label = 'Total Sessions';
    el.value = '1,204';
    await mount(el);
    expect(shadow(el).querySelector('.label')?.textContent).toBe('Total Sessions');
    expect(shadow(el).querySelector('.value')?.textContent).toBe('1,204');
  });

  it('renders an up delta chip with the triangle pointing up', async () => {
    const el = document.createElement('stat-tile-hero') as StatTileHero;
    el.delta = { direction: 'up', text: '+12%' };
    await mount(el);
    const chip = shadow(el).querySelector('.delta-chip.up');
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toContain('+12%');
    expect(chip?.querySelector('polygon')).not.toBeNull();
  });

  it('renders a down delta chip', async () => {
    const el = document.createElement('stat-tile-hero') as StatTileHero;
    el.delta = { direction: 'down', text: '-4%' };
    await mount(el);
    expect(shadow(el).querySelector('.delta-chip.down')?.textContent).toContain('-4%');
  });

  it('renders a flat delta chip with a rect glyph', async () => {
    const el = document.createElement('stat-tile-hero') as StatTileHero;
    el.delta = { direction: 'flat', text: '0%' };
    await mount(el);
    const chip = shadow(el).querySelector('.delta-chip.flat');
    expect(chip).not.toBeNull();
    expect(chip?.querySelector('rect')).not.toBeNull();
  });

  it('renders no delta chip when delta is undefined', async () => {
    const el = document.createElement('stat-tile-hero') as StatTileHero;
    await mount(el);
    expect(shadow(el).querySelector('.delta-chip')).toBeNull();
  });

  it('renders the sparkline with the given points', async () => {
    const el = document.createElement('stat-tile-hero') as StatTileHero;
    el.sparklinePoints = [1, 2, 3, 4];
    await mount(el);
    const spark = shadow(el).querySelector('rd-sparkline');
    expect(spark).not.toBeNull();
    expect((spark as HTMLElement & { points: number[] }).points).toEqual([1, 2, 3, 4]);
  });

  it('renders the footnote when provided', async () => {
    const el = document.createElement('stat-tile-hero') as StatTileHero;
    el.footnote = 'vs. prior 30 days';
    await mount(el);
    expect(shadow(el).querySelector('.footnote')?.textContent).toBe('vs. prior 30 days');
  });

  it('renders the sample label (n=) when provided', async () => {
    const el = document.createElement('stat-tile-hero') as StatTileHero;
    el.sampleLabel = 'n=128';
    await mount(el);
    expect(shadow(el).querySelector('.caption')?.textContent).toBe('n=128');
  });

  it('omits the sample label when not provided', async () => {
    const el = document.createElement('stat-tile-hero') as StatTileHero;
    await mount(el);
    expect(shadow(el).querySelector('.caption')).toBeNull();
  });

  it('applies the accent gradient class', async () => {
    const el = document.createElement('stat-tile-hero') as StatTileHero;
    el.accent = true;
    await mount(el);
    expect(shadow(el).querySelector('.stat-tile-hero.accent')).not.toBeNull();
  });

  it('renders as a div when not clickable', async () => {
    const el = document.createElement('stat-tile-hero') as StatTileHero;
    await mount(el);
    expect(shadow(el).querySelector('button')).toBeNull();
  });

  it('dispatches card-click when clicked and clickable', async () => {
    const el = document.createElement('stat-tile-hero') as StatTileHero;
    el.clickable = true;
    el.label = 'Total Sessions';
    await mount(el);

    const listener = vi.fn();
    el.addEventListener('card-click', listener);
    shadow(el)
      .querySelector('button')
      ?.dispatchEvent(new Event('click', { bubbles: true }));

    expect(listener).toHaveBeenCalledTimes(1);
    const event = listener.mock.calls[0]?.[0] as CustomEvent;
    expect(event.detail).toEqual({ label: 'Total Sessions' });
  });
});
