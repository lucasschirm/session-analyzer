import type {
  AnalyticsToken,
  ComponentFactPage,
  ContextTimingSeries,
  EvidencePage,
  MetricValueDto,
  RootChildBreakdown,
  SessionEventsDetail,
  SessionEvidenceSummary,
  SessionTree,
  SessionValidationSummary,
  TurnTimeline,
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
  getTranscriptPages: vi.fn(),
  getSessionEvents: vi.fn(),
  getTurnTimeline: vi.fn(),
  getEventPayload: vi.fn(),
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
    mode: 'default',
    outcome: 'clean',
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

function sessionEventsFixture(overrides: Partial<SessionEventsDetail> = {}): SessionEventsDetail {
  return {
    token: tokenFixture(),
    sessionId: 's1',
    events: [
      {
        id: 'inv-1',
        timestamp: new Date(1_700_000_000_500).toISOString(),
        turnNumber: 1,
        kind: 'tool',
        name: 'read_file',
        target: 'src/index.ts',
        tokens: 42,
        durationMs: 120,
        status: 'completed',
        inputPayload: { payloadId: 'p1', content: '{"path":"src/index.ts"}', truncated: false },
        resultPayload: { payloadId: 'p2', content: '{"ok":true}', truncated: false },
      },
      {
        id: 'inv-2',
        timestamp: new Date(1_700_000_050_000).toISOString(),
        turnNumber: 2,
        kind: 'tool',
        name: 'run_tests',
        status: 'failed',
        inputPayload: { payloadId: 'p3', content: '{"cmd":"pnpm test"}', truncated: false },
      },
    ],
    ...overrides,
  };
}

function turnTimelineFixture(overrides: Partial<TurnTimeline> = {}): TurnTimeline {
  return {
    token: tokenFixture(),
    sessionId: 's1',
    totalDurationMs: 1000,
    segments: [
      { kind: 'user', startMs: 0, durationMs: 400, sourceId: 'inv-1' },
      {
        kind: 'invocation',
        startMs: 400,
        durationMs: 600,
        invocationKind: 'tool',
        sourceId: 'inv-2',
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
  sessionMock.getTranscriptPages.mockResolvedValue(transcriptPageFixture());
  sessionMock.getSessionEvents.mockResolvedValue(sessionEventsFixture());
  sessionMock.getTurnTimeline.mockResolvedValue(turnTimelineFixture());
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
  it('loads and renders header, timing, tree, components, validation, events', async () => {
    const view = Object.assign(document.createElement('session-evidence-view'), {
      sessionId: 's1',
    }) as SessionEvidenceView;
    await mount(view);
    const root = view.shadowRoot as ShadowRoot;

    expect(root.textContent).toContain('Context and request timing');
    expect(root.textContent).toContain('Root and child sessions');
    expect(root.textContent).toContain('Tool / Skill / Agent activity');
    expect(root.textContent).toContain('Validation');
    expect(root.textContent).toContain('Events');

    const header = root.querySelector('session-evidence-header') as LitElement | null;
    expect(header).not.toBeNull();
    expect(header?.shadowRoot?.textContent).toContain('Hello **world**');
    expect(header?.shadowRoot?.textContent).toContain('Clean');

    const cardTexts = allChildTexts(root, 'metrics-card').join(' ');
    expect(cardTexts).toContain('Total Tokens');

    const tree = root.querySelector('session-evidence-tree');
    expect(tree).not.toBeNull();

    expect(searchMock.getRootSessionTree).toHaveBeenCalledWith('s1');
    expect(sessionMock.getSummary).toHaveBeenCalledWith('s1', expect.any(Object));
    expect(sessionMock.getSessionEvents).toHaveBeenCalledWith('s1', expect.any(Object));
    expect(sessionMock.getTurnTimeline).toHaveBeenCalledWith('s1', expect.any(Object));
  });

  it('renders the turn timeline strip and applies a turn filter chip on segment click', async () => {
    const view = Object.assign(document.createElement('session-evidence-view'), {
      sessionId: 's1',
    }) as SessionEvidenceView;
    await mount(view);
    const root = view.shadowRoot as ShadowRoot;

    const timeline = root.querySelector('session-evidence-timeline') as LitElement | null;
    expect(timeline).not.toBeNull();
    const segments = timeline?.shadowRoot?.querySelectorAll('.segment') ?? [];
    expect(segments.length).toBe(2);

    (segments[1] as HTMLButtonElement).click();
    await flush(view);

    const table = root.querySelector('session-evidence-events-table') as LitElement | null;
    expect(table?.shadowRoot?.textContent).toContain('Turn 2');
  });

  it('renders precomputed context/request timeline buckets', async () => {
    const view = Object.assign(document.createElement('session-evidence-view'), {
      sessionId: 's1',
    }) as SessionEvidenceView;
    await mount(view);
    const root = view.shadowRoot as ShadowRoot;

    const chart = root.querySelector('analytics-chart');
    expect(chart).not.toBeNull();
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

  it('renders the full-detail events table (not the old paginated evidence view)', async () => {
    const view = Object.assign(document.createElement('session-evidence-view'), {
      sessionId: 's1',
    }) as SessionEvidenceView;
    await mount(view);
    const root = view.shadowRoot as ShadowRoot;

    const table = root.querySelector('session-evidence-events-table') as LitElement | null;
    expect(table).not.toBeNull();
    const tableText = table?.shadowRoot?.textContent ?? '';
    expect(tableText).toContain('read_file');
    expect(tableText).toContain('run_tests');
    expect(root.querySelector('session-evidence-evidence')).toBeNull();
  });

  it('renders the sub agent transcript with chat-like markdown messages', async () => {
    window.location.hash = '#/sessions/s1?view=transcript';
    const view = Object.assign(document.createElement('session-evidence-view'), {
      sessionId: 's1',
    }) as SessionEvidenceView;
    await mount(view);
    const root = view.shadowRoot as ShadowRoot;

    expect(sessionMock.getTranscriptPages).toHaveBeenCalled();
    const transcriptEl = root.querySelector('session-evidence-transcript') as LitElement | null;
    expect(transcriptEl).not.toBeNull();
    const transcriptText = transcriptEl?.shadowRoot?.textContent ?? '';
    expect(transcriptText).toContain('Hello');
    expect(transcriptText).toContain('world');
  });

  it('resolves a deleted/superseded transcript to a tombstone', async () => {
    sessionMock.getTranscriptPages.mockResolvedValue({
      items: [
        {
          evidenceId: 'tombstone-s1',
          entityType: 'tombstone',
          summary: 'Transcript for session s1 is no longer available: superseded',
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
  });

  it('shows loading and empty states, distinct from an error', async () => {
    sessionMock.getSummary.mockResolvedValue(summaryFixture({ headlineMetrics: [] }));
    sessionMock.getComponentFacts.mockResolvedValue({
      items: [],
      generationToken: 'gen-1',
      analysisReleaseToken: 'rel-1',
    });
    sessionMock.getValidationSummary.mockResolvedValue(validationFixture({ validations: [] }));
    sessionMock.getSessionEvents.mockResolvedValue({
      token: tokenFixture({ eligibleN: 0, knownN: 0 }),
      sessionId: 's1',
      events: [],
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
    const table = root.querySelector('session-evidence-events-table') as LitElement | null;
    expect(table?.shadowRoot?.textContent).toContain('No events recorded for this session.');
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

  it('shows an error affordance (distinct from empty) when the data source fails', async () => {
    sessionMock.getSummary.mockRejectedValue(new Error('summary failed'));
    sessionMock.getContextTimingSeries.mockRejectedValue(new Error('timing failed'));
    sessionMock.getRootChildBreakdown.mockRejectedValue(new Error('tree failed'));
    sessionMock.getComponentFacts.mockRejectedValue(new Error('components failed'));
    sessionMock.getValidationSummary.mockRejectedValue(new Error('validation failed'));
    sessionMock.getSessionEvents.mockRejectedValue(new Error('events failed'));
    sessionMock.getTurnTimeline.mockRejectedValue(new Error('timeline failed'));
    sessionMock.getTranscriptPages.mockRejectedValue(new Error('transcript failed'));
    searchMock.getRootSessionTree.mockRejectedValue(new Error('tree search failed'));

    const view = Object.assign(document.createElement('session-evidence-view'), {
      sessionId: 's1',
    }) as SessionEvidenceView;
    await mount(view);
    const root = view.shadowRoot as ShadowRoot;

    expect(root.textContent).toContain('summary failed');
    expect(root.textContent).toContain('Session evidence failed to load');
    expect(root.textContent).not.toContain('No events match');

    // The turn timeline surfaces its own error affordance too — a
    // getTurnTimeline failure must never render identically to the
    // legitimate "no timestamped evidence yet" empty state.
    expect(root.textContent).toContain('timeline failed');
    expect(root.querySelector('session-evidence-timeline')).toBeNull();
  });
});
