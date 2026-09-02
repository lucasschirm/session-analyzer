import type {
  ComponentFactPage,
  ContextTimingSeries,
  EvidencePage,
  EvidenceRow,
  MetricValueDto,
  RootChildBreakdown,
  SessionEventKind,
  SessionEventRow,
  SessionEvidenceSummary,
  SessionOutcome,
  SessionTree,
  SessionTreeNode,
  TurnTimeline,
  TurnTimelineSegment,
  TurnTimelineSegmentKind,
} from '@lucasschirm/sal-db';
import { tryMetricIdToLabel } from '@lucasschirm/sal-transformer';
import type { ChartBucket, ChartSeries, TableRow } from '../../components/charts/chart-types';
import { formatChartValue } from '../../components/charts/chart-types';
import { seriesTokens } from '../../styles/tokens';
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

/**
 * Badge labels for the four canonical invocation kinds plus the two message
 * kinds (issue #172). "MCP" is never a label here — an MCP-server call is a
 * `tool`-kind row whose component identity happens to be an MCP server
 * (`.agents/rules/analytics-domain-distinctions.md`).
 */
const KIND_BADGE_LABELS: Record<SessionEventKind, string> = {
  tool: 'Tool',
  skill: 'Skill',
  agent: 'Agent',
  sub_agent: 'Sub Agent',
  user_message: 'User',
  assistant_message: 'Assistant',
};

export function eventKindBadgeLabel(kind: SessionEventKind): string {
  return KIND_BADGE_LABELS[kind];
}

const ERROR_INVOCATION_STATUSES = new Set(['failed', 'timeout']);

/** A row is an "error row" per the filterable-table-pattern's error-flagging guidance. */
export function isErrorEventStatus(status: string): boolean {
  return ERROR_INVOCATION_STATUSES.has(status);
}

export interface EventStatusView {
  readonly icon: string;
  readonly text: string;
}

/**
 * Status is always rendered icon + text together — never color alone
 * (`.agents/rules/no-silent-empty-states.md` companion guidance in the
 * filterable-table-pattern skill: exceptional rows must be scannable
 * without relying on color perception).
 */
export function eventStatusView(status: string): EventStatusView {
  switch (status) {
    case 'completed':
      return { icon: '✓', text: 'Completed' };
    case 'failed':
      return { icon: '✕', text: 'Failed' };
    case 'timeout':
      return { icon: '⏱', text: 'Timed out' };
    case 'cancelled':
      return { icon: '⊘', text: 'Cancelled' };
    case 'started':
      return { icon: '…', text: 'Started' };
    default:
      return { icon: '?', text: status };
  }
}

export interface OutcomeBadgeView {
  readonly icon: string;
  readonly label: string;
  readonly tone: 'good' | 'warning' | 'critical' | 'unknown';
}

const OUTCOME_VIEWS: Record<SessionOutcome, OutcomeBadgeView> = {
  clean: { icon: '✓', label: 'Clean', tone: 'good' },
  interrupted_by_user: { icon: '⏸', label: 'Interrupted by user', tone: 'warning' },
  ended_on_error: { icon: '✕', label: 'Ended on error', tone: 'critical' },
};

/**
 * `outcome === undefined` means "not yet loaded" (render nothing / a
 * loading affordance); `outcome === null` is the classified-but-unreadable
 * sentinel and gets its own distinct badge — never conflated with a clean
 * outcome (`.agents/rules/missing-is-never-zero.md`).
 */
export function outcomeBadgeView(
  outcome: SessionOutcome | null | undefined,
): OutcomeBadgeView | null {
  if (outcome === undefined) return null;
  if (outcome === null) return { icon: '—', label: 'Not classifiable', tone: 'unknown' };
  return OUTCOME_VIEWS[outcome];
}

/**
 * Turn-timeline band colors (issue #172 design spec) — indices into the
 * validated categorical `seriesTokens` order
 * (`packages/site/src/styles/tokens.ts`): assistant reuses series 1 (accent
 * blue), user series 2 (orange), the combined invocation band series 3
 * (green), sub agent series 5 (pink). Never reorder — these exact hex
 * values are the issue's spec (`#d95926` user / `#4f8cff` assistant /
 * `#199e70` invocation / `#d55181` sub agent).
 */
const TIMELINE_BAND_COLORS: Record<TurnTimelineSegmentKind, string> = {
  assistant: seriesTokens[0],
  user: seriesTokens[1],
  invocation: seriesTokens[2],
  sub_agent: seriesTokens[4],
};

/**
 * Band labels for the timeline legend. The `invocation` band is never
 * labelled "Tool" — it is combined Tool/Skill/Agent wall-clock time
 * (`.agents/rules/analytics-domain-distinctions.md`); the specific
 * underlying kind is only named in the per-segment tooltip.
 */
const TIMELINE_BAND_LABELS: Record<TurnTimelineSegmentKind, string> = {
  user: 'User',
  assistant: 'Assistant',
  invocation: 'Invocation activity',
  sub_agent: 'Sub agent',
};

export function timelineBandLabel(kind: TurnTimelineSegmentKind): string {
  return TIMELINE_BAND_LABELS[kind];
}

