import type { EvidenceLink } from '@lucasschirm/sal-db';
import { describe, expect, it } from 'vitest';
import {
  buildPortfolioHash,
  detectRangeSelection,
  evidenceLinkHref,
  type PortfolioParams,
  parsePortfolioHash,
  portfolioParamsToQuery,
  resolveRangePreset,
} from '../../src/pages/portfolio/portfolio-params';

function makeLink(overrides: Partial<EvidenceLink> = {}): EvidenceLink {
  return {
    evidenceId: 'e1',
    entityType: 'project',
    entityId: 'x',
    label: 'Link',
    ...overrides,
  } as EvidenceLink;
}

describe('parsePortfolioHash', () => {
  it('returns defaults for an empty hash', () => {
    expect(parsePortfolioHash('')).toEqual({ sessions: 'main' });
  });

  it('returns defaults for a hash with no query string', () => {
    expect(parsePortfolioHash('#/portfolio')).toEqual({ sessions: 'main' });
  });

  it('parses all filter params from the hash', () => {
    const hash =
      '#/portfolio?project=p1&harness=claude-code&model=sonnet&mode=auto&component=c1&search=test&timeStart=2024-01&timeEnd=2024-02&analysisRelease=r1&comparabilityGroup=g1&generation=gen1&sessions=all';
    const params = parsePortfolioHash(hash);
    expect(params).toEqual({
      project: 'p1',
      harness: 'claude-code',
      model: 'sonnet',
      mode: 'auto',
      component: 'c1',
      search: 'test',
      timeStart: '2024-01',
      timeEnd: '2024-02',
      analysisRelease: 'r1',
      comparabilityGroup: 'g1',
      generation: 'gen1',
      sessions: 'all',
    });
  });

  it('preserves default sessions when sessions param is absent', () => {
    const params = parsePortfolioHash('#/portfolio?project=p1');
    expect(params.sessions).toBe('main');
    expect(params.project).toBe('p1');
  });

  it('ignores empty param values', () => {
    const params = parsePortfolioHash('#/portfolio?project=&harness=');
    expect(params.project).toBeUndefined();
    expect(params.harness).toBeUndefined();
  });
});

describe('buildPortfolioHash', () => {
  it('returns empty string for empty params', () => {
    expect(buildPortfolioHash({})).toBe('');
  });

  it('builds a query string with all set params', () => {
    const params: PortfolioParams = {
      project: 'p1',
      harness: 'claude-code',
      sessions: 'all',
    };
    const hash = buildPortfolioHash(params);
    expect(hash).toContain('project=p1');
    expect(hash).toContain('harness=claude-code');
    expect(hash).toContain('sessions=all');
    expect(hash.startsWith('?')).toBe(true);
  });

  it('skips undefined and empty string values', () => {
    const params: PortfolioParams = {
      project: 'p1',
      harness: undefined,
      model: '',
    };
    const hash = buildPortfolioHash(params);
    expect(hash).toContain('project=p1');
    expect(hash).not.toContain('harness');
    expect(hash).not.toContain('model');
  });

  it('includes sessions=main when explicitly set', () => {
    const hash = buildPortfolioHash({ sessions: 'main' });
    expect(hash).toBe('?sessions=main');
  });
});

