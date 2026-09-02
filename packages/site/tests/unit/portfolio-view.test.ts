import type {
  AnalyticsToken,
  InvocationsByDomain,
  ModelHarnessMatrix,
  PortfolioKpiBand,
  PortfolioTrendSeries,
  ProjectLeaderboard,
  SessionsByModelBar,
} from '@lucasschirm/sal-db';
import type { LitElement } from 'lit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../../src/pages/portfolio/portfolio-view';
import type { PortfolioView } from '../../src/pages/portfolio/portfolio-view';

const portfolioMock = vi.hoisted(() => ({
  getKpiBand: vi.fn(),
  getTrends: vi.fn(),
  getSessionsByModel: vi.fn(),
  getModelHarnessMatrix: vi.fn(),
  getInvocationsByDomain: vi.fn(),
  getProjectLeaderboard: vi.fn(),
}));

const metadataMock = vi.hoisted(() => ({
  getDimensionDomains: vi.fn(),
}));

const mockAnalyticsClient = vi.hoisted(() => {
  const client = new EventTarget() as {
    portfolio: typeof portfolioMock;
    metadata: typeof metadataMock;
    exportAnalyticsDatabase: ReturnType<typeof vi.fn>;
  } & EventTarget;
  client.portfolio = portfolioMock;
  client.metadata = metadataMock;
  client.exportAnalyticsDatabase = vi.fn().mockResolvedValue(new Uint8Array());
  return client;
});

const syncManagerMock = vi.hoisted(() => {
  const manager = new EventTarget() as {
    getSnapshot: ReturnType<typeof vi.fn>;
  } & EventTarget;
  manager.getSnapshot = vi.fn().mockReturnValue({
    initialized: true,
    readOnly: false,
    activeRun: null,
    projects: [],
    sessions: [],
    queuedRuns: [],
    warnings: [],
    lastCompletedAt: null,
  });
  return manager;
});

vi.mock('../../src/db/analytics-client', () => ({
  AnalyticsClient: vi.fn(),
  analyticsClient: mockAnalyticsClient,
}));

vi.mock('../../src/sync/sync-manager', () => ({
  syncManager: syncManagerMock,
}));

async function flush(element: LitElement): Promise<void> {
  await element.updateComplete;
  const children = element.shadowRoot?.querySelectorAll('*') ?? [];
  for (const child of children) {
    const litChild = child as LitElement;
    if (typeof litChild.updateComplete?.then === 'function') {
      await litChild.updateComplete;
    }
  }
}

async function mount<T extends LitElement>(element: T): Promise<T> {
  document.body.appendChild(element);
  await flush(element);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await flush(element);
  await flush(element);
  return element;
}

function tokenFixture(overrides: Partial<AnalyticsToken> = {}): AnalyticsToken {
  return {
    analysisReleaseId: 'rel-1',
    generationId: 'gen-1',
    comparabilityGroupId: 'cgrp-1',
    eligibleN: 100,
    knownN: 95,
    unknownCount: 5,
    coverage: 'complete',
    measurementClass: 'observed',
    confidence: 'high',
    metricVersion: '1.0.0',
    evidenceLinks: [],
    ...overrides,
  };
}

function kpiBandFixture(overrides: Partial<PortfolioKpiBand> = {}): PortfolioKpiBand {
  return {
    token: tokenFixture(),
    sessions: { current: 42, currentN: 42, previous: 30, previousN: 30 },
    tokens: {
      in: { current: 1000, currentN: 42 },
      out: { current: 2000, currentN: 42 },
    },
    cost: { currentTotal: 12.5, currentReportedHarnesses: 1, currentTotalHarnesses: 1 },
    cleanCompletionRate: { value: 0.9, eligibleN: 42, knownN: 40 },
    ...overrides,
  };
}

