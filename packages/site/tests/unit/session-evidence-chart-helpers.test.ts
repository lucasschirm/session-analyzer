import type {
  ComponentFactPage,
  ContextTimingSeries,
  RootChildBreakdown,
  SessionEvidenceSummary,
  SessionTree,
} from '@lucasschirm/sal-db';
import { describe, expect, it } from 'vitest';
import { toEChartsOption } from '../../src/components/charts/chart-helpers';
import {
  componentFactsToChartSeries,
  componentFactsToRows,
  contextGrowthToChartSeries,
  contextTimingToChartSeries,
  evidenceToTableRows,
  rootChildToChartSeries,
  sessionTreeToRows,
  summaryToMetricCards,
} from '../../src/pages/session-evidence/session-evidence-chart-helpers';
import type { SessionEvidenceParams } from '../../src/pages/session-evidence/session-evidence-params';

describe('contextGrowthToChartSeries', () => {
  it('converts context timing series into stacked_bar chart series with chronological order preserved', () => {
    const series: ContextTimingSeries = {
      token: {
        analysisReleaseId: 'rel-1',
        generationId: 'gen-1',
        comparabilityGroupId: 'grp',
        eligibleN: 3,
        knownN: 3,
        unknownCount: 0,
        coverage: 'complete',
        measurementClass: 'observed',
        confidence: 'high',
        metricVersion: '1.0.0',
        evidenceLinks: [],
      },
      points: [
        {
          turnNumber: 1,
          messageIndex: 1,
          messageId: 'm1',
          role: 'user',
          timestamp: '2026-01-01T00:00:00Z',
          totalTokens: 100,
          contextTokens: 80,
          generationTokens: 20,
          inputTokens: 80,
          outputTokens: 20,
        },
        {
          turnNumber: 2,
          messageIndex: 2,
          messageId: 'm2',
          role: 'assistant',
          timestamp: '2026-01-01T00:01:00Z',
          totalTokens: 250,
          contextTokens: 200,
          generationTokens: 50,
          inputTokens: 200,
          outputTokens: 50,
        },
        {
          turnNumber: 3,
          messageIndex: 3,
          messageId: 'm3',
          role: 'user',
          timestamp: '2026-01-01T00:02:00Z',
          totalTokens: 300,
          contextTokens: 300,
          generationTokens: 0,
          inputTokens: 300,
          outputTokens: 0,
        },
      ],
    };

    const result = contextGrowthToChartSeries(series, 'sess-123');

    expect(result.seriesId).toBe('context-growth');
    expect(result.chartType).toBe('stacked_bar');
    expect(result.xLabel).toBe('Message');
    expect(result.yLabel).toBe('Tokens');

    // Message 1: Context (80) + Generation (20)
    // Message 2: Context (200) + Generation (50)
    // Message 3: Context (300) only (generationTokens is 0)
    expect(result.buckets).toHaveLength(5);

    expect(result.buckets[0]).toEqual({
      x: '#1 user',
      y: 80,
      label: 'Message #1 (user): context 80 tokens',
      series: 'Context',
      evidenceLink: {
        label: 'Message #1 (user)',
        href: '#/sessions/sess-123#msg-m1',
      },
    });

    expect(result.buckets[1]).toEqual({
      x: '#1 user',
      y: 20,
      label: 'Message #1 (user): generation 20 tokens',
      series: 'Generation',
      evidenceLink: {
        label: 'Message #1 (user)',
        href: '#/sessions/sess-123#msg-m1',
      },
    });

    expect(result.buckets[2].x).toBe('#2 assistant');
    expect(result.buckets[2].y).toBe(200);
    expect(result.buckets[2].series).toBe('Context');

    expect(result.buckets[3].x).toBe('#2 assistant');
    expect(result.buckets[3].y).toBe(50);
    expect(result.buckets[3].series).toBe('Generation');

    expect(result.buckets[4].x).toBe('#3 user');
    expect(result.buckets[4].y).toBe(300);
    expect(result.buckets[4].series).toBe('Context');
  });

  it('falls back to turnNumber and role "message" if messageIndex or role are missing', () => {
    const series: ContextTimingSeries = {
      token: {
        analysisReleaseId: 'rel-1',
        generationId: 'gen-1',
        comparabilityGroupId: 'grp',
        eligibleN: 1,
        knownN: 1,
        unknownCount: 0,
        coverage: 'complete',
        measurementClass: 'observed',
        confidence: 'high',
        metricVersion: '1.0.0',
        evidenceLinks: [],
      },
      points: [
        {
          turnNumber: 5,
          timestamp: '2026-01-01T00:00:00Z',
          totalTokens: 100,
          contextTokens: 75,
          generationTokens: null,
        },
      ],
    };

    const result = contextGrowthToChartSeries(series);
    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0].x).toBe('#5 message');
    expect(result.buckets[0].y).toBe(75);
    expect(result.buckets[0].evidenceLink?.href).toBe('');
  });

  it('includes Compacted series bucket and enforces stack order when compaction occurs', () => {
    const series: ContextTimingSeries = {
      token: {
        analysisReleaseId: 'rel-1',
        generationId: 'gen-1',
        comparabilityGroupId: 'grp',
        eligibleN: 2,
        knownN: 2,
        unknownCount: 0,
        coverage: 'complete',
        measurementClass: 'observed',
        confidence: 'high',
        metricVersion: '1.0.0',
        evidenceLinks: [],
      },
      points: [
        {
          turnNumber: 1,
          messageIndex: 1,
          messageId: 'm1',
          role: 'user',
          timestamp: '2026-08-11T10:00:00.000Z',
          totalTokens: 50100,
          contextTokens: 50000,
          generationTokens: 100,
        },
        {
          turnNumber: 2,
          messageIndex: 2,
          messageId: 'm2',
          role: 'assistant',
          timestamp: '2026-08-11T10:00:10.000Z',
          totalTokens: 12050,
          contextTokens: 12000,
          generationTokens: 50,
          compactedTokens: 38000,
        },
      ],
    };

    const result = contextGrowthToChartSeries(series, 'sess-compact');

    expect(result.seriesOrder).toEqual(['Context', 'Compacted', 'Generation']);
    expect(result.colors).toEqual(['#4f8cff', '#ffb86c', '#3ecf8e']);

    // Point 1: Context (50000) + Generation (100)
    // Point 2: Context (12000) + Compacted (38000) + Generation (50)
    expect(result.buckets).toHaveLength(5);

    const p2Buckets = result.buckets.filter((b) => b.x === '#2 assistant');
    expect(p2Buckets).toHaveLength(3);

    const contextBucket = p2Buckets.find((b) => b.series === 'Context');
    expect(contextBucket).toBeDefined();
    expect(contextBucket?.y).toBe(12000);
    expect(contextBucket?.label).toContain('context 12,000 tokens');

    const compactedBucket = p2Buckets.find((b) => b.series === 'Compacted');
    expect(compactedBucket).toBeDefined();
    expect(compactedBucket?.y).toBe(38000);
    expect(compactedBucket?.label).toContain('compacted 38,000 tokens');
    expect(compactedBucket?.evidenceLink?.href).toBe('#/sessions/sess-compact#msg-m2');

    const genBucket = p2Buckets.find((b) => b.series === 'Generation');
    expect(genBucket).toBeDefined();
    expect(genBucket?.y).toBe(50);
    expect(genBucket?.label).toContain('generation 50 tokens');

    // Verify ECharts option generated from result respects stack and series order
    const option = toEChartsOption(result) as {
      color?: string[];
      series?: Array<{ name: string; stack: string; data: unknown[] }>;
    };
    expect(option.color).toEqual(['#4f8cff', '#ffb86c', '#3ecf8e']);
    expect(option.series).toHaveLength(3);
    expect(option.series?.[0].name).toBe('Context');
    expect(option.series?.[0].stack).toBe('total');
    expect(option.series?.[1].name).toBe('Compacted');
    expect(option.series?.[1].stack).toBe('total');
    expect(option.series?.[2].name).toBe('Generation');
    expect(option.series?.[2].stack).toBe('total');
  });

  it('infers removedTokens fallback when context drops between turns and compactedTokens is absent', () => {
    const series: ContextTimingSeries = {
      token: {
        analysisReleaseId: 'rel-1',
        generationId: 'gen-1',
        comparabilityGroupId: 'grp',
        eligibleN: 2,
        knownN: 2,
        unknownCount: 0,
        coverage: 'complete',
        measurementClass: 'observed',
        confidence: 'high',
        metricVersion: '1.0.0',
        evidenceLinks: [],
      },
      points: [
        {
          turnNumber: 1,
          messageIndex: 1,
          messageId: 'm1',
          role: 'user',
          timestamp: '2026-08-11T10:00:00.000Z',
          totalTokens: 60000,
          contextTokens: 60000,
          generationTokens: 0,
        },
        {
          turnNumber: 2,
          messageIndex: 2,
          messageId: 'm2',
          role: 'assistant',
          timestamp: '2026-08-11T10:00:10.000Z',
          totalTokens: 20000,
          contextTokens: 20000,
          generationTokens: 0,
        },
      ],
    };

    const result = contextGrowthToChartSeries(series, 'sess-fallback');
    const compactedBucket = result.buckets.find(
      (b) => b.x === '#2 assistant' && b.series === 'Compacted',
    );
    expect(compactedBucket).toBeDefined();
    expect(compactedBucket?.y).toBe(40000); // 60000 - 20000
    expect(compactedBucket?.label).toContain('compacted 40,000 tokens');
  });
});