export function timelineBandColor(kind: TurnTimelineSegmentKind): string {
  return TIMELINE_BAND_COLORS[kind];
}

export interface TimelineSegmentView {
  readonly key: string;
  readonly kind: TurnTimelineSegmentKind;
  readonly color: string;
  readonly leftPercent: number;
  readonly widthPercent: number;
  readonly tooltip: string;
  readonly turnNumber?: number;
  readonly sourceId: string;
  readonly startMs: number;
  readonly durationMs: number;
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function segmentTooltip(segment: TurnTimelineSegment, turnNumber: number | undefined): string {
  const bandLabel =
    segment.kind === 'invocation' && segment.invocationKind
      ? eventKindBadgeLabel(segment.invocationKind)
      : timelineBandLabel(segment.kind);
  const turnLabel = turnNumber !== undefined ? `Turn ${turnNumber} — ` : '';
  return `${turnLabel}${bandLabel} (${formatMs(segment.durationMs)})`;
}

/**
 * Lays out turn-timeline segments as percentage widths of the full
 * duration. Segments already exactly partition `[0, totalDurationMs]`
 * (per `TurnTimelineSegment`'s docstring), so `widthPercent` sums to 100
 * (within floating-point rounding) by construction — verified by a unit
 * test rather than assumed. Returns `[]` when `totalDurationMs` is
 * unavailable (`null`/`0`), a legitimate "cannot lay out proportionally
 * yet" state distinct from a query failure.
 */
export function buildTimelineSegmentViews(
  timeline: TurnTimeline,
  events: readonly SessionEventRow[],
): TimelineSegmentView[] {
  const total = timeline.totalDurationMs;
  if (!total || total <= 0) return [];

  const eventById = new Map(events.map((event) => [event.id, event]));
  let cursor = 0;
  return timeline.segments.map((segment) => {
    const turnNumber = eventById.get(segment.sourceId)?.turnNumber;
    const widthPercent = (segment.durationMs / total) * 100;
    const view: TimelineSegmentView = {
      key: `${segment.sourceId}-${segment.startMs}`,
      kind: segment.kind,
      color: timelineBandColor(segment.kind),
      leftPercent: cursor,
      widthPercent,
      tooltip: segmentTooltip(segment, turnNumber),
      turnNumber,
      sourceId: segment.sourceId,
      startMs: segment.startMs,
      durationMs: segment.durationMs,
    };
    cursor += widthPercent;
    return view;
  });
}

export interface EventFilterState {
  readonly turn: number | null;
  readonly tool: string;
  readonly errorsOnly: boolean;
  readonly text: string;
}

export const EMPTY_EVENT_FILTER: EventFilterState = {
  turn: null,
  tool: '',
  errorsOnly: false,
  text: '',
};

/** Dropdown options derived from the *unfiltered* row list, per the pattern. */
export function eventToolOptions(events: readonly SessionEventRow[]): string[] {
  return Array.from(new Set(events.map((event) => event.name))).sort();
}

function eventSearchText(event: SessionEventRow): string {
  return [
    event.name,
    event.target ?? '',
    event.inputPayload?.content ?? '',
    event.resultPayload?.content ?? '',
  ]
    .join(' ')
    .toLowerCase();
}

/**
 * Plain in-memory `.filter()` over an already-loaded event list — legitimate
 * here only because the full-detail, non-paginated session-events DTO loads
 * every event up front (`.agents/skills/filterable-table-pattern`). Combines
 * predicates with AND, cheapest-first: turn equality, then the tool-name
 * dropdown, then the errors-only checkbox, then the free-text substring
 * search (case-insensitive, matches only the *transferred* — possibly
 * truncated — payload text).
 */
export function filterSessionEvents(
  events: readonly SessionEventRow[],
  filter: EventFilterState,
): SessionEventRow[] {
  const text = filter.text.trim().toLowerCase();
  return events.filter((event) => {
    if (filter.turn !== null && event.turnNumber !== filter.turn) return false;
    if (filter.tool && event.name !== filter.tool) return false;
    if (filter.errorsOnly && !isErrorEventStatus(event.status)) return false;
    if (text && !eventSearchText(event).includes(text)) return false;
    return true;
  });
}

function transcriptRole(row: EvidenceRow): string {
  const match = row.summary.match(/^Message \d+ \(([^)]+)\)/);
  return match?.[1]?.toLowerCase() ?? 'unknown';
}

/**
 * Extracts a short excerpt of the first user message for the header card's
 * title, from the already-loaded transcript page. Display-only text
 * extraction — not a canonical metric — so it is safe to compute here
 * rather than in `AnalyticsDataSource` (`.agents/rules/no-canonical-metrics-in-lit.md`
 * governs metric derivation, not string slicing of already-fetched text).
 */
export function firstUserMessageExcerpt(page: EvidencePage | null, maxLen = 140): string | null {
  if (!page) return null;
  const first = page.items.find((row) => transcriptRole(row) === 'user');
  if (!first) return null;
  const content = first.summary.replace(/^Message \d+ \([^)]+\)\n\n/, '').trim();
  if (!content) return null;
  return content.length > maxLen ? `${content.slice(0, maxLen).trimEnd()}…` : content;
}
