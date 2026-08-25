import type {
  AnalyticsToken,
  ComponentFactPage,
  ContextTimingSeries,
  EvidencePage,
  MetricValueDto,
  RootChildBreakdown,
  SessionEvidenceSummary,
  SessionTree,
  SessionValidationSummary,
} from '@lucasschirm/sal-db';
import type { LitElement } from 'lit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../../src/pages/session-evidence/session-evidence-view';
import type { SessionEvidenceView } from '../../src/pages/session-evidence/session-evidence-view';

const sessionMock = vi.hoisted(() => ({
  getSummary: vi.fn(),
  getContextTimingSeries: vi.fn(),
  getRootChildBreakdown: vi.fn(),
  getComponentFacts: vi.fn(),
  getValidationSummary: vi.fn(),
  getEvidencePages: vi.fn(),
  getTranscriptPages: vi.fn(),
}));

const searchMock = vi.hoisted(() => ({
  getRootSessionTree: vi.fn(),
}));

vi.mock('../../src/db/analytics-client', () => ({
  AnalyticsClient: vi.fn(),
  analyticsClient: { session: sessionMock, search: searchMock },
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

function allChildTexts(parent: ShadowRoot | Element, selector: string): string[] {
  const root = parent instanceof ShadowRoot ? parent : parent.shadowRoot;
  if (!root) return [];
  return Array.from(root.querySelectorAll(selector)).map(
    (child) => ((child as LitElement).shadowRoot?.textContent ?? child.textContent ?? '') as string,
  );
}

function tokenFixture(overrides: Partial<AnalyticsToken> = {}): AnalyticsToken {
  return {
    analysisReleaseId: 'rel-1',
    generationId: 'gen-1',
    comparabilityGroupId: 'cgrp-session',
    eligibleN: 10,
    knownN: 9,
    unknownCount: 1,
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
    ...tokenFixture({
      evidenceLinks: [
        { evidenceId: 'e1', entityType: 'session', entityId: 's1', label: 'Session s1' },
      ],
    }),
    metricId: 'total_tokens',
    value: 1234,
    unit: 'count',
    label: 'Total Tokens',
    isExact: true,
    ...overrides,
  };
}

function summaryFixture(overrides: Partial<SessionEvidenceSummary> = {}): SessionEvidenceSummary {
  return {
    token: tokenFixture(),
    sessionId: 's1',
    rootSessionId: 's1',
    parentSessionId: undefined,
    harness: 'claude',
    headlineMetrics: [metricValueFixture()],
    ...overrides,
  };
}

function contextTimingFixture(overrides: Partial<ContextTimingSeries> = {}): ContextTimingSeries {
  return {
    token: tokenFixture(),
    points: [
      {
        turnNumber: 1,
        timestamp: new Date(1_700_000_000_000).toISOString(),
        totalTokens: 100,
        contextTokens: 80,
        generationTokens: 20,
      },
      {
        turnNumber: 2,
        timestamp: new Date(1_700_000_100_000).toISOString(),
        totalTokens: 200,
        contextTokens: 150,
        generationTokens: 50,
      },
    ],
    ...overrides,
  };
}

function rootChildFixture(overrides: Partial<RootChildBreakdown> = {}): RootChildBreakdown {
  return {
    token: tokenFixture(),
    root: {
      sessionId: 's1',
      isRoot: true,
      childCount: 2,
      contributionMetrics: [metricValueFixture({ value: 100 })],
    },
    children: [
      {
        sessionId: 's2',
        isRoot: false,
        childCount: 0,
        contributionMetrics: [metricValueFixture({ value: 50 })],
      },
      {
        sessionId: 's3',
        isRoot: false,
        childCount: 0,
        contributionMetrics: [metricValueFixture({ value: 30 })],
      },
    ],
    ...overrides,
  };
}

function componentFactFixture(overrides: Partial<ComponentFactPage> = {}): ComponentFactPage {
  return {
    items: [
      {
        componentId: 'read_file',
        kind: 'tool',
        invocationCount: 3,
        outcome: 'success',
        metricValues: [metricValueFixture({ value: 3, label: 'Invocations' })],
      },
      {
        componentId: 'Skill',
        kind: 'skill',
        invocationCount: 2,
        outcome: 'success',
        metricValues: [metricValueFixture({ value: 2, label: 'Invocations' })],
      },
      {
        componentId: 'Agent',
        kind: 'agent',
        invocationCount: 1,
        outcome: 'success',
        metricValues: [metricValueFixture({ value: 1, label: 'Invocations' })],
      },
    ],
    generationToken: 'gen-1',
    analysisReleaseToken: 'rel-1',
    ...overrides,
  };
}

function validationFixture(
  overrides: Partial<SessionValidationSummary> = {},
): SessionValidationSummary {
  return {
    token: tokenFixture(),
    validations: [{ validationType: 'schema', status: 'passed', count: 1 }],
    ...overrides,
  };
}

function evidencePageFixture(overrides: Partial<EvidencePage> = {}): EvidencePage {
  return {
    items: [
      {
        evidenceId: 'e1',
        entityType: 'invocation',
        turnNumber: 1,
        timestamp: new Date(1_700_000_000_000).toISOString(),
        summary: 'Invocation (tool): success',
        evidenceLinks: [],
      },
      {
        evidenceId: 'e2',
        entityType: 'file_operation',
        summary: 'File read (success)',
        evidenceLinks: [],
      },
    ],
    nextCursor: undefined,
    previousCursor: undefined,
    generationToken: 'gen-1',
    analysisReleaseToken: 'rel-1',
    ...overrides,
  };
}

function transcriptPageFixture(overrides: Partial<EvidencePage> = {}): EvidencePage {
  return {
    items: [
      {
        evidenceId: 'm1',
        entityType: 'message',
        turnNumber: 1,
        timestamp: new Date(1_700_000_000_000).toISOString(),
        summary: 'Message 1 (user)\n\nHello **world**',
        evidenceLinks: [],
      },
      {
        evidenceId: 'm2',
        entityType: 'message',
        turnNumber: 2,
        timestamp: new Date(1_700_000_100_000).toISOString(),
        summary: 'Message 2 (assistant)\n\nResponse',
        evidenceLinks: [],
      },
    ],
    nextCursor: undefined,
    previousCursor: undefined,
    generationToken: 'gen-1',
    analysisReleaseToken: 'rel-1',
    ...overrides,
  };
}

function sessionTreeFixture(overrides: Partial<SessionTree> = {}): SessionTree {
  return {
    rootSessionId: 's1',
    nodes: [
      {
        sessionId: 's1',
        children: [
          { sessionId: 's2', children: [], generationToken: 'gen-1' },
          { sessionId: 's3', children: [], generationToken: 'gen-1' },
        ],
        generationToken: 'gen-1',
      },
    ],
    ...overrides,
  };
}

function stubSessionLoad(): void {
  sessionMock.getSummary.mockResolvedValue(summaryFixture());
  sessionMock.getContextTimingSeries.mockResolvedValue(contextTimingFixture());
  sessionMock.getRootChildBreakdown.mockResolvedValue(rootChildFixture());
  sessionMock.getComponentFacts.mockResolvedValue(componentFactFixture());
  sessionMock.getValidationSummary.mockResolvedValue(validationFixture());
  sessionMock.getEvidencePages.mockResolvedValue(evidencePageFixture());
  sessionMock.getTranscriptPages.mockResolvedValue(transcriptPageFixture());
  searchMock.getRootSessionTree.mockResolvedValue(sessionTreeFixture());
}

beforeEach(() => {
  stubSessionLoad();
  window.location.hash = '#/sessions/s1';
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

describe('session-evidence-view', () => {
  it('loads and renders summary, timing, tree, components, validation, evidence', async () => {
    const view = Object.assign(document.createElement('session-evidence-view'), {
      sessionId: 's1',
    }) as SessionEvidenceView;
    await mount(view);
    const root = view.shadowRoot as ShadowRoot;

    expect(root.textContent).toContain('Session Evidence');
    expect(root.textContent).toContain('Context and request timing');
    expect(root.textContent).toContain('Root and child sessions');
    expect(root.textContent).toContain('Tool / Skill / Agent activity');
    expect(root.textContent).toContain('Validation');
    expect(root.textContent).toContain('Evidence');

    const cardTexts = allChildTexts(root, 'metrics-card').join(' ');
    expect(cardTexts).toContain('Total Tokens');

    const tree = root.querySelector('session-evidence-tree');
    expect(tree).not.toBeNull();

    expect(searchMock.getRootSessionTree).toHaveBeenCalledWith('s1');
    expect(sessionMock.getSummary).toHaveBeenCalledWith('s1', expect.any(Object));
  });

  it('renders precomputed context/request timeline buckets', async () => {
    const view = Object.assign(document.createElement('session-evidence-view'), {
      sessionId: 's1',
    }) as SessionEvidenceView;
    await mount(view);
    const root = view.shadowRoot as ShadowRoot;

    const chart = root.querySelector('analytics-chart');
    expect(chart).not.toBeNull();
    expect((chart as HTMLElement).getAttribute('aria-label')).toBeNull();
    expect(root.textContent).toContain('Context and request timing');
  });

  it('renders the root/child session tree', async () => {
    const view = Object.assign(document.createElement('session-evidence-view'), {
      sessionId: 's1',
    }) as SessionEvidenceView;
    await mount(view);
    const root = view.shadowRoot as ShadowRoot;

    const tree = root.querySelector('session-evidence-tree');
    expect(tree).not.toBeNull();
    const treeText = (tree as LitElement)?.shadowRoot?.textContent ?? '';
    expect(treeText).toContain('s2');
    expect(treeText).toContain('s3');
  });

  it('renders paginated evidence rows with cursor navigation', async () => {
    sessionMock.getEvidencePages.mockResolvedValue(
      evidencePageFixture({ nextCursor: '2', previousCursor: undefined }),
    );

    const view = Object.assign(document.createElement('session-evidence-view'), {
      sessionId: 's1',
    }) as SessionEvidenceView;
    await mount(view);
    const root = view.shadowRoot as ShadowRoot;

    const evidenceEl = root.querySelector('session-evidence-evidence') as LitElement | null;
    expect(evidenceEl).not.toBeNull();
    const evidenceText = evidenceEl?.shadowRoot?.textContent ?? '';
    expect(evidenceText).toContain('Invocation (tool): success');
    const nextButton = evidenceEl?.shadowRoot?.querySelector(
      'button:not(:disabled)',
    ) as HTMLButtonElement | null;
    expect(nextButton).not.toBeNull();
    expect(nextButton?.textContent?.trim()).toBe('Next');

    nextButton?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(window.location.hash).toContain('cursor=2');
  });

  it('renders paginated transcript with chat-like markdown messages', async () => {
    sessionMock.getTranscriptPages.mockResolvedValue(transcriptPageFixture({ nextCursor: '2' }));

    const view = Object.assign(document.createElement('session-evidence-view'), {
      sessionId: 's1',
    }) as SessionEvidenceView;
    await mount(view);
    const root = view.shadowRoot as ShadowRoot;

    const tab = Array.from(root.querySelectorAll('a.view-tab')).find(
      (a) => a.textContent?.trim() === 'Transcript',
    ) as HTMLAnchorElement | undefined;
    tab?.click();
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await flush(view);

    expect(window.location.hash).toContain('view=transcript');
    expect(sessionMock.getTranscriptPages).toHaveBeenCalled();
    const transcriptEl = root.querySelector('session-evidence-transcript') as LitElement | null;
    expect(transcriptEl).not.toBeNull();
    const transcriptText = transcriptEl?.shadowRoot?.textContent ?? '';
    expect(transcriptText).toContain('Hello');
    expect(transcriptText).toContain('world');
  });

  it('resolves deleted/superseded evidence to a tombstone', async () => {
    sessionMock.getEvidencePages.mockResolvedValue({
      items: [
        {
          evidenceId: 'tombstone-s1',
          entityType: 'tombstone',
          summary: 'Evidence for session s1 is no longer available: superseded',
          evidenceLinks: [],
        },
      ],
      generationToken: 'gen-1',
      analysisReleaseToken: 'rel-1',
    });
    sessionMock.getSummary.mockResolvedValue(
      summaryFixture({
        headlineMetrics: [],
        token: tokenFixture({ knownN: 0, unknownCount: 1, coverage: 'unknown' }),
      }),
    );

    const view = Object.assign(document.createElement('session-evidence-view'), {
      sessionId: 's1',
    }) as SessionEvidenceView;
    await mount(view);
    const root = view.shadowRoot as ShadowRoot;

    expect(root.textContent).toContain('deleted or superseded');
    const evidenceEl = root.querySelector('session-evidence-evidence') as LitElement | null;
    const evidenceText = evidenceEl?.shadowRoot?.textContent ?? '';
    expect(evidenceText).toContain('no longer available');
  });

  it('shows loading and empty states', async () => {
    sessionMock.getSummary.mockResolvedValue(summaryFixture({ headlineMetrics: [] }));
    sessionMock.getComponentFacts.mockResolvedValue({
      items: [],
      generationToken: 'gen-1',
      analysisReleaseToken: 'rel-1',
    });
    sessionMock.getValidationSummary.mockResolvedValue(validationFixture({ validations: [] }));
    sessionMock.getEvidencePages.mockResolvedValue({
      items: [],
      generationToken: 'gen-1',
      analysisReleaseToken: 'rel-1',
    });
    sessionMock.getTranscriptPages.mockResolvedValue({
      items: [],
      generationToken: 'gen-1',
      analysisReleaseToken: 'rel-1',
    });

    const view = Object.assign(document.createElement('session-evidence-view'), {
      sessionId: 's1',
    }) as SessionEvidenceView;
    await mount(view);
    const root = view.shadowRoot as ShadowRoot;

    expect(root.textContent).toContain('No component activity');
    expect(root.textContent).toContain('No validation records');
    const evidenceEl = root.querySelector('session-evidence-evidence') as LitElement | null;
    const evidenceText = evidenceEl?.shadowRoot?.textContent ?? '';
    expect(evidenceText).toContain('No evidence rows');
  });

  it('keeps Tool, Skill, and Agent distinct in the component table', async () => {
    const view = Object.assign(document.createElement('session-evidence-view'), {
      sessionId: 's1',
    }) as SessionEvidenceView;
    await mount(view);
    const root = view.shadowRoot as ShadowRoot;

    const rows = Array.from(root.querySelectorAll('.component-table tbody tr'));
    const kinds = rows.map((row) =>
      (row.querySelector('.kind-badge') as HTMLElement)?.textContent?.trim(),
    );
    expect(kinds).toContain('tool');
    expect(kinds).toContain('skill');
    expect(kinds).toContain('agent');
    expect(rows.length).toBe(3);
  });

  it('shows an error when the data source fails', async () => {
    sessionMock.getSummary.mockRejectedValue(new Error('summary failed'));
    sessionMock.getContextTimingSeries.mockRejectedValue(new Error('timing failed'));
    sessionMock.getRootChildBreakdown.mockRejectedValue(new Error('tree failed'));
    sessionMock.getComponentFacts.mockRejectedValue(new Error('components failed'));
    sessionMock.getValidationSummary.mockRejectedValue(new Error('validation failed'));
    sessionMock.getEvidencePages.mockRejectedValue(new Error('evidence failed'));
    sessionMock.getTranscriptPages.mockRejectedValue(new Error('transcript failed'));
    searchMock.getRootSessionTree.mockRejectedValue(new Error('tree search failed'));

    const view = Object.assign(document.createElement('session-evidence-view'), {
      sessionId: 's1',
    }) as SessionEvidenceView;
    await mount(view);
    const root = view.shadowRoot as ShadowRoot;

    expect(root.textContent).toContain('summary failed');
    expect(root.textContent).toContain('Session evidence failed to load');
  });
});
