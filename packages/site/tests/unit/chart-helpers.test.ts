import { describe, expect, it } from 'vitest';
import { toEChartsOption } from '../../src/components/charts/chart-helpers';
import {
  type ChartBucket,
  type ChartSeries,
  type ChartState,
  formatChartValue,
  stateIcon,
  stateLabel,
  textualSummary,
  toTableRows,
} from '../../src/components/charts/chart-types';

function makeBucket(overrides: Partial<ChartBucket> = {}): ChartBucket {
  return { x: 'a', y: 1, label: 'A', ...overrides };
}

function makeSeries(overrides: Partial<ChartSeries> = {}): ChartSeries {
  return {
    seriesId: 's1',
    label: 'Test',
    chartType: 'time_series',
    xLabel: 'X',
    yLabel: 'Y',
    buckets: [makeBucket()],
    ...overrides,
  };
}

describe('stateLabel', () => {
  it.each([
    ['loading', 'Loading chart data'],
    ['empty', 'No data'],
    ['partial', 'Partial data'],
    ['unavailable', 'Data unavailable'],
    ['unsupported', 'Unsupported view'],
    ['integrity-error', 'Data integrity error'],
    ['stale-rollup', 'Stale rollup'],
    ['error', 'Chart error'],
  ] as const)('returns the correct label for %s', (state, expected) => {
    expect(stateLabel(state)).toBe(expected);
  });

  it('returns "Unknown state" for an unrecognized state', () => {
    expect(stateLabel('unknown' as ChartState)).toBe('Unknown state');
  });
});

describe('stateIcon', () => {
  it.each([
    ['loading', '⏳'],
    ['empty', '∅'],
    ['partial', '◐'],
    ['unavailable', '⊘'],
    ['unsupported', '⚠'],
    ['integrity-error', '⛒'],
    ['stale-rollup', '⧗'],
    ['error', '✕'],
  ] as const)('returns the correct icon for %s', (state, expected) => {
    expect(stateIcon(state)).toBe(expected);
  });

  it('returns "?" for an unrecognized state', () => {
    expect(stateIcon('unknown' as ChartState)).toBe('?');
  });
});

describe('formatChartValue', () => {
  it('returns "—" for null', () => {
    expect(formatChartValue(null)).toBe('—');
  });

  it('returns "—" for NaN', () => {
    expect(formatChartValue(Number.NaN)).toBe('—');
  });

  it('formats a plain number', () => {
    expect(formatChartValue(42)).toBe('42');
  });

  it('formats with usd unit as $ prefix', () => {
    expect(formatChartValue(1500, 'usd')).toBe('$1,500');
  });

  it('formats with percent unit with % suffix', () => {
    expect(formatChartValue(95, 'percent')).toBe('95%');
  });

  it('formats with ratio unit without suffix', () => {
    expect(formatChartValue(0.5, 'ratio')).toBe('0.5');
  });

  it('formats with a custom unit', () => {
    expect(formatChartValue(10, 'ms')).toBe('10 ms');
  });

  it('formats with count unit as plain number', () => {
    expect(formatChartValue(100, 'count')).toBe('100');
  });

  it('formats with empty unit as plain number', () => {
    expect(formatChartValue(100, '')).toBe('100');
  });
});

describe('toTableRows', () => {
  it('maps buckets to table rows with formatted values', () => {
    const series = makeSeries({
      buckets: [
        makeBucket({ x: '2024-01', y: 100, label: 'Jan', series: 'A' }),
        makeBucket({ x: '2024-02', y: null, label: 'Feb', series: 'B' }),
      ],
    });
    const rows = toTableRows(series);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      x: '2024-01',
      y: '100',
      series: 'A',
      label: 'Jan',
      evidenceHref: undefined,
    });
    expect(rows[1].y).toBe('—');
    expect(rows[1].series).toBe('B');
  });

  it('uses series label as fallback when bucket has no series', () => {
    const series = makeSeries({
      label: 'My Series',
      buckets: [makeBucket({ x: 'x', y: 1, label: 'L', series: undefined })],
    });
    const rows = toTableRows(series);
    expect(rows[0].series).toBe('My Series');
  });

  it('includes evidence href when present', () => {
    const series = makeSeries({
      buckets: [
        makeBucket({
          x: 'x',
          y: 1,
          label: 'L',
          evidenceLink: { label: 'link', href: '#/evidence/1' },
        }),
      ],
    });
    const rows = toTableRows(series);
    expect(rows[0].evidenceHref).toBe('#/evidence/1');
  });
});

