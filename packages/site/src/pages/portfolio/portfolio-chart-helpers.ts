// TODO(#142 / DS-B4): this direct import of the Claude-specific
// `tryMetricIdToLabel` violates the AnalyticsDataSource boundary
// (`.agents/rules/no-canonical-metrics-in-lit.md`). It is repointed here
// from the pre-split `@lucasschirm/sal-transformer` to
// `@lucasschirm/sal-claude-transformer` as an interim step for the DS-F5
// (#154) package split; #142 should remove this import entirely and route
// label lookup through AnalyticsDataSource instead.
import { tryMetricIdToLabel } from '@lucasschirm/sal-claude-transformer';
import type {
  ComponentUtilizationPage,
  ComponentUtilizationRow,
  MetricValueDto,
  ModelHarnessCohortPage,
  PortfolioOverview,
  PortfolioTrendSeries,
  ProjectListItem,
  ProjectListPage,
  TimeSeriesPoint,
} from '@lucasschirm/sal-db';
import type { ChartBucket, ChartSeries } from '../../components/charts/chart-types';
import { formatChartValue } from '../../components/charts/chart-types';
import { componentHref } from '../component-ecosystem/component-ecosystem-params';
import type { PortfolioParams, SessionsScope } from './portfolio-params';
import { buildPortfolioHash, evidenceLinkHref } from './portfolio-params';

// ---------------------------------------------------------------------------
// Sessions scope filtering (shared by portfolio and project-behavior)
// ---------------------------------------------------------------------------

/**
 * Metric IDs are shaped `<harness>:<category>:...` consistently across every
 * harness transformer (e.g. `claude:tokens:total:root_only` and
 * `devin:tokens:total:root_only`, or `claude:duration:wall_ms:root_only` and
 * `devin:duration:wall_ms:root_only` — see claude-transformer's
 * `claude-code-metrics.ts` and devin-transformer's `metrics/definitions.ts`).
 * Category matching must key off this domain segment, not a hardcoded
 * harness prefix, so chart helpers work for any harness's metric IDs.
 */
function metricDomainSegments(metricId: string): string[] {
  return metricId.split(':').slice(1);
}

/** Whether a metric ID belongs to the token usage chart, for any harness. */
export function isTokenMetric(metricId: string): boolean {
  return metricDomainSegments(metricId)[0] === 'tokens';
}

/**
 * Strips the trailing scope suffix (" (root-only)" / " (inclusive)") from a
 * metric label. The scope is already conveyed by the Sessions filter, so the
 * suffix is redundant in chart legends and axis labels.
 */
export function stripScopeSuffix(label: string): string {
  return label.replace(/\s*\((root-only|inclusive)\)\s*$/, '');
}

/** tryMetricIdToLabel with the scope suffix stripped. */
export function metricLabel(metricId: string, fallback?: string): string {
  const raw = tryMetricIdToLabel(metricId) ?? fallback ?? metricId;
  const stripped = stripScopeSuffix(raw);
  // The duration metric is stored in minutes; surface the unit in the label
  // so chart axes and tooltips read "Session duration (min)".
  if (isDurationMetric(metricId)) return 'Session duration (min)';
  return stripped;
}

/**
 * Returns true when the metric is the wall-clock duration metric, for any
 * harness, so chart helpers can round displayed values to 0 decimals
 * (minutes are integers in practice and fractional minutes add noise).
 */
export function isDurationMetric(metricId: string): boolean {
  const [category, subcategory] = metricDomainSegments(metricId);
  return category === 'duration' && subcategory === 'wall_ms';
}

/**
 * Filters and transforms TimeSeriesPoint[] by sessions scope.
 * - `main` → root_only metrics only
 * - `all` → inclusive metrics only
 * - `sub_agents` → computes inclusive - root_only per metric/time
 */
