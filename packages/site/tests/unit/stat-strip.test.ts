import type { LitElement } from 'lit';
import { afterEach, describe, expect, it } from 'vitest';
import '../../src/components/analytics/stat-strip';
import type { StatStrip } from '../../src/components/analytics/stat-strip';

async function mount<T extends LitElement>(element: T): Promise<T> {
  document.body.appendChild(element);
  await element.updateComplete;
  return element;
}

function shadow(element: LitElement): ShadowRoot {
  expect(element.shadowRoot).not.toBeNull();
  return element.shadowRoot as ShadowRoot;
}

describe('stat-strip', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders no items for empty input', async () => {
    const el = document.createElement('stat-strip') as StatStrip;
    await mount(el);
    expect(shadow(el).querySelectorAll('.item')).toHaveLength(0);
  });

  it('renders one item per entry with label and value', async () => {
    const el = document.createElement('stat-strip') as StatStrip;
    el.items = [
      { label: 'Sessions', value: '128' },
      { label: 'Tool calls', value: '842' },
      { label: 'Tokens', value: '1.4M' },
    ];
    await mount(el);
    const items = shadow(el).querySelectorAll('.item');
    expect(items).toHaveLength(3);
    expect(items[0]?.querySelector('.value')?.textContent).toBe('128');
    expect(items[0]?.querySelector('.label')?.textContent).toBe('Sessions');
  });

  it('renders a sample label for an item when provided', async () => {
    const el = document.createElement('stat-strip') as StatStrip;
    el.items = [{ label: 'Sessions', value: '128', sampleLabel: 'n=128' }];
    await mount(el);
    expect(shadow(el).querySelector('.caption')?.textContent).toBe('n=128');
  });

  it('omits the sample label caption when not provided', async () => {
    const el = document.createElement('stat-strip') as StatStrip;
    el.items = [{ label: 'Sessions', value: '128' }];
    await mount(el);
    expect(shadow(el).querySelector('.caption')).toBeNull();
  });

  it('uses hairline separators between items via CSS border-left', async () => {
    const el = document.createElement('stat-strip') as StatStrip;
    el.items = [
      { label: 'A', value: '1' },
      { label: 'B', value: '2' },
    ];
    await mount(el);
    const items = shadow(el).querySelectorAll('.item');
    expect(items).toHaveLength(2);
  });
});