describe('contextTimingToChartSeries', () => {
  it('converts points into annotated_timeline series', () => {
    const series: ContextTimingSeries = {
      token: {
        analysisReleaseId: 'rel-1',
        generationId: 'gen-1',
        comparabilityGroupId: 'grp',
        eligibleN: 1,
        knownN: 1,
        unknownCount: 0,
        coverage: 'complete',
        measurementClass: 'observed',
        confidence: 'high',
        metricVersion: '1.0.0',
        evidenceLinks: [],
      },
      points: [
        {
          turnNumber: 1,
          timestamp: '2026-01-01T00:00:00Z',
          totalTokens: 100,
          contextTokens: 80,
          generationTokens: 20,
        },
      ],
    };

    const result = contextTimingToChartSeries(series);
    expect(result.seriesId).toBe('context-timing');
    expect(result.chartType).toBe('annotated_timeline');
    expect(result.buckets).toHaveLength(3);
    expect(result.buckets[0].series).toBe('Total');
    expect(result.buckets[1].series).toBe('Context');
    expect(result.buckets[2].series).toBe('Generation');
  });
});

describe('componentFactsToChartSeries and componentFactsToRows', () => {
  it('converts component facts to chart series and table rows', () => {
    const page: ComponentFactPage = {
      items: [
        {
          componentId: 'Bash',
          kind: 'tool',
          invocationCount: 10,
          outcome: 'success',
          metricValues: [
            {
              analysisReleaseId: 'rel-1',
              generationId: 'gen-1',
              comparabilityGroupId: 'grp',
              eligibleN: 1,
              knownN: 1,
              unknownCount: 0,
              coverage: 'complete',
              measurementClass: 'observed',
              confidence: 'high',
              metricVersion: '1.0.0',
              evidenceLinks: [],
              metricId: 'invocations',
              label: 'Invocations',
              value: 10,
              unit: 'count',
              isExact: true,
            },
          ],
        },
      ],
      generationToken: 'gen-1',
      analysisReleaseToken: 'rel-1',
    };

    const chartSeries = componentFactsToChartSeries(page);
    expect(chartSeries.seriesId).toBe('component-facts');
    expect(chartSeries.buckets[0].x).toBe('Bash');
    expect(chartSeries.buckets[0].y).toBe(10);
    expect(chartSeries.buckets[0].series).toBe('tool');

    const rows = componentFactsToRows(page);
    expect(rows).toHaveLength(1);
    expect(rows[0].componentId).toBe('Bash');
    expect(rows[0].kind).toBe('tool');
    expect(rows[0].invocations).toBe(10);
    expect(rows[0].metrics).toContain('Invocations: 10');
  });
});

