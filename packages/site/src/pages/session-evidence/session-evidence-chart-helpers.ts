import type {
  ComponentFactPage,
  ContextTimingSeries,
  MetricValueDto,
  SessionEvidenceSummary,
} from '@lucasschirm/sal-db';
import type {
  ChartBucket,
  ChartEvidenceLink,
  ChartSeries,
  TableRow,
} from '../../components/charts/chart-types';
import { formatChartValue } from '../../components/charts/chart-types';
import { metricDescription, metricLabel } from '../../lib/metric-descriptions';
import type { MetricCardView } from '../portfolio/portfolio-chart-helpers';
import type { SessionEvidenceParams } from './session-evidence-params';
import { evidenceLinkHref } from './session-evidence-params';

/**
 * Fill colors for the context-growth `Context` segment, keyed on the message
 * domain the transformer classified it into
 * (`.agents/rules/analytics-domain-distinctions.md`). `message` is the plain
 * no-tool case and is also the series color the chart always had, so an
 * unclassified bar is rendered exactly as before.
 *
 * Color is never the only carrier: every bucket label repeats the domain in
 * text, the view renders `CONTEXT_KIND_LEGEND` beside the chart, and the
 * message drawer shows a matching badge (components/charts/AGENTS.md
 * color-independence invariant).
 */
export const CONTEXT_BAR_COLORS: Record<'message' | 'tool' | 'skill' | 'agent', string> = {
  message: '#4f8cff',
  tool: '#facc15',
  skill: '#a78bfa',
  agent: '#f472b6',
};

const CONTEXT_KIND_LABELS: Record<'message' | 'tool' | 'skill' | 'agent', string> = {
  message: 'Message',
  tool: 'Tool call',
  skill: 'Skill call',
  agent: 'Agent call',
};

export const CONTEXT_KIND_LEGEND: readonly { kind: string; label: string; color: string }[] = (
  ['message', 'tool', 'skill', 'agent'] as const
).map((kind) => ({ kind, label: CONTEXT_KIND_LABELS[kind], color: CONTEXT_BAR_COLORS[kind] }));

function kindSuffix(kind: 'tool' | 'skill' | 'agent' | undefined): string {
  return kind ? `, ${kind} invocation` : '';
}

export function contextGrowthToChartSeries(
  series: ContextTimingSeries,
  sessionId = '',
): ChartSeries {
  const buckets: ChartBucket[] = [];
  let prevContextTokens: number | null = null;

  for (const point of series.points) {
    const idx = point.messageIndex ?? point.turnNumber;
    const role = point.role ?? 'message';
    const kindLabel = kindSuffix(point.invocationKind);
    const x = `#${idx} ${role}`;
    const evidenceLink: ChartEvidenceLink = {
      label: `Message #${idx} (${role}${kindLabel})`,
      href: sessionId ? `#/sessions/${sessionId}#msg-${point.messageId ?? idx}` : '',
    };
    buckets.push({
      x,
      y: point.contextTokens,
      label: `Message #${idx} (${role}${kindLabel}): context ${formatChartValue(point.contextTokens)} tokens`,
      series: 'Context',
      color: point.invocationKind ? CONTEXT_BAR_COLORS[point.invocationKind] : undefined,
      evidenceLink,
    });

    let removedTokens = point.compactedTokens ?? point.removedTokens ?? null;
    if (
      removedTokens === null &&
      prevContextTokens !== null &&
      point.contextTokens !== null &&
      prevContextTokens > point.contextTokens
    ) {
      removedTokens = prevContextTokens - point.contextTokens;
    }

    if (removedTokens !== null && removedTokens > 0) {
      buckets.push({
        x,
        y: removedTokens,
        label: `Message #${idx} (${role}${kindLabel}): compacted ${formatChartValue(removedTokens)} tokens`,
        series: 'Compacted',
        evidenceLink,
      });
    }

    if (point.generationTokens !== null && point.generationTokens > 0) {
      buckets.push({
        x,
        y: point.generationTokens,
        label: `Message #${idx} (${role}${kindLabel}): generation ${formatChartValue(point.generationTokens)} tokens`,
        series: 'Generation',
        evidenceLink,
      });
    }

    if (point.contextTokens !== null) {
      prevContextTokens = point.contextTokens;
    }
  }

  return {
    seriesId: 'context-growth',
    label: 'Context growth across session',
    chartType: 'stacked_bar',
    xLabel: 'Message',
    yLabel: 'Tokens',
    seriesOrder: ['Context', 'Compacted', 'Generation'],
    colors: [CONTEXT_BAR_COLORS.message, '#ffb86c', '#3ecf8e'],
    buckets,
  };
}

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
    // `kind/nativeId` label, never the raw canonical component id
    // (`.agents/rules/never-display-raw-ids.md`).
    x: row.displayName,
    y: row.invocationCount,
    label: `${row.displayName} — ${row.invocationCount} invocations (${row.outcome})`,
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
      label: metricLabel(metric.metricId, metric.label),
      value: formatChartValue(metric.value, metric.unit),
      sub: `${coverageN(metric)} • ${metric.coverage} • ${metric.confidence}`,
      description: metricDescription(metric.metricId),
      href: link ? evidenceLinkHref(link, params) : undefined,
    };
  });
}

export interface ComponentRowView {
  readonly componentId: string;
  readonly displayName: string;
  readonly kind: string;
  readonly invocations: number;
  readonly outcome: string;
  readonly metrics: string;
}

export function componentFactsToRows(page: ComponentFactPage): ComponentRowView[] {
  return page.items.map((row) => ({
    componentId: row.componentId,
    displayName: row.displayName,
    kind: row.kind,
    invocations: row.invocationCount,
    outcome: row.outcome,
    metrics: row.metricValues
      .map((m) => `${m.label}: ${formatChartValue(m.value, m.unit)}`)
      .join(' • '),
  }));
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
