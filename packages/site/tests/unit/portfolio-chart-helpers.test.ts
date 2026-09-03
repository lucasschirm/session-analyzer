import type {
  InvocationsByDomain,
  ModelHarnessMatrix,
  PortfolioKpiBand,
  PortfolioTrendSeries,
  ProjectLeaderboard,
  SessionsByModelBar,
  TimeSeriesPoint,
} from '@lucasschirm/sal-db';
import { describe, expect, it } from 'vitest';
import {
  filterByScope,
  invocationsByDomainToRows,
  isTokenMetric,
  kpiBandToCleanCompletionView,
  kpiBandToCostView,
  kpiBandToSessionsHero,
  kpiBandToTokensView,
  metricLabel,
  modelHarnessMatrixToHeatmapSeries,
  periodDeltaToStatDelta,
  projectLeaderboardToRows,
  sessionsByModelToChartSeries,
  stripScopeSuffix,
  tokenTrendToChartSeries,
} from '../../src/pages/portfolio/portfolio-chart-helpers';

function makePoint(overrides: Partial<TimeSeriesPoint> = {}): TimeSeriesPoint {
  return {
    time: '2024-01',
    value: 10,
    metricId: 'claude:tokens:total::root_only',
    label: 'Total Tokens (root-only)',
    comparabilityGroupId: 'g1',
    ...overrides,
  } as TimeSeriesPoint;
}

describe('isTokenMetric', () => {
  it('returns true for all token metric prefixes including input', () => {
    expect(isTokenMetric('claude:tokens:cache_creation:root_only')).toBe(true);
    expect(isTokenMetric('claude:tokens:cache_read:root_only')).toBe(true);
    expect(isTokenMetric('claude:tokens:total:root_only')).toBe(true);
    expect(isTokenMetric('claude:tokens:output:root_only')).toBe(true);
    expect(isTokenMetric('claude:tokens:input:root_only')).toBe(true);
  });

  it('returns false for non-token metrics', () => {
    expect(isTokenMetric('claude:duration:wall_ms:root_only')).toBe(false);
    expect(isTokenMetric('claude:turns:count:root_only')).toBe(false);
  });
});

describe('stripScopeSuffix', () => {
  it('strips (root-only) suffix', () => {
    expect(stripScopeSuffix('Total Tokens (root-only)')).toBe('Total Tokens');
  });

  it('strips (inclusive) suffix', () => {
    expect(stripScopeSuffix('Total Tokens (inclusive)')).toBe('Total Tokens');
  });

  it('leaves labels without scope suffix unchanged', () => {
    expect(stripScopeSuffix('Total Tokens')).toBe('Total Tokens');
  });
});

describe('metricLabel', () => {
  it('returns the transformer label when available', () => {
    // claude:tokens:total is a known metric in the transformer registry
    const label = metricLabel('claude:tokens:total::root_only', 'Fallback');
    expect(label).not.toContain('(root-only)');
  });

  it('falls back to the provided fallback', () => {
    const label = metricLabel('unknown:metric', 'My Fallback');
    expect(label).toBe('My Fallback');
  });

  it('falls back to the metricId when no fallback', () => {
    const label = metricLabel('unknown:metric');
    expect(label).toBe('unknown:metric');
  });
});

