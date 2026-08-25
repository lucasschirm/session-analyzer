import type {
  ComponentUtilizationPage,
  ComponentUtilizationRow,
  MetricValueDto,
  ModelHarnessCohortPage,
  PortfolioOverview,
  PortfolioTrendSeries,
  ProjectListItem,
  ProjectListPage,
} from '@lucasschirm/sal-db';
import type { ChartBucket, ChartSeries } from '../../components/charts/chart-types';
import { formatChartValue } from '../../components/charts/chart-types';
import { componentHref } from '../component-ecosystem/component-ecosystem-params';
import type { PortfolioParams } from './portfolio-params';
import { buildPortfolioHash, evidenceLinkHref } from './portfolio-params';

function valueForMetric(
  row: { metricValues: readonly MetricValueDto[] },
  metricId?: string,
): number | null {
  if (metricId) {
    return row.metricValues.find((m) => m.metricId === metricId)?.value ?? null;
  }
  return row.metricValues[0]?.value ?? null;
}

function _metricLabel(metric: MetricValueDto): string {
  return metric.label || metric.metricId;
}

export function trendToChartSeries(trend: PortfolioTrendSeries, metricId?: string): ChartSeries {
  const buckets: ChartBucket[] = trend.series
    .filter((p) => !metricId || p.metricId === metricId)
    .map((p) => ({
      x: p.time,
      y: p.value,
      label: `${p.time}: ${formatChartValue(p.value)}`,
      series: p.metricId,
    }));

  return {
    seriesId: metricId ?? 'trend',
    label: metricId ?? 'Trends',
    chartType: 'time_series',
    xLabel: 'Time',
    yLabel: 'Value',
    buckets,
  };
}

export function componentUtilizationToChartSeries(
  page: ComponentUtilizationPage,
  params?: PortfolioParams,
): ChartSeries {
  const buckets: ChartBucket[] = page.items.map((row: ComponentUtilizationRow) => ({
    x: row.componentId,
    y: row.sessionCount,
    label: `${row.componentId} (${row.kind})`,
    series: row.kind,
    evidenceLink: {
      label: `Open ${row.componentId}`,
      href: componentHref(row.componentId, {
        project: params?.project,
        harness: params?.harness,
        model: params?.model,
        mode: params?.mode,
        timeStart: params?.timeStart,
        timeEnd: params?.timeEnd,
        analysisRelease: params?.analysisRelease,
        comparabilityGroup: params?.comparabilityGroup,
        generation: params?.generation,
        kind: row.kind,
        origin: 'portfolio',
        returnContext: buildPortfolioHash(params ?? {}).slice(1) || undefined,
      }),
    },
  }));

  return {
    seriesId: 'component-utilization',
    label: 'Component Utilization',
    chartType: 'stacked_bar',
    xLabel: 'Component',
    yLabel: 'Sessions',
    buckets,
  };
}

export function modelHarnessCohortsToChartSeries(
  page: ModelHarnessCohortPage,
  metricId?: string,
): ChartSeries {
  const buckets: ChartBucket[] = page.items.map((row) => ({
    x: row.model,
    y: valueForMetric(row, metricId) ?? row.sessionCount,
    label: `${row.model} / ${row.harness}`,
    series: row.harness,
  }));

  return {
    seriesId: metricId ?? 'model-harness-cohorts',
    label: 'Model × Harness Cohorts',
    chartType: 'stacked_bar',
    xLabel: 'Model',
    yLabel: metricId ? 'Metric value' : 'Sessions',
    buckets,
  };
}

export interface MetricCardView {
  metricId: string;
  label: string;
  value: string;
  sub: string;
  href?: string;
}

function formatMetricValue(metric: MetricValueDto): string {
  return formatChartValue(metric.value, metric.unit);
}

function coverageN(metric: MetricValueDto): string {
  return `n=${metric.knownN}${metric.knownN < metric.eligibleN ? ` of ${metric.eligibleN}` : ''}`;
}

export function overviewToMetricCards(
  overview: PortfolioOverview,
  params: PortfolioParams,
): MetricCardView[] {
  return overview.headlineMetrics.map((metric) => {
    const link = metric.evidenceLinks[0];
    return {
      metricId: metric.metricId,
      label: metric.label || metric.metricId,
      value: formatMetricValue(metric),
      sub: `${coverageN(metric)} • ${metric.coverage} • ${metric.confidence}`,
      href: link ? evidenceLinkHref(link, params) : undefined,
    };
  });
}

export interface ProjectRowView {
  projectId: string;
  name: string;
  sessionCount: number;
  harness: string;
  source: string;
  completeness: string;
  finality: string;
  href: string;
}

export function projectListToRows(
  page: ProjectListPage,
  params: PortfolioParams,
): ProjectRowView[] {
  return page.items.map((project: ProjectListItem) => ({
    projectId: project.projectId,
    name: project.name,
    sessionCount: project.sessionCount,
    harness: project.harness,
    source: project.source,
    completeness: project.completeness,
    finality: project.finality,
    href: `#/projects/${project.projectId}/behavior?returnContext=${encodeURIComponent(
      buildPortfolioHash(params).slice(1),
    )}`,
  }));
}
