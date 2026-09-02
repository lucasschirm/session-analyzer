import type {
  AnalyticsToken,
  ComponentUtilizationPage,
  MetricValueDto,
  ModelHarnessCohortPage,
  PortfolioOverview,
  PortfolioTrendSeries,
  ProjectListPage,
} from '@lucasschirm/sal-db';
import type { LitElement } from 'lit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../../src/pages/portfolio/portfolio-view';
import type { PortfolioView } from '../../src/pages/portfolio/portfolio-view';

const portfolioMock = vi.hoisted(() => ({
  getOverview: vi.fn(),
  getTrends: vi.fn(),
  getComponentUtilization: vi.fn(),
  getModelHarnessCohorts: vi.fn(),
  getProjectList: vi.fn(),
}));

const metadataMock = vi.hoisted(() => ({
  getDimensionDomains: vi.fn(),
}));

const mockAnalyticsClient = vi.hoisted(() => {
  const client = new EventTarget() as {
    portfolio: typeof portfolioMock;
    metadata: typeof metadataMock;
  } & EventTarget;
  client.portfolio = portfolioMock;
  client.metadata = metadataMock;
  return client;
});

vi.mock('../../src/db/analytics-client', () => ({
  AnalyticsClient: vi.fn(),
  analyticsClient: mockAnalyticsClient,
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

function allShadowTexts(parent: ShadowRoot, selector: string): string[] {
  return Array.from(parent.querySelectorAll(selector)).map(
    (child) => ((child as LitElement).shadowRoot?.textContent ?? '') as string,
  );
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

function metricValueFixture(overrides: Partial<MetricValueDto> = {}): MetricValueDto {
  return {
    ...tokenFixture(),
    metricId: 'total_tokens',
    value: 1_234_567,
    unit: 'count',
    label: 'Total Tokens',
    isExact: true,
    ...overrides,
  };
}

function overviewFixture(overrides: Partial<PortfolioOverview> = {}): PortfolioOverview {
  return {
    token: tokenFixture(),
    headlineMetrics: [metricValueFixture()],
    projectCount: 3,
    sessionCount: 12,
    componentCounts: { tool: 5, agent: 2 },
    unusedOfferedComponents: ['unused-component'],
    totalTokens: 1_234_567,
    modelCount: 2,
    harnessCount: 1,
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
        metricId: 'total_tokens',
        label: 'Total tokens',
        comparabilityGroupId: 'cgrp-1',
      },
      {
        time: '2024-01-02',
        value: 150,
        metricId: 'total_tokens',
        label: 'Total tokens',
        comparabilityGroupId: 'cgrp-1',
      },
    ],
    ...overrides,
  };
}

function componentsFixture(
  overrides: Partial<ComponentUtilizationPage> = {},
): ComponentUtilizationPage {
  return {
    items: [
      {
        componentId: 'read_file',
        name: 'tool/read_file',
        kind: 'tool',
        projectCount: 2,
        sessionCount: 10,
        token: tokenFixture(),
      },
    ],
    generationToken: 'gen-1',
    analysisReleaseToken: 'rel-1',
    ...overrides,
  };
}

function cohortsFixture(overrides: Partial<ModelHarnessCohortPage> = {}): ModelHarnessCohortPage {
  return {
    items: [
      {
        model: 'claude-3-5-sonnet',
        harness: 'claude',
        sessionCount: 5,
        metricValues: [metricValueFixture({ value: 500_000 })],
        token: tokenFixture(),
      },
    ],
    generationToken: 'gen-1',
    analysisReleaseToken: 'rel-1',
    ...overrides,
  };
}

function projectsFixture(overrides: Partial<ProjectListPage> = {}): ProjectListPage {
  return {
    items: [
      {
        projectId: 'p1',
        name: 'Project One',
        sessionCount: 3,
        source: 'claude',
        harness: 'claude',
        completeness: 'complete',
        finality: 'final',
        reprocessing: 'unknown',
        issueState: 'clean',
        coverage: 'complete',
        token: tokenFixture(),
      },
    ],
    generationToken: 'gen-1',
    analysisReleaseToken: 'rel-1',
    ...overrides,
  };
}

function stubPortfolioLoad(): void {
  portfolioMock.getOverview.mockResolvedValue(overviewFixture());
  portfolioMock.getTrends.mockResolvedValue(trendsFixture());
  portfolioMock.getComponentUtilization.mockResolvedValue(componentsFixture());
  portfolioMock.getModelHarnessCohorts.mockResolvedValue(cohortsFixture());
  portfolioMock.getProjectList.mockResolvedValue(projectsFixture());
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
  it('loads and renders overview, charts, and project list', async () => {
    const view = document.createElement('portfolio-view') as PortfolioView;
    await mount(view);
    const root = view.shadowRoot as ShadowRoot;

    expect(root.textContent).toContain('Portfolio');
    const cardTexts = allShadowTexts(root, 'metrics-card').join(' ');
    expect(cardTexts).toContain('Total Tokens');
    expect(cardTexts).toContain('1.2M');
    expect(root.textContent).toContain('Project One');
    expect(root.textContent).toContain('Artifact utilization');
    expect(root.textContent).toContain('Model × harness cohorts');
  });

  it('renders an empty state when all panels return empty pages', async () => {
    portfolioMock.getOverview.mockResolvedValue(
      overviewFixture({ headlineMetrics: [], sessionCount: 0, projectCount: 0 }),
    );
    portfolioMock.getTrends.mockResolvedValue(trendsFixture({ series: [] }));
    portfolioMock.getComponentUtilization.mockResolvedValue(componentsFixture({ items: [] }));
    portfolioMock.getModelHarnessCohorts.mockResolvedValue(cohortsFixture({ items: [] }));
    portfolioMock.getProjectList.mockResolvedValue(projectsFixture({ items: [] }));

    const view = document.createElement('portfolio-view') as PortfolioView;
    await mount(view);
    const root = view.shadowRoot as ShadowRoot;

    expect(allShadowTexts(root, 'analytics-chart').join(' ')).toMatch(/Session Metrics/i);
    expect(root.textContent).toContain('No projects found');
  });

  it('enters a partial state when one view fails', async () => {
    portfolioMock.getOverview.mockRejectedValue(new Error('overview down'));
    portfolioMock.getTrends.mockResolvedValue(trendsFixture());
    portfolioMock.getComponentUtilization.mockResolvedValue(componentsFixture());
    portfolioMock.getModelHarnessCohorts.mockResolvedValue(cohortsFixture());
    portfolioMock.getProjectList.mockResolvedValue(projectsFixture());

    const view = document.createElement('portfolio-view') as PortfolioView;
    await mount(view);
    const root = view.shadowRoot as ShadowRoot;

    expect(root.textContent).toContain('overview down');
    expect(root.textContent).toContain('Project One');
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
    expect(portfolioMock.getOverview).toHaveBeenCalled();
  });

  it('passes the unfiltered dimension domains as chip options, independent of the active filter selection', async () => {
    window.location.hash = '#/?harness=claude';
    const view = document.createElement('portfolio-view') as PortfolioView;
    await mount(view);
    const root = view.shadowRoot as ShadowRoot;

    expect(metadataMock.getDimensionDomains).toHaveBeenCalledWith();

    const filterBar = root.querySelector('filter-bar') as LitElement;
    await filterBar.updateComplete;
    const projectChip = filterBar.shadowRoot?.querySelector(
      'dimension-chip[label="Project"]',
    ) as LitElement;
    await projectChip.updateComplete;
    const select = projectChip.shadowRoot?.querySelector('select') as HTMLSelectElement;
    const values = Array.from(select.options).map((o) => o.value);
    expect(values).toContain('zero-session-harness-project');
  });

  it('parses filters from the hash and re-loads', async () => {
    window.location.hash = '#/?project=p1&harness=claude';

    const view = document.createElement('portfolio-view') as PortfolioView;
    await mount(view);

    expect(portfolioMock.getOverview).toHaveBeenCalled();
    const query = portfolioMock.getOverview.mock.calls[0][0];
    expect(query.filters).toEqual(
      expect.arrayContaining([
        { field: 'projectId', operator: 'eq', value: 'p1' },
        { field: 'harness', operator: 'eq', value: 'claude' },
      ]),
    );
  });

  it('renders the trend chart empty affordance when the series is empty but other panels are not', async () => {
    portfolioMock.getTrends.mockResolvedValue(trendsFixture({ series: [] }));

    const view = document.createElement('portfolio-view') as PortfolioView;
    await mount(view);
    const root = view.shadowRoot as ShadowRoot;

    const trendChart = Array.from(root.querySelectorAll('analytics-chart')).find((el) =>
      (el as LitElement).shadowRoot?.textContent?.includes('Session Metrics'),
    ) as (LitElement & { state?: string }) | undefined;
    expect(trendChart?.state).toBe('empty');
    // A genuinely empty range must not be reported as a global error.
    expect(root.textContent).not.toContain('All portfolio views failed to load.');
  });

  it('re-queries when the analytics client reports a data change', async () => {
    const view = document.createElement('portfolio-view') as PortfolioView;
    await mount(view);

    const callsBefore = portfolioMock.getOverview.mock.calls.length;

    mockAnalyticsClient.dispatchEvent(new CustomEvent('data-change'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await flush(view);

    const callsAfter = portfolioMock.getOverview.mock.calls.length;
    expect(callsAfter - callsBefore).toBe(1);

    view.remove();
  });

  it('does not re-query for data changes outside the portfolio route', async () => {
    const view = document.createElement('portfolio-view') as PortfolioView;
    await mount(view);

    const callsBefore = portfolioMock.getOverview.mock.calls.length;

    window.location.hash = '#/manual-import';
    mockAnalyticsClient.dispatchEvent(new CustomEvent('data-change'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await flush(view);

    const callsAfter = portfolioMock.getOverview.mock.calls.length;
    expect(callsAfter).toBe(callsBefore);

    view.remove();
  });
});
