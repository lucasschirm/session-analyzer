import { formatCompactNumber } from '../../lib/format';
import type { ChartBucket, ChartSeries, EChartsCoreOption } from './chart-types';

function sortedUnique<T>(items: T[]): T[] {
  return [...new Set(items)].sort((a, b) => String(a).localeCompare(String(b)));
}

function groupBySeries(buckets: readonly ChartBucket[]): Map<string, ChartBucket[]> {
  const groups = new Map<string, ChartBucket[]>();
  for (const bucket of buckets) {
    const key = bucket.series ?? '';
    const list = groups.get(key) ?? [];
    list.push(bucket);
    groups.set(key, list);
  }
  return groups;
}

const LEGEND_TEXT_COLOR = '#c4cad6';
const AXIS_TEXT_COLOR = '#9aa4b2';

const baseGrid = { left: '3%', right: '4%', bottom: '3%', containLabel: true };
const baseTooltip = {
  trigger: 'axis',
  backgroundColor: '#1f242e',
  borderColor: '#3a4150',
  textStyle: { color: '#e6e9ef' },
};
const baseLegend = {
  type: 'plain',
  top: 0,
  textStyle: { color: LEGEND_TEXT_COLOR },
  inactiveColor: '#4a5260',
  pageTextStyle: { color: LEGEND_TEXT_COLOR },
};
const baseXAxis = {
  type: 'category',
  nameLocation: 'middle',
  nameGap: 24,
  axisLabel: { color: AXIS_TEXT_COLOR },
  axisLine: { lineStyle: { color: '#3a4150' } },
  splitLine: { lineStyle: { color: '#252b36' } },
  nameTextStyle: { color: AXIS_TEXT_COLOR },
};
const baseYAxis = {
  type: 'value',
  nameLocation: 'middle',
  nameGap: 36,
  axisLabel: { color: AXIS_TEXT_COLOR },
  axisLine: { lineStyle: { color: '#3a4150' } },
  splitLine: { lineStyle: { color: '#252b36' } },
  nameTextStyle: { color: AXIS_TEXT_COLOR },
};
const baseDataZoom = [
  { type: 'inside', start: 0, end: 100 },
  {
    type: 'slider',
    start: 0,
    end: 100,
    height: 20,
    bottom: 8,
    textStyle: { color: AXIS_TEXT_COLOR },
  },
];

function buildSeries(
  type: 'line' | 'bar',
  xAxisData: string[],
  groups: Map<string, ChartBucket[]>,
  stacked = false,
  area = false,
): unknown[] {
  return Array.from(groups.entries())
    .sort(([a], [b]) => (a || '').localeCompare(b || ''))
    .map(([name, buckets]) => {
      const byX = new Map(buckets.map((b) => [String(b.x), b.y]));
      return {
        name: name || 'value',
        type,
        stack: stacked ? 'total' : undefined,
        areaStyle: area ? {} : undefined,
        emphasis: { focus: 'series' },
        data: xAxisData.map((x) => byX.get(x) ?? null),
      };
    });
}

function timeSeriesOption(series: ChartSeries): EChartsCoreOption {
  const groups = groupBySeries(series.buckets);
  const xAxisData = sortedUnique(series.buckets.map((b) => String(b.x)));
  return {
    aria: { enabled: true },
    tooltip: baseTooltip,
    legend: baseLegend,
    grid: { ...baseGrid, bottom: '12%' },
    xAxis: { ...baseXAxis, name: series.xLabel, data: xAxisData },
    yAxis: { ...baseYAxis, name: series.yLabel },
    dataZoom: baseDataZoom,
    series: buildSeries('line', xAxisData, groups),
    animation: false,
  } as EChartsCoreOption;
}

function stackedBarOption(series: ChartSeries): EChartsCoreOption {
  const groups = groupBySeries(series.buckets);
  const xAxisData = sortedUnique(series.buckets.map((b) => String(b.x)));
  return {
    aria: { enabled: true },
    tooltip: baseTooltip,
    legend: baseLegend,
    grid: { ...baseGrid, bottom: '12%' },
    xAxis: { ...baseXAxis, name: series.xLabel, data: xAxisData },
    yAxis: { ...baseYAxis, name: series.yLabel },
    dataZoom: baseDataZoom,
    series: buildSeries('bar', xAxisData, groups, true),
    animation: false,
  } as EChartsCoreOption;
}

