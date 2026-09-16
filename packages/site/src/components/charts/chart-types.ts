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

export interface ChartClickDetail {
  readonly dataIndex?: number;
  readonly name?: string;
  readonly seriesName?: string;
  readonly value?: unknown;
  readonly evidenceLink?: ChartEvidenceLink;
  readonly messageId?: string;
  readonly messageIndex?: number;
}

export interface ChartBucket {
  readonly x: string | number;
  readonly y: number | null;
  readonly label: string;
  readonly series?: string;
  readonly evidenceLink?: ChartEvidenceLink;
  /**
   * Optional per-bucket fill color, for charts that encode a category *within*
   * a series (e.g. a context-growth bar colored by the message's Tool / Skill /
   * Agent domain) while keeping one legend entry per series. Never the only
   * carrier of that category: the same value must appear in `label` and the
   * textual/table fallback, per the color-independence invariant in
   * `components/charts/AGENTS.md`.
   */
  readonly color?: string;
}

export interface ChartAnnotation {
  readonly position: string | number;
  readonly label: string;
  readonly type: 'lifecycle' | 'compaction' | 'mode_change' | 'configuration';
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
  readonly seriesOrder?: readonly string[];
  readonly colors?: readonly string[];
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
  // Minutes are always presented whole ("62.683 minutes" -> "63 minutes").
  // Session duration is a wall-clock difference whose fractional part carries
  // nothing a reader can act on, and the metric card labels the unit explicitly.
  // Display-side rounding only — the stored metric value is never changed
  // (packages/site/src/lib/AGENTS.md: formatting is presentation, not
  // derivation).
  const effective =
    unit === 'minutes' || unit === 'minute' || unit === 'min' ? Math.round(value) : value;
  const formatted = formatCompactNumber(effective);
  if (unit === 'usd') return `$${formatted}`;
  if (unit === 'percent' || unit === 'ratio') return `${formatted}${unit === 'percent' ? '%' : ''}`;
  if (unit && unit !== 'count') return `${formatted} ${unit}`;
  return formatted;
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
    const max = values.reduce((m, v) => Math.max(m, v), -Infinity);
    peak += `${key} peaks at ${formatChartValue(max, series.unit)}. `;
  }

  return `${stateText}${series.chartType.replaceAll('_', ' ')} chart "${series.label}" showing ${known} of ${total} buckets across ${bySeries.size} series, from ${series.buckets[0]?.x ?? '?'} to ${series.buckets[series.buckets.length - 1]?.x ?? '?'}. ${peak}`.trim();
}

export type { EChartsCoreOption };
