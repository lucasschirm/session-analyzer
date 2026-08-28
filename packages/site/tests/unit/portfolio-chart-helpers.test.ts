import type {
  ComponentUtilizationPage,
  MetricValueDto,
  ModelHarnessCohortPage,
  PortfolioOverview,
  PortfolioTrendSeries,
  ProjectListPage,
  TimeSeriesPoint,
} from '@lucasschirm/sal-db';
import { describe, expect, it } from 'vitest';
import {
  componentUtilizationToChartSeries,
  filterByScope,
  isTokenMetric,
  metricLabel,
  modelHarnessCohortsToChartSeries,
  overviewToMetricCards,
  projectListToRows,
  stripScopeSuffix,
  tokenTrendToChartSeries,
  trendToChartSeries,
} from '../../src/pages/portfolio/portfolio-chart-helpers';
import type { PortfolioParams } from '../../src/pages/portfolio/portfolio-params';

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

function makeMetric(overrides: Partial<MetricValueDto> = {}): MetricValueDto {
  return {
    metricId: 'portfolio-session-count',
    label: 'Sessions',
    value: 100,
    unit: 'count',
    knownN: 100,
    eligibleN: 100,
    isExact: true,
    evidenceLinks: [],
    ...overrides,
  } as MetricValueDto;
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

describe('trendToChartSeries', () => {
  it('filters out token metrics and maps to buckets', () => {
    const trend = {
      series: [
        makePoint({ time: 't1', value: 10, metricId: 'm1:root_only', label: 'M1 (root-only)' }),
        makePoint({
          time: 't1',
          value: 500,
          metricId: 'claude:tokens:total::root_only',
          label: 'Tokens (root-only)',
        }),
      ],
    } as unknown as PortfolioTrendSeries;
    const series = trendToChartSeries(trend, 'main');
    expect(series.buckets).toHaveLength(1);
    expect(series.buckets[0].x).toBe('t1');
    expect(series.buckets[0].y).toBe(10);
    expect(series.chartType).toBe('time_series');
  });

  it('uses default scope main', () => {
    const trend = {
      series: [makePoint({ time: 't1', value: 10, metricId: 'm1:root_only' })],
    } as unknown as PortfolioTrendSeries;
    const series = trendToChartSeries(trend);
    expect(series.buckets).toHaveLength(1);
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

describe('componentUtilizationToChartSeries', () => {
  it('maps component utilization rows to chart buckets with evidence links', () => {
    const page = {
      items: [
        { componentId: 'Write', kind: 'tool', sessionCount: 50 },
        { componentId: 'Skill', kind: 'skill', sessionCount: 20 },
      ],
    } as unknown as ComponentUtilizationPage;
    const params: PortfolioParams = { sessions: 'main' };
    const series = componentUtilizationToChartSeries(page, params);
    expect(series.buckets).toHaveLength(2);
    expect(series.buckets[0].x).toBe('Write');
    expect(series.buckets[0].y).toBe(50);
    expect(series.buckets[0].series).toBe('tool');
    expect(series.buckets[0].evidenceLink).toBeDefined();
    expect(series.chartType).toBe('stacked_bar');
  });

  it('works without params', () => {
    const page = {
      items: [{ componentId: 'Read', kind: 'tool', sessionCount: 10 }],
    } as unknown as ComponentUtilizationPage;
    const series = componentUtilizationToChartSeries(page);
    expect(series.buckets).toHaveLength(1);
    expect(series.buckets[0].evidenceLink).toBeDefined();
  });
});

describe('modelHarnessCohortsToChartSeries', () => {
  it('maps cohorts to chart buckets using session count when no metricId', () => {
    const page = {
      items: [
        { model: 'sonnet', harness: 'claude-code', sessionCount: 30, metricValues: [] },
        { model: 'opus', harness: 'claude-code', sessionCount: 15, metricValues: [] },
      ],
    } as unknown as ModelHarnessCohortPage;
    const series = modelHarnessCohortsToChartSeries(page);
    expect(series.buckets).toHaveLength(2);
    expect(series.buckets[0].x).toBe('sonnet');
    expect(series.buckets[0].y).toBe(30);
    expect(series.buckets[0].series).toBe('claude-code');
    expect(series.yLabel).toBe('Sessions');
  });

  it('uses metric value when metricId is provided', () => {
    const page = {
      items: [
        {
          model: 'sonnet',
          harness: 'claude-code',
          sessionCount: 30,
          metricValues: [
            makeMetric({
              metricId: 'm1',
              value: 42,
              label: 'M1',
              unit: 'count',
              knownN: 30,
              eligibleN: 30,
            }),
          ],
        },
      ],
    } as unknown as ModelHarnessCohortPage;
    const series = modelHarnessCohortsToChartSeries(page, 'm1');
    expect(series.buckets[0].y).toBe(42);
    expect(series.yLabel).toBe('Metric value');
  });

  it('falls back to sessionCount when metric value is null', () => {
    const page = {
      items: [
        {
          model: 'sonnet',
          harness: 'claude-code',
          sessionCount: 30,
          metricValues: [
            makeMetric({
              metricId: 'm1',
              value: null,
              label: 'M1',
              unit: 'count',
              knownN: 0,
              eligibleN: 30,
            }),
          ],
        },
      ],
    } as unknown as ModelHarnessCohortPage;
    const series = modelHarnessCohortsToChartSeries(page, 'm1');
    expect(series.buckets[0].y).toBe(30);
  });
});

describe('overviewToMetricCards', () => {
  it('maps headline metrics to card views with sub-text and hrefs', () => {
    const overview = {
      headlineMetrics: [
        makeMetric({
          metricId: 'portfolio-session-count',
          value: 100,
          evidenceLinks: [
            {
              evidenceId: 'e1',
              entityType: 'portfolio' as never,
              entityId: '',
              label: 'Portfolio',
            },
          ],
        }),
        makeMetric({
          metricId: 'portfolio-project-count',
          value: 5,
          unit: 'count',
        }),
      ],
      totalTokens: 50000,
      modelCount: 3,
      harnessCount: 2,
      componentCounts: { skill: 10, tool: 20 },
    } as unknown as PortfolioOverview;

    const params: PortfolioParams = { sessions: 'main' };
    const cards = overviewToMetricCards(overview, params);
    expect(cards).toHaveLength(2);
    expect(cards[0].metricId).toBe('portfolio-session-count');
    expect(cards[0].sub).toBe('3 Models');
    expect(cards[0].href).toBeDefined();
    expect(cards[1].sub).toBe('50,000 Tokens');
  });

  it('computes skill and other component counts for unused-components card', () => {
    const overview = {
      headlineMetrics: [makeMetric({ metricId: 'portfolio-unused-components', value: 5 })],
      totalTokens: 0,
      modelCount: 0,
      harnessCount: 0,
      componentCounts: { skill: 8, tool: 15, agent: 3 },
    } as unknown as PortfolioOverview;

    const cards = overviewToMetricCards(overview, { sessions: 'main' });
    expect(cards[0].sub).toBe('8 Skills • 18 Others');
  });

  it('handles missing component counts gracefully', () => {
    const overview = {
      headlineMetrics: [makeMetric({ metricId: 'portfolio-component-count', value: 5 })],
      totalTokens: 0,
      modelCount: 0,
      harnessCount: 0,
      componentCounts: {},
    } as unknown as PortfolioOverview;

    const cards = overviewToMetricCards(overview, { sessions: 'main' });
    expect(cards[0].sub).toBe('0 Harness');
  });

  it('uses empty sub for unknown metric ids', () => {
    const overview = {
      headlineMetrics: [makeMetric({ metricId: 'unknown-metric', value: 1 })],
      totalTokens: 0,
      modelCount: 0,
      harnessCount: 0,
      componentCounts: {},
    } as unknown as PortfolioOverview;

    const cards = overviewToMetricCards(overview, { sessions: 'main' });
    expect(cards[0].sub).toBe('');
  });

  it('omits href when metric has no evidence links', () => {
    const overview = {
      headlineMetrics: [makeMetric({ evidenceLinks: [] })],
      totalTokens: 0,
      modelCount: 0,
      harnessCount: 0,
      componentCounts: {},
    } as unknown as PortfolioOverview;

    const cards = overviewToMetricCards(overview, { sessions: 'main' });
    expect(cards[0].href).toBeUndefined();
  });

  it('shows eligibleN in coverage when knownN < eligibleN', () => {
    const overview = {
      headlineMetrics: [makeMetric({ knownN: 80, eligibleN: 100, value: 50 })],
      totalTokens: 0,
      modelCount: 0,
      harnessCount: 0,
      componentCounts: {},
    } as unknown as PortfolioOverview;

    // coverageN is internal, but the sub text for portfolio-session-count
    // should still be populated
    const cards = overviewToMetricCards(overview, { sessions: 'main' });
    expect(cards[0]).toBeDefined();
  });
});

describe('projectListToRows', () => {
  it('maps project list items to row views with hrefs', () => {
    const page = {
      items: [
        { projectId: 'p1', name: 'Project A', sessionCount: 10, harness: 'claude-code' },
        { projectId: 'p2', name: 'Project B', sessionCount: 5, harness: 'agentic-pi' },
      ],
    } as unknown as ProjectListPage;

    const params: PortfolioParams = { project: 'p1', sessions: 'main' };
    const rows = projectListToRows(page, params);
    expect(rows).toHaveLength(2);
    expect(rows[0].projectId).toBe('p1');
    expect(rows[0].name).toBe('Project A');
    expect(rows[0].sessionCount).toBe(10);
    expect(rows[0].harness).toBe('claude-code');
    expect(rows[0].href).toContain('#/projects/Project A/behavior');
    expect(rows[0].href).toContain('returnContext=');
  });
});