describe('rootChildToChartSeries and sessionTreeToRows', () => {
  it('converts root child breakdown into chart series', () => {
    const breakdown: RootChildBreakdown = {
      token: {
        analysisReleaseId: 'rel-1',
        generationId: 'gen-1',
        comparabilityGroupId: 'grp',
        eligibleN: 2,
        knownN: 2,
        unknownCount: 0,
        coverage: 'complete',
        measurementClass: 'observed',
        confidence: 'high',
        metricVersion: '1.0.0',
        evidenceLinks: [],
      },
      root: {
        sessionId: 'root-s',
        childCount: 2,
        isRoot: true,
        contributionMetrics: [],
      },
      children: [
        {
          sessionId: 'child-1',
          childCount: 0,
          isRoot: false,
          contributionMetrics: [],
        },
      ],
    };

    const chart = rootChildToChartSeries(breakdown);
    expect(chart.seriesId).toBe('root-child');
    expect(chart.buckets).toHaveLength(2);
    expect(chart.buckets[0].series).toBe('root');
    expect(chart.buckets[1].series).toBe('child');
  });

  it('converts tree to flattened row views', () => {
    const tree: SessionTree = {
      rootSessionId: 'root-s',
      nodes: [
        {
          sessionId: 'root-s',
          generationToken: 'gen-1',
          children: [
            {
              sessionId: 'sub-1',
              generationToken: 'gen-1',
              children: [],
            },
          ],
        },
      ],
    };

    const rows = sessionTreeToRows(tree);
    expect(rows).toHaveLength(2);
    expect(rows[0].sessionId).toBe('root-s');
    expect(rows[0].isRoot).toBe(true);
    expect(rows[1].sessionId).toBe('sub-1');
    expect(rows[1].isRoot).toBe(false);
    expect(rows[1].depth).toBe(1);
  });

  it('handles null tree gracefully', () => {
    expect(sessionTreeToRows(null)).toEqual([]);
  });
});

