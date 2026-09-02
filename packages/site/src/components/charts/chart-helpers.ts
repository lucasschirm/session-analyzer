import { formatCompactNumber } from '../../lib/format';
import {
  borderTokens,
  inkTokens,
  rampTokens,
  seriesTokens,
  surfaceTokens,
} from '../../styles/tokens';
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

// Every color used by these option builders comes from `styles/tokens.ts` —
// echarts cannot resolve `var(--rd-*)` CSS custom properties, so this module
// is the one place literal hex values are allowed outside the token module.
const TOOLTIP_SURFACE = surfaceTokens.surfaceRowHover; // #1f2531
const TOOLTIP_BORDER = borderTokens.borderEmphasis2; // #3a4150
const AXIS_TEXT_COLOR = inkTokens.inkFaint; // #7d8794
const GRIDLINE_COLOR = borderTokens.border2; // #232936
const BASELINE_COLOR = borderTokens.borderEmphasis; // #313947
const LEGEND_TEXT_COLOR = inkTokens.inkSecondary; // #c9d4e3
const TRACK_COLOR = borderTokens.border1; // #20242e

function hashEntityId(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

/**
 * Assigns a stable categorical color to a series/entity id from the five
 * validated palette slots. The color is a pure function of the id — never of
 * the id's position among currently-visible series — so removing a series
 * from the input never repaints the remaining series' colors.
 */
export function colorForEntity(id: string): string {
  const key = id || 'value';
  const slot = hashEntityId(key) % seriesTokens.length;
  return seriesTokens[slot] as string;
}

const baseGrid = { left: '3%', right: '4%', bottom: '3%', containLabel: true };
const baseTooltip = {
  trigger: 'axis',
  backgroundColor: TOOLTIP_SURFACE,
  borderColor: TOOLTIP_BORDER,
  textStyle: { color: inkTokens.inkPrimary },
  axisPointer: {
    type: 'cross',
    label: { backgroundColor: TOOLTIP_BORDER },
    crossStyle: { color: BASELINE_COLOR },
  },
};
const baseLegend = {
  type: 'plain',
  top: 0,
  textStyle: { color: LEGEND_TEXT_COLOR },
  inactiveColor: AXIS_TEXT_COLOR,
  pageTextStyle: { color: LEGEND_TEXT_COLOR },
};
const baseXAxis = {
  type: 'category',
  nameLocation: 'middle',
  nameGap: 24,
  axisLabel: { color: AXIS_TEXT_COLOR },
  axisLine: { lineStyle: { color: BASELINE_COLOR } },
  splitLine: { lineStyle: { color: GRIDLINE_COLOR } },
  nameTextStyle: { color: AXIS_TEXT_COLOR },
};
const baseYAxis = {
  type: 'value',
  nameLocation: 'middle',
  nameGap: 36,
  axisLabel: { color: AXIS_TEXT_COLOR },
  axisLine: { lineStyle: { color: BASELINE_COLOR } },
  splitLine: { lineStyle: { color: GRIDLINE_COLOR } },
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

/** Legend is shown only for 2+ distinct series; a single series is titled instead. */
function legendFor(groupCount: number): typeof baseLegend | undefined {
  return groupCount >= 2 ? baseLegend : undefined;
}

/**
 * Builds a `markPoint` that draws a single emphasis dot on the last
 * non-null value of a line series, colored to match the series (never a
 * status color — status tokens are reserved for outcome encodings).
 */
function lastPointMarker(
  xAxisData: string[],
  byX: Map<string, number | null>,
  color: string,
): Record<string, unknown> | undefined {
  for (let i = xAxisData.length - 1; i >= 0; i--) {
    const x = xAxisData[i] as string;
    const y = byX.get(x);
    if (y !== null && y !== undefined) {
      return {
        symbol: 'circle',
        symbolSize: 8,
        animation: false,
        label: { show: false },
        itemStyle: { color, borderColor: TOOLTIP_SURFACE, borderWidth: 2 },
        data: [{ coord: [x, y] }],
      };
    }
  }
  return undefined;
}

function buildSeries(
  type: 'line' | 'bar',
  xAxisData: string[],
  groups: Map<string, ChartBucket[]>,
  stacked = false,
  area = false,
  areaOpacity = 0.13,
): unknown[] {
  return Array.from(groups.entries())
    .sort(([a], [b]) => (a || '').localeCompare(b || ''))
    .map(([name, buckets]) => {
      const byX = new Map(buckets.map((b) => [String(b.x), b.y]));
      const color = colorForEntity(name || 'value');
      const data = xAxisData.map((x) => byX.get(x) ?? null);
      const base: Record<string, unknown> = {
        name: name || 'value',
        type,
        stack: stacked ? 'total' : undefined,
        itemStyle: { color },
        emphasis: { focus: 'series' },
        data,
      };
      if (type === 'line') {
        base.lineStyle = { color, width: 2 };
        base.showSymbol = false;
        base.symbol = 'circle';
        if (area) {
          base.areaStyle = { color, opacity: areaOpacity };
        }
        base.markPoint = lastPointMarker(xAxisData, byX, color);
      }
      return base;
    });
}

function timeSeriesOption(series: ChartSeries): EChartsCoreOption {
  const groups = groupBySeries(series.buckets);
  const xAxisData = sortedUnique(series.buckets.map((b) => String(b.x)));
  return {
    aria: { enabled: true },
    tooltip: baseTooltip,
    legend: legendFor(groups.size),
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
    legend: legendFor(groups.size),
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
    legend: legendFor(groups.size),
    grid: { ...baseGrid, bottom: '12%' },
    xAxis: { ...baseXAxis, name: series.xLabel, data: xAxisData },
    yAxis: { ...baseYAxis, name: series.yLabel },
    dataZoom: baseDataZoom,
    series: buildSeries('line', xAxisData, groups, true, true, 0.1),
    animation: false,
  } as EChartsCoreOption;
}

function histogramOption(series: ChartSeries): EChartsCoreOption {
  const xAxisData = sortedUnique(series.buckets.map((b) => String(b.x)));
  const byX = new Map(series.buckets.map((b) => [String(b.x), b.y]));
  const color = colorForEntity(series.seriesId || series.label);
  return {
    aria: { enabled: true },
    tooltip: baseTooltip,
    grid: baseGrid,
    xAxis: { ...baseXAxis, name: series.xLabel, data: xAxisData },
    yAxis: { ...baseYAxis, name: series.yLabel },
    series: [
      {
        name: series.label,
        type: 'bar',
        itemStyle: { color },
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
    legend: legendFor(groups.size),
    grid: { ...baseGrid, bottom: '12%' },
    xAxis: { ...baseXAxis, name: series.xLabel, data: xAxisData },
    yAxis: { ...baseYAxis, name: series.yLabel },
    dataZoom: baseDataZoom,
    series: buildSeries('line', xAxisData, groups, false, true, 0.13),
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
      backgroundColor: TOOLTIP_SURFACE,
      borderColor: TOOLTIP_BORDER,
      textStyle: { color: inkTokens.inkPrimary },
      formatter: (params: unknown) => {
        const p = params as { value?: [number | string, number, string] };
        const value = Array.isArray(p.value) ? p.value[1] : null;
        return `${p.value?.[2] ?? ''}: ${value === null ? '—' : formatCompactNumber(value as number)}`;
      },
    },
    legend: undefined,
    grid: baseGrid,
    xAxis: {
      ...baseXAxis,
      type: xAxisType,
      name: series.xLabel,
      data: xAxisType === 'category' ? xValues : undefined,
    },
    yAxis: { ...baseYAxis, name: series.yLabel },
    series: [
      {
        name: series.label,
        type: 'scatter',
        itemStyle: { color: colorForEntity(series.label) },
        data,
      },
    ],
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

  const values = series.buckets.map((b) => b.y).filter((v): v is number => v !== null);
  const maxValue = values.length > 0 ? Math.max(1, ...values) : 1;

  return {
    aria: { enabled: true },
    tooltip: { position: 'top', backgroundColor: TOOLTIP_SURFACE, borderColor: TOOLTIP_BORDER },
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
      inRange: { color: [...rampTokens] },
      textStyle: { color: AXIS_TEXT_COLOR },
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

/**
 * Horizontal bar list: a track (`TRACK_COLOR`) behind a filled, end-radiused
 * bar per row, value labels in plain ink to the right (never series-colored
 * text), and a pixel floor (`barMinHeight`) so tiny values stay visible.
 * Buckets with a missing (`null`) value still get a row — a track-only bar
 * labeled "—" — rather than being omitted (which would read as "this entity
 * doesn't exist") or drawn as a zero-length bar conflated with a measured
 * `0` — see `.agents/rules/missing-is-never-zero.md`.
 */
function horizontalBarOption(series: ChartSeries): EChartsCoreOption {
  const present = series.buckets.filter((b) => b.y !== null);
  const missing = series.buckets.filter((b) => b.y === null);
  const sorted = [...present].sort((a, b) => (b.y as number) - (a.y as number));
  const rows = [...sorted, ...missing];
  const categories = rows.map((b) => b.label || String(b.x));
  const data = rows.map((b) => {
    const rowLabel = b.label || String(b.x);
    if (b.y === null) {
      return {
        value: 0,
        itemStyle: { color: 'transparent' },
        label: { formatter: () => '—' },
        // Item-trigger tooltips default to the raw numeric `value` (0) — a
        // full per-datum formatter override (not just `valueFormatter`,
        // which item-level tooltip config does not reliably honor) so
        // hovering a missing row never reads "0", matching the "—" bar
        // label. See .agents/rules/missing-is-never-zero.md.
        tooltip: { formatter: () => `${rowLabel}: —` },
      };
    }
    return {
      value: b.y,
      itemStyle: {
        color: colorForEntity(b.series ?? b.label ?? String(b.x)),
        borderRadius: [0, 5, 5, 0],
      },
    };
  });

  return {
    aria: { enabled: true },
    tooltip: { ...baseTooltip, trigger: 'item', axisPointer: undefined },
    grid: { left: '3%', right: '14%', top: '4%', bottom: '4%', containLabel: true },
    xAxis: { type: 'value', show: false, splitLine: { show: false } },
    yAxis: {
      type: 'category',
      inverse: true,
      data: categories,
      axisLabel: { color: LEGEND_TEXT_COLOR },
      axisLine: { show: false },
      axisTick: { show: false },
      splitLine: { show: false },
    },
    series: [
      {
        name: series.label,
        type: 'bar',
        data,
        barMinHeight: 4,
        barWidth: '60%',
        showBackground: true,
        backgroundStyle: { color: TRACK_COLOR, borderRadius: [0, 5, 5, 0] },
        label: {
          show: true,
          position: 'right',
          color: inkTokens.inkPrimary,
          formatter: (p: unknown) => formatCompactNumber((p as { value: number }).value ?? 0),
        },
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
    legend: undefined,
    grid: baseGrid,
    xAxis: { ...baseXAxis, name: series.xLabel, data: categories },
    yAxis: { ...baseYAxis, name: series.yLabel },
    series: [
      {
        name: series.label,
        type: 'boxplot',
        itemStyle: {
          color: colorForEntity(series.label),
          borderColor: colorForEntity(series.label),
        },
        data,
      },
    ],
    animation: false,
  } as EChartsCoreOption;
}

function distributionOption(series: ChartSeries): EChartsCoreOption {
  return histogramOption(series);
}

function funnelOption(series: ChartSeries): EChartsCoreOption {
  const data = series.buckets
    .filter((b) => b.y !== null)
    .map((b) => ({
      name: String(b.x),
      value: b.y as number,
      itemStyle: { color: colorForEntity(b.series ?? String(b.x)) },
    }))
    .sort((a, b) => b.value - a.value);

  return {
    aria: { enabled: true },
    tooltip: {
      trigger: 'item',
      backgroundColor: TOOLTIP_SURFACE,
      borderColor: TOOLTIP_BORDER,
      textStyle: { color: inkTokens.inkPrimary },
      formatter: '{b}: {c}',
    },
    legend: legendFor(data.length),
    series: [{ name: series.label, type: 'funnel', data }],
    animation: false,
  } as EChartsCoreOption;
}

function annotatedTimelineOption(series: ChartSeries): EChartsCoreOption {
  const option = timeSeriesOption(series) as Record<string, unknown>;
  const markLines = (series.annotations ?? []).map((a) => ({
    xAxis: a.position,
    label: { formatter: a.label, color: AXIS_TEXT_COLOR },
    lineStyle: { type: 'dashed', color: BASELINE_COLOR },
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
    case 'horizontal_bar':
      return horizontalBarOption(series);
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
        legend: undefined,
        grid: baseGrid,
        xAxis: { ...baseXAxis, name: series.xLabel },
        yAxis: { ...baseYAxis, name: series.yLabel },
        animation: false,
      } as EChartsCoreOption;
  }
}
