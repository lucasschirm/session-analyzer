import type { LitElement } from 'lit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../../src/components/charts/echarts-base';
import type { ChartSeries } from '../../src/components/charts/chart-types';
import type { EchartsBase } from '../../src/components/charts/echarts-base';

async function mount<T extends LitElement>(element: T): Promise<T> {
  document.body.appendChild(element);
  await element.updateComplete;
  return element;
}

function shadow(element: LitElement): ShadowRoot {
  expect(element.shadowRoot).not.toBeNull();
  return element.shadowRoot as ShadowRoot;
}

function makeSeries(overrides: Partial<ChartSeries> = {}): ChartSeries {
  return {
    seriesId: 's1',
    label: 'Sessions',
    chartType: 'heatmap',
    xLabel: 'X',
    yLabel: 'Y',
    buckets: [{ x: 'a', y: 1, label: 'A', series: 'row' }],
    ...overrides,
  };
}

/**
 * State-machine coverage for `echarts-base`. Real ECharts init (canvas/SVG
 * rendering, ResizeObserver) is exercised by the Playwright E2E suite, not
 * here — these tests stay off the 'data' render path for non-heatmap chart
 * types and instead assert the loading/empty/error affordances, which never
 * touch the ECharts instance lifecycle.
 */
describe('echarts-base state machine', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders a skeleton shimmer, no error or empty markers, while loading', async () => {
    const el = document.createElement('echarts-base') as EchartsBase;
    el.state = 'loading';
    await mount(el);
    const root = shadow(el);
    expect(root.querySelector('.chart-skeleton')).not.toBeNull();
    expect(root.querySelector('.state-error, .chart-error, [role="alert"]')).toBeNull();
    expect(root.querySelector('.state-empty')).toBeNull();
  });

  it('renders a distinguishable empty affordance with no error marker', async () => {
    const el = document.createElement('echarts-base') as EchartsBase;
    el.state = 'empty';
    await mount(el);
    const root = shadow(el);
    const empty = root.querySelector('.chart-affordance.state-empty');
    expect(empty).not.toBeNull();
    expect(empty?.textContent).toContain('No sessions in this range');
    expect(root.querySelector('[role="alert"]')).toBeNull();
    expect(root.querySelector('.chart-skeleton')).toBeNull();
  });

  it('renders a distinguishable error affordance with a retry affordance, no empty marker', async () => {
    const el = document.createElement('echarts-base') as EchartsBase;
    el.state = 'error';
    await mount(el);
    const root = shadow(el);
    const error = root.querySelector('.chart-affordance.state-error[role="alert"]');
    expect(error).not.toBeNull();
    expect(root.querySelector('.state-empty')).toBeNull();
    expect(root.querySelector('button.affordance-retry')).not.toBeNull();
  });

  it('dispatches a chart-retry event when the retry button is clicked', async () => {
    const el = document.createElement('echarts-base') as EchartsBase;
    el.state = 'error';
    await mount(el);
    const listener = vi.fn();
    el.addEventListener('chart-retry', listener);
    shadow(el).querySelector<HTMLButtonElement>('button.affordance-retry')?.click();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('treats "unavailable" as an empty-group state and "integrity-error"/"unsupported" as an error-group state', async () => {
    const unavailable = document.createElement('echarts-base') as EchartsBase;
    unavailable.state = 'unavailable';
    await mount(unavailable);
    expect(shadow(unavailable).querySelector('.chart-affordance.state-unavailable')).not.toBeNull();

    const integrity = document.createElement('echarts-base') as EchartsBase;
    integrity.state = 'integrity-error';
    await mount(integrity);
    expect(
      shadow(integrity).querySelector('.chart-affordance.state-integrity-error[role="alert"]'),
    ).not.toBeNull();
  });

  it('routes chartType "heatmap" to rd-heatmap-grid instead of the ECharts container', async () => {
    const el = document.createElement('echarts-base') as EchartsBase;
    el.series = makeSeries({ chartType: 'heatmap' });
    await mount(el);
    const root = shadow(el);
    expect(root.querySelector('rd-heatmap-grid')).not.toBeNull();
    expect(root.querySelector('.chart-container')).toBeNull();
  });

  it('accepts custom empty/error copy via emptyMessage/errorMessage', async () => {
    const el = document.createElement('echarts-base') as EchartsBase;
    el.state = 'empty';
    el.emptyMessage = 'No matching component versions.';
    await mount(el);
    expect(shadow(el).querySelector('.affordance-message')?.textContent).toBe(
      'No matching component versions.',
    );
  });
});
