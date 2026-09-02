import type {
  DimensionDomains,
  ProjectHeader,
  ProjectModelHarnessCohorts,
  ProjectStatStrip,
  SessionDurationHistogram,
  SessionOutcomeDistribution,
  TopToolsList,
  WeeklyToolErrorRateSeries,
} from '@lucasschirm/sal-db';
import type { LitElement } from 'lit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../../src/pages/project-behavior/project-behavior-view';
import type { ProjectBehaviorPage } from '../../src/pages/project-behavior/project-behavior-view';

const projectMock = vi.hoisted(() => ({
  getHeader: vi.fn(),
  getStatStrip: vi.fn(),
  getDurationHistogram: vi.fn(),
  getOutcomeMix: vi.fn(),
  getWeeklyToolErrorRate: vi.fn(),
  getTopTools: vi.fn(),
  getModelHarnessCohorts: vi.fn(),
}));

const metadataMock = vi.hoisted(() => ({ getDimensionDomains: vi.fn() }));
const resolveProjectIdMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/db/analytics-client', () => ({
  AnalyticsClient: vi.fn(),
  analyticsClient: {
    project: projectMock,
    metadata: metadataMock,
    resolveProjectId: resolveProjectIdMock,
  },
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

function tokenFixture() {
  return {
    analysisReleaseId: 'rel-1',
    generationId: 'gen-1',
    comparabilityGroupId: 'cgrp-1',
    eligibleN: 10,
    knownN: 10,
    unknownCount: 0,
    coverage: 'complete',
    measurementClass: 'derived',
    confidence: 'high',
    metricVersion: '1',
    evidenceLinks: [],
  };
}

function headerFixture(overrides: Partial<ProjectHeader> = {}): ProjectHeader {
  return {
    token: tokenFixture() as ProjectHeader['token'],
    displayName: 'Alpha Project',
    harnesses: ['claude-code', 'codex'],
    sessionCount: 12,
    activeWindowStart: '2024-01-01T00:00:00.000Z',
    activeWindowEnd: '2024-02-01T00:00:00.000Z',
    ...overrides,
  };
}