function trendsFixture(overrides: Partial<PortfolioTrendSeries> = {}): PortfolioTrendSeries {
  return {
    token: tokenFixture(),
    series: [
      {
        time: '2024-01-01',
        value: 100,
        metricId: 'claude:tokens:total::root_only',
        label: 'Total tokens (root-only)',
        comparabilityGroupId: 'cgrp-1',
      },
      {
        time: '2024-01-02',
        value: 150,
        metricId: 'claude:tokens:total::root_only',
        label: 'Total tokens (root-only)',
        comparabilityGroupId: 'cgrp-1',
      },
    ],
    ...overrides,
  };
}

function sessionsByModelFixture(overrides: Partial<SessionsByModelBar> = {}): SessionsByModelBar {
  return {
    token: tokenFixture(),
    rows: [{ model: 'claude-3-5-sonnet', sessionCount: 30 }],
    ...overrides,
  };
}

function matrixFixture(overrides: Partial<ModelHarnessMatrix> = {}): ModelHarnessMatrix {
  return {
    token: tokenFixture(),
    models: ['claude-3-5-sonnet'],
    harnesses: ['claude'],
    cells: [{ model: 'claude-3-5-sonnet', harness: 'claude', sessionCount: 30 }],
    ...overrides,
  };
}

function invocationsFixture(overrides: Partial<InvocationsByDomain> = {}): InvocationsByDomain {
  return {
    token: tokenFixture(),
    totalInvocations: 40,
    rows: [
      { kind: 'tool', count: 20 },
      { kind: 'skill', count: 10 },
      { kind: 'agent', count: 5 },
      { kind: 'sub_agent', count: 5 },
    ],
    ...overrides,
  };
}

function leaderboardFixture(overrides: Partial<ProjectLeaderboard> = {}): ProjectLeaderboard {
  return {
    token: tokenFixture(),
    rows: [
      {
        projectId: 'p1',
        name: 'Project One',
        sessionCount: 3,
        tokens: { inputTokens: 1000, inputKnownN: 3, outputTokens: 2000, outputKnownN: 3 },
        cleanRate: { value: 1, eligibleN: 3, knownN: 3 },
        lastActiveAt: '2024-01-05T00:00:00.000Z',
        trend: [{ day: '2024-01-01', sessionCount: 1 }],
      },
    ],
    ...overrides,
  };
}

function stubPortfolioLoad(): void {
  portfolioMock.getKpiBand.mockResolvedValue(kpiBandFixture());
  portfolioMock.getTrends.mockResolvedValue(trendsFixture());
  portfolioMock.getSessionsByModel.mockResolvedValue(sessionsByModelFixture());
  portfolioMock.getModelHarnessMatrix.mockResolvedValue(matrixFixture());
  portfolioMock.getInvocationsByDomain.mockResolvedValue(invocationsFixture());
  portfolioMock.getProjectLeaderboard.mockResolvedValue(leaderboardFixture());
  metadataMock.getDimensionDomains.mockResolvedValue({
    token: tokenFixture(),
    projects: ['Project One', 'zero-session-harness-project'],
    harnesses: ['claude'],
    models: ['claude-3-5-sonnet'],
  });
}

beforeEach(() => {
  stubPortfolioLoad();
  window.location.hash = '#/';
});

afterEach(() => {
  document.querySelectorAll('portfolio-view').forEach((el) => {
    el.remove();
  });
  document.body.innerHTML = '';
  vi.resetAllMocks();
});

