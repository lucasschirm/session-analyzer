import type {
  InvocationsByDomain,
  ModelHarnessMatrix,
  PeriodDelta,
  PortfolioKpiBand,
  PortfolioTrendSeries,
  ProjectLeaderboard,
  SessionsByModelBar,
  TimeSeriesPoint,
} from '@lucasschirm/sal-db';
import { tryMetricIdToLabel } from '@lucasschirm/sal-transformer';
import type { StatBreakdownItem, StatDelta } from '../../components/analytics/analytics-card-types';
import { colorForEntity } from '../../components/charts/chart-helpers';
import type { ChartBucket, ChartSeries } from '../../components/charts/chart-types';
import { formatChartValue } from '../../components/charts/chart-types';
import {
  formatCompactNumber,
  formatCurrency,
  formatPercent,
  formatShortDate,
} from '../../lib/format';
import { seriesTokens } from '../../styles/tokens';
import type { PortfolioParams, SessionsScope } from './portfolio-params';
import { buildPortfolioHash } from './portfolio-params';

// ---------------------------------------------------------------------------
// Sessions scope filtering (shared by portfolio and project-behavior)
// ---------------------------------------------------------------------------

/** Metric IDs that belong to the token usage chart (split out from main trend). */
const TOKEN_METRIC_PREFIXES = [
  'claude:tokens:cache_creation:',
  'claude:tokens:cache_read:',
  'claude:tokens:total:',
  'claude:tokens:output:',
  'claude:tokens:input:',
];

/** Whether a metric ID belongs to the token usage chart. */
export function isTokenMetric(metricId: string): boolean {
  return TOKEN_METRIC_PREFIXES.some((prefix) => metricId.startsWith(prefix));
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
  if (/^claude:duration:wall_ms/.test(metricId)) return 'Session duration (min)';
  return stripped;
}

/**
 * Returns true when the metric is the wall-clock duration metric, so chart
 * helpers can round displayed values to 0 decimals (minutes are integers in
 * practice and fractional minutes add noise).
 */