export function filterByScope(
  points: readonly TimeSeriesPoint[],
  scope: SessionsScope,
): TimeSeriesPoint[] {
  if (scope === 'main') {
    return points.filter((p) => p.metricId.endsWith(':root_only'));
  }
  if (scope === 'all') {
    return points.filter((p) => p.metricId.endsWith(':inclusive'));
  }
  // sub_agents: compute inclusive - root_only for each metric base + time
  const inclusive = new Map<string, TimeSeriesPoint>();
  const rootOnly = new Map<string, TimeSeriesPoint>();
  for (const p of points) {
    const base = p.metricId.replace(/:(root_only|inclusive)$/, '');
    const key = `${base}|${p.time}`;
    if (p.metricId.endsWith(':inclusive')) {
      inclusive.set(key, p);
    } else if (p.metricId.endsWith(':root_only')) {
      rootOnly.set(key, p);
    }
  }
  const result: TimeSeriesPoint[] = [];
  for (const [key, incPoint] of inclusive) {
    const rootPoint = rootOnly.get(key);
    const base = incPoint.metricId.replace(/:inclusive$/, '');
    const subAgentMetricId = `${base}:sub_agents`;
    const incValue = incPoint.value ?? 0;
    const rootValue = rootPoint?.value ?? 0;
    const delta = incValue - rootValue;
    result.push({
      time: incPoint.time,
      value: delta,
      metricId: subAgentMetricId,
      label: metricLabel(`${base}:root_only`, incPoint.label),
      comparabilityGroupId: incPoint.comparabilityGroupId,
    });
  }
  return result;
}

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
  return metricLabel(metric.metricId, metric.label);
}

export function trendToChartSeries(
  trend: PortfolioTrendSeries,
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
    seriesId: 'trend',
    label: 'Session Metrics',
    chartType: 'time_series',
    xLabel: 'Time',
    yLabel: 'Value',
    buckets,
  };
}

export function tokenTrendToChartSeries(
  trend: PortfolioTrendSeries,
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
    seriesId: 'token-trend',
    label: 'Token usage trends',
    chartType: 'time_series',
    xLabel: 'Time',
    yLabel: 'Tokens',
    buckets,
  };
}

export function componentUtilizationToChartSeries(
  page: ComponentUtilizationPage,
  params?: PortfolioParams,
): ChartSeries {
  const buckets: ChartBucket[] = page.items.map((row: ComponentUtilizationRow) => ({
    x: row.name || row.componentId,
    y: row.sessionCount,
    label: `${row.name || row.componentId} (${row.kind})`,
    series: row.kind,
    evidenceLink: {
      label: `Open ${row.name || row.componentId}`,
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
    label: 'Artifact Utilization',
    chartType: 'stacked_bar',
    xLabel: 'Artifact',
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
  const skillCount = overview.componentCounts['skill'] ?? 0;
  const otherComponentCount = Object.entries(overview.componentCounts)
    .filter(([kind]) => kind !== 'skill')
    .reduce((sum, [, count]) => sum + count, 0);

  const subForMetric: Record<string, string> = {
    'portfolio-project-count': `${formatChartValue(overview.totalTokens)} Tokens`,
    'portfolio-session-count': `${overview.modelCount} Models`,
    'portfolio-component-count': `${overview.harnessCount} Harness`,
    'portfolio-unused-components': `${skillCount} Skills • ${otherComponentCount} Others`,
  };

  return overview.headlineMetrics.map((metric) => {
    const link = metric.evidenceLinks[0];
    return {
      metricId: metric.metricId,
      label: metricLabel(metric.metricId, metric.label),
      value: formatMetricValue(metric),
      sub: subForMetric[metric.metricId] ?? '',
      href: link ? evidenceLinkHref(link, params) : undefined,
    };
  });
}

export interface ProjectRowView {
  projectId: string;
  name: string;
  sessionCount: number;
  harness: string;
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
    href: `#/projects/${project.name}?returnContext=${encodeURIComponent(
      buildPortfolioHash(params).slice(1),
    )}`,
  }));
}