describe('filterByScope', () => {
  const points: TimeSeriesPoint[] = [
    makePoint({ time: 't1', value: 100, metricId: 'm1:root_only' }),
    makePoint({ time: 't1', value: 150, metricId: 'm1:inclusive' }),
    makePoint({ time: 't2', value: 200, metricId: 'm1:root_only' }),
    makePoint({ time: 't2', value: 250, metricId: 'm1:inclusive' }),
  ];

  it('filters to root_only metrics for main scope', () => {
    const result = filterByScope(points, 'main');
    expect(result).toHaveLength(2);
    expect(result.every((p) => p.metricId.endsWith(':root_only'))).toBe(true);
  });

  it('filters to inclusive metrics for all scope', () => {
    const result = filterByScope(points, 'all');
    expect(result).toHaveLength(2);
    expect(result.every((p) => p.metricId.endsWith(':inclusive'))).toBe(true);
  });

  it('computes inclusive - root_only delta for sub_agents scope', () => {
    const result = filterByScope(points, 'sub_agents');
    expect(result).toHaveLength(2);
    expect(result[0].value).toBe(50); // 150 - 100
    expect(result[0].metricId).toBe('m1:sub_agents');
    expect(result[1].value).toBe(50); // 250 - 200
  });

  it('handles missing root_only for sub_agents (uses 0)', () => {
    const result = filterByScope(
      [makePoint({ time: 't1', value: 100, metricId: 'm1:inclusive' })],
      'sub_agents',
    );
    expect(result).toHaveLength(1);
    expect(result[0].value).toBe(100);
  });

  it('passes wall_ms values through unchanged for sub_agents (transformer already emits minutes)', () => {
    const result = filterByScope(
      [
        makePoint({ time: 't1', value: 2, metricId: 'claude:duration:wall_ms:root_only' }),
        makePoint({ time: 't1', value: 3, metricId: 'claude:duration:wall_ms:inclusive' }),
      ],
      'sub_agents',
    );
    expect(result[0].value).toBe(1); // 3 - 2 = 1 minute (no division)
  });

  it('passes wall_ms values through unchanged for main scope', () => {
    const result = filterByScope(
      [makePoint({ time: 't1', value: 2, metricId: 'claude:duration:wall_ms:root_only' })],
      'main',
    );
    expect(result[0].value).toBe(2); // already in minutes
  });

  it('passes wall_ms values through unchanged for all scope', () => {
    const result = filterByScope(
      [makePoint({ time: 't1', value: 1, metricId: 'claude:duration:wall_ms:inclusive' })],
      'all',
    );
    expect(result[0].value).toBe(1);
  });

  it('handles null values in sub_agents delta', () => {
    const result = filterByScope(
      [
        makePoint({ time: 't1', value: null, metricId: 'm1:inclusive' }),
        makePoint({ time: 't1', value: 50, metricId: 'm1:root_only' }),
      ],
      'sub_agents',
    );
    expect(result[0].value).toBe(-50); // 0 - 50
  });
});

describe('tokenTrendToChartSeries', () => {
  it('filters to token metrics only', () => {
    const trend = {
      series: [
        makePoint({ time: 't1', value: 10, metricId: 'm1:root_only' }),
        makePoint({
          time: 't1',
          value: 500,
          metricId: 'claude:tokens:total::root_only',
          label: 'Tokens (root-only)',
        }),
      ],
    } as unknown as PortfolioTrendSeries;
    const series = tokenTrendToChartSeries(trend, 'main');
    expect(series.buckets).toHaveLength(1);
    expect(series.buckets[0].y).toBe(500);
    expect(series.label).toBe('Token usage trends');
  });
});

// ---------------------------------------------------------------------------
// KPI band (issue #170)
// ---------------------------------------------------------------------------

describe('periodDeltaToStatDelta', () => {
  it('renders "—" (flat, never a fabricated 0%) when there is no previous window', () => {
    const delta = periodDeltaToStatDelta({ current: 42, previous: undefined });
    expect(delta).toEqual({ direction: 'flat', text: '—' });
  });

  it('renders an up chip when current exceeds previous', () => {
    const delta = periodDeltaToStatDelta({ current: 120, previous: 100 });
    expect(delta.direction).toBe('up');
    expect(delta.text).toBe('+20%');
  });

  it('renders a down chip when current is below previous', () => {
    const delta = periodDeltaToStatDelta({ current: 80, previous: 100 });
    expect(delta.direction).toBe('down');
    expect(delta.text).toBe('-20%');
  });

  it('renders flat with 0% when current equals previous', () => {
    const delta = periodDeltaToStatDelta({ current: 100, previous: 100 });
    expect(delta).toEqual({ direction: 'flat', text: '0%' });
  });

  it('renders "—" when previous is exactly 0 and current is also 0', () => {
    const delta = periodDeltaToStatDelta({ current: 0, previous: 0 });
    expect(delta).toEqual({ direction: 'flat', text: '—' });
  });
});

function makeKpiBand(overrides: Partial<PortfolioKpiBand> = {}): PortfolioKpiBand {
  return {
    token: {} as PortfolioKpiBand['token'],
    sessions: { current: 100, currentN: 100, previous: 80, previousN: 80 },
    tokens: {
      in: { current: 1000, currentN: 100 },
      out: { current: 2000, currentN: 100 },
    },
    cost: { currentTotal: 12.5, currentReportedHarnesses: 2, currentTotalHarnesses: 2 },
    cleanCompletionRate: { value: 0.9, eligibleN: 100, knownN: 90 },
    ...overrides,
  } as PortfolioKpiBand;
}