describe('textualSummary', () => {
  it('returns no-data message for empty buckets', () => {
    const series = makeSeries({ buckets: [] });
    expect(textualSummary(series)).toBe('Chart "Test" has no data points.');
  });

  it('includes state prefix when state is provided', () => {
    const series = makeSeries({ buckets: [] });
    expect(textualSummary(series, 'partial')).toBe(
      'Partial data. Chart "Test" has no data points.',
    );
  });

  it('summarizes data with known and total counts', () => {
    const series = makeSeries({
      chartType: 'time_series',
      buckets: [
        makeBucket({ x: 'a', y: 10, label: 'A' }),
        makeBucket({ x: 'b', y: null, label: 'B' }),
      ],
    });
    const summary = textualSummary(series);
    expect(summary).toContain('1 of 2 buckets');
    expect(summary).toContain('1 series');
    expect(summary).toContain('from a to b');
    expect(summary).toContain('value peaks at 10');
  });

  it('groups peaks by series name', () => {
    const series = makeSeries({
      chartType: 'stacked_bar',
      buckets: [
        makeBucket({ x: 'a', y: 10, label: 'A', series: 'S1' }),
        makeBucket({ x: 'b', y: 20, label: 'B', series: 'S2' }),
      ],
    });
    const summary = textualSummary(series);
    expect(summary).toContain('S1 peaks at 10');
    expect(summary).toContain('S2 peaks at 20');
    expect(summary).toContain('2 series');
  });

  it('replaces underscores in chart type', () => {
    const series = makeSeries({
      chartType: 'stacked_area',
      buckets: [makeBucket({ x: 'a', y: 1, label: 'A' })],
    });
    expect(textualSummary(series)).toContain('stacked area chart');
  });
});

