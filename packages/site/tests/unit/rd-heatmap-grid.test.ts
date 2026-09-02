import type { LitElement } from 'lit';
import { afterEach, describe, expect, it } from 'vitest';
import '../../src/components/charts/rd-heatmap-grid';
import type { ChartSeries } from '../../src/components/charts/chart-types';
import type { HeatmapGrid } from '../../src/components/charts/rd-heatmap-grid';

async function mount<T extends LitElement>(element: T): Promise<T> {
  document.body.appendChild(element);
  await element.updateComplete;
  return element;
}

function shadow(element: LitElement): ShadowRoot {
  expect(element.shadowRoot).not.toBeNull();
  return element.shadowRoot as ShadowRoot;
}

function makeSeries(): ChartSeries {
  return {
    seriesId: 'heatmap-1',
    label: 'Row',
    chartType: 'heatmap',
    xLabel: 'Day',
    yLabel: 'Component',
    unit: 'count',
    buckets: [
      { x: 'Mon', y: 10, label: 'Mon', series: 'alpha' },
      { x: 'Tue', y: 0, label: 'Tue', series: 'alpha' },
      { x: 'Wed', y: null, label: 'Wed', series: 'alpha' },
      { x: 'Mon', y: 90, label: 'Mon', series: 'beta' },
    ],
  };
}

describe('rd-heatmap-grid', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders one cell per row/column combination', async () => {
    const el = document.createElement('rd-heatmap-grid') as HeatmapGrid;
    el.series = makeSeries();
    await mount(el);
    // 2 rows (alpha, beta) x 3 columns (Mon, Tue, Wed) = 6 cells.
    expect(shadow(el).querySelectorAll('.cell')).toHaveLength(6);
  });

  it('marks a missing (null) cell with data-missing="true" and a dashed "—" affordance', async () => {
    const el = document.createElement('rd-heatmap-grid') as HeatmapGrid;
    el.series = makeSeries();
    await mount(el);
    const missingCell = Array.from(shadow(el).querySelectorAll('.cell')).find(
      (c) => c.getAttribute('data-missing') === 'true',
    );
    expect(missingCell).toBeDefined();
    expect(missingCell?.textContent?.trim()).toBe('—');
  });

  it('does not mark a measured-zero cell as missing (missing-is-never-zero)', async () => {
    const el = document.createElement('rd-heatmap-grid') as HeatmapGrid;
    el.series = makeSeries();
    await mount(el);
    const cells = Array.from(shadow(el).querySelectorAll('.cell'));
    const zeroCell = cells.find((c) => c.textContent?.trim() === '0');
    expect(zeroCell).toBeDefined();
    expect(zeroCell?.getAttribute('data-missing')).toBe('false');
  });

  it('renders present cells with a non-missing data-missing attribute', async () => {
    const el = document.createElement('rd-heatmap-grid') as HeatmapGrid;
    el.series = makeSeries();
    await mount(el);
    const cells = Array.from(shadow(el).querySelectorAll('.cell'));
    const presentCells = cells.filter((c) => c.getAttribute('data-missing') === 'false');
    const missingCells = cells.filter((c) => c.getAttribute('data-missing') === 'true');
    // Present: alpha/Mon(10), alpha/Tue(0), beta/Mon(90).
    // Missing: alpha/Wed (explicit null) plus beta/Tue and beta/Wed (no data
    // point at all for that row/column combination — also missing, never a
    // fabricated 0, per .agents/rules/missing-is-never-zero.md).
    expect(presentCells.length).toBe(3);
    expect(missingCells.length).toBe(3);
  });

  it('renders a ramp legend with min and max labels', async () => {
    const el = document.createElement('rd-heatmap-grid') as HeatmapGrid;
    el.series = makeSeries();
    await mount(el);
    const legend = shadow(el).querySelector('.legend');
    expect(legend).not.toBeNull();
    expect(legend?.textContent).toContain('0');
    expect(legend?.textContent).toContain('90');
  });

  it('renders a "No data" affordance (never blank) for an empty series', async () => {
    const el = document.createElement('rd-heatmap-grid') as HeatmapGrid;
    el.series = { ...makeSeries(), buckets: [] };
    await mount(el);
    expect(shadow(el).querySelectorAll('.cell')).toHaveLength(0);
    expect(shadow(el).querySelector('.empty')?.textContent).toBe('No data');
  });

  it('is keyboard-focusable and image-labeled for assistive tech', async () => {
    const el = document.createElement('rd-heatmap-grid') as HeatmapGrid;
    el.series = makeSeries();
    el.ariaDescription = 'Heatmap chart "Row" showing component activity.';
    await mount(el);
    const root = shadow(el).querySelector('.rd-heatmap-grid');
    expect(root?.getAttribute('role')).toBe('img');
    expect(root?.getAttribute('tabindex')).toBe('0');
    expect(root?.getAttribute('aria-label')).toBe(
      'Heatmap chart "Row" showing component activity.',
    );
  });
});