describe('kpiBandToSessionsHero', () => {
  it('shapes value, delta, sparkline, footnote, and sample label', () => {
    const view = kpiBandToSessionsHero(makeKpiBand(), 'main');
    expect(view.value).toBe('100');
    expect(view.delta.direction).toBe('up');
    expect(view.sparklinePoints).toEqual([80, 100]);
    expect(view.footnote).toBe('Main sessions only');
    expect(view.sampleLabel).toBe('n=100 sessions');
  });

  it('reflects the active sessions scope in the footnote (not a hardcoded string)', () => {
    expect(kpiBandToSessionsHero(makeKpiBand(), 'all').footnote).toBe('Including sub agents');
    expect(kpiBandToSessionsHero(makeKpiBand(), 'sub_agents').footnote).toBe(
      'Sub-agent sessions only',
    );
  });

  it('falls back to a single-point sparkline under the All preset (no previous window)', () => {
    const kpi = makeKpiBand({ sessions: { current: 50, currentN: 50 } });
    const view = kpiBandToSessionsHero(kpi, 'main');
    expect(view.sparklinePoints).toEqual([50]);
    expect(view.delta).toEqual({ direction: 'flat', text: '—' });
  });
});

describe('kpiBandToTokensView', () => {
  it('sums in/out for the headline value and breaks them down', () => {
    const view = kpiBandToTokensView(makeKpiBand());
    expect(view.value).toBe('3,000');
    expect(view.breakdown).toEqual([
      { label: 'In', value: '1,000', color: expect.any(String) },
      { label: 'Out', value: '2,000', color: expect.any(String) },
    ]);
    expect(view.sampleLabel).toBe('n=100 in · n=100 out');
  });

  it('omits the delta comparison when either side has no previous window', () => {
    const kpi = makeKpiBand({
      tokens: {
        in: { current: 10, currentN: 1, previous: 5, previousN: 1 },
        out: { current: 20, currentN: 1 },
      },
    });
    expect(kpiBandToTokensView(kpi).delta).toEqual({ direction: 'flat', text: '—' });
  });
});

describe('kpiBandToCostView', () => {
  it('renders the missing-cost path when no harness reports cost (never a fabricated $0)', () => {
    const kpi = makeKpiBand({
      cost: { currentTotal: null, currentReportedHarnesses: 0, currentTotalHarnesses: 3 },
    });
    const view = kpiBandToCostView(kpi);
    expect(view).toEqual({
      kind: 'missing',
      reason: '0 of 3 harnesses report cost in this window',
    });
  });

  it('renders the present path with a currency value and coverage sample label', () => {
    const view = kpiBandToCostView(makeKpiBand());
    expect(view).toEqual({
      kind: 'present',
      value: '$13',
      delta: { direction: 'flat', text: '—' },
      sampleLabel: 'n=2 of 2 harnesses reporting',
    });
  });
});

describe('kpiBandToCleanCompletionView', () => {
  it('renders the ring when a clean-completion rate is classified', () => {
    const view = kpiBandToCleanCompletionView(makeKpiBand());
    expect(view).toEqual({
      kind: 'present',
      percent: 90,
      centerText: '90%',
      sampleLabel: 'n=90 of 100',
    });
  });

  it('renders the missing-state tile (never a fabricated rate) when nothing is classified', () => {
    const kpi = makeKpiBand({
      cleanCompletionRate: { value: null, eligibleN: 10, knownN: 0 },
    });
    const view = kpiBandToCleanCompletionView(kpi);
    expect(view).toEqual({
      kind: 'missing',
      reason: '0 of 10 final sessions have a classified outcome yet',
    });
  });

  it('gives a distinct reason when there are no eligible sessions at all', () => {
    const kpi = makeKpiBand({
      cleanCompletionRate: { value: null, eligibleN: 0, knownN: 0 },
    });
    expect(kpiBandToCleanCompletionView(kpi)).toEqual({
      kind: 'missing',
      reason: 'No final sessions in this window yet',
    });
  });
});

// ---------------------------------------------------------------------------
// Sessions-by-model, model×harness heatmap, invocations-by-domain
// ---------------------------------------------------------------------------

