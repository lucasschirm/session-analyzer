import type {
  ComponentDistributionPage,
  ComponentDistributionRow,
  ComponentEcosystemSummary,
  ComponentProjectSessionPage,
  ComponentScopePage,
  ComponentUtilizationDetail,
  ComponentVersionPage,
  LifecycleComparisonPage,
  MetricValueDto,
} from '@lucasschirm/sal-db';
import type { ChartBucket, ChartSeries } from '../../components/charts/chart-types';
import { formatChartValue } from '../../components/charts/chart-types';
import type { ComponentEcosystemParams } from './component-ecosystem-params';
import { buildComponentEcosystemQueryString, componentHref } from './component-ecosystem-params';

export interface MetricCardView {
  metricId: string;
  label: string;
  value: string;
  sub: string;
  href?: string;
  icon?: string;
}

function coverageN(metric: { knownN: number; eligibleN: number }): string {
  return `n=${metric.knownN}${metric.knownN < metric.eligibleN ? ` of ${metric.eligibleN}` : ''}`;
}

function formatMetricValue(metric: MetricValueDto): string {
  return formatChartValue(metric.value, metric.unit);
}

export function countsByKindToChartSeries(summary: ComponentEcosystemSummary): ChartSeries {
  const buckets: ChartBucket[] = Object.entries(summary.countsByKind).map(([kind, count]) => ({
    x: kind,
    y: count,
    label: `${kind}: ${count}`,
    series: kind,
  }));

  return {
    seriesId: 'component-counts-by-kind',
    label: 'Components by kind',
    chartType: 'stacked_bar',
    xLabel: 'Kind',
    yLabel: 'Count',
    buckets,
  };
}

export function topByUtilizationToChartSeries(
  summary: ComponentEcosystemSummary,
  kindFilter?: string,
  returnParams?: ComponentEcosystemParams,
): ChartSeries {
  const metrics = kindFilter
    ? summary.topByUtilization.filter((m) => m.label.startsWith(`${kindFilter} `))
    : summary.topByUtilization;

  const buckets: ChartBucket[] = metrics.map((metric) => {
    const [kind, ...rest] = metric.label.split(' ');
    const componentId = rest.join(' ');
    return {
      x: componentId,
      y: metric.value,
      label: `${metric.label}: ${formatMetricValue(metric)}`,
      series: kind ?? 'component',
      evidenceLink: returnParams
        ? {
            label: `Open ${componentId}`,
            href: componentHref(componentId, { ...returnParams, kind }),
          }
        : undefined,
    };
  });

  return {
    seriesId: 'top-components-by-utilization',
    label: kindFilter ? `Top ${kindFilter} components` : 'Top components by utilization',
    chartType: 'stacked_bar',
    xLabel: 'Component',
    yLabel: 'Invocations',
    unit: 'count',
    buckets,
  };
}

export function summaryToMetricCards(summary: ComponentEcosystemSummary): MetricCardView[] {
  return [
    {
      metricId: 'total-components',
      label: 'Total components',
      value: formatChartValue(Object.values(summary.countsByKind).reduce((a, b) => a + b, 0)),
      sub: coverageN(summary.token),
    },
    ...Object.entries(summary.countsByKind).map(([kind, count]) => ({
      metricId: `count-${kind}`,
      label: `${kind} components`,
      value: formatChartValue(count),
      sub: '',
    })),
  ];
}

export function versionsToChartSeries(page: ComponentVersionPage): ChartSeries {
  const buckets: ChartBucket[] = [];
  for (const row of page.items) {
    buckets.push({
      x: row.version,
      y: row.sessionCount,
      label: `${row.version}: ${row.sessionCount} sessions`,
      series: 'Sessions',
    });
    buckets.push({
      x: row.version,
      y: row.projectCount,
      label: `${row.version}: ${row.projectCount} projects`,
      series: 'Projects',
    });
  }

  return {
    seriesId: 'component-versions',
    label: 'Versions by exposure',
    chartType: 'stacked_bar',
    xLabel: 'Version',
    yLabel: 'Count',
    unit: 'count',
    buckets,
  };
}

export interface VersionRowView {
  version: string;
  sessionCount: number;
  projectCount: number;
  firstSeen?: string;
  lastSeen?: string;
  href: string;
}

export function versionsToRows(
  page: ComponentVersionPage,
  params: ComponentEcosystemParams,
): VersionRowView[] {
  return page.items.map((row) => ({
    version: row.version,
    sessionCount: row.sessionCount,
    projectCount: row.projectCount,
    firstSeen: row.firstSeen,
    lastSeen: row.lastSeen,
    href: componentHref(params.component ?? '', { ...params, version: row.version }),
  }));
}