function stackedAreaOption(series: ChartSeries): EChartsCoreOption {
  const groups = groupBySeries(series.buckets);
  const xAxisData = sortedUnique(series.buckets.map((b) => String(b.x)));
  return {
    aria: { enabled: true },
    tooltip: baseTooltip,
    legend: baseLegend,
    grid: { ...baseGrid, bottom: '12%' },
    xAxis: { ...baseXAxis, name: series.xLabel, data: xAxisData },
    yAxis: { ...baseYAxis, name: series.yLabel },
    dataZoom: baseDataZoom,
    series: buildSeries('line', xAxisData, groups, true, true),
    animation: false,
  } as EChartsCoreOption;
}

function histogramOption(series: ChartSeries): EChartsCoreOption {
  const xAxisData = sortedUnique(series.buckets.map((b) => String(b.x)));
  const byX = new Map(series.buckets.map((b) => [String(b.x), b.y]));
  return {
    aria: { enabled: true },
    tooltip: baseTooltip,
    legend: baseLegend,
    grid: baseGrid,
    xAxis: { ...baseXAxis, name: series.xLabel, data: xAxisData },
    yAxis: { ...baseYAxis, name: series.yLabel },
    series: [
      {
        name: series.label,
        type: 'bar',
        data: xAxisData.map((x) => byX.get(x) ?? null),
      },
    ],
    animation: false,
  } as EChartsCoreOption;
}

function percentileBandsOption(series: ChartSeries): EChartsCoreOption {
  const groups = groupBySeries(series.buckets);
  const xAxisData = sortedUnique(series.buckets.map((b) => String(b.x)));
  return {
    aria: { enabled: true },
    tooltip: baseTooltip,
    legend: baseLegend,
    grid: { ...baseGrid, bottom: '12%' },
    xAxis: { ...baseXAxis, name: series.xLabel, data: xAxisData },
    yAxis: { ...baseYAxis, name: series.yLabel },
    dataZoom: baseDataZoom,
    series: buildSeries('line', xAxisData, groups, false, true),
    animation: false,
  } as EChartsCoreOption;
}

function scatterOption(series: ChartSeries): EChartsCoreOption {
  const xAxisType: 'value' | 'category' = series.buckets.every((b) => typeof b.x === 'number')
    ? 'value'
    : 'category';
  const xValues =
    xAxisType === 'category' ? sortedUnique(series.buckets.map((b) => String(b.x))) : [];
  const data = series.buckets
    .filter((b) => b.y !== null)
    .map((b) => {
      const x = xAxisType === 'category' ? xValues.indexOf(String(b.x)) : (b.x as number);
      return [x, b.y as number, b.label];
    });

  return {
    aria: { enabled: true },
    tooltip: {
      trigger: 'item',
      formatter: (params: unknown) => {
        const p = params as { value?: [number | string, number, string] };
        const value = Array.isArray(p.value) ? p.value[1] : null;
        return `${p.value?.[2] ?? ''}: ${value === null ? '—' : formatCompactNumber(value as number)}`;
      },
    },
    legend: baseLegend,
    grid: baseGrid,
    xAxis: {
      ...baseXAxis,
      type: xAxisType,
      name: series.xLabel,
      data: xAxisType === 'category' ? xValues : undefined,
    },
    yAxis: { ...baseYAxis, name: series.yLabel },
    series: [{ name: series.label, type: 'scatter', data }],
    animation: false,
  } as EChartsCoreOption;
}

function heatmapOption(series: ChartSeries): EChartsCoreOption {
  const yLabels = sortedUnique(series.buckets.map((b) => b.series ?? series.label));
  const xLabels = sortedUnique(series.buckets.map((b) => String(b.x)));
  const data = series.buckets
    .filter((b) => b.y !== null)
    .map((b) => [
      xLabels.indexOf(String(b.x)),
      yLabels.indexOf(b.series ?? series.label),
      b.y as number,
    ]);

  const maxValue = Math.max(1, ...data.map((d) => d[2] as number));

  return {
    aria: { enabled: true },
    tooltip: { position: 'top' },
    grid: { height: '70%', top: '10%' },
    xAxis: { ...baseXAxis, data: xLabels, splitArea: { show: true } },
    yAxis: {
      ...baseXAxis,
      type: 'category',
      data: yLabels,
      splitArea: { show: true },
    },
    visualMap: {
      min: 0,
      max: maxValue,
      calculable: true,
      orient: 'horizontal',
      left: 'center',
      bottom: '0%',
    },
    series: [
      {
        name: series.label,
        type: 'heatmap',
        data,
        label: { show: true },
        emphasis: { itemStyle: { shadowBlur: 10, shadowColor: 'rgba(0,0,0,0.5)' } },
      },
    ],
    animation: false,
  } as EChartsCoreOption;
}