describe('portfolioParamsToQuery', () => {
  it('returns a query with no filters for default params', () => {
    const query = portfolioParamsToQuery({ sessions: 'main' });
    expect(query.filters).toEqual([]);
    expect(query.timeRange).toBeUndefined();
    expect(query.analysisReleaseId).toBeUndefined();
  });

  it('builds eq filters for project, harness, model, mode, component', () => {
    const query = portfolioParamsToQuery({
      project: 'p1',
      harness: 'claude-code',
      model: 'sonnet',
      mode: 'auto',
      component: 'c1',
    });
    expect(query.filters).toEqual([
      { field: 'projectId', operator: 'eq', value: 'p1' },
      { field: 'harness', operator: 'eq', value: 'claude-code' },
      { field: 'model', operator: 'eq', value: 'sonnet' },
      { field: 'mode', operator: 'eq', value: 'auto' },
      { field: 'componentId', operator: 'eq', value: 'c1' },
    ]);
  });

  it('builds a contains filter for search', () => {
    const query = portfolioParamsToQuery({ search: 'test' });
    expect(query.filters).toEqual([{ field: 'search', operator: 'contains', value: 'test' }]);
  });

  it('builds a timeRange when both start and end are present', () => {
    const query = portfolioParamsToQuery({ timeStart: '2024-01', timeEnd: '2024-02' });
    expect(query.timeRange).toEqual({ start: '2024-01', end: '2024-02' });
  });

  it('omits timeRange when only start is present', () => {
    const query = portfolioParamsToQuery({ timeStart: '2024-01' });
    expect(query.timeRange).toBeUndefined();
  });

  it('omits timeRange when only end is present', () => {
    const query = portfolioParamsToQuery({ timeEnd: '2024-02' });
    expect(query.timeRange).toBeUndefined();
  });

  it('forwards analysisRelease, comparabilityGroup, and generation', () => {
    const query = portfolioParamsToQuery({
      analysisRelease: 'r1',
      comparabilityGroup: 'g1',
      generation: 'gen1',
    });
    expect(query.analysisReleaseId).toBe('r1');
    expect(query.comparabilityGroupId).toBe('g1');
    expect(query.generationId).toBe('gen1');
  });
});

describe('resolveRangePreset', () => {
  const now = new Date('2026-09-02T12:00:00.000Z');

  it('resolves 7d to an explicit start/end window', () => {
    const range = resolveRangePreset('7d', now);
    expect(range.timeEnd).toBe(now.toISOString());
    expect(range.timeStart).toBe(new Date('2026-08-26T12:00:00.000Z').toISOString());
  });

  it('resolves 30d and 90d windows', () => {
    expect(resolveRangePreset('30d', now).timeStart).toBe(
      new Date('2026-08-03T12:00:00.000Z').toISOString(),
    );
    expect(resolveRangePreset('90d', now).timeStart).toBe(
      new Date('2026-06-04T12:00:00.000Z').toISOString(),
    );
  });

  it('resolves all to both bounds omitted (unbounded window)', () => {
    const range = resolveRangePreset('all', now);
    expect(range.timeStart).toBeUndefined();
    expect(range.timeEnd).toBeUndefined();
  });
});

describe('detectRangeSelection', () => {
  const now = new Date('2026-09-02T12:00:00.000Z');

  it('detects all when both bounds are omitted', () => {
    expect(detectRangeSelection({})).toBe('all');
  });

  it('detects a preset from its resolved window', () => {
    const range = resolveRangePreset('7d', now);
    expect(detectRangeSelection(range)).toBe('7d');
  });

  it('detects 30d and 90d symmetrically', () => {
    expect(detectRangeSelection(resolveRangePreset('30d', now))).toBe('30d');
    expect(detectRangeSelection(resolveRangePreset('90d', now))).toBe('90d');
  });

  it('falls back to custom for an arbitrary legacy range', () => {
    const legacy = { timeStart: '2024-01-01T00:00:00.000Z', timeEnd: '2024-02-01T00:00:00.000Z' };
    expect(detectRangeSelection(legacy)).toBe('custom');
  });

  it('falls back to custom when only one bound is present', () => {
    expect(detectRangeSelection({ timeStart: '2024-01-01T00:00:00.000Z' })).toBe('custom');
    expect(detectRangeSelection({ timeEnd: '2024-01-01T00:00:00.000Z' })).toBe('custom');
  });

  /**
   * Regression for a `pr-review` finding on #167: matching must be
   * duration-only, never tied to how long ago the preset was selected.
   * `detectRangeSelection` is re-derived on every `filter-bar` render (e.g.
   * a `data-change` event long after selection), so a "recency of now"
   * check would make a still-correct, still-active preset silently drift
   * into `custom` — disabling the segmented control — purely because time
   * passed while the tab stayed open. Proven days, not minutes, later.
   */
  it('keeps recognizing a preset no matter how much later it is viewed', () => {
    const selectedAt = new Date('2026-09-02T12:00:00.000Z');
    const range = resolveRangePreset('7d', selectedAt);
    expect(detectRangeSelection(range)).toBe('7d');
    // detectRangeSelection no longer takes a "now" — re-asserting against
    // the same stored range at any later point must still resolve '7d'.
  });
});

