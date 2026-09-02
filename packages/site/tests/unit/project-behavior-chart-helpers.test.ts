import type {
  ProjectModelHarnessCohorts,
  ProjectStatStrip,
  SessionDurationHistogram,
  SessionOutcomeDistribution,
} from '@lucasschirm/sal-db';
import { describe, expect, it } from 'vitest';
import {
  costTile,
  durationHistogramToChartSeries,
  modelCohortsToRows,
  outcomeMixToView,
  statStripToView,
} from '../../src/pages/project-behavior/project-behavior-chart-helpers';

function tokenStub() {
  return {
    analysisReleaseId: 'rel-1',
    generationId: 'gen-1',
    comparabilityGroupId: 'cgrp-1',
    eligibleN: 1,
    knownN: 1,
    unknownCount: 0,
    coverage: 'complete',
    measurementClass: 'derived',
    confidence: 'high',
    metricVersion: '1',
    evidenceLinks: [],
  } as ProjectStatStrip['token'];
}

function statStripFixture(overrides: Partial<ProjectStatStrip> = {}): ProjectStatStrip {
  return {
    token: tokenStub(),
    sessions: { current: 10, currentN: 10 },
    durationMedianMs: { value: 60_000, eligibleN: 10, knownN: 10 },
    durationP90Ms: { value: 120_000, eligibleN: 10, knownN: 10 },
    turnsMedian: { value: 5, eligibleN: 10, knownN: 10 },
    turnsP90: { value: 12, eligibleN: 10, knownN: 10 },
    tokensPerSession: { value: 1000, eligibleN: 10, knownN: 10 },
    costPerSession: { value: null, eligibleN: 10, knownN: 0 },
    costHarnessCoverage: { reportingHarnessCount: 1, totalHarnessCount: 2 },
    ...overrides,
  };
}

describe('durationHistogramToChartSeries (issue #171)', () => {
  it('derives bin labels from the DTO startMs/endMs, not a hardcoded table', () => {
    const histogram: SessionDurationHistogram = {
      token: tokenStub(),
      eligibleN: 3,
      knownN: 3,
      bins: [
        { startMs: 0, endMs: 60_000, count: 1 },
        { startMs: 60_000, endMs: 5 * 60_000, count: 2 },
        { startMs: 5 * 60_000, endMs: null, count: 0 },
      ],
    };
    const series = durationHistogramToChartSeries(histogram);
    expect(series.buckets.map((b) => b.x)).toEqual(['0s–1m', '1m–5m', '5m+']);
    expect(series.buckets.map((b) => b.y)).toEqual([1, 2, 0]);
  });

  it('scales bucket y values to the raw counts from the DTO (no rescaling)', () => {
    const histogram: SessionDurationHistogram = {
      token: tokenStub(),
      eligibleN: 1,
      knownN: 1,
      bins: [{ startMs: 0, endMs: null, count: 42 }],
    };
    const series = durationHistogramToChartSeries(histogram);
    expect(series.buckets[0]?.y).toBe(42);
  });
});

describe('outcomeMixToView (issue #171)', () => {
  it('sums bucket counts to the session total exactly', () => {
    const mix: SessionOutcomeDistribution = {
      token: tokenStub(),
      buckets: [
        { outcome: 'clean', count: 7 },
        { outcome: 'interrupted_by_user', count: 2 },
        { outcome: 'ended_on_error', count: 1 },
        { outcome: null, count: 3 },
      ],
    };
    const view = outcomeMixToView(mix);
    const countSum = view.rows.reduce((sum, r) => sum + r.count, 0) + view.unreadableTailCount;
    expect(countSum).toBe(13);
    expect(view.total).toBe(13);
  });

  it('sums bucket percentages to exactly 100 when total > 0', () => {
    // A deliberately awkward split to exercise the largest-remainder rounding.
    const mix: SessionOutcomeDistribution = {
      token: tokenStub(),
      buckets: [
        { outcome: 'clean', count: 1 },
        { outcome: 'interrupted_by_user', count: 1 },
        { outcome: 'ended_on_error', count: 1 },
        { outcome: null, count: 0 },
      ],
    };
    const view = outcomeMixToView(mix);
    const percentSum =
      view.rows.reduce((sum, r) => sum + r.percent, 0) + view.unreadableTailPercent;
    expect(percentSum).toBe(100);
  });

  it('reports the unreadable-tail count separately from classified outcomes', () => {
    const mix: SessionOutcomeDistribution = {
      token: tokenStub(),
      buckets: [
        { outcome: 'clean', count: 5 },
        { outcome: null, count: 2 },
      ],
    };
    const view = outcomeMixToView(mix);
    expect(view.unreadableTailCount).toBe(2);
    expect(view.rows.find((r) => r.outcome === 'clean')?.count).toBe(5);
  });

  it('reports zero for every bucket when there are no sessions at all', () => {
    const mix: SessionOutcomeDistribution = { token: tokenStub(), buckets: [] };
    const view = outcomeMixToView(mix);
    expect(view.total).toBe(0);
    expect(view.rows.every((r) => r.count === 0 && r.percent === 0)).toBe(true);
    expect(view.unreadableTailCount).toBe(0);
  });
});