function boxValues(values: number[]): number[] {
  if (values.length === 0) return [0, 0, 0, 0, 0];
  const sorted = [...values].sort((a, b) => a - b);
  const min = sorted[0] as number;
  const max = sorted[sorted.length - 1] as number;
  const q1 = sorted[Math.floor(sorted.length * 0.25)] ?? min;
  const median = sorted[Math.floor(sorted.length * 0.5)] ?? min;
  const q3 = sorted[Math.floor(sorted.length * 0.75)] ?? max;
  return [min, q1, median, q3, max];
}

function boxOption(series: ChartSeries): EChartsCoreOption {
  const groups = groupBySeries(series.buckets);
  const categories: string[] = [];
  const data: number[][] = [];
  for (const [name, buckets] of groups) {
    categories.push(name || series.label);
    const values = buckets.map((b) => b.y).filter((v): v is number => v !== null);
    data.push(boxValues(values));
  }

  return {
    aria: { enabled: true },
    tooltip: baseTooltip,
    legend: baseLegend,
    grid: baseGrid,
    xAxis: { ...baseXAxis, name: series.xLabel, data: categories },
    yAxis: { ...baseYAxis, name: series.yLabel },
    series: [{ name: series.label, type: 'boxplot', data }],
    animation: false,
  } as EChartsCoreOption;
}

function distributionOption(series: ChartSeries): EChartsCoreOption {
  return histogramOption(series);
}

function funnelOption(series: ChartSeries): EChartsCoreOption {
  const data = series.buckets
    .filter((b) => b.y !== null)
    .map((b) => ({ name: String(b.x), value: b.y as number }))
    .sort((a, b) => b.value - a.value);

  return {
    aria: { enabled: true },
    tooltip: { trigger: 'item', formatter: '{b}: {c}' },
    legend: baseLegend,
    series: [{ name: series.label, type: 'funnel', data }],
    animation: false,
  } as EChartsCoreOption;
}

function annotatedTimelineOption(series: ChartSeries): EChartsCoreOption {
  const option = timeSeriesOption(series) as Record<string, unknown>;
  const markLines = (series.annotations ?? []).map((a) => ({
    xAxis: a.position,
    label: { formatter: a.label },
    lineStyle: { type: 'dashed' },
  }));
  const seriesArray = (option.series as unknown[]) ?? [];
  if (seriesArray.length > 0) {
    seriesArray[0] = { ...(seriesArray[0] as object), markLine: { data: markLines } };
  }
  return option as EChartsCoreOption;
}

export function toEChartsOption(series: ChartSeries): EChartsCoreOption {
  switch (series.chartType) {
    case 'time_series':
      return timeSeriesOption(series);
    case 'stacked_bar':
      return stackedBarOption(series);
    case 'stacked_area':
      return stackedAreaOption(series);
    case 'histogram':
      return histogramOption(series);
    case 'percentile_bands':
      return percentileBandsOption(series);
    case 'scatter':
      return scatterOption(series);
    case 'heatmap':
      return heatmapOption(series);
    case 'box':
      return boxOption(series);
    case 'distribution':
      return distributionOption(series);
    case 'funnel':
      return funnelOption(series);
    case 'annotated_timeline':
      return annotatedTimelineOption(series);
    default:
      return {
        aria: { enabled: true },
        tooltip: baseTooltip,
        legend: baseLegend,
        grid: baseGrid,
        xAxis: { ...baseXAxis, name: series.xLabel },
        yAxis: { ...baseYAxis, name: series.yLabel },
        animation: false,
      } as EChartsCoreOption;
  }
}
