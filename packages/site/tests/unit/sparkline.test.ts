import type { LitElement } from 'lit';
import { afterEach, describe, expect, it } from 'vitest';
import '../../src/components/charts/sparkline';
import type { Sparkline } from '../../src/components/charts/sparkline';
import { buildSparklineGeometry } from '../../src/components/charts/sparkline';

async function mount<T extends LitElement>(element: T): Promise<T> {
  document.body.appendChild(element);
  await element.updateComplete;
  return element;
}

function shadow(element: LitElement): ShadowRoot {
  expect(element.shadowRoot).not.toBeNull();
  return element.shadowRoot as ShadowRoot;
}

describe('buildSparklineGeometry', () => {
  it('returns null for empty input', () => {
    expect(buildSparklineGeometry([], 100, 30)).toBeNull();
  });

  it('returns a flat line for a single point', () => {
    const geometry = buildSparklineGeometry([42], 100, 30);
    expect(geometry).not.toBeNull();
    expect(geometry?.linePath).toBe('M0,15 L100,15');
    expect(geometry?.linePath).not.toContain('NaN');
  });

  it('builds a polyline across the full width for 2 points', () => {
    const geometry = buildSparklineGeometry([0, 10], 100, 30);
    expect(geometry?.linePath).toBe('M0,30 L100,0');
    expect(geometry?.linePath).not.toContain('NaN');
  });

  it('builds a polyline for many (60) points without NaN', () => {
    const points = Array.from({ length: 60 }, (_, i) => Math.sin(i) * 10 + 20);
    const geometry = buildSparklineGeometry(points, 120, 34);
    expect(geometry).not.toBeNull();
    expect(geometry?.linePath).not.toContain('NaN');
    expect(geometry?.linePath.split('L')).toHaveLength(60);
  });

  it('renders a flat mid-height line when all values are equal', () => {
    const geometry = buildSparklineGeometry([5, 5, 5], 90, 30);
    expect(geometry?.linePath).not.toContain('NaN');
    expect(geometry?.linePath).toContain('15');
  });

  it('closes an area path down to the baseline', () => {
    const geometry = buildSparklineGeometry([1, 5, 2], 90, 30);
    expect(geometry?.areaPath.endsWith('Z')).toBe(true);
    expect(geometry?.areaPath).not.toContain('NaN');
  });
});

describe('rd-sparkline', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders nothing for empty points', async () => {
    const el = document.createElement('rd-sparkline') as Sparkline;
    await mount(el);
    expect(shadow(el).querySelector('svg')).toBeNull();
  });

  it('renders an svg path for multiple points', async () => {
    const el = document.createElement('rd-sparkline') as Sparkline;
    el.points = [1, 4, 2, 8, 3];
    await mount(el);
    const path = shadow(el).querySelector('path.line');
    expect(path).not.toBeNull();
    expect(path?.getAttribute('d')).not.toContain('NaN');
  });

  it('renders an area path when area is enabled', async () => {
    const el = document.createElement('rd-sparkline') as Sparkline;
    el.points = [1, 4, 2];
    el.area = true;
    await mount(el);
    expect(shadow(el).querySelector('path.area')).not.toBeNull();
  });

  it('does not render an area path when area is disabled', async () => {
    const el = document.createElement('rd-sparkline') as Sparkline;
    el.points = [1, 4, 2];
    await mount(el);
    expect(shadow(el).querySelector('path.area')).toBeNull();
  });

  it('renders a flat line for a single point', async () => {
    const el = document.createElement('rd-sparkline') as Sparkline;
    el.points = [7];
    await mount(el);
    const path = shadow(el).querySelector('path.line');
    expect(path?.getAttribute('d')).not.toContain('NaN');
  });
});