describe('costTile missing-cost copy (issue #171)', () => {
  it('reports "Not reported by 1 of 2 harnesses" when only one of two harnesses has cost', () => {
    const strip = statStripFixture();
    const tile = costTile(strip);
    expect(tile.missing).toBe(true);
    expect(tile.reason).toBe('Not reported by 1 of 2 harnesses');
  });

  it('reports no harness activity when totalHarnessCount is 0', () => {
    const strip = statStripFixture({
      costHarnessCoverage: { reportingHarnessCount: 0, totalHarnessCount: 0 },
    });
    const tile = costTile(strip);
    expect(tile.reason).toBe('No harness activity in this window');
  });

  it('is not missing when a value is present, regardless of coverage', () => {
    const strip = statStripFixture({
      costPerSession: { value: 1.5, eligibleN: 10, knownN: 5 },
    });
    const tile = costTile(strip);
    expect(tile.missing).toBe(false);
    expect(tile.value).toBe('$1.50');
  });
});

describe('statStripToView delta chips (issue #171)', () => {
  it('renders "—" for every delta under the All time-range preset', () => {
    const strip = statStripFixture({
      sessions: { current: 10, currentN: 10, previous: 5, previousN: 5 },
    });
    const view = statStripToView(strip, 'all');
    expect(view.sessions.delta).toEqual({ direction: 'flat', text: '—' });
  });

  it('computes a real delta outside the All preset when a previous window exists', () => {
    const strip = statStripFixture({
      sessions: { current: 12, currentN: 12, previous: 10, previousN: 10 },
    });
    const view = statStripToView(strip, '7d');
    expect(view.sessions.delta).toEqual({ direction: 'up', text: '+20%' });
  });
});

describe('modelCohortsToRows low-n flagging (issue #171)', () => {
  it('flags a cohort below the low-n threshold in its clean-rate label', () => {
    const cohorts: ProjectModelHarnessCohorts = {
      token: tokenStub(),
      rows: [
        {
          model: 'claude-sonnet',
          harness: 'claude-code',
          n: 2,
          medianTokens: 100,
          medianCost: null,
          cleanRate: 1,
          cleanRateKnownN: 2,
          lowN: true,
        },
      ],
    };
    const rows = modelCohortsToRows(cohorts);
    expect(rows[0]?.lowN).toBe(true);
    expect(rows[0]?.cleanRateLabel).toContain('low n');
    expect(rows[0]?.medianCostLabel).toBe('—');
  });

  it('scales the median-tokens bar to the max across rows', () => {
    const cohorts: ProjectModelHarnessCohorts = {
      token: tokenStub(),
      rows: [
        {
          model: 'a',
          harness: 'h',
          n: 10,
          medianTokens: 50,
          medianCost: null,
          cleanRate: null,
          cleanRateKnownN: 0,
          lowN: false,
        },
        {
          model: 'b',
          harness: 'h',
          n: 10,
          medianTokens: 100,
          medianCost: null,
          cleanRate: null,
          cleanRateKnownN: 0,
          lowN: false,
        },
      ],
    };
    const rows = modelCohortsToRows(cohorts);
    expect(rows[0]?.medianTokensBarPercent).toBe(50);
    expect(rows[1]?.medianTokensBarPercent).toBe(100);
  });
});
