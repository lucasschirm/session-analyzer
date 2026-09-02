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

function tokenStub(overrides: Partial<ProjectStatStrip['token']> = {}) {
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
    ...overrides,
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
  // The largest-remainder rounding that makes bucket percentages sum to
  // exactly 100 happens once in `getSessionOutcomeDistribution`
  // (`packages/db/src/analytics-session.ts`) — proven exhaustively by
  // `packages/db/tests/unit/project-behavior-171.test.ts`
  // ("getOutcomeMix bucket percent allocation"). `outcomeMixToView` only
  // formats the DTO's already-computed `count`/`percent` fields
  // (`.agents/rules/no-canonical-metrics-in-lit.md`) — these tests prove it
  // passes them through unmodified, not that the math is correct.
  it('reads count/percent straight through from the DTO buckets, and total from token.eligibleN', () => {
    const mix: SessionOutcomeDistribution = {
      token: tokenStub({ eligibleN: 13 }),
      buckets: [
        { outcome: 'clean', count: 7, percent: 54 },
        { outcome: 'interrupted_by_user', count: 2, percent: 15 },
        { outcome: 'ended_on_error', count: 1, percent: 8 },
        { outcome: null, count: 3, percent: 23 },
      ],
    };
    const view = outcomeMixToView(mix);
    expect(view.total).toBe(13);
    expect(view.rows.map((r) => [r.outcome, r.count, r.percent])).toEqual([
      ['clean', 7, 54],
      ['interrupted_by_user', 2, 15],
      ['ended_on_error', 1, 8],
    ]);
    expect(view.unreadableTailCount).toBe(3);
    expect(view.unreadableTailPercent).toBe(23);
  });

  it('defaults a missing bucket to count/percent 0 rather than throwing', () => {
    const mix: SessionOutcomeDistribution = {
      token: tokenStub({ eligibleN: 5 }),
      buckets: [{ outcome: 'clean', count: 5, percent: 100 }],
    };
    const view = outcomeMixToView(mix);
    expect(view.rows.find((r) => r.outcome === 'interrupted_by_user')?.count).toBe(0);
    expect(view.unreadableTailCount).toBe(0);
    expect(view.unreadableTailPercent).toBe(0);
  });

  it('reports zero total when there are no eligible sessions at all', () => {
    const mix: SessionOutcomeDistribution = { token: tokenStub({ eligibleN: 0 }), buckets: [] };
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
  // deltaPercent/deltaDirection are read-contract fields, already computed by
  // packages/db (`.agents/rules/no-canonical-metrics-in-lit.md`) — these
  // fixtures supply them exactly as `getStatStrip` would, and the helper
  // under test only formats them.
  it('renders "—" for every delta under the All time-range preset', () => {
    const strip = statStripFixture({
      sessions: {
        current: 10,
        currentN: 10,
        previous: 5,
        previousN: 5,
        deltaPercent: 100,
        deltaDirection: 'up',
      },
    });
    const view = statStripToView(strip, 'all');
    expect(view.sessions.delta).toEqual({ direction: 'flat', text: '—' });
  });

  it('formats a precomputed delta outside the All preset when a previous window exists', () => {
    const strip = statStripFixture({
      sessions: {
        current: 12,
        currentN: 12,
        previous: 10,
        previousN: 10,
        deltaPercent: 20,
        deltaDirection: 'up',
      },
    });
    const view = statStripToView(strip, '7d');
    expect(view.sessions.delta).toEqual({ direction: 'up', text: '+20%' });
  });

  it('renders "—" text (not a fabricated 0%) when deltaPercent is null (previous was 0)', () => {
    const strip = statStripFixture({
      sessions: {
        current: 3,
        currentN: 3,
        previous: 0,
        previousN: 0,
        deltaPercent: null,
        deltaDirection: 'up',
      },
    });
    const view = statStripToView(strip, '7d');
    expect(view.sessions.delta).toEqual({ direction: 'up', text: '—' });
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
