// TODO(#142 / DS-B4): see the same note in portfolio-chart-helpers.ts — this
// import is repointed to @lucasschirm/sal-claude-transformer as an interim
// step for the DS-F5 (#154) package split; #142 should remove it.
import { tryMetricIdToLabel } from '@lucasschirm/sal-claude-transformer';
import type {
  ComponentFactPage,
  ContextTimingSeries,
  MetricValueDto,
  RootChildBreakdown,
  SessionEvidenceSummary,
  SessionTree,
  SessionTreeNode,
} from '@lucasschirm/sal-db';
import type { ChartBucket, ChartSeries, TableRow } from '../../components/charts/chart-types';
import { formatChartValue } from '../../components/charts/chart-types';
import type { MetricCardView } from '../portfolio/portfolio-chart-helpers';
import type { SessionEvidenceParams } from './session-evidence-params';
import { evidenceLinkHref } from './session-evidence-params';

export function contextTimingToChartSeries(series: ContextTimingSeries): ChartSeries {
  const buckets: ChartBucket[] = [];
  for (const point of series.points) {
    const x = point.turnNumber;
    buckets.push({
      x,
      y: point.totalTokens,
      label: `Turn ${x}: total ${formatChartValue(point.totalTokens)}`,
      series: 'Total',
    });
    buckets.push({
      x,
      y: point.contextTokens,
      label: `Turn ${x}: context ${formatChartValue(point.contextTokens)}`,
      series: 'Context',
    });
    buckets.push({
      x,
      y: point.generationTokens,
      label: `Turn ${x}: generation ${formatChartValue(point.generationTokens)}`,
      series: 'Generation',
    });
  }

  return {
    seriesId: 'context-timing',
    label: 'Context and request timing',
    chartType: 'annotated_timeline',
    xLabel: 'Turn',
    yLabel: 'Tokens',
    buckets,
  };
}

export function componentFactsToChartSeries(page: ComponentFactPage): ChartSeries {
  const buckets: ChartBucket[] = page.items.map((row) => ({
    x: row.componentId,
    y: row.invocationCount,
    label: `${row.componentId} — ${row.invocationCount} invocations (${row.outcome})`,
    series: row.kind,
  }));

  return {
    seriesId: 'component-facts',
    label: 'Artifact invocations by kind',
    chartType: 'stacked_bar',
    xLabel: 'Artifact',
    yLabel: 'Invocations',
    buckets,
  };
}

export function rootChildToChartSeries(breakdown: RootChildBreakdown): ChartSeries {
  const buckets: ChartBucket[] = [
    {
      x: breakdown.root.sessionId,
      y: breakdown.root.childCount,
      label: `Root ${breakdown.root.sessionId} — ${breakdown.root.childCount} children`,
      series: 'root',
    },
    ...breakdown.children.map((child) => ({
      x: child.sessionId,
      y: child.childCount,
      label: `Child ${child.sessionId} — ${child.childCount} children`,
      series: 'child',
    })),
  ];

  return {
    seriesId: 'root-child',
    label: 'Root and child contribution',
    chartType: 'stacked_bar',
    xLabel: 'Session',
    yLabel: 'Children',
    buckets,
  };
}

function coverageN(metric: MetricValueDto): string {
  return `n=${metric.knownN}${metric.knownN < metric.eligibleN ? ` of ${metric.eligibleN}` : ''}`;
}

export function summaryToMetricCards(
  summary: SessionEvidenceSummary,
  params: SessionEvidenceParams,
): MetricCardView[] {
  return summary.headlineMetrics.map((metric) => {
    const link = metric.evidenceLinks[0];
    return {
      metricId: metric.metricId,
      label: tryMetricIdToLabel(metric.metricId) ?? metric.label,
      value: formatChartValue(metric.value, metric.unit),
      sub: `${coverageN(metric)} • ${metric.coverage} • ${metric.confidence}`,
      href: link ? evidenceLinkHref(link, params) : undefined,
    };
  });
}

export interface ComponentRowView {
  readonly componentId: string;
  readonly kind: string;
  readonly invocations: number;
  readonly outcome: string;
  readonly metrics: string;
}

export function componentFactsToRows(page: ComponentFactPage): ComponentRowView[] {
  return page.items.map((row) => ({
    componentId: row.componentId,
    kind: row.kind,
    invocations: row.invocationCount,
    outcome: row.outcome,
    metrics: row.metricValues
      .map((m) => `${m.label}: ${formatChartValue(m.value, m.unit)}`)
      .join(' • '),
  }));
}

export interface TreeRowView {
  readonly sessionId: string;
  readonly depth: number;
  readonly isRoot: boolean;
  readonly href: string;
}

function flattenNode(node: SessionTreeNode, depth: number, isRoot: boolean): TreeRowView[] {
  const href = `#/sessions/${node.sessionId}?generation=${encodeURIComponent(node.generationToken)}`;
  const rows: TreeRowView[] = [
    {
      sessionId: node.sessionId,
      depth,
      isRoot,
      href,
    },
  ];
  for (const child of node.children) {
    rows.push(...flattenNode(child, depth + 1, false));
  }
  return rows;
}

function flattenTree(tree: SessionTree): TreeRowView[] {
  const rows: TreeRowView[] = [];
  for (const node of tree.nodes) {
    rows.push(...flattenNode(node, 0, tree.rootSessionId === node.sessionId));
  }
  return rows;
}

export function sessionTreeToRows(tree: SessionTree | null): TreeRowView[] {
  if (!tree) return [];
  return flattenTree(tree);
}

export function evidenceToTableRows(
  rows: { timestamp?: string; summary: string; entityType: string }[],
): TableRow[] {
  return rows.map((row) => ({
    x: row.timestamp ?? '',
    y: row.summary,
    series: row.entityType,
    label: row.summary,
  }));
}
