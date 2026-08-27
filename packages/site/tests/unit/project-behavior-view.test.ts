import type {
  AnalyticsToken,
  ComparisonPage,
  ConfigurationTimeline,
  MetricValueDto,
  OutlierPage,
  ProjectBehaviorSummary,
  SessionTrendSeries,
} from '@lucasschirm/sal-db';
import type { LitElement } from 'lit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../../src/pages/project-behavior/project-behavior-view';
import type { ProjectBehaviorPage } from '../../src/pages/project-behavior/project-behavior-view';

const projectMock = vi.hoisted(() => ({
  getSummary: vi.fn(),
  getSessionTrendSeries: vi.fn(),
  getConfigurationTimeline: vi.fn(),
  getOutliers: vi.fn(),
  getComparisons: vi.fn(),
}));

const resolveProjectIdMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/db/analytics-client', () => ({
  AnalyticsClient: vi.fn(),
  analyticsClient: { project: projectMock, resolveProjectId: resolveProjectIdMock },
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

function shadowText(parent: ShadowRoot, selector: string): string {
  const child = parent.querySelector(selector) as LitElement | null;
  expect(child).not.toBeNull();
  return (child?.shadowRoot?.textContent ?? '') as string;
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
    metricId: 'm-duration',
    value: 1_234,
    unit: 'ms',
    label: 'Duration',
    isExact: true,
    ...overrides,
  };
}

function summaryFixture(overrides: Partial<ProjectBehaviorSummary> = {}): ProjectBehaviorSummary {
  return {
    token: tokenFixture(),
    headlineMetrics: [metricValueFixture()],
    trendToken: tokenFixture(),
    ...overrides,
  };
}