describe('legacy bookmarked hash compatibility', () => {
  it('round-trips a hash containing every current param', () => {
    const hash =
      '#/portfolio?project=p1&harness=claude-code&model=sonnet&mode=auto&component=c1&search=test&timeStart=2024-01-01T00%3A00%3A00.000Z&timeEnd=2024-02-01T00%3A00%3A00.000Z&analysisRelease=r1&comparabilityGroup=g1&generation=gen1&sessions=all';
    const params = parsePortfolioHash(hash);
    const rebuilt = buildPortfolioHash(params);
    const reparsed = parsePortfolioHash(`#/portfolio${rebuilt}`);

    expect(reparsed).toEqual(params);
    expect(detectRangeSelection(params)).toBe('custom');

    const query = portfolioParamsToQuery(params);
    expect(query.timeRange).toEqual({
      start: '2024-01-01T00:00:00.000Z',
      end: '2024-02-01T00:00:00.000Z',
    });
    expect(query.analysisReleaseId).toBe('r1');
  });

  it('round-trips the All preset as omitted timeStart/timeEnd', () => {
    const params: PortfolioParams = { sessions: 'main' };
    const hash = buildPortfolioHash(params);
    expect(hash).not.toContain('timeStart');
    expect(hash).not.toContain('timeEnd');

    const reparsed = parsePortfolioHash(`#/portfolio${hash}`);
    expect(detectRangeSelection(reparsed)).toBe('all');
  });

  it('parses a hash with only the legacy sessions param and defaults the rest', () => {
    const params = parsePortfolioHash('#/portfolio?sessions=sub_agents');
    expect(params).toEqual({ sessions: 'sub_agents' });
  });
});

describe('evidenceLinkHref', () => {
  it('builds a project behavior link with returnContext', () => {
    const href = evidenceLinkHref(
      makeLink({ entityType: 'project', entityId: 'p1', label: 'Project 1' }),
      { project: 'p1', sessions: 'main' },
    );
    expect(href).toContain('#/projects/p1');
    expect(href).not.toContain('#/projects/p1/behavior');
    expect(href).toContain('returnContext=');
  });

  it('builds a session link', () => {
    const href = evidenceLinkHref(
      makeLink({ entityType: 'session', entityId: 's1', label: 'Session 1' }),
    );
    expect(href).toBe('#/sessions/s1');
  });

  it('builds a component link with return context', () => {
    const href = evidenceLinkHref(
      makeLink({ entityType: 'component', entityId: 'c1', label: 'Component 1' }),
      { sessions: 'main' },
    );
    expect(href).toContain('#/artifacts');
    expect(href).toContain('c1');
  });

  it('builds a portfolio link with filters', () => {
    const href = evidenceLinkHref(
      makeLink({ entityType: 'portfolio', entityId: '', label: 'Portfolio' }),
      { project: 'p1', sessions: 'main' },
    );
    expect(href).toContain('#/');
    expect(href).toContain('project=p1');
  });

  it('falls back to portfolio for unknown entity types', () => {
    const href = evidenceLinkHref(
      makeLink({ entityType: 'unknown' as never, entityId: 'x', label: 'Unknown' }),
      { sessions: 'main' },
    );
    expect(href).toContain('#/');
  });
});