export function scopesToChartSeries(page: ComponentScopePage): ChartSeries {
  const buckets: ChartBucket[] = page.items.map((row) => ({
    x: row.scope,
    y: row.installationCount,
    label: `${row.scope}: ${row.installationCount}`,
    series: 'Installations',
  }));

  return {
    seriesId: 'component-scopes',
    label: 'Installation scope',
    chartType: 'stacked_bar',
    xLabel: 'Scope',
    yLabel: 'Installations',
    unit: 'count',
    buckets,
  };
}

export interface ScopeRowView {
  scope: string;
  installationCount: number;
}

export function scopesToRows(page: ComponentScopePage): ScopeRowView[] {
  return page.items.map((row) => ({
    scope: row.scope,
    installationCount: row.installationCount,
  }));
}

export function utilizationToMetricCards(detail: ComponentUtilizationDetail): MetricCardView[] {
  return [
    {
      metricId: detail.loadRate.metricId,
      label: detail.loadRate.label,
      value: formatMetricValue(detail.loadRate),
      sub: coverageN(detail.loadRate),
    },
    {
      metricId: detail.invokeRate.metricId,
      label: detail.invokeRate.label,
      value: formatMetricValue(detail.invokeRate),
      sub: coverageN(detail.invokeRate),
    },
    {
      metricId: detail.overhead.metricId,
      label: detail.overhead.label,
      value: formatMetricValue(detail.overhead),
      sub: coverageN(detail.overhead),
    },
  ];
}

export function distributionToChartSeries(row: ComponentDistributionRow): ChartSeries {
  const buckets: ChartBucket[] = row.values.map((metric) => ({
    x: metric.label,
    y: metric.value,
    label: `${metric.label}: ${formatMetricValue(metric)}`,
    series: row.metricId,
  }));

  return {
    seriesId: `distribution-${row.metricId}`,
    label: `Distribution: ${row.metricId}`,
    chartType: 'funnel',
    xLabel: 'Outcome',
    yLabel: 'Count',
    unit: 'count',
    buckets,
  };
}

export function distributionsToChartSeries(page: ComponentDistributionPage): ChartSeries[] {
  return page.items.map((row) => distributionToChartSeries(row));
}

export interface ProjectSessionRowView {
  projectId: string;
  sessionId: string;
  lastUsed?: string;
  metrics: string;
  projectHref: string;
  sessionHref: string;
}

export function projectSessionsToRows(
  page: ComponentProjectSessionPage,
  params: ComponentEcosystemParams,
): ProjectSessionRowView[] {
  return page.items.map((row) => ({
    projectId: row.projectId,
    sessionId: row.sessionId,
    lastUsed: row.lastUsed,
    metrics: row.metricValues.map((m) => `${m.label}: ${formatMetricValue(m)}`).join(' • '),
    projectHref: `#/projects/${row.projectId}/behavior?returnContext=${encodeURIComponent(
      buildComponentEcosystemQueryString(params),
    )}`,
    sessionHref: `#/sessions/${row.sessionId}`,
  }));
}

export interface LifecycleRowView {
  eventId: string;
  changeType: string;
  beforeVersion?: string;
  afterVersion?: string;
  affectedSessions: number;
  diffHref?: string;
}

export function lifecycleToChartSeries(page: LifecycleComparisonPage): ChartSeries {
  const buckets: ChartBucket[] = page.items.map((row) => ({
    x: row.eventId,
    y: row.affectedSessions,
    label: `${row.changeType}: ${row.beforeVersion ?? '—'} → ${row.afterVersion ?? '—'}`,
    series: row.changeType,
  }));

  return {
    seriesId: 'component-lifecycle',
    label: 'Lifecycle changes',
    chartType: 'stacked_bar',
    xLabel: 'Event',
    yLabel: 'Affected sessions',
    unit: 'count',
    buckets,
  };
}

export function lifecycleToRows(
  page: LifecycleComparisonPage,
  params: ComponentEcosystemParams,
): LifecycleRowView[] {
  return page.items.map((row) => ({
    eventId: row.eventId,
    changeType: row.changeType,
    beforeVersion: row.beforeVersion,
    afterVersion: row.afterVersion,
    affectedSessions: row.affectedSessions,
    diffHref:
      row.beforeVersion && row.afterVersion
        ? componentHref(params.component ?? '', {
            ...params,
            leftVersion: row.beforeVersion,
            rightVersion: row.afterVersion,
          })
        : undefined,
  }));
}