export function isDurationMetric(metricId: string): boolean {
  return /^claude:duration:wall_ms/.test(metricId);
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

/**
 * Shared metric-card view-model shape. Owned here because it predates the
 * per-page redesign (issue #170 removed this page's own producer,
 * `overviewToMetricCards`, along with the Overview cards it fed) but
 * `session-evidence-chart-helpers.ts` still imports the type from this
 * module — kept as the shared type source rather than duplicated.
 */
export interface MetricCardView {
  metricId: string;
  label: string;
  value: string;
  sub: string;
  href?: string;
}

// ---------------------------------------------------------------------------
// KPI band (issue #170) — PortfolioKpiBand -> stat-tile view models.
// ---------------------------------------------------------------------------

/**
 * Shapes a {@link PeriodDelta} into a `StatDelta` chip. When `previous` is
 * `undefined` (the "All" time preset has no comparable prior window), the
 * chip still renders — with direction `flat` and the literal text "—" —
 * rather than being omitted or showing a fabricated 0%
 * (`.agents/rules/missing-is-never-zero.md`).
 */
export function periodDeltaToStatDelta(
  delta: Pick<PeriodDelta, 'current' | 'previous'>,
): StatDelta {
  if (delta.previous === undefined) return { direction: 'flat', text: '—' };
  if (delta.previous === 0) {
    return delta.current === 0
      ? { direction: 'flat', text: '—' }
      : { direction: 'up', text: '+∞%' };
  }
  const change = (delta.current - delta.previous) / delta.previous;
  const direction = change > 0 ? 'up' : change < 0 ? 'down' : 'flat';
  const sign = change > 0 ? '+' : '';
  return { direction, text: `${sign}${formatPercent(change)}` };
}

export interface KpiSessionsHeroView {
  value: string;
  delta: StatDelta;
  sparklinePoints: number[];
  footnote: string;
  sampleLabel: string;
}

const SESSIONS_SCOPE_FOOTNOTE: Record<SessionsScope, string> = {
  main: 'Main sessions only',
  all: 'Including sub agents',
  sub_agents: 'Sub-agent sessions only',
};

export function kpiBandToSessionsHero(
  kpi: PortfolioKpiBand,
  scope: SessionsScope,
): KpiSessionsHeroView {
  const { sessions } = kpi;
  return {
    value: formatCompactNumber(sessions.current),
    delta: periodDeltaToStatDelta(sessions),
    sparklinePoints:
      sessions.previous !== undefined ? [sessions.previous, sessions.current] : [sessions.current],
    footnote: SESSIONS_SCOPE_FOOTNOTE[scope] ?? SESSIONS_SCOPE_FOOTNOTE.main,
    sampleLabel: `n=${sessions.currentN} sessions`,
  };
}

export interface KpiTokensView {
  value: string;
  delta: StatDelta;
  breakdown: StatBreakdownItem[];
  sampleLabel: string;
}

export function kpiBandToTokensView(kpi: PortfolioKpiBand): KpiTokensView {
  const { in: inTotals, out: outTotals } = kpi.tokens;
  const currentTotal = inTotals.current + outTotals.current;
  const previousTotal =
    inTotals.previous !== undefined && outTotals.previous !== undefined
      ? inTotals.previous + outTotals.previous
      : undefined;

  return {
    value: formatCompactNumber(currentTotal),
    delta: periodDeltaToStatDelta({ current: currentTotal, previous: previousTotal }),
    breakdown: [
      { label: 'In', value: formatCompactNumber(inTotals.current), color: seriesTokens[0] },
      { label: 'Out', value: formatCompactNumber(outTotals.current), color: seriesTokens[1] },
    ],
    sampleLabel: `n=${inTotals.currentN} in · n=${outTotals.currentN} out`,
  };
}

/** Either a normal delta tile, or the missing-state tile when no harness in
 * the window reported cost (`.agents/rules/missing-is-never-zero.md`). */
export type KpiCostView =
  | { kind: 'present'; value: string; delta: StatDelta; sampleLabel: string }
  | { kind: 'missing'; reason: string };

export function kpiBandToCostView(kpi: PortfolioKpiBand): KpiCostView {
  const { cost } = kpi;
  if (cost.currentTotal === null) {
    return {
      kind: 'missing',
      reason: `0 of ${cost.currentTotalHarnesses} harnesses report cost in this window`,
    };
  }
  const previous =
    cost.previousTotal !== undefined && cost.previousTotal !== null
      ? cost.previousTotal
      : undefined;
  return {
    kind: 'present',
    value: formatCurrency(cost.currentTotal),
    delta: periodDeltaToStatDelta({ current: cost.currentTotal, previous }),
    sampleLabel: `n=${cost.currentReportedHarnesses} of ${cost.currentTotalHarnesses} harnesses reporting`,
  };
}

/** Either a ring (a classified clean-completion rate exists) or the
 * missing-state tile when no session in the window has a classified outcome
 * yet — never a fabricated 0%/100% ring. */
export type KpiCleanCompletionView =
  | { kind: 'present'; percent: number; centerText: string; sampleLabel: string }
  | { kind: 'missing'; reason: string };

export function kpiBandToCleanCompletionView(kpi: PortfolioKpiBand): KpiCleanCompletionView {
  const { cleanCompletionRate: rate } = kpi;
  if (rate.value === null) {
    return {
      kind: 'missing',
      reason:
        rate.eligibleN > 0
          ? `0 of ${rate.eligibleN} final sessions have a classified outcome yet`
          : 'No final sessions in this window yet',
    };
  }
  return {
    kind: 'present',
    percent: rate.value * 100,
    centerText: formatPercent(rate.value),
    sampleLabel: `n=${rate.knownN} of ${rate.eligibleN}`,
  };
}

// ---------------------------------------------------------------------------
// Sessions-by-model bar list, model×harness heatmap, invocations-by-domain
// (issue #170).
// ---------------------------------------------------------------------------

export function sessionsByModelToChartSeries(bar: SessionsByModelBar): ChartSeries {
  const buckets: ChartBucket[] = bar.rows.map((row) => ({
    x: row.model,
    y: row.sessionCount,
    label: `${row.model}: ${formatChartValue(row.sessionCount)} sessions`,
    series: row.model,
  }));

  return {
    seriesId: 'sessions-by-model',
    label: 'Sessions by model',
    chartType: 'horizontal_bar',
    xLabel: 'Sessions',
    yLabel: 'Model',
    buckets,
  };
}

/**
 * Model×harness session-count matrix -> heatmap `ChartSeries`. A cell with
 * `sessionCount: null` (that (model, harness) pair has never run) becomes a
 * `y: null` bucket, which `rd-heatmap-grid`/`classifyHeatmapCell` render as a
 * dashed "missing" cell — never coerced to a measured `0`
 * (`.agents/rules/missing-is-never-zero.md`).
 */
export function modelHarnessMatrixToHeatmapSeries(matrix: ModelHarnessMatrix): ChartSeries {
  const buckets: ChartBucket[] = matrix.cells.map((cell) => ({
    x: cell.model,
    y: cell.sessionCount,
    label: `${cell.harness} · ${cell.model}: ${
      cell.sessionCount === null
        ? 'never observed'
        : `${formatChartValue(cell.sessionCount)} sessions`
    }`,
    series: cell.harness,
  }));

  return {
    seriesId: 'model-harness-matrix',
    label: 'Sessions by model and harness',
    chartType: 'heatmap',
    xLabel: 'Model',
    yLabel: 'Harness',
    buckets,
  };
}

export interface DomainBarRowView {
  kind: 'tool' | 'skill' | 'agent' | 'sub_agent';
  label: string;
  count: number;
  color: string;
  href: string;
}

/** Display order + labels + destination routes for the four canonical
 * invocation domains — Tool / Skill / Agent / Sub Agent only. MCP is never a
 * fifth peer bucket: it is a subset of Tool, surfaced instead as a footnote
 * link (`.agents/rules/analytics-domain-distinctions.md`). */
const DOMAIN_ORDER: ReadonlyArray<{
  kind: DomainBarRowView['kind'];
  label: string;
  href: (params: PortfolioParams) => string;
}> = [
  { kind: 'tool', label: 'Tool', href: () => '#/tools' },
  { kind: 'skill', label: 'Skill', href: () => '#/skills' },
  { kind: 'agent', label: 'Agent', href: () => '#/agents' },
  {
    kind: 'sub_agent',
    label: 'Sub Agent',
    href: (params) => `#/${buildPortfolioHash({ ...params, sessions: 'sub_agents' })}`,
  },
];

export function invocationsByDomainToRows(
  domain: InvocationsByDomain,
  params: PortfolioParams,
): DomainBarRowView[] {
  const byKind = new Map(domain.rows.map((row) => [row.kind, row.count]));
  return DOMAIN_ORDER.map((entry) => ({
    kind: entry.kind,
    label: entry.label,
    count: byKind.get(entry.kind) ?? 0,
    // Stable per-entity color (never positional) — a domain kind's color
    // must not shift if another kind is filtered out of the row set.
    color: colorForEntity(entry.kind),
    href: entry.href(params),
  }));
}

export function invocationsByDomainToChartSeries(
  domain: InvocationsByDomain,
  params: PortfolioParams,
): ChartSeries {
  const rows = invocationsByDomainToRows(domain, params);
  const buckets: ChartBucket[] = rows.map((row) => ({
    x: row.label,
    y: row.count,
    label: `${row.label}: ${formatChartValue(row.count)} invocations`,
    series: row.label,
    evidenceLink: { label: `Open ${row.label}`, href: row.href },
  }));

  return {
    seriesId: 'invocations-by-domain',
    label: 'Invocations by component domain',
    chartType: 'horizontal_bar',
    xLabel: 'Invocations',
    yLabel: 'Domain',
    buckets,
  };
}

// ---------------------------------------------------------------------------
// Project leaderboard (issue #170).
// ---------------------------------------------------------------------------

export interface ProjectLeaderboardRowView {
  projectId: string;
  name: string;
  color: string;
  sessionCount: string;
  tokensValue: string;
  tokensSampleLabel: string;
  tokensFraction: number;
  cleanRateText: string;
  cleanRateSampleLabel: string;
  lastActiveText: string;
  trendPoints: number[];
  trendAriaLabel: string;
  href: string;
}

export function projectLeaderboardToRows(
  leaderboard: ProjectLeaderboard,
  params: PortfolioParams,
): ProjectLeaderboardRowView[] {
  const withTotals = leaderboard.rows.map((row) => ({
    row,
    totalTokens: row.tokens.inputTokens + row.tokens.outputTokens,
  }));
  const ranked = [...withTotals].sort((a, b) => b.totalTokens - a.totalTokens);
  const maxTokens = ranked.reduce((max, r) => Math.max(max, r.totalTokens), 0);

  return ranked.map(({ row, totalTokens }) => ({
    projectId: row.projectId,
    name: row.name,
    // Stable per-project color (never positional by rank) — re-ranking on a
    // filter change must not repaint an unrelated project's color/dot.
    color: colorForEntity(row.projectId),
    sessionCount: formatCompactNumber(row.sessionCount),
    tokensValue: formatCompactNumber(totalTokens),
    // The combined total's sample size is conservatively the smaller of the
    // two independently-tracked coverage counts — a session only
    // contributes a trustworthy *combined* figure when both its input and
    // output token counts are known (`.agents/rules/aggregates-expose-sample-size.md`).
    tokensSampleLabel: `n=${Math.min(row.tokens.inputKnownN, row.tokens.outputKnownN)}`,
    tokensFraction: maxTokens > 0 ? totalTokens / maxTokens : 0,
    cleanRateText: row.cleanRate.value === null ? '—' : formatPercent(row.cleanRate.value),
    cleanRateSampleLabel: `n=${row.cleanRate.knownN} of ${row.cleanRate.eligibleN}`,
    lastActiveText: row.lastActiveAt ? formatShortDate(row.lastActiveAt) : '—',
    trendPoints: row.trend.map((point) => point.sessionCount),
    trendAriaLabel: trendAriaLabel(row.trend),
    href: `#/projects/${row.name}?returnContext=${encodeURIComponent(
      buildPortfolioHash(params).slice(1),
    )}`,
  }));
}

/** Textual alternative for the leaderboard row's sparkline — `rd-sparkline`
 * renders `aria-hidden="true"` (it is a decorative SVG shared across the
 * card library), so the trend's actual values must be surfaced as text
 * here instead, per the chart layer's textual-summary accessibility
 * convention (`chart-types.ts`'s `textualSummary`). */
function trendAriaLabel(trend: ProjectLeaderboard['rows'][number]['trend']): string {
  if (trend.length === 0) return '30-day session trend: no data';
  const first = trend[0];
  const last = trend[trend.length - 1];
  const peak = trend.reduce((max, point) => Math.max(max, point.sessionCount), 0);
  return `30-day session trend: ${first.sessionCount} on ${first.day} to ${last.sessionCount} on ${last.day}, peak ${peak}`;
}