describe('portfolio-view', () => {
  it('loads and renders the title row, KPI band (with n=), trend/model row, heatmap/domains row, and leaderboard', async () => {
    const view = document.createElement('portfolio-view') as PortfolioView;
    await mount(view);
    const root = view.shadowRoot as ShadowRoot;

    expect(root.textContent).toContain('Portfolio');

    const heroTile = root.querySelector('stat-tile-hero');
    expect(heroTile?.getAttribute('value')).toBe('42');
    expect(heroTile?.getAttribute('samplelabel') ?? heroTile?.getAttribute('sampleLabel')).toBe(
      'n=42 sessions',
    );

    expect(root.textContent).toContain('Project One');
    expect(root.textContent).toContain('Project leaderboard');
    expect(root.textContent).toContain('All time');
    expect(root.textContent).toContain('MCP servers');
  });

  it('renders the missing-state tiles (never a fabricated value) for cost and clean completion when uncovered', async () => {
    portfolioMock.getKpiBand.mockResolvedValue(
      kpiBandFixture({
        cost: { currentTotal: null, currentReportedHarnesses: 0, currentTotalHarnesses: 2 },
        cleanCompletionRate: { value: null, eligibleN: 0, knownN: 0 },
      }),
    );

    const view = document.createElement('portfolio-view') as PortfolioView;
    await mount(view);
    const root = view.shadowRoot as ShadowRoot;

    const missingTiles = Array.from(root.querySelectorAll('stat-tile-missing')) as LitElement[];
    expect(missingTiles.length).toBe(2);
    for (const tile of missingTiles) await tile.updateComplete;
    const missingText = missingTiles.map((tile) => tile.shadowRoot?.textContent ?? '').join(' ');
    expect(missingText).toContain('0 of 2 harnesses report cost');
  });

  it('renders a per-card error affordance without blanking a sibling card (no-silent-empty-states)', async () => {
    portfolioMock.getKpiBand.mockRejectedValue(new Error('kpi band down'));

    const view = document.createElement('portfolio-view') as PortfolioView;
    await mount(view);
    const root = view.shadowRoot as ShadowRoot;

    expect(root.textContent).toContain('kpi band down');
    // A failing KPI band must not blank the leaderboard.
    expect(root.textContent).toContain('Project One');
  });

  it('renders the heatmap missing-cell affordance as "—", never a fabricated 0', async () => {
    portfolioMock.getModelHarnessMatrix.mockResolvedValue(
      matrixFixture({
        cells: [{ model: 'claude-3-5-sonnet', harness: 'claude', sessionCount: null }],
      }),
    );

    const view = document.createElement('portfolio-view') as PortfolioView;
    await mount(view);
    const root = view.shadowRoot as ShadowRoot;

    const heatmapChart = Array.from(root.querySelectorAll('analytics-chart')).find((el) =>
      (el as LitElement).shadowRoot?.textContent?.includes('model × harness'),
    ) as LitElement | undefined;
    await heatmapChart?.updateComplete;
    const echartsBase = heatmapChart?.shadowRoot?.querySelector('echarts-base') as LitElement;
    await echartsBase?.updateComplete;
    const heatmapGrid = echartsBase?.shadowRoot?.querySelector('rd-heatmap-grid') as LitElement;
    await heatmapGrid?.updateComplete;
    expect(heatmapGrid?.shadowRoot?.textContent).toContain('—');
    expect(heatmapGrid?.shadowRoot?.textContent).not.toMatch(/\b0 sessions\b/);
  });

  it('navigates to a project row preserving return context', async () => {
    const view = document.createElement('portfolio-view') as PortfolioView;
    await mount(view);
    const root = view.shadowRoot as ShadowRoot;

    const link = root.querySelector('a[href^="#/projects/"]') as HTMLAnchorElement;
    expect(link).not.toBeNull();
    expect(link.getAttribute('href')).toMatch(/returnContext=/);

    link.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(window.location.hash).toContain('#/projects/Project%20One?returnContext=');
  });

  it('applies filters and updates the hash', async () => {
    const view = document.createElement('portfolio-view') as PortfolioView;
    await mount(view);
    const root = view.shadowRoot as ShadowRoot;

    const filterBar = root.querySelector('filter-bar') as LitElement;
    await filterBar.updateComplete;
    const harnessChip = filterBar.shadowRoot?.querySelector(
      'dimension-chip[label="Harness"]',
    ) as LitElement;
    await harnessChip.updateComplete;
    const select = harnessChip.shadowRoot?.querySelector('select') as HTMLSelectElement;
    select.value = 'claude';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(window.location.hash).toMatch(/harness=claude/);
    expect(portfolioMock.getKpiBand).toHaveBeenCalled();
  });

  it('parses filters from the hash and re-loads, and always queries the leaderboard without a time range', async () => {
    window.location.hash =
      '#/?project=p1&harness=claude&timeStart=2024-01-01T00:00:00.000Z&timeEnd=2024-01-08T00:00:00.000Z';

    const view = document.createElement('portfolio-view') as PortfolioView;
    await mount(view);

    expect(portfolioMock.getKpiBand).toHaveBeenCalled();
    const query = portfolioMock.getKpiBand.mock.calls[0][0];
    expect(query.filters).toEqual(
      expect.arrayContaining([
        { field: 'projectId', operator: 'eq', value: 'p1' },
        { field: 'harness', operator: 'eq', value: 'claude' },
      ]),
    );
    expect(query.timeRange).toBeDefined();

    const leaderboardQuery = portfolioMock.getProjectLeaderboard.mock.calls[0][0];
    expect(leaderboardQuery.timeRange).toBeUndefined();
  });

  it('renders the trend chart empty affordance when the series is empty but other panels are not', async () => {
    portfolioMock.getTrends.mockResolvedValue(trendsFixture({ series: [] }));

    const view = document.createElement('portfolio-view') as PortfolioView;
    await mount(view);
    const root = view.shadowRoot as ShadowRoot;

    const trendChart = Array.from(root.querySelectorAll('analytics-chart')).find((el) =>
      (el as LitElement).shadowRoot?.textContent?.includes('Token usage trend'),
    ) as (LitElement & { state?: string }) | undefined;
    expect(trendChart?.state).toBe('empty');
  });

  /**
   * Integration-level proof of the stale-response guard: `load()` allows
   * overlapping requests rather than queuing them, so a filter change
   * re-issues immediately instead of waiting for a slower in-flight query.
   * Here the first (slow) request resolves *after* the second (fast) one —
   * its response must be discarded, not applied over the fresher data.
   */
  it('discards a stale response that resolves after a superseding request (stale-response guard)', async () => {
    let resolveFirst: (value: PortfolioKpiBand) => void = () => {};
    const firstPending = new Promise<PortfolioKpiBand>((resolve) => {
      resolveFirst = resolve;
    });
    portfolioMock.getKpiBand
      .mockReturnValueOnce(firstPending)
      .mockResolvedValueOnce(kpiBandFixture({ sessions: { current: 999, currentN: 999 } }));

    const view = document.createElement('portfolio-view') as PortfolioView;
    document.body.appendChild(view);
    await view.updateComplete;

    // A second, faster load starts (e.g. a filter change) while the first
    // is still pending. happy-dom fires 'hashchange' on its own when the
    // hash is assigned, same as a real browser — no manual dispatch needed.
    window.location.hash = '#/?harness=claude';
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The slow first request resolves last — it must be discarded.
    resolveFirst(kpiBandFixture({ sessions: { current: 1, currentN: 1 } }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await flush(view);
    await flush(view);

    const root = view.shadowRoot as ShadowRoot;
    const heroTile = root.querySelector('stat-tile-hero');
    expect(heroTile?.getAttribute('value')).toBe('999');
  });

  it('re-queries when the analytics client reports a data change', async () => {
    const view = document.createElement('portfolio-view') as PortfolioView;
    await mount(view);

    const callsBefore = portfolioMock.getKpiBand.mock.calls.length;

    mockAnalyticsClient.dispatchEvent(new CustomEvent('data-change'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await flush(view);

    const callsAfter = portfolioMock.getKpiBand.mock.calls.length;
    expect(callsAfter - callsBefore).toBe(1);

    view.remove();
  });

  it('does not re-query for data changes outside the portfolio route', async () => {
    const view = document.createElement('portfolio-view') as PortfolioView;
    await mount(view);

    const callsBefore = portfolioMock.getKpiBand.mock.calls.length;

    window.location.hash = '#/manual-import';
    mockAnalyticsClient.dispatchEvent(new CustomEvent('data-change'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await flush(view);

    const callsAfter = portfolioMock.getKpiBand.mock.calls.length;
    expect(callsAfter).toBe(callsBefore);

    view.remove();
  });
});
