import type { LitElement } from 'lit';
import { afterEach, describe, expect, it } from 'vitest';
import '../../src/components/analytics/stat-ring';
import type { StatRing } from '../../src/components/analytics/stat-ring';

async function mount<T extends LitElement>(element: T): Promise<T> {
  document.body.appendChild(element);
  await element.updateComplete;
  return element;
}

function shadow(element: LitElement): ShadowRoot {
  expect(element.shadowRoot).not.toBeNull();
  return element.shadowRoot as ShadowRoot;
}

describe('stat-ring', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders the center text', async () => {
    const el = document.createElement('stat-ring') as StatRing;
    el.percent = 82;
    el.centerText = '82%';
    await mount(el);
    expect(shadow(el).querySelector('.center-text')?.textContent).toBe('82%');
  });

  it('renders label, description and sample label', async () => {
    const el = document.createElement('stat-ring') as StatRing;
    el.label = 'Success rate';
    el.description = 'Sessions ending without error';
    el.sampleLabel = 'n=310';
    await mount(el);
    expect(shadow(el).querySelector('.label')?.textContent).toBe('Success rate');
    expect(shadow(el).querySelector('.description')?.textContent).toBe(
      'Sessions ending without error',
    );
    expect(shadow(el).querySelector('.caption')?.textContent).toBe('n=310');
  });

  it('produces a valid dasharray/dashoffset with no NaN for a normal percent', async () => {
    const el = document.createElement('stat-ring') as StatRing;
    el.percent = 40;
    await mount(el);
    const arc = shadow(el).querySelector('.ring-arc');
    expect(arc?.getAttribute('stroke-dashoffset')).not.toContain('NaN');
    expect(arc?.getAttribute('stroke-dasharray')).not.toContain('NaN');
  });

  it('clamps an out-of-range percent instead of producing NaN geometry', async () => {
    const el = document.createElement('stat-ring') as StatRing;
    el.percent = 150;
    await mount(el);
    const arc = shadow(el).querySelector('.ring-arc');
    expect(Number(arc?.getAttribute('stroke-dashoffset'))).toBeGreaterThanOrEqual(0);
  });

  it('clamps a negative percent to zero', async () => {
    const el = document.createElement('stat-ring') as StatRing;
    el.percent = -20;
    await mount(el);
    const arc = shadow(el).querySelector('.ring-arc');
    const dashoffset = Number(arc?.getAttribute('stroke-dashoffset'));
    const dasharray = Number(arc?.getAttribute('stroke-dasharray'));
    expect(dashoffset).toBeCloseTo(dasharray, 5);
  });

  it('handles a NaN percent without producing a NaN geometry', async () => {
    const el = document.createElement('stat-ring') as StatRing;
    el.percent = Number.NaN;
    await mount(el);
    const arc = shadow(el).querySelector('.ring-arc');
    expect(arc?.getAttribute('stroke-dashoffset')).not.toContain('NaN');
  });

  it('omits label/description/caption when not provided', async () => {
    const el = document.createElement('stat-ring') as StatRing;
    await mount(el);
    expect(shadow(el).querySelector('.label')).toBeNull();
    expect(shadow(el).querySelector('.description')).toBeNull();
    expect(shadow(el).querySelector('.caption')).toBeNull();
  });
});