describe('sessionsByModelToChartSeries', () => {
  it('maps bar rows to a horizontal_bar chart series', () => {
    const bar = {
      token: {},
      rows: [
        { model: 'sonnet', sessionCount: 30 },
        { model: 'opus', sessionCount: 10 },
      ],
    } as unknown as SessionsByModelBar;
    const series = sessionsByModelToChartSeries(bar);
    expect(series.chartType).toBe('horizontal_bar');
    expect(series.buckets).toHaveLength(2);
    expect(series.buckets[0].x).toBe('sonnet');
    expect(series.buckets[0].y).toBe(30);
  });
});

describe('modelHarnessMatrixToHeatmapSeries', () => {
  it('maps a never-observed cell to y: null (missing, never a fabricated 0)', () => {
    const matrix = {
      token: {},
      models: ['sonnet'],
      harnesses: ['claude-code'],
      cells: [{ model: 'sonnet', harness: 'claude-code', sessionCount: null }],
    } as unknown as ModelHarnessMatrix;
    const series = modelHarnessMatrixToHeatmapSeries(matrix);
    expect(series.chartType).toBe('heatmap');
    expect(series.buckets[0].y).toBeNull();
    expect(series.buckets[0].label).toContain('never observed');
  });

  it('maps a measured cell to its real count', () => {
    const matrix = {
      token: {},
      models: ['sonnet'],
      harnesses: ['claude-code'],
      cells: [{ model: 'sonnet', harness: 'claude-code', sessionCount: 0 }],
    } as unknown as ModelHarnessMatrix;
    const series = modelHarnessMatrixToHeatmapSeries(matrix);
    expect(series.buckets[0].y).toBe(0);
  });
});

