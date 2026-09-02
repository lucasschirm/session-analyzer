import type { EChartsCoreOption } from 'echarts/core';
import { formatCompactNumber } from '../../lib/format';

/**
 * Chart states every analytics chart can surface. These are intentionally
 * distinct from the chart's visual state so that screen-reader users and
 * keyboard-only users get the same information as sighted users.
 */
export type ChartState =
  | 'loading'
  | 'empty'
  | 'partial'
  | 'unavailable'
  | 'unsupported'
  | 'integrity-error'
  | 'stale-rollup'
  | 'error';

export const CHART_TYPE_OPTIONS = [
  'time_series',
  'stacked_bar',
  'stacked_area',
  'histogram',
  'percentile_bands',
  'scatter',
  'heatmap',
  'horizontal_bar',
  'box',
  'distribution',
  'funnel',
  'annotated_timeline',
] as const;

export type ChartType = (typeof CHART_TYPE_OPTIONS)[number];

export interface ChartEvidenceLink {
  readonly label: string;
  readonly href: string;
}

export interface ChartBucket {
  readonly x: string | number;
  readonly y: number | null;
  readonly label: string;
  readonly series?: string;
  readonly evidenceLink?: ChartEvidenceLink;
}

export interface ChartAnnotation {
  readonly position: string | number;
  readonly label: string;
  /** `threshold` draws a horizontal (y-axis) dashed reference line at
   * `position`, e.g. a registry-defined review threshold; every other kind
   * draws a vertical (x-axis) line at a point in time. */
  readonly type: 'lifecycle' | 'compaction' | 'mode_change' | 'configuration' | 'threshold';
}

/**
 * Generic chart series DTO consumed by the analytics chart components.
 * Carries no SQL types and performs no metric derivation.
 */
export interface ChartSeries {
  readonly seriesId: string;
  readonly label: string;
  readonly chartType: ChartType;
  readonly xLabel: string;
  readonly yLabel: string;
  readonly unit?: string;
  readonly buckets: readonly ChartBucket[];
  readonly annotations?: readonly ChartAnnotation[];
}

export interface TableRow {
  readonly x: string;
  readonly y: string;
  readonly series: string;
  readonly label: string;
  readonly evidenceHref?: string;
}

export function stateLabel(state: ChartState): string {
  switch (state) {
    case 'loading':
      return 'Loading chart data';
    case 'empty':
      return 'No data';
    case 'partial':
      return 'Partial data';
    case 'unavailable':
      return 'Data unavailable';
    case 'unsupported':
      return 'Unsupported view';
    case 'integrity-error':
      return 'Data integrity error';
    case 'stale-rollup':
      return 'Stale rollup';
    case 'error':
      return 'Chart error';
    default:
      return 'Unknown state';
  }
}

export function stateIcon(state: ChartState): string {
  switch (state) {
    case 'loading':
      return '⏳';
    case 'empty':
      return '∅';
    case 'partial':
      return '◐';
    case 'unavailable':
      return '⊘';
    case 'unsupported':
      return '⚠';
    case 'integrity-error':
      return '⛒';
    case 'stale-rollup':
      return '⧗';
    case 'error':
      return '✕';
    default:
      return '?';
  }
}

export function formatChartValue(value: number | null, unit = ''): string {
  if (value === null || Number.isNaN(value)) return '—';
  const formatted = formatCompactNumber(value);
  if (unit === 'usd') return `$${formatted}`;
  if (unit === 'percent' || unit === 'ratio') return `${formatted}${unit === 'percent' ? '%' : ''}`;
  if (unit && unit !== 'count') return `${formatted} ${unit}`;
  return formatted;
}

export type HeatmapCellKind = 'missing' | 'zero' | 'low' | 'high';

/**
 * Classifies a heatmap cell's value against the sequential ramp.
 *
 * `missing` (native value unavailable, `y === null`) is never conflated with
 * a measured `zero` — see `.agents/rules/missing-is-never-zero.md`. `high`
 * marks cells at or above ~55% ramp intensity, where in-cell text switches
 * to dark ink for contrast against the lighter ramp steps.
 */
export function classifyHeatmapCell(value: number | null, max: number): HeatmapCellKind {
  if (value === null) return 'missing';
  if (value === 0) return 'zero';
  const fraction = max > 0 ? value / max : 0;
  return fraction >= 0.55 ? 'high' : 'low';
}

export function toTableRows(series: ChartSeries): TableRow[] {
  return series.buckets.map((bucket) => ({
    x: String(bucket.x),
    y: formatChartValue(bucket.y, series.unit),
    series: bucket.series ?? series.label,
    label: bucket.label,
    evidenceHref: bucket.evidenceLink?.href,
  }));
}

export function textualSummary(series: ChartSeries, state?: ChartState | null): string {
  const known = series.buckets.filter((b) => b.y !== null).length;
  const total = series.buckets.length;
  const stateText = state ? `${stateLabel(state)}. ` : '';

  if (total === 0) {
    return `${stateText}Chart "${series.label}" has no data points.`;
  }

  const bySeries = new Map<string, number[]>();
  for (const bucket of series.buckets) {
    if (bucket.y === null) continue;
    const key = bucket.series ?? 'value';
    const values = bySeries.get(key) ?? [];
    values.push(bucket.y);
    bySeries.set(key, values);
  }

  let peak = '';
  for (const [key, values] of bySeries) {
    const max = Math.max(...values);
    peak += `${key} peaks at ${formatChartValue(max, series.unit)}. `;
  }

  return `${stateText}${series.chartType.replaceAll('_', ' ')} chart "${series.label}" showing ${known} of ${total} buckets across ${bySeries.size} series, from ${series.buckets[0]?.x ?? '?'} to ${series.buckets[series.buckets.length - 1]?.x ?? '?'}. ${peak}`.trim();
}

export type { EChartsCoreOption };
