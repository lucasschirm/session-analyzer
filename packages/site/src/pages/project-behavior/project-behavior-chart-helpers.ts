import type {
  DurationHistogramBin,
  HarnessCoverage,
  ProjectHeader,
  ProjectModelHarnessCohorts,
  ProjectStatStrip,
  SessionDurationHistogram,
  SessionOutcomeBucket,
  SessionOutcomeDistribution,
  TopToolsList,
  WeeklyToolErrorRateSeries,
} from '@lucasschirm/sal-db';
import { PROJECT_TOOL_ERROR_RATE_REVIEW_THRESHOLD } from '@lucasschirm/sal-db';
import type { StatDelta } from '../../components/analytics/analytics-card-types';
import type { ChartBucket, ChartSeries } from '../../components/charts/chart-types';
import { formatCompactNumber, formatDuration } from '../../lib/format';
import { statusTokens } from '../../styles/tokens';
import type { RangeSelection } from '../portfolio/portfolio-params';

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

export interface ProjectHeaderView {
  displayName: string;
  harnessesLabel: string;
  sessionCountLabel: string;
  activeWindowLabel: string;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function activeWindowLabel(header: ProjectHeader): string {
  if (!header.activeWindowStart || !header.activeWindowEnd) return 'No dated activity';
  return `${formatDate(header.activeWindowStart)} – ${formatDate(header.activeWindowEnd)}`;
}

export function headerToView(header: ProjectHeader): ProjectHeaderView {
  return {
    displayName: header.displayName,
    harnessesLabel: header.harnesses.length > 0 ? header.harnesses.join(', ') : '—',
    sessionCountLabel: `${header.sessionCount} session${header.sessionCount === 1 ? '' : 's'}`,
    activeWindowLabel: activeWindowLabel(header),
  };
}

// ---------------------------------------------------------------------------
// Stat strip
// ---------------------------------------------------------------------------

function coverageLabel(knownN: number, eligibleN: number): string {
  return `n=${knownN}${knownN < eligibleN ? ` of ${eligibleN}` : ''}`;
}

/** A period-comparison shape shared by {@link PeriodDelta} and
 * {@link AggregateStat}'s "previous window" fields — see either type's
 * doc comment for the omission/`null` rules `deltaPercent` follows. */
interface DeltaSource {
  previous?: number | null;
  deltaPercent?: number | null;
  deltaDirection?: 'up' | 'down' | 'flat';
}

/** Formats an already-computed `deltaPercent`/`deltaDirection` pair (see
 * `PeriodDelta`/`AggregateStat` in `@lucasschirm/sal-db`) into display text.
 * No percentage-change arithmetic happens here — only rounding and sign
 * formatting of a value the read contract already computed
 * (`.agents/rules/no-canonical-metrics-in-lit.md`). */
function formatDelta(source: DeltaSource, rangeSelection: RangeSelection): StatDelta | undefined {
  if (rangeSelection === 'all') return { direction: 'flat', text: '—' };
  if (source.previous === undefined || source.previous === null) return undefined;
  const { deltaPercent, deltaDirection = 'flat' } = source;
  if (deltaPercent === null || deltaPercent === undefined) {
    return { direction: deltaDirection, text: '—' };
  }
  const rounded = Math.round(deltaPercent);
  return { direction: deltaDirection, text: `${rounded >= 0 ? '+' : ''}${rounded}%` };
}

export interface AggregateTileView {
  value: string;
  sampleLabel: string;
}

export interface StatTileView {
  value: string;
  delta?: StatDelta;
  sampleLabel: string;
}

export interface CostTileView {
  missing: boolean;
  value: string;
  reason?: string;
  sampleLabel: string;
}

export interface StatStripView {
  sessions: StatTileView;
  duration: AggregateTileView;
  turns: AggregateTileView;
  tokensPerSession: StatTileView;
  cost: CostTileView;
}

function durationTile(strip: ProjectStatStrip): AggregateTileView {
  const { durationMedianMs, durationP90Ms } = strip;
  const value = durationMedianMs.value !== null ? formatDuration(durationMedianMs.value) : '—';
  const p90 = durationP90Ms.value !== null ? formatDuration(durationP90Ms.value) : '—';
  return {
    value,
    sampleLabel: `p90 ${p90} • ${coverageLabel(durationMedianMs.knownN, durationMedianMs.eligibleN)}`,
  };
}

function turnsTile(strip: ProjectStatStrip): AggregateTileView {
  const { turnsMedian, turnsP90 } = strip;
  const value = turnsMedian.value !== null ? String(Math.round(turnsMedian.value)) : '—';
  const p90 = turnsP90.value !== null ? String(Math.round(turnsP90.value)) : '—';
  return {
    value,
    sampleLabel: `p90 ${p90} • ${coverageLabel(turnsMedian.knownN, turnsMedian.eligibleN)}`,
  };
}

function costReason(coverage: HarnessCoverage): string {
  if (coverage.totalHarnessCount === 0) return 'No harness activity in this window';
  const unreported = coverage.totalHarnessCount - coverage.reportingHarnessCount;
  if (unreported === 0) return '';
  return `Not reported by ${unreported} of ${coverage.totalHarnessCount} harnesses`;
}

export function costTile(strip: ProjectStatStrip): CostTileView {
  const { costPerSession, costHarnessCoverage } = strip;
  if (costPerSession.value !== null) {
    return {
      missing: false,
      value: `$${costPerSession.value.toFixed(2)}`,
      sampleLabel: coverageLabel(costPerSession.knownN, costPerSession.eligibleN),
    };
  }
  return {
    missing: true,
    value: '—',
    reason: costReason(costHarnessCoverage),
    sampleLabel: coverageLabel(costPerSession.knownN, costPerSession.eligibleN),
  };
}

export function statStripToView(
  strip: ProjectStatStrip,
  rangeSelection: RangeSelection,
): StatStripView {
  const { sessions, tokensPerSession } = strip;
  return {
    sessions: {
      value: String(sessions.current),
      delta: formatDelta(sessions, rangeSelection),
      sampleLabel: coverageLabel(sessions.currentN, sessions.currentN),
    },
    duration: durationTile(strip),
    turns: turnsTile(strip),
    tokensPerSession: {
      value: tokensPerSession.value !== null ? formatCompactNumber(tokensPerSession.value) : '—',
      delta:
        tokensPerSession.value !== null
          ? formatDelta(
              {
                previous: tokensPerSession.previousValue,
                deltaPercent: tokensPerSession.deltaPercent,
                deltaDirection: tokensPerSession.deltaDirection,
              },
              rangeSelection,
            )
          : undefined,
      sampleLabel: coverageLabel(tokensPerSession.knownN, tokensPerSession.eligibleN),
    },
    cost: costTile(strip),
  };
}

// ---------------------------------------------------------------------------
// Session duration histogram
// ---------------------------------------------------------------------------

function formatBinEdge(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  const hours = ms / 3_600_000;
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)}h`;
}

/** Bin edge labels come from the DTO's `startMs`/`endMs` — never a
 * hardcoded label string — per `.agents/rules/aggregates-expose-sample-size.md`
 * and the issue's "never hardcoded" acceptance criterion. */
function binLabel(bin: DurationHistogramBin): string {
  const start = formatBinEdge(bin.startMs);
  return bin.endMs === null ? `${start}+` : `${start}–${formatBinEdge(bin.endMs)}`;
}

export function durationHistogramToChartSeries(histogram: SessionDurationHistogram): ChartSeries {
  const buckets: ChartBucket[] = histogram.bins.map((bin) => ({
    x: binLabel(bin),
    y: bin.count,
    label: `${binLabel(bin)}: ${bin.count} session${bin.count === 1 ? '' : 's'}`,
  }));
  return {
    seriesId: 'session-duration-histogram',
    label: 'Session duration',
    chartType: 'histogram',
    xLabel: 'Duration',
    yLabel: 'Sessions',
    buckets,
  };
}

export function durationHistogramSampleLabel(histogram: SessionDurationHistogram): string {
  return coverageLabel(histogram.knownN, histogram.eligibleN);
}

// ---------------------------------------------------------------------------
// Session outcomes
// ---------------------------------------------------------------------------

type ClassifiedOutcome = 'clean' | 'interrupted_by_user' | 'ended_on_error';

const OUTCOME_ORDER: readonly ClassifiedOutcome[] = [
  'clean',
  'interrupted_by_user',
  'ended_on_error',
];

const OUTCOME_LABELS: Record<ClassifiedOutcome, string> = {
  clean: 'Clean',
  interrupted_by_user: 'Interrupted by user',
  ended_on_error: 'Ended on error',
};

const OUTCOME_COLORS: Record<ClassifiedOutcome, string> = {
  clean: statusTokens.statusGood,
  interrupted_by_user: statusTokens.statusWarning,
  ended_on_error: statusTokens.statusCritical,
};

export interface OutcomeLegendRow {
  outcome: ClassifiedOutcome;
  label: string;
  color: string;
  count: number;
  percent: number;
}

export interface OutcomeMixView {
  rows: OutcomeLegendRow[];
  total: number;
  unreadableTailCount: number;
  unreadableTailPercent: number;
}

/**
 * Largest-remainder integer-percentage allocation so bucket percentages sum
 * to exactly 100 (never 99/101 from independent rounding) whenever
 * `total > 0` — the issue's "percentages ... sum to the session total"
 * acceptance criterion.
 */
function allocatePercentages(counts: readonly number[], total: number): number[] {
  if (total <= 0) return counts.map(() => 0);
  const raw = counts.map((c) => (c / total) * 100);
  const floors = raw.map(Math.floor);
  const used = floors.reduce((sum, v) => sum + v, 0);
  const remainder = Math.round(100 - used);
  const order = raw.map((v, i) => ({ i, frac: v - Math.floor(v) })).sort((a, b) => b.frac - a.frac);
  const result = [...floors];
  for (let k = 0; k < remainder; k++) {
    const slot = order[k % order.length];
    result[slot.i] += 1;
  }
  return result;
}

function bucketCount(
  buckets: readonly SessionOutcomeBucket[],
  outcome: ClassifiedOutcome | null,
): number {
  return buckets.find((b) => b.outcome === outcome)?.count ?? 0;
}

export function outcomeMixToView(mix: SessionOutcomeDistribution): OutcomeMixView {
  const counts = [
    ...OUTCOME_ORDER.map((o) => bucketCount(mix.buckets, o)),
    bucketCount(mix.buckets, null),
  ];
  const total = counts.reduce((sum, c) => sum + c, 0);
  const percents = allocatePercentages(counts, total);

  const rows: OutcomeLegendRow[] = OUTCOME_ORDER.map((outcome, i) => ({
    outcome,
    label: OUTCOME_LABELS[outcome],
    color: OUTCOME_COLORS[outcome],
    count: counts[i] as number,
    percent: percents[i] as number,
  }));

  return {
    rows,
    total,
    unreadableTailCount: counts[3] as number,
    unreadableTailPercent: percents[3] as number,
  };
}

// ---------------------------------------------------------------------------
// Weekly tool error rate
// ---------------------------------------------------------------------------

export function weeklyToolErrorRateToChartSeries(series: WeeklyToolErrorRateSeries): ChartSeries {
  const buckets: ChartBucket[] = series.series.map((point) => ({
    x: point.weekBucket,
    y: point.rate !== null ? Math.round(point.rate * 1000) / 10 : null,
    label:
      point.rate !== null
        ? `${point.weekBucket}: ${(point.rate * 100).toFixed(1)}% (${point.toolCallsN} calls)`
        : `${point.weekBucket}: no tool calls`,
  }));
  return {
    seriesId: 'weekly-tool-error-rate',
    label: 'Tool error rate',
    chartType: 'annotated_timeline',
    xLabel: 'Week',
    yLabel: 'Error rate (%)',
    buckets,
    annotations: [
      {
        position: PROJECT_TOOL_ERROR_RATE_REVIEW_THRESHOLD * 100,
        label: `Review threshold ${PROJECT_TOOL_ERROR_RATE_REVIEW_THRESHOLD * 100}%`,
        type: 'threshold',
      },
    ],
  };
}

export function weeklyToolErrorRateNote(series: WeeklyToolErrorRateSeries): string {
  const current = series.currentValue !== null ? `${(series.currentValue * 100).toFixed(1)}%` : '—';
  return `Currently ${current} • n=${series.currentWeekN} tool calls this week`;
}

// ---------------------------------------------------------------------------
// Top tools
// ---------------------------------------------------------------------------

export function topToolsToChartSeries(list: TopToolsList): ChartSeries {
  const buckets: ChartBucket[] = list.rows.map((row) => ({
    x: row.componentId,
    y: row.invocationCount,
    label: `${row.displayName ?? row.componentId}: ${row.invocationCount}`,
    series: row.displayName ?? row.componentId,
  }));
  return {
    seriesId: 'top-tools',
    label: 'Top tools by invocations',
    chartType: 'horizontal_bar',
    xLabel: 'Tool',
    yLabel: 'Invocations',
    buckets,
  };
}

// ---------------------------------------------------------------------------
// Model x harness cohorts
// ---------------------------------------------------------------------------

export interface ModelCohortRowView {
  model: string;
  harness: string;
  n: number;
  medianTokensLabel: string;
  medianTokensBarPercent: number;
  cleanRateLabel: string;
  lowN: boolean;
  medianCostLabel: string;
}

export function modelCohortsToRows(cohorts: ProjectModelHarnessCohorts): ModelCohortRowView[] {
  const maxTokens = Math.max(0, ...cohorts.rows.map((r) => r.medianTokens ?? 0));
  return cohorts.rows.map((row) => ({
    model: row.model,
    harness: row.harness,
    n: row.n,
    medianTokensLabel: row.medianTokens !== null ? formatCompactNumber(row.medianTokens) : '—',
    medianTokensBarPercent:
      row.medianTokens !== null && maxTokens > 0
        ? Math.round((row.medianTokens / maxTokens) * 100)
        : 0,
    cleanRateLabel:
      row.cleanRate !== null
        ? `${Math.round(row.cleanRate * 100)}%${row.lowN ? ' · low n' : ''}`
        : `—${row.lowN ? ' · low n' : ''}`,
    lowN: row.lowN,
    medianCostLabel: row.medianCost !== null ? `$${row.medianCost.toFixed(2)}` : '—',
  }));
}