function trendsFixture(overrides: Partial<SessionTrendSeries> = {}): SessionTrendSeries {
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

function timelineFixture(overrides: Partial<ConfigurationTimeline> = {}): ConfigurationTimeline {
  return {
    token: tokenFixture(),
    events: [
      {
        sequence: 1,
        captureTime: '2024-01-01T12:00:00.000Z',
        changeType: 'added',
        componentId: 'main.ts',
        componentKind: 'file',
        toVersion: 'v1.0.0',
      },
    ],
    ...overrides,
  };
}

function outlierFixture(overrides: Partial<OutlierPage> = {}): OutlierPage {
  return {
    items: [
      {
        sessionId: 's1',
        metricId: 'm-duration',
        value: 10_000,
        deviation: 5_000,
        evidenceLinks: [
          { evidenceId: 's1', entityType: 'session', entityId: 's1', label: 'Session s1' },
        ],
      },
    ],
    generationToken: 'gen-1',
    analysisReleaseToken: 'rel-1',
    ...overrides,
  };
}

function comparisonFixture(overrides: Partial<ComparisonPage> = {}): ComparisonPage {
  return {
    items: [
      {
        comparisonId: 'cmp-1',
        kind: 'observed',
        cohortA: {
          cohortId: 'before-1',
          label: 'before',
          eligibleN: 10,
          knownN: 10,
          unknownCount: 0,
        },
        cohortB: {
          cohortId: 'after-1',
          label: 'after',
          eligibleN: 10,
          knownN: 10,
          unknownCount: 0,
        },
        metricValues: [
          metricValueFixture({
            metricId: 'absolute-delta',
            value: 100,
            unit: 'ms',
            label: 'Absolute delta',
          }),
          metricValueFixture({
            metricId: 'relative-delta',
            value: 0.2,
            unit: 'ratio',
            label: 'Relative delta',
          }),
          metricValueFixture({
            metricId: 'regression',
            value: 1,
            unit: 'flag',
            label: 'Regression',
          }),
        ],
      },
    ],
    generationToken: 'gen-1',
    analysisReleaseToken: 'rel-1',
    ...overrides,
  };
}

function stubProjectBehaviorLoad(): void {
  resolveProjectIdMock.mockResolvedValue('p1');
  projectMock.getSummary.mockResolvedValue(summaryFixture());
  projectMock.getSessionTrendSeries.mockResolvedValue(trendsFixture());
  projectMock.getConfigurationTimeline.mockResolvedValue(timelineFixture());
  projectMock.getOutliers.mockResolvedValue(outlierFixture());
  projectMock.getComparisons.mockResolvedValue(comparisonFixture());
}

beforeEach(() => {
  stubProjectBehaviorLoad();
  window.location.hash = '#/projects/p1/behavior';
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.resetAllMocks();
});

describe('project-behavior-view', () => {
  it('loads and renders overview, trends, timeline, cohorts, and outliers', async () => {
    const view = Object.assign(document.createElement('project-behavior-view'), {
      projectId: 'p1',
    }) as ProjectBehaviorPage;
    await mount(view);
    const root = view.shadowRoot as ShadowRoot;

    expect(root.textContent).toContain('Project Behavior');
    const cardTexts = allShadowTexts(root, 'metrics-card').join(' ');
    expect(cardTexts).toContain('Duration');
    expect(root.textContent).toContain('Session Metrics');
    expect(root.textContent).toContain('Configuration timeline');
    expect(root.textContent).toContain('Matched before / after cohorts');
    expect(root.textContent).toContain('Outliers');
    expect(root.querySelectorAll('table')[1]?.textContent).toContain('s1');
  });

  it('displays session-to-session context growth as a time-series chart', async () => {
    const view = Object.assign(document.createElement('project-behavior-view'), {
      projectId: 'p1',
    }) as ProjectBehaviorPage;
    await mount(view);
    const root = view.shadowRoot as ShadowRoot;

    const chart = root.querySelectorAll('analytics-chart')[1] as LitElement;
    expect(chart).not.toBeNull();
    const chartRoot = chart.shadowRoot as ShadowRoot;
    const echarts = chartRoot.querySelector('echarts-base') as LitElement;
    expect(echarts).not.toBeNull();
    const chartText = (chartRoot.textContent ?? '') as string;
    expect(chartText).toMatch(/Session Metrics/i);
  });

  it('renders configuration timeline annotations', async () => {
    const view = Object.assign(document.createElement('project-behavior-view'), {
      projectId: 'p1',
    }) as ProjectBehaviorPage;
    await mount(view);
    const root = view.shadowRoot as ShadowRoot;

    expect(root.textContent).toContain('Configuration timeline');
    const chart = root.querySelectorAll('analytics-chart')[3] as LitElement;
    const chartRoot = chart.shadowRoot as ShadowRoot;
    const echarts = chartRoot.querySelector('echarts-base') as LitElement;
    expect(echarts).not.toBeNull();
    const chartText = (chartRoot.textContent ?? '') as string;
    expect(chartText).toMatch(/Configuration timeline/i);
  });

  it('renders cohort table with regression flags', async () => {
    const view = Object.assign(document.createElement('project-behavior-view'), {
      projectId: 'p1',
    }) as ProjectBehaviorPage;
    await mount(view);
    const root = view.shadowRoot as ShadowRoot;

    const table = root.querySelectorAll('table')[0];
    expect(table.textContent).toContain('observed');
    expect(table.textContent).toContain('before');
    expect(table.textContent).toContain('after');
    expect(table.textContent).toContain('Yes');
  });

  it('renders outlier table with links to session evidence', async () => {
    const view = Object.assign(document.createElement('project-behavior-view'), {
      projectId: 'p1',
    }) as ProjectBehaviorPage;
    await mount(view);
    const root = view.shadowRoot as ShadowRoot;

    const link = root.querySelector('a[href^="#/sessions/"]') as HTMLAnchorElement;
    expect(link).not.toBeNull();
    expect(link.getAttribute('href')).toBe('#/sessions/s1');
  });

  it('applies filters and updates the hash', async () => {
    const view = Object.assign(document.createElement('project-behavior-view'), {
      projectId: 'p1',
    }) as ProjectBehaviorPage;
    await mount(view);
    const root = view.shadowRoot as ShadowRoot;

    const modelInput = Array.from(root.querySelectorAll('input')).find(
      (input) => input.parentElement?.textContent?.trim() === 'Model',
    );
    expect(modelInput).not.toBeUndefined();
    (modelInput as HTMLInputElement).value = 'claude';
    modelInput?.dispatchEvent(new Event('change'));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(window.location.hash).toMatch(/model=claude/);
    expect(projectMock.getSummary).toHaveBeenCalled();
  });

  it('parses filters from the hash and re-loads', async () => {
    window.location.hash = '#/projects/p1/behavior?harness=claude&mode=plan';

    const view = Object.assign(document.createElement('project-behavior-view'), {
      projectId: 'p1',
    }) as ProjectBehaviorPage;
    await mount(view);

    expect(projectMock.getSummary).toHaveBeenCalled();
    const query = projectMock.getSummary.mock.calls[0][1];
    expect(query.filters).toEqual(
      expect.arrayContaining([
        { field: 'harness', operator: 'eq', value: 'claude' },
        { field: 'mode', operator: 'eq', value: 'plan' },
      ]),
    );
  });

  it('navigates back to portfolio preserving return context', async () => {
    window.location.hash = '#/projects/p1/behavior?returnContext=project%3Dp1';

    const view = Object.assign(document.createElement('project-behavior-view'), {
      projectId: 'p1',
    }) as ProjectBehaviorPage;
    await mount(view);
    const root = view.shadowRoot as ShadowRoot;

    const back = root.querySelector('a[href^="#/portfolio"]') as HTMLAnchorElement;
    expect(back).not.toBeNull();
    expect(back.getAttribute('href')).toMatch(/project=p1/);

    back.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(window.location.hash).toMatch(/#\/portfolio\?/);
    expect(window.location.hash).toMatch(/project=p1/);
  });

  it('renders empty state when all panels return empty', async () => {
    projectMock.getSummary.mockResolvedValue(summaryFixture({ headlineMetrics: [] }));
    projectMock.getSessionTrendSeries.mockResolvedValue(trendsFixture({ series: [] }));
    projectMock.getConfigurationTimeline.mockResolvedValue(timelineFixture({ events: [] }));
    projectMock.getOutliers.mockResolvedValue(outlierFixture({ items: [] }));
    projectMock.getComparisons.mockResolvedValue(comparisonFixture({ items: [] }));

    const view = Object.assign(document.createElement('project-behavior-view'), {
      projectId: 'p1',
    }) as ProjectBehaviorPage;
    await mount(view);
    const root = view.shadowRoot as ShadowRoot;

    expect(allShadowTexts(root, 'analytics-chart').join(' ')).toMatch(/Session Metrics/i);
    expect(root.textContent).toContain('No metrics available');
    expect(root.textContent).toContain('No cohort comparisons available');
    expect(root.textContent).toContain('No outliers available');
  });

  it('enters a partial state when one view fails', async () => {
    projectMock.getSummary.mockRejectedValue(new Error('summary down'));
    projectMock.getSessionTrendSeries.mockResolvedValue(trendsFixture());
    projectMock.getConfigurationTimeline.mockResolvedValue(timelineFixture());
    projectMock.getOutliers.mockResolvedValue(outlierFixture());
    projectMock.getComparisons.mockResolvedValue(comparisonFixture());

    const view = Object.assign(document.createElement('project-behavior-view'), {
      projectId: 'p1',
    }) as ProjectBehaviorPage;
    await mount(view);
    const root = view.shadowRoot as ShadowRoot;

    expect(root.textContent).toContain('summary down');
    expect(root.textContent).toContain('Session Metrics');
  });

  it('exposes chart accessibility (summary, table fallback, keyboard focus)', async () => {
    const view = Object.assign(document.createElement('project-behavior-view'), {
      projectId: 'p1',
    }) as ProjectBehaviorPage;
    await mount(view);
    const root = view.shadowRoot as ShadowRoot;

    const chart = root.querySelector('analytics-chart') as LitElement;
    expect(chart).not.toBeNull();
    const chartRoot = chart.shadowRoot as ShadowRoot;
    const echarts = chartRoot.querySelector('echarts-base') as LitElement;
    expect(echarts).not.toBeNull();
    const echartsRoot = echarts.shadowRoot as ShadowRoot;
    const container = echartsRoot.querySelector('.chart-container') as HTMLElement;
    expect(container).not.toBeNull();
    expect(container.getAttribute('tabindex')).toBe('0');
    expect(container.getAttribute('role')).toBe('img');
    expect(container.getAttribute('aria-label')).toBeTruthy();
    expect(echartsRoot.querySelector('details.table-fallback')).not.toBeNull();
  });
});