describe('invocationsByDomainToRows', () => {
  it('always returns exactly the four canonical kinds, in order, never a fifth MCP bucket', () => {
    const domain = {
      token: {},
      totalInvocations: 40,
      rows: [
        { kind: 'tool', count: 10 },
        { kind: 'skill', count: 20 },
        { kind: 'agent', count: 5 },
        { kind: 'sub_agent', count: 5 },
      ],
    } as unknown as InvocationsByDomain;
    const rows = invocationsByDomainToRows(domain, { sessions: 'main' });
    expect(rows.map((r) => r.kind)).toEqual(['tool', 'skill', 'agent', 'sub_agent']);
    expect(rows.map((r) => r.count)).toEqual([10, 20, 5, 5]);
  });

  it('routes each domain to its own page, and Sub Agent to the sub-agent-scoped portfolio hash', () => {
    const domain = { token: {}, totalInvocations: 0, rows: [] } as unknown as InvocationsByDomain;
    const rows = invocationsByDomainToRows(domain, { sessions: 'main' });
    const byKind = Object.fromEntries(rows.map((r) => [r.kind, r.href]));
    expect(byKind.tool).toBe('#/tools');
    expect(byKind.skill).toBe('#/skills');
    expect(byKind.agent).toBe('#/agents');
    expect(byKind.sub_agent).toContain('sessions=sub_agents');
  });

  it('reports a real observed zero for a kind with no invocations (never omitted)', () => {
    const domain = {
      token: {},
      totalInvocations: 10,
      rows: [{ kind: 'tool', count: 10 }],
    } as unknown as InvocationsByDomain;
    const rows = invocationsByDomainToRows(domain, { sessions: 'main' });
    expect(rows.find((r) => r.kind === 'agent')?.count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Project leaderboard
// ---------------------------------------------------------------------------

describe('projectLeaderboardToRows', () => {
  it('ranks rows by total token volume descending', () => {
    const leaderboard = {
      token: {},
      rows: [
        {
          projectId: 'p1',
          name: 'Small',
          sessionCount: 5,
          tokens: { inputTokens: 100, inputKnownN: 5, outputTokens: 100, outputKnownN: 5 },
          cleanRate: { value: 1, eligibleN: 5, knownN: 5 },
          trend: [],
        },
        {
          projectId: 'p2',
          name: 'Big',
          sessionCount: 50,
          tokens: { inputTokens: 5000, inputKnownN: 50, outputTokens: 5000, outputKnownN: 50 },
          cleanRate: { value: 0.8, eligibleN: 50, knownN: 40 },
          trend: [{ day: '2024-01-01', sessionCount: 3 }],
        },
      ],
    } as unknown as ProjectLeaderboard;

    const rows = projectLeaderboardToRows(leaderboard, { sessions: 'main' });
    expect(rows.map((r) => r.name)).toEqual(['Big', 'Small']);
    expect(rows[0].tokensFraction).toBe(1);
    expect(rows[1].tokensFraction).toBeCloseTo(200 / 10000);
  });

  it('renders "—" for an unclassified clean rate, never a fabricated 0%', () => {
    const leaderboard = {
      token: {},
      rows: [
        {
          projectId: 'p1',
          name: 'A',
          sessionCount: 1,
          tokens: { inputTokens: 0, inputKnownN: 0, outputTokens: 0, outputKnownN: 0 },
          cleanRate: { value: null, eligibleN: 1, knownN: 0 },
          trend: [],
        },
      ],
    } as unknown as ProjectLeaderboard;

    const rows = projectLeaderboardToRows(leaderboard, { sessions: 'main' });
    expect(rows[0].cleanRateText).toBe('—');
    expect(rows[0].cleanRateSampleLabel).toBe('n=0 of 1');
  });

  it('renders "—" for a project with no recorded last-active timestamp', () => {
    const leaderboard = {
      token: {},
      rows: [
        {
          projectId: 'p1',
          name: 'A',
          sessionCount: 1,
          tokens: { inputTokens: 0, inputKnownN: 0, outputTokens: 0, outputKnownN: 0 },
          cleanRate: { value: null, eligibleN: 0, knownN: 0 },
          trend: [],
        },
      ],
    } as unknown as ProjectLeaderboard;

    const rows = projectLeaderboardToRows(leaderboard, { sessions: 'main' });
    expect(rows[0].lastActiveText).toBe('—');
  });

  it('carries a returnContext back to the portfolio filter state', () => {
    const leaderboard = {
      token: {},
      rows: [
        {
          projectId: 'p1',
          name: 'A',
          sessionCount: 1,
          tokens: { inputTokens: 0, inputKnownN: 0, outputTokens: 0, outputKnownN: 0 },
          cleanRate: { value: null, eligibleN: 0, knownN: 0 },
          trend: [],
        },
      ],
    } as unknown as ProjectLeaderboard;

    const rows = projectLeaderboardToRows(leaderboard, { project: 'p1', sessions: 'main' });
    expect(rows[0].href).toContain('#/projects/A');
    expect(rows[0].href).toContain('returnContext=');
  });

  it("exposes the combined tokens figure's sample size as the smaller of the two independently-tracked coverage counts", () => {
    const leaderboard = {
      token: {},
      rows: [
        {
          projectId: 'p1',
          name: 'A',
          sessionCount: 5,
          tokens: { inputTokens: 100, inputKnownN: 5, outputTokens: 200, outputKnownN: 3 },
          cleanRate: { value: null, eligibleN: 0, knownN: 0 },
          trend: [],
        },
      ],
    } as unknown as ProjectLeaderboard;

    const rows = projectLeaderboardToRows(leaderboard, { sessions: 'main' });
    expect(rows[0].tokensSampleLabel).toBe('n=3');
  });

  it('builds a textual trend summary for the sparkline (which is aria-hidden and needs a text alternative)', () => {
    const leaderboard = {
      token: {},
      rows: [
        {
          projectId: 'p1',
          name: 'A',
          sessionCount: 5,
          tokens: { inputTokens: 0, inputKnownN: 0, outputTokens: 0, outputKnownN: 0 },
          cleanRate: { value: null, eligibleN: 0, knownN: 0 },
          trend: [
            { day: '2024-01-01', sessionCount: 2 },
            { day: '2024-01-02', sessionCount: 9 },
            { day: '2024-01-03', sessionCount: 4 },
          ],
        },
      ],
    } as unknown as ProjectLeaderboard;

    const rows = projectLeaderboardToRows(leaderboard, { sessions: 'main' });
    expect(rows[0].trendAriaLabel).toContain('2 on 2024-01-01');
    expect(rows[0].trendAriaLabel).toContain('4 on 2024-01-03');
    expect(rows[0].trendAriaLabel).toContain('peak 9');
  });

  it('gives an explicit "no data" trend summary when the trend series is empty', () => {
    const leaderboard = {
      token: {},
      rows: [
        {
          projectId: 'p1',
          name: 'A',
          sessionCount: 0,
          tokens: { inputTokens: 0, inputKnownN: 0, outputTokens: 0, outputKnownN: 0 },
          cleanRate: { value: null, eligibleN: 0, knownN: 0 },
          trend: [],
        },
      ],
    } as unknown as ProjectLeaderboard;

    const rows = projectLeaderboardToRows(leaderboard, { sessions: 'main' });
    expect(rows[0].trendAriaLabel).toBe('30-day session trend: no data');
  });
});
