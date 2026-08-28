import type { EvidenceLink } from '@lucasschirm/sal-db';
import { describe, expect, it } from 'vitest';
import {
  buildPortfolioHash,
  evidenceLinkHref,
  type PortfolioParams,
  parsePortfolioHash,
  portfolioParamsToQuery,
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

describe('evidenceLinkHref', () => {
  it('builds a project behavior link with returnContext', () => {
    const href = evidenceLinkHref(
      makeLink({ entityType: 'project', entityId: 'p1', label: 'Project 1' }),
      { project: 'p1', sessions: 'main' },
    );
    expect(href).toContain('#/projects/p1/behavior');
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
    expect(href).toContain('#/components');
    expect(href).toContain('c1');
  });

  it('builds a portfolio link with filters', () => {
    const href = evidenceLinkHref(
      makeLink({ entityType: 'portfolio', entityId: '', label: 'Portfolio' }),
      { project: 'p1', sessions: 'main' },
    );
    expect(href).toContain('#/portfolio');
    expect(href).toContain('project=p1');
  });

  it('falls back to portfolio for unknown entity types', () => {
    const href = evidenceLinkHref(
      makeLink({ entityType: 'unknown' as never, entityId: 'x', label: 'Unknown' }),
      { sessions: 'main' },
    );
    expect(href).toContain('#/portfolio');
  });
});