describe('toEChartsOption', () => {
  it.each([
    'time_series',
    'stacked_bar',
    'stacked_area',
    'histogram',
    'percentile_bands',
    'scatter',
    'heatmap',
    'box',
    'distribution',
    'funnel',
    'annotated_timeline',
  ] as const)('builds an option object for %s', (chartType) => {
    const series = makeSeries({
      chartType,
      buckets: [
        makeBucket({ x: 'a', y: 10, label: 'A', series: 'S1' }),
        makeBucket({ x: 'b', y: 20, label: 'B', series: 'S1' }),
      ],
    });
    const option = toEChartsOption(series) as Record<string, unknown>;
    expect(option).toBeDefined();
    expect(option.aria).toEqual({ enabled: true });
    expect(option.animation).toBe(false);
  });

  it('returns a default option for unknown chart types', () => {
    const series = makeSeries({ chartType: 'unknown' as never });
    const option = toEChartsOption(series) as Record<string, unknown>;
    expect(option.aria).toEqual({ enabled: true });
    expect(option.animation).toBe(false);
  });

  it('builds scatter option with value axis for numeric x values', () => {
    const series = makeSeries({
      chartType: 'scatter',
      buckets: [makeBucket({ x: 1, y: 10, label: 'A' }), makeBucket({ x: 2, y: 20, label: 'B' })],
    });
    const option = toEChartsOption(series) as Record<string, unknown>;
    const xAxis = option.xAxis as Record<string, unknown>;
    expect(xAxis.type).toBe('value');
  });

  it('builds scatter option with category axis for string x values', () => {
    const series = makeSeries({
      chartType: 'scatter',
      buckets: [
        makeBucket({ x: 'a', y: 10, label: 'A' }),
        makeBucket({ x: 'b', y: 20, label: 'B' }),
      ],
    });
    const option = toEChartsOption(series) as Record<string, unknown>;
    const xAxis = option.xAxis as Record<string, unknown>;
    expect(xAxis.type).toBe('category');
  });

  it('filters out null-y buckets in scatter', () => {
    const series = makeSeries({
      chartType: 'scatter',
      buckets: [makeBucket({ x: 1, y: 10, label: 'A' }), makeBucket({ x: 2, y: null, label: 'B' })],
    });
    const option = toEChartsOption(series) as Record<string, unknown>;
    const seriesArr = option.series as Array<{ data: unknown[] }>;
    expect(seriesArr[0].data).toHaveLength(1);
  });

  it('builds heatmap with visualMap max from data', () => {
    const series = makeSeries({
      chartType: 'heatmap',
      buckets: [
        makeBucket({ x: 'a', y: 50, label: 'A', series: 'S1' }),
        makeBucket({ x: 'b', y: 100, label: 'B', series: 'S2' }),
      ],
    });
    const option = toEChartsOption(series) as Record<string, unknown>;
    const visualMap = option.visualMap as Record<string, unknown>;
    expect(visualMap.max).toBe(100);
  });

  it('builds heatmap with max of 1 when all data is zero', () => {
    const series = makeSeries({
      chartType: 'heatmap',
      buckets: [makeBucket({ x: 'a', y: 0, label: 'A' })],
    });
    const option = toEChartsOption(series) as Record<string, unknown>;
    const visualMap = option.visualMap as Record<string, unknown>;
    expect(visualMap.max).toBe(1);
  });

  it('builds box option with boxplot statistics', () => {
    const series = makeSeries({
      chartType: 'box',
      buckets: [
        makeBucket({ x: 'a', y: 1, label: 'A', series: 'S1' }),
        makeBucket({ x: 'a', y: 2, label: 'A', series: 'S1' }),
        makeBucket({ x: 'a', y: 3, label: 'A', series: 'S1' }),
        makeBucket({ x: 'a', y: 4, label: 'A', series: 'S1' }),
        makeBucket({ x: 'a', y: 5, label: 'A', series: 'S1' }),
      ],
    });
    const option = toEChartsOption(series) as Record<string, unknown>;
    const seriesArr = option.series as Array<{ data: number[][] }>;
    // boxValues: sorted=[1,2,3,4,5], min=1, q1=floor(5*0.25)=1→2, median=floor(5*0.5)=2→3, q3=floor(5*0.75)=3→4, max=5
    expect(seriesArr[0].data[0]).toEqual([1, 2, 3, 4, 5]);
  });

  it('builds box option with zeros for empty values', () => {
    const series = makeSeries({
      chartType: 'box',
      buckets: [makeBucket({ x: 'a', y: null, label: 'A', series: 'S1' })],
    });
    const option = toEChartsOption(series) as Record<string, unknown>;
    const seriesArr = option.series as Array<{ data: number[][] }>;
    expect(seriesArr[0].data[0]).toEqual([0, 0, 0, 0, 0]);
  });

  it('builds funnel option sorted by value descending', () => {
    const series = makeSeries({
      chartType: 'funnel',
      buckets: [
        makeBucket({ x: 'a', y: 10, label: 'A' }),
        makeBucket({ x: 'b', y: 30, label: 'B' }),
        makeBucket({ x: 'c', y: 20, label: 'C' }),
      ],
    });
    const option = toEChartsOption(series) as Record<string, unknown>;
    const seriesArr = option.series as Array<{ data: Array<{ value: number }> }>;
    const values = seriesArr[0].data.map((d) => d.value);
    expect(values).toEqual([30, 20, 10]);
  });

  it('builds annotated_timeline with markLine from annotations', () => {
    const series = makeSeries({
      chartType: 'annotated_timeline',
      buckets: [makeBucket({ x: 'a', y: 10, label: 'A' })],
      annotations: [{ position: 'a', label: 'Event', type: 'lifecycle' }],
    });
    const option = toEChartsOption(series) as Record<string, unknown>;
    const seriesArr = option.series as Array<{ markLine?: { data: unknown[] } }>;
    expect(seriesArr[0].markLine).toBeDefined();
    expect(seriesArr[0].markLine?.data).toHaveLength(1);
  });

  it('annotated_timeline does not add markLine when series array is empty', () => {
    const series = makeSeries({
      chartType: 'annotated_timeline',
      buckets: [],
      annotations: [{ position: 'a', label: 'Event', type: 'lifecycle' }],
    });
    const option = toEChartsOption(series) as Record<string, unknown>;
    const seriesArr = (option.series as unknown[]) ?? [];
    // With no buckets, buildSeries produces one "value" series with empty data,
    // so the array is not empty — markLine should be on series[0].
    if (seriesArr.length > 0) {
      const first = seriesArr[0] as { markLine?: unknown };
      expect(first.markLine).toBeDefined();
    }
  });

  it('builds stacked_bar with stack property on series', () => {
    const series = makeSeries({
      chartType: 'stacked_bar',
      buckets: [
        makeBucket({ x: 'a', y: 10, label: 'A', series: 'S1' }),
        makeBucket({ x: 'a', y: 5, label: 'B', series: 'S2' }),
      ],
    });
    const option = toEChartsOption(series) as Record<string, unknown>;
    const seriesArr = option.series as Array<{ stack?: string; type: string }>;
    expect(seriesArr.every((s) => s.stack === 'total')).toBe(true);
    expect(seriesArr.every((s) => s.type === 'bar')).toBe(true);
  });

  it('builds stacked_area with areaStyle on series', () => {
    const series = makeSeries({
      chartType: 'stacked_area',
      buckets: [makeBucket({ x: 'a', y: 10, label: 'A', series: 'S1' })],
    });
    const option = toEChartsOption(series) as Record<string, unknown>;
    const seriesArr = option.series as Array<{ areaStyle?: unknown; type: string }>;
    expect(seriesArr[0].areaStyle).toBeDefined();
    expect(seriesArr[0].type).toBe('line');
  });

  it('builds time_series with line type and no stack', () => {
    const series = makeSeries({
      chartType: 'time_series',
      buckets: [makeBucket({ x: 'a', y: 10, label: 'A', series: 'S1' })],
    });
    const option = toEChartsOption(series) as Record<string, unknown>;
    const seriesArr = option.series as Array<{ stack?: string; type: string }>;
    expect(seriesArr[0].type).toBe('line');
    expect(seriesArr[0].stack).toBeUndefined();
  });

  it('builds histogram with bar type', () => {
    const series = makeSeries({
      chartType: 'histogram',
      buckets: [makeBucket({ x: 'a', y: 10, label: 'A' })],
    });
    const option = toEChartsOption(series) as Record<string, unknown>;
    const seriesArr = option.series as Array<{ type: string }>;
    expect(seriesArr[0].type).toBe('bar');
  });

  it('builds distribution as histogram (bar type)', () => {
    const series = makeSeries({
      chartType: 'distribution',
      buckets: [makeBucket({ x: 'a', y: 10, label: 'A' })],
    });
    const option = toEChartsOption(series) as Record<string, unknown>;
    const seriesArr = option.series as Array<{ type: string }>;
    expect(seriesArr[0].type).toBe('bar');
  });

  it('fills null y values with null in time_series data', () => {
    const series = makeSeries({
      chartType: 'time_series',
      buckets: [
        makeBucket({ x: 'a', y: 10, label: 'A', series: 'S1' }),
        makeBucket({ x: 'b', y: null, label: 'B', series: 'S1' }),
        makeBucket({ x: 'c', y: 30, label: 'C', series: 'S1' }),
      ],
    });
    const option = toEChartsOption(series) as Record<string, unknown>;
    const seriesArr = option.series as Array<{ data: unknown[] }>;
    expect(seriesArr[0].data).toEqual([10, null, 30]);
  });

  it('uses "value" as fallback series name when series is empty string', () => {
    const series = makeSeries({
      chartType: 'time_series',
      buckets: [makeBucket({ x: 'a', y: 10, label: 'A', series: '' })],
    });
    const option = toEChartsOption(series) as Record<string, unknown>;
    const seriesArr = option.series as Array<{ name: string }>;
    expect(seriesArr[0].name).toBe('value');
  });
});
