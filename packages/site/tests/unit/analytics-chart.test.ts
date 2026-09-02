import type { LitElement } from 'lit';
import { afterEach, describe, expect, it } from 'vitest';
import '../../src/components/charts/analytics-chart';
import type { AnalyticsChart } from '../../src/components/charts/analytics-chart';
import type { ChartSeries } from '../../src/components/charts/chart-types';

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
    chartType: 'time_series',
    xLabel: 'X',
    yLabel: 'Y',
    buckets: [{ x: 'a', y: 1, label: 'A' }],
    ...overrides,
  };
}

/**
 * `analytics-chart` receives an already-built `ChartSeries` DTO and never
 * computes metrics itself — see `.agents/rules/no-canonical-metrics-in-lit.md`.
 * These tests cover the wrapper's own responsibilities: memoized option
 * identity (issue #168 perf fix — a fresh option object on every unrelated
 * re-render would force `echarts-base` to redraw), and state/message
 * pass-through to `echarts-base`.
 */
describe('analytics-chart', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('passes a built ECharts option down to echarts-base', async () => {
    const el = document.createElement('analytics-chart') as AnalyticsChart;
    el.series = makeSeries();
    await mount(el);
    const base = shadow(el).querySelector('echarts-base') as HTMLElement & {
      option: unknown;
    };
    expect(base.option).not.toBeNull();
  });

  it('memoizes the computed option across an unrelated re-render (same series)', async () => {
    const el = document.createElement('analytics-chart') as AnalyticsChart;
    el.series = makeSeries();
    await mount(el);
    const base = shadow(el).querySelector('echarts-base') as HTMLElement & {
      option: unknown;
    };
    const firstOption = base.option;

    // Trigger an unrelated re-render (toggling the summary), not a series change.
    el.title = 'Retitled';
    await el.updateComplete;

    expect(base.option).toBe(firstOption);
  });

  it('skips building an ECharts option for a heatmap series (rendered by rd-heatmap-grid instead)', async () => {
    const el = document.createElement('analytics-chart') as AnalyticsChart;
    el.series = makeSeries({ chartType: 'heatmap' });
    await mount(el);
    const base = shadow(el).querySelector('echarts-base') as HTMLElement & {
      option: unknown;
    };
    expect(base.option).toBeNull();
  });

  it('recomputes the option when series changes', async () => {
    const el = document.createElement('analytics-chart') as AnalyticsChart;
    el.series = makeSeries();
    await mount(el);
    const base = shadow(el).querySelector('echarts-base') as HTMLElement & {
      option: unknown;
    };
    const firstOption = base.option;

    el.series = makeSeries({ buckets: [{ x: 'b', y: 2, label: 'B' }] });
    await el.updateComplete;

    expect(base.option).not.toBe(firstOption);
  });

  it('passes emptyMessage/errorMessage through to echarts-base', async () => {
    const el = document.createElement('analytics-chart') as AnalyticsChart;
    el.emptyMessage = 'No matching rows.';
    el.errorMessage = 'Could not load.';
    await mount(el);
    const base = shadow(el).querySelector('echarts-base') as HTMLElement & {
      emptyMessage: string;
      errorMessage: string;
    };
    expect(base.emptyMessage).toBe('No matching rows.');
    expect(base.errorMessage).toBe('Could not load.');
  });

  it('toggles the textual summary visibility', async () => {
    const el = document.createElement('analytics-chart') as AnalyticsChart;
    el.series = makeSeries();
    el.title = 'Trend';
    await mount(el);
    const root = shadow(el);
    expect(root.querySelector('.chart-summary')).toBeNull();

    root.querySelector<HTMLButtonElement>('.summary-toggle')?.click();
    await el.updateComplete;

    expect(root.querySelector('.chart-summary')).not.toBeNull();
  });
});
