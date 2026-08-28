import type {
  AnalyticsToken,
  ComponentDistributionPage,
  ComponentDistributionRow,
  ComponentEcosystemSummary,
  ComponentProjectSessionPage,
  ComponentScopePage,
  ComponentUtilizationDetail,
  ComponentVersionPage,
  LifecycleComparisonPage,
  MetricValueDto,
} from '@lucasschirm/sal-db';
import type { LitElement } from 'lit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../../src/pages/component-ecosystem/component-ecosystem-view';
import type { ComponentEcosystemView } from '../../src/pages/component-ecosystem/component-ecosystem-view';

const componentMock = vi.hoisted(() => ({
  getSummary: vi.fn(),
  getVersions: vi.fn(),
  getScopes: vi.fn(),
  getUtilization: vi.fn(),
  getDistributions: vi.fn(),
  getProjectsSessions: vi.fn(),
  getLifecycleComparisons: vi.fn(),
}));

const artifactMock = vi.hoisted(() => ({
  getDiff: vi.fn(),
  getMetadata: vi.fn(),
}));

vi.mock('../../src/db/analytics-client', () => ({
  AnalyticsClient: vi.fn(),
  analyticsClient: { component: componentMock, artifact: artifactMock },
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

function metricValue(
  metricId: string,
  value: number | null,
  label: string,
  unit = 'count',
  overrides: Partial<MetricValueDto> = {},
): MetricValueDto {
  return {
    ...tokenFixture(),
    metricId,
    value,
    unit,
    label,
    isExact: true,
    ...overrides,
  };
}

function summaryFixture(
  overrides: Partial<ComponentEcosystemSummary> = {},
): ComponentEcosystemSummary {
  return {
    token: tokenFixture(),
    countsByKind: {
      tool: 5,
      mcp: 1,
      skill: 2,
      agent: 1,
      rule: 1,
      plugin: 1,
      setting: 1,
      model: 1,
      version: 3,
    },
    topByUtilization: [
      metricValue('component-utilization', 120, 'tool read_file'),
      metricValue('component-utilization', 80, 'skill code-review'),
      metricValue('component-utilization', 45, 'agent general-purpose'),
    ],
    ...overrides,
  };
}

function versionsFixture(overrides: Partial<ComponentVersionPage> = {}): ComponentVersionPage {
  return {
    items: [
      {
        version: 'v1.0.0',
        sessionCount: 10,
        projectCount: 2,
        firstSeen: '2024-01-01',
        lastSeen: '2024-01-10',
      },
      {
        version: 'v1.1.0',
        sessionCount: 6,
        projectCount: 1,
        firstSeen: '2024-02-01',
        lastSeen: '2024-02-05',
      },
    ],
    generationToken: 'gen-1',
    analysisReleaseToken: 'rel-1',
    ...overrides,
  };
}

function scopesFixture(overrides: Partial<ComponentScopePage> = {}): ComponentScopePage {
  return {
    items: [
      { scope: 'global', installationCount: 5 },
      { scope: 'workspace', installationCount: 3 },
      { scope: 'session', installationCount: 2 },
    ],
    generationToken: 'gen-1',
    analysisReleaseToken: 'rel-1',
    ...overrides,
  };
}

function utilizationFixture(
  overrides: Partial<ComponentUtilizationDetail> = {},
): ComponentUtilizationDetail {
  const token = tokenFixture({ knownN: 90, eligibleN: 120 });
  return {
    token,
    loadRate: metricValue('load-rate', 0.75, 'Load rate', 'ratio'),
    invokeRate: metricValue('invoke-rate', 12, 'Invocations per session', 'count'),
    overhead: metricValue('overhead', 150, 'Overhead latency', 'ms'),
    ...overrides,
  };
}

function distributionsFixture(
  overrides: Partial<ComponentDistributionPage> = {},
): ComponentDistributionPage {
  const row: ComponentDistributionRow = {
    metricId: 'outcome',
    values: [
      metricValue('success', 80, 'success'),
      metricValue('partial', 10, 'partial'),
      metricValue('failure', 5, 'failure'),
    ],
    bins: { success: 80, partial: 10, failure: 5 },
  };
  return {
    items: [row],
    generationToken: 'gen-1',
    analysisReleaseToken: 'rel-1',
    ...overrides,
  };
}

function projectSessionsFixture(
  overrides: Partial<ComponentProjectSessionPage> = {},
): ComponentProjectSessionPage {
  return {
    items: [
      {
        projectId: 'p1',
        sessionId: 's1',
        lastUsed: '2024-01-05',
        metricValues: [
          metricValue('invocations', 10, 'Invocations'),
          metricValue('payloads', 4, 'Payloads'),
          metricValue('payload-bytes', 1024, 'Payload bytes', 'bytes'),
        ],
      },
    ],
    generationToken: 'gen-1',
    analysisReleaseToken: 'rel-1',
    ...overrides,
  };
}

function lifecycleFixture(
  overrides: Partial<LifecycleComparisonPage> = {},
): LifecycleComparisonPage {
  return {
    items: [
      {
        eventId: 'ev1',
        changeType: 'updated',
        beforeVersion: 'v1.0.0',
        afterVersion: 'v1.1.0',
        affectedSessions: 4,
      },
    ],
    generationToken: 'gen-1',
    analysisReleaseToken: 'rel-1',
    ...overrides,
  };
}

function stubComponentLoad(): void {
  componentMock.getSummary.mockResolvedValue(summaryFixture());
  componentMock.getVersions.mockResolvedValue(versionsFixture());
  componentMock.getScopes.mockResolvedValue(scopesFixture());
  componentMock.getUtilization.mockResolvedValue(utilizationFixture());
  componentMock.getDistributions.mockResolvedValue(distributionsFixture());
  componentMock.getProjectsSessions.mockResolvedValue(projectSessionsFixture());
  componentMock.getLifecycleComparisons.mockResolvedValue(lifecycleFixture());
}

beforeEach(() => {
  stubComponentLoad();
  window.location.hash = '#/components';
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.resetAllMocks();
});

function allShadowTexts(parent: ShadowRoot, selector: string): string[] {
  return Array.from(parent.querySelectorAll(selector)).map(
    (child) => ((child as LitElement).shadowRoot?.textContent ?? '') as string,
  );
}

describe('component-ecosystem-view', () => {
  it('renders the summary with counts by kind and top components', async () => {
    const view = document.createElement('component-ecosystem-view') as ComponentEcosystemView;
    await mount(view);
    const root = view.shadowRoot as ShadowRoot;

    expect(root.textContent).toContain('Component Ecosystem');

    const cardTexts = allShadowTexts(root, 'metrics-card').join(' ');
    expect(cardTexts).toContain('Total components');
    expect(cardTexts).toContain('tool components');

    const echartsTexts: string[] = [];
    for (const chart of root.querySelectorAll('analytics-chart')) {
      const echarts = (chart as LitElement).shadowRoot?.querySelector('echarts-base') as
        | LitElement
        | undefined;
      if (echarts?.shadowRoot) {
        echartsTexts.push(echarts.shadowRoot.textContent ?? '');
      }
    }
    const chartText = echartsTexts.join(' ');
    expect(chartText).toContain('read_file');
    expect(chartText).toContain('code-review');

    const summaries = allShadowTexts(root, 'analytics-chart');
    expect(summaries.length).toBeGreaterThanOrEqual(2);
  });

  it('filters by kind and updates the hash', async () => {
    const view = document.createElement('component-ecosystem-view') as ComponentEcosystemView;
    await mount(view);
    const root = view.shadowRoot as ShadowRoot;

    const kindInput = root.querySelector('input') as HTMLInputElement;
    kindInput.value = 'tool';
    kindInput.dispatchEvent(new Event('change'));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(window.location.hash).toMatch(/kind=tool/);
    expect(componentMock.getSummary).toHaveBeenCalled();
  });

  it('navigates to a component detail from the top-components chart', async () => {
    const view = document.createElement('component-ecosystem-view') as ComponentEcosystemView;
    await mount(view);
    const root = view.shadowRoot as ShadowRoot;

    const chart = root.querySelector(
      'analytics-chart[title="Invocations per component"]',
    ) as LitElement;
    chart.dispatchEvent(
      new CustomEvent('point-click', {
        detail: { label: 'Open read_file', href: '#/components/read_file?kind=tool' },
        bubbles: true,
        composed: true,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(window.location.hash).toContain('#/components/read_file');
  });

  it('renders a component detail with all panels', async () => {
    window.location.hash =
      '#/components/read_file?kind=tool&returnContext=project%3Dp1&origin=portfolio';
    const view = Object.assign(document.createElement('component-ecosystem-view'), {
      componentId: 'read_file',
    }) as ComponentEcosystemView;
    await mount(view);
    const root = view.shadowRoot as ShadowRoot;

    expect(root.textContent).toContain('Component: read_file');
    expect(root.textContent).toContain('(tool)');
    expect(root.textContent).toContain('Versions');
    expect(root.textContent).toContain('Installation scope');
    expect(root.textContent).toContain('Utilization');
    expect(root.textContent).toContain('Payload distributions');
    expect(root.textContent).toContain('Project / session evidence');
    expect(root.textContent).toContain('Lifecycle timing');

    const cards = allShadowTexts(root, 'metrics-card').join(' ');
    expect(cards).toContain('Load rate');
    expect(cards).toContain('Invocations per session');
    expect(cards).toContain('Overhead latency');

    const projectLink = root.querySelector('a[href^="#/projects/"]') as HTMLAnchorElement;
    expect(projectLink).not.toBeNull();
    expect(projectLink.getAttribute('href')).toMatch(/returnContext=/);

    const sessionLink = root.querySelector('a[href^="#/sessions/"]') as HTMLAnchorElement;
    expect(sessionLink).not.toBeNull();
  });

  it('preserves originating filters in breadcrumbs', async () => {
    window.location.hash =
      '#/components/read_file?kind=tool&returnContext=project%3Dp1&origin=portfolio';
    const view = Object.assign(document.createElement('component-ecosystem-view'), {
      componentId: 'read_file',
    }) as ComponentEcosystemView;
    await mount(view);
    const root = view.shadowRoot as ShadowRoot;

    const originLink = root.querySelector('a[href^="#/portfolio"]') as HTMLAnchorElement;
    expect(originLink).not.toBeNull();
    expect(originLink.getAttribute('href')).toBe('#/portfolio?project=p1');
  });

  it('renders a funnel chart for payload distributions', async () => {
    window.location.hash = '#/components/read_file';
    const view = Object.assign(document.createElement('component-ecosystem-view'), {
      componentId: 'read_file',
    }) as ComponentEcosystemView;
    await mount(view);
    const root = view.shadowRoot as ShadowRoot;

    const chart = root.querySelector('analytics-chart[title^="Distribution:"]') as LitElement;
    expect(chart).not.toBeNull();
    const shadow = chart.shadowRoot as ShadowRoot;
    expect(shadow.textContent).toContain('Distribution:');
  });

  it('renders lifecycle timing and a diff link', async () => {
    window.location.hash = '#/components/read_file';
    const view = Object.assign(document.createElement('component-ecosystem-view'), {
      componentId: 'read_file',
    }) as ComponentEcosystemView;
    await mount(view);
    const root = view.shadowRoot as ShadowRoot;

    expect(root.textContent).toContain('Lifecycle timing');
    expect(root.textContent).toContain('v1.0.0');
    expect(root.textContent).toContain('v1.1.0');
    expect(root.textContent).toContain('View diff');

    const diffLink = root.querySelector('a.diff-link') as HTMLAnchorElement;
    expect(diffLink).not.toBeNull();
    expect(diffLink.getAttribute('href')).toMatch(/leftVersion=v1\.0\.0/);
    expect(diffLink.getAttribute('href')).toMatch(/rightVersion=v1\.1\.0/);
  });

  it('exposes accessible chart fallbacks and summaries', async () => {
    const view = document.createElement('component-ecosystem-view') as ComponentEcosystemView;
    await mount(view);
    const root = view.shadowRoot as ShadowRoot;

    const charts = root.querySelectorAll('analytics-chart');
    expect(charts.length).toBeGreaterThan(0);
    for (const chart of charts) {
      const shadow = (chart as LitElement).shadowRoot as ShadowRoot;
      expect(shadow.querySelector('.summary-toggle')).not.toBeNull();

      const echartsBase = shadow.querySelector('echarts-base') as LitElement;
      expect(echartsBase).not.toBeNull();
      const echartsShadow = echartsBase.shadowRoot as ShadowRoot;
      expect(echartsShadow.querySelector('details')).not.toBeNull();
    }
  });

  it('enters a partial state when one detail panel fails', async () => {
    componentMock.getUtilization.mockRejectedValue(new Error('utilization down'));
    window.location.hash = '#/components/read_file';
    const view = Object.assign(document.createElement('component-ecosystem-view'), {
      componentId: 'read_file',
    }) as ComponentEcosystemView;
    await mount(view);
    const root = view.shadowRoot as ShadowRoot;

    expect(root.textContent).toContain('utilization down');
    expect(root.textContent).toContain('Versions');
  });

  it('shows empty states when no data is returned', async () => {
    componentMock.getSummary.mockResolvedValue(
      summaryFixture({ countsByKind: {}, topByUtilization: [] }),
    );
    componentMock.getVersions.mockResolvedValue({
      items: [],
      generationToken: 'gen-1',
      analysisReleaseToken: 'rel-1',
    });
    componentMock.getScopes.mockResolvedValue({
      items: [],
      generationToken: 'gen-1',
      analysisReleaseToken: 'rel-1',
    });
    componentMock.getDistributions.mockResolvedValue({
      items: [],
      generationToken: 'gen-1',
      analysisReleaseToken: 'rel-1',
    });
    componentMock.getProjectsSessions.mockResolvedValue({
      items: [],
      generationToken: 'gen-1',
      analysisReleaseToken: 'rel-1',
    });
    componentMock.getLifecycleComparisons.mockResolvedValue({
      items: [],
      generationToken: 'gen-1',
      analysisReleaseToken: 'rel-1',
    });
    window.location.hash = '#/components/read_file';
    const view = Object.assign(document.createElement('component-ecosystem-view'), {
      componentId: 'read_file',
    }) as ComponentEcosystemView;
    await mount(view);
    const root = view.shadowRoot as ShadowRoot;

    expect(root.textContent).toContain('No versions found');
    expect(root.textContent).toContain('No installation scopes found');
    expect(root.textContent).toContain('No distributions found');
    expect(root.textContent).toContain('No project or session evidence found');
    expect(root.textContent).toContain('No lifecycle events found');
  });

  it('loads an artifact diff when left and right versions are selected', async () => {
    artifactMock.getDiff.mockResolvedValue({
      artifactId: 'art-1',
      leftVersion: 'v1.0.0',
      rightVersion: 'v1.1.0',
      unifiedDiff: '- old\n+ new',
      metadataChanges: [{ field: 'version', oldValue: 'v1.0.0', newValue: 'v1.1.0' }],
      sessionExposure: {},
    });

    window.location.hash = '#/components/read_file?leftVersion=v1.0.0&rightVersion=v1.1.0';
    const view = Object.assign(document.createElement('component-ecosystem-view'), {
      componentId: 'read_file',
    }) as ComponentEcosystemView;
    await mount(view);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await flush(view);

    expect(artifactMock.getDiff).toHaveBeenCalledWith('v1.0.0', 'v1.1.0', expect.any(Object));
    const root = view.shadowRoot as ShadowRoot;
    expect(root.textContent).toContain('Artifact diff');
    expect(root.textContent).toContain('+ new');
    expect(root.textContent).toContain('- old');
  });
});
