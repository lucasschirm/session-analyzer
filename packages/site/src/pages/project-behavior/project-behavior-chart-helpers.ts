import type {
  ComparisonPage,
  ComparisonRow,
  ConfigurationTimeline,
  MetricValueDto,
  OutlierPage,
  OutlierRow,
  ProjectBehaviorSummary,
  SessionTrendSeries,
} from '@lucasschirm/sal-db';
import type { ChartBucket, ChartSeries } from '../../components/charts/chart-types';
import { formatChartValue } from '../../components/charts/chart-types';
import { formatFullNumber } from '../../lib/format';
import {
  filterByScope,
  isDurationMetric,
  isTokenMetric,
  metricLabel,
} from '../portfolio/portfolio-chart-helpers';
import type { SessionsScope } from '../portfolio/portfolio-params';
import type { ProjectBehaviorParams } from './project-behavior-params';
import { evidenceLinkHref } from './project-behavior-params';

export function formatMetricValue(metric: MetricValueDto | undefined): string {
  if (!metric) return '—';
  if (isDurationMetric(metric.metricId) && metric.value !== null) {
    return formatChartValue(Math.round(metric.value), metric.unit);
  }
  return formatChartValue(metric.value, metric.unit);
}

function coverageN(metric: MetricValueDto): string {
  return `n=${metric.knownN}${metric.knownN < metric.eligibleN ? ` of ${metric.eligibleN}` : ''}`;
}

export interface MetricCardView {
  metricId: string;
  label: string;
  value: string;
  sub: string;
  href?: string;
  valueTitle?: string;
}

export function summaryToMetricCards(
  summary: ProjectBehaviorSummary,
  params?: ProjectBehaviorParams,
): MetricCardView[] {
  return summary.headlineMetrics.map((metric) => {
    const link =
      metric.evidenceLinks.find((l) => l.entityType === 'session') ?? metric.evidenceLinks[0];
    return {
      metricId: metric.metricId,
      label: metricLabel(metric.metricId, metric.label),
      value: formatMetricValue(metric),
      sub: `${coverageN(metric)} • ${metric.coverage} • ${metric.confidence}`,
      href: link ? evidenceLinkHref(link, params) : undefined,
      valueTitle: metric.value !== null ? formatFullNumber(metric.value) : '',
    };
  });
}

export function sessionTrendToChartSeries(
  trend: SessionTrendSeries,
  scope: SessionsScope = 'main',
): ChartSeries {
  const filtered = filterByScope(trend.series, scope).filter((p) => !isTokenMetric(p.metricId));
  const buckets: ChartBucket[] = filtered.map((p) => ({
    x: p.time,
    y: isDurationMetric(p.metricId) && p.value !== null ? Math.round(p.value) : p.value,
    label: `${p.time}: ${formatChartValue(p.value)}`,
    series: metricLabel(p.metricId, p.label),
  }));

  return {
    seriesId: 'session-trend',
    label: 'Session Metrics',
    chartType: 'time_series',
    xLabel: 'Time',
    yLabel: 'Value',
    buckets,
  };
}

export function sessionTokenTrendToChartSeries(
  trend: SessionTrendSeries,
  scope: SessionsScope = 'main',
): ChartSeries {
  const filtered = filterByScope(trend.series, scope).filter((p) => isTokenMetric(p.metricId));
  const buckets: ChartBucket[] = filtered.map((p) => ({
    x: p.time,
    y: p.value,
    label: `${p.time}: ${formatChartValue(p.value)}`,
    series: metricLabel(p.metricId, p.label),
  }));

  return {
    seriesId: 'session-token-trend',
    label: 'Token usage trends',
    chartType: 'time_series',
    xLabel: 'Time',
    yLabel: 'Tokens',
    buckets,
  };
}

export function configurationTimelineToChartSeries(timeline: ConfigurationTimeline): ChartSeries {
  const buckets: ChartBucket[] = timeline.events.map((e) => ({
    x: e.captureTime ?? String(e.sequence),
    y: e.sequence,
    label: `${e.changeType} ${e.componentKind} ${e.componentId}${
      e.toVersion ? ` ${e.toVersion}` : ''
    }`.trim(),
    series: e.componentKind,
  }));
  const annotations = timeline.events.map((e) => ({
    position: e.captureTime ?? String(e.sequence),
    label: `${e.changeType} ${e.componentId}`,
    type: 'configuration' as const,
  }));

  return {
    seriesId: 'configuration-timeline',
    label: 'Configuration timeline',
    chartType: 'annotated_timeline',
    xLabel: 'Time',
    yLabel: 'Changes',
    buckets,
    annotations,
  };
}

export interface OutlierRowView extends OutlierRow {
  href: string;
}

export function outlierPageToRows(
  page: OutlierPage,
  params?: ProjectBehaviorParams,
): OutlierRowView[] {
  return page.items.map((row) => {
    const sessionLink = row.evidenceLinks.find((l) => l.entityType === 'session');
    return {
      ...row,
      href: sessionLink ? evidenceLinkHref(sessionLink, params) : `#/sessions/${row.sessionId}`,
    };
  });
}

export interface ComparisonRowView extends ComparisonRow {
  regression: boolean;
  absoluteDelta: MetricValueDto | undefined;
  relativeDelta: MetricValueDto | undefined;
}

export function comparisonPageToRows(page: ComparisonPage): ComparisonRowView[] {
  return page.items.map((row) => ({
    ...row,
    regression: row.metricValues.find((m) => m.metricId === 'regression')?.value === 1,
    absoluteDelta: row.metricValues.find((m) => m.metricId === 'absolute-delta'),
    relativeDelta: row.metricValues.find((m) => m.metricId === 'relative-delta'),
  }));
}