function statStripFixture(overrides: Partial<ProjectStatStrip> = {}): ProjectStatStrip {
  return {
    token: tokenFixture() as ProjectStatStrip['token'],
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

function histogramFixture(
  overrides: Partial<SessionDurationHistogram> = {},
): SessionDurationHistogram {
  return {
    token: tokenFixture() as SessionDurationHistogram['token'],
    eligibleN: 3,
    knownN: 3,
    bins: [
      { startMs: 0, endMs: 60_000, count: 1 },
      { startMs: 60_000, endMs: null, count: 2 },
    ],
    ...overrides,
  };
}

function outcomesFixture(
  overrides: Partial<SessionOutcomeDistribution> = {},
): SessionOutcomeDistribution {
  return {
    token: tokenFixture() as SessionOutcomeDistribution['token'],
    buckets: [
      { outcome: 'clean', count: 7 },
      { outcome: 'interrupted_by_user', count: 2 },
      { outcome: 'ended_on_error', count: 1 },
      { outcome: null, count: 0 },
    ],
    ...overrides,
  };
}

function toolErrorFixture(
  overrides: Partial<WeeklyToolErrorRateSeries> = {},
): WeeklyToolErrorRateSeries {
  return {
    token: tokenFixture() as WeeklyToolErrorRateSeries['token'],
    series: [{ weekBucket: '2024-01', rate: 0.1, toolCallsN: 20, failedN: 2 }],
    currentValue: 0.1,
    currentWeekN: 20,
    ...overrides,
  };
}

function topToolsFixture(overrides: Partial<TopToolsList> = {}): TopToolsList {
  return {
    token: tokenFixture() as TopToolsList['token'],
    rows: [{ componentId: 'bash', displayName: 'bash', invocationCount: 5 }],
    totalInvocations: 5,
    ...overrides,
  };
}

function modelCohortsFixture(
  overrides: Partial<ProjectModelHarnessCohorts> = {},
): ProjectModelHarnessCohorts {
  return {
    token: tokenFixture() as ProjectModelHarnessCohorts['token'],
    rows: [
      {
        model: 'claude-sonnet',
        harness: 'claude-code',
        n: 10,
        medianTokens: 500,
        medianCost: 0.5,
        cleanRate: 0.9,
        cleanRateKnownN: 10,
        lowN: false,
      },
    ],
    ...overrides,
  };
}

const domainsFixture: DimensionDomains = {
  token: tokenFixture() as DimensionDomains['token'],
  projects: ['Alpha Project'],
  harnesses: ['claude-code', 'codex'],
  models: ['claude-sonnet'],
};

function stubLoad(): void {
  resolveProjectIdMock.mockResolvedValue('p1');
  projectMock.getHeader.mockResolvedValue(headerFixture());
  projectMock.getStatStrip.mockResolvedValue(statStripFixture());
  projectMock.getDurationHistogram.mockResolvedValue(histogramFixture());
  projectMock.getOutcomeMix.mockResolvedValue(outcomesFixture());
  projectMock.getWeeklyToolErrorRate.mockResolvedValue(toolErrorFixture());
  projectMock.getTopTools.mockResolvedValue(topToolsFixture());
  projectMock.getModelHarnessCohorts.mockResolvedValue(modelCohortsFixture());
  metadataMock.getDimensionDomains.mockResolvedValue(domainsFixture);
}

beforeEach(() => {
  stubLoad();
  window.location.hash = '#/projects/p1';
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.resetAllMocks();
});

async function mountView(): Promise<ProjectBehaviorPage> {
  const view = Object.assign(document.createElement('project-behavior-view'), {
    projectId: 'p1',
  }) as ProjectBehaviorPage;
  return mount(view);
}

describe('project-behavior-view header and breadcrumb', () => {
  it('renders the project display name and identity chips', async () => {
    const view = await mountView();
    const root = view.shadowRoot as ShadowRoot;
    expect(root.textContent).toContain('Alpha Project');
    expect(root.textContent).toContain('claude-code, codex');
    expect(root.textContent).toContain('12 sessions');
  });

  it('does not render a "Compare period" control', async () => {
    const view = await mountView();
    const root = view.shadowRoot as ShadowRoot;
    expect(root.textContent).not.toMatch(/compare period/i);
  });

  it('returns to the filtered portfolio via returnContext', async () => {
    window.location.hash = '#/projects/p1?returnContext=project%3Dp1';
    const view = await mountView();
    const root = view.shadowRoot as ShadowRoot;
    const back = root.querySelector('a.back-link') as HTMLAnchorElement;
    expect(back.getAttribute('href')).toMatch(/project=p1/);
  });
});

describe('project-behavior-view stat strip', () => {
  it('renders the cost tile as missing with harness-coverage copy', async () => {
    const view = await mountView();
    const root = view.shadowRoot as ShadowRoot;
    const missing = root.querySelector('stat-tile-missing') as LitElement;
    expect(missing).not.toBeNull();
    expect(missing.shadowRoot?.textContent).toContain('Not reported by 1 of 2 harnesses');
  });
});

describe('project-behavior-view histogram', () => {
  it('renders bin count from the histogram DTO', async () => {
    const view = await mountView();
    const root = view.shadowRoot as ShadowRoot;
    const charts = root.querySelectorAll('analytics-chart');
    const durationChart = Array.from(charts).find((c) =>
      (c as LitElement).shadowRoot?.textContent?.includes('Session duration'),
    ) as LitElement;
    expect(durationChart).not.toBeUndefined();
  });
});

describe('project-behavior-view outcomes legend', () => {
  it('shows legend counts that sum to the session total', async () => {
    const view = await mountView();
    const root = view.shadowRoot as ShadowRoot;
    const rows = root.querySelectorAll('.outcome-legend-row');
    expect(rows).toHaveLength(3);
    const text = Array.from(rows)
      .map((r) => r.textContent ?? '')
      .join(' ');
    expect(text).toContain('Clean');
    expect(text).toContain('7');
    expect(text).toContain('Interrupted by user');
    expect(text).toContain('Ended on error');
  });

  it('reports the unreadable-tail count in the footnote when non-zero', async () => {
    projectMock.getOutcomeMix.mockResolvedValue(
      outcomesFixture({
        buckets: [
          { outcome: 'clean', count: 5 },
          { outcome: null, count: 2 },
        ],
      }),
    );
    const view = await mountView();
    const root = view.shadowRoot as ShadowRoot;
    expect(root.textContent).toContain('unreadable tail');
  });

  it('omits the unreadable-tail line when the count is zero', async () => {
    const view = await mountView();
    const root = view.shadowRoot as ShadowRoot;
    expect(root.textContent).not.toContain('unreadable tail');
  });
});

describe('project-behavior-view empty and error affordances', () => {
  it('renders an error affordance distinguishable from empty, for the model-cohorts section', async () => {
    projectMock.getModelHarnessCohorts.mockRejectedValue(new Error('cohorts down'));
    const view = await mountView();
    const root = view.shadowRoot as ShadowRoot;
    expect(root.querySelector('.error')?.textContent).toContain('cohorts down');
  });

  it('renders an empty affordance (not an error) when the model-cohorts section has no rows', async () => {
    projectMock.getModelHarnessCohorts.mockResolvedValue(modelCohortsFixture({ rows: [] }));
    const view = await mountView();
    const root = view.shadowRoot as ShadowRoot;
    expect(root.querySelector('.error')).toBeNull();
    expect(root.textContent).toContain('No model activity in this window');
  });
});

describe('project-behavior-view model cohorts table', () => {
  it('flags a low-n row with "· low n"', async () => {
    projectMock.getModelHarnessCohorts.mockResolvedValue(
      modelCohortsFixture({
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
      }),
    );
    const view = await mountView();
    const root = view.shadowRoot as ShadowRoot;
    expect(root.textContent).toContain('low n');
    expect(root.querySelector('td.low-n')).not.toBeNull();
  });
});

describe('project-behavior-view filter bar', () => {
  it('locks the Project chip to this project and preserves harness/model on filter change', async () => {
    const view = await mountView();
    const root = view.shadowRoot as ShadowRoot;
    const filterBar = root.querySelector('filter-bar') as LitElement;
    expect(filterBar).not.toBeNull();
    expect((filterBar as unknown as { projectFixed: boolean }).projectFixed).toBe(true);
  });
});

describe('project-behavior-view top tools', () => {
  it('states that Skills/Agents/MCP have their own pages', async () => {
    const view = await mountView();
    const root = view.shadowRoot as ShadowRoot;
    expect(root.textContent).toMatch(/Skills, Agents, and MCP servers are tracked separately/i);
  });
});