describe('evidenceToTableRows', () => {
  it('formats evidence rows into table rows', () => {
    const rows = evidenceToTableRows([
      { timestamp: '2026-01-01T00:00:00Z', summary: 'Tool call', entityType: 'tool' },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].x).toBe('2026-01-01T00:00:00Z');
    expect(rows[0].y).toBe('Tool call');
    expect(rows[0].series).toBe('tool');
  });
});

describe('summaryToMetricCards', () => {
  it('maps summary headline metrics to metric cards', () => {
    const summary: SessionEvidenceSummary = {
      token: {
        analysisReleaseId: 'rel-1',
        generationId: 'gen-1',
        comparabilityGroupId: 'grp',
        eligibleN: 1,
        knownN: 1,
        unknownCount: 0,
        coverage: 'complete',
        measurementClass: 'observed',
        confidence: 'high',
        metricVersion: '1.0.0',
        evidenceLinks: [],
      },
      sessionId: 's1',
      rootSessionId: 's1',
      harness: 'claude',
      headlineMetrics: [
        {
          analysisReleaseId: 'rel-1',
          generationId: 'gen-1',
          comparabilityGroupId: 'grp',
          eligibleN: 10,
          knownN: 10,
          unknownCount: 0,
          coverage: 'complete',
          measurementClass: 'observed',
          confidence: 'high',
          metricVersion: '1.0.0',
          metricId: 'total_tokens',
          label: 'Total Tokens',
          value: 5000,
          unit: 'count',
          isExact: true,
          evidenceLinks: [
            { evidenceId: 'e1', entityType: 'session', entityId: 's1', label: 'Session' },
          ],
        },
      ],
    };

    const params: SessionEvidenceParams = {
      view: 'evidence',
    };

    const cards = summaryToMetricCards(summary, params);
    expect(cards).toHaveLength(1);
    expect(cards[0].metricId).toBe('total_tokens');
    expect(cards[0].value).toBe('5,000');
    expect(cards[0].sub).toContain('n=10');
  });
});
