import type {
  AnalyticsToken,
  ComponentFactPage,
  ContextTimingSeries,
  EvidencePage,
  MetricValueDto,
  ScopeUtilizationReportDto,
  SessionEvidenceSummary,
  SessionValidationSummary,
} from '@lucasschirm/sal-db';
import type { LitElement } from 'lit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../../src/pages/session-evidence/session-evidence-view';
import type { SessionEvidenceView } from '../../src/pages/session-evidence/session-evidence-view';

const sessionMock = vi.hoisted(() => ({
  getSummary: vi.fn(),
  getContextTimingSeries: vi.fn(),
  getComponentFacts: vi.fn(),
  getValidationSummary: vi.fn(),
  getTranscriptPages: vi.fn(),
  getUtilizationReport: vi.fn(),
}));

const searchMock = vi.hoisted(() => ({
  getRootSessionTree: vi.fn(),
}));

const mockSetSessionTitle = vi.hoisted(() => vi.fn());

vi.mock('../../src/db/analytics-client', () => ({
  AnalyticsClient: vi.fn(),
  analyticsClient: {
    session: sessionMock,
    search: searchMock,
    setSessionTitle: (...args: unknown[]) => mockSetSessionTitle(...args),
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
    title: 'Quarterly report analysis',
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
        messageIndex: 1,
        messageId: 'msg-1',
        role: 'user',
        timestamp: new Date(1_700_000_000_000).toISOString(),
        totalTokens: 100,
        contextTokens: 80,
        generationTokens: 20,
        inputTokens: 80,
        outputTokens: 20,
        content: 'Hello assistant',
      },
      {
        turnNumber: 2,
        messageIndex: 2,
        messageId: 'msg-2',
        role: 'assistant',
        model: 'claude-3-7-sonnet',
        timestamp: new Date(1_700_000_100_000).toISOString(),
        totalTokens: 200,
        contextTokens: 150,
        generationTokens: 50,
        inputTokens: 150,
        outputTokens: 50,
        content: 'I am here to help',
      },
    ],
    ...overrides,
  };
}

function componentFactFixture(overrides: Partial<ComponentFactPage> = {}): ComponentFactPage {
  return {
    items: [
      {
        componentId: 'comp-read-file',
        kind: 'tool',
        displayName: 'tool/read_file',
        invocationCount: 3,
        outcome: 'success',
        metricValues: [metricValueFixture({ value: 3, label: 'Invocations' })],
      },
      {
        componentId: 'comp-skill',
        kind: 'skill',
        displayName: 'skill/add-e2e-test',
        invocationCount: 2,
        outcome: 'success',
        metricValues: [metricValueFixture({ value: 2, label: 'Invocations' })],
      },
      {
        componentId: 'comp-agent',
        kind: 'agent',
        displayName: 'agent/pr-review',
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

function utilizationFixture(): ScopeUtilizationReportDto {
  return {
    scopeType: 'session',
    scopeId: 's1',
    token: tokenFixture(),
    domains: {
      tool: {
        domain: 'tool',
        tiers: {
          totalAvailable: 2,
          totalUsed: 1,
          totalUnused: 1,
          usedLt10Pct: 0,
          usedLt25Pct: 0,
          usedLt50Pct: 0,
          usedGte50Pct: 0,
          insufficientSample: 0,
        },
        sampleSessions: 1,
        eligibleSessions: 1,
        minSampleSizeConfig: 5,
        components: [],
      },
      skill: {
        domain: 'skill',
        tiers: {
          totalAvailable: 1,
          totalUsed: 0,
          totalUnused: 1,
          usedLt10Pct: 0,
          usedLt25Pct: 0,
          usedLt50Pct: 0,
          usedGte50Pct: 0,
          insufficientSample: 0,
        },
        sampleSessions: 1,
        eligibleSessions: 1,
        minSampleSizeConfig: 5,
        components: [],
      },
      agent: {
        domain: 'agent',
        tiers: {
          totalAvailable: 0,
          totalUsed: 0,
          totalUnused: 0,
          usedLt10Pct: 0,
          usedLt25Pct: 0,
          usedLt50Pct: 0,
          usedGte50Pct: 0,
          insufficientSample: 0,
        },
        sampleSessions: 1,
        eligibleSessions: 1,
        minSampleSizeConfig: 5,
        components: [],
      },
    },
    sessionDomains: {
      tool: {
        domain: 'tool',
        availableCount: 2,
        usedCount: 1,
        unusedCount: 1,
        availableComponents: ['tool/Bash', 'tool/Edit'],
        usedComponents: ['tool/Bash'],
        unusedComponents: ['tool/Edit'],
      },
      skill: {
        domain: 'skill',
        availableCount: 1,
        usedCount: 0,
        unusedCount: 1,
        availableComponents: ['skill/pr-review'],
        usedComponents: [],
        unusedComponents: ['skill/pr-review'],
      },
      agent: {
        domain: 'agent',
        availableCount: 0,
        usedCount: 0,
        unusedCount: 0,
        availableComponents: [],
        usedComponents: [],
        unusedComponents: [],
      },
    },
  };
}

function stubSessionLoad(): void {
  sessionMock.getSummary.mockResolvedValue(summaryFixture());
  sessionMock.getContextTimingSeries.mockResolvedValue(contextTimingFixture());
  sessionMock.getComponentFacts.mockResolvedValue(componentFactFixture());
  sessionMock.getValidationSummary.mockResolvedValue(validationFixture());
  sessionMock.getTranscriptPages.mockResolvedValue(transcriptPageFixture());
  sessionMock.getUtilizationReport.mockResolvedValue(utilizationFixture());
}

beforeEach(() => {
  stubSessionLoad();
  mockSetSessionTitle.mockResolvedValue(undefined);
  window.location.hash = '#/sessions/s1';
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

describe('session-evidence-view', () => {
  it('loads and renders summary, component availability, timing, components, validation', async () => {
    const view = Object.assign(document.createElement('session-evidence-view'), {
      sessionId: 's1',
    }) as SessionEvidenceView;
    await mount(view);
    const root = view.shadowRoot as ShadowRoot;

    expect(root.querySelector('h1')?.textContent).toContain('Quarterly report analysis');
    expect(root.textContent).toContain('Context and request timing');
    expect(root.textContent).toContain('Tool / Skill / Agent activity');
    expect(root.textContent).toContain('Validation');
    expect(allChildTexts(root, 'component-utilization-panel').join(' ')).toContain(
      'Session Component Availability & Invocations',
    );

    // Removed sections stay removed: the session page leads with the metrics,
    // component availability, and context growth, and the evidence rows and
    // session tree no longer have a place on it.
    expect(root.textContent).not.toContain('Root and child sessions');
    expect(root.querySelector('session-evidence-tree')).toBeNull();
    expect(root.querySelector('session-evidence-evidence')).toBeNull();
    // The transcript is reached from the header action, not shown inline.
    expect(root.querySelector('session-evidence-transcript')).toBeNull();

    const cardTexts = allChildTexts(root, 'metrics-card').join(' ');
    expect(cardTexts).toContain('Total Tokens');

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

  it('opens message details drawer on chart bar click and closes on drawer-close event', async () => {
    const view = Object.assign(document.createElement('session-evidence-view'), {
      sessionId: 's1',
    }) as SessionEvidenceView;
    await mount(view);
    const root = view.shadowRoot as ShadowRoot;

    const drawer = root.querySelector('session-context-drawer') as LitElement;
    expect(drawer).not.toBeNull();
    // Initially no message is selected
    expect(drawer.shadowRoot?.querySelector('.drawer-panel')).toBeNull();

    const chart = root.querySelector('analytics-chart');
    expect(chart).not.toBeNull();

    // Simulate clicking the first bar (Message #1)
    chart?.dispatchEvent(
      new CustomEvent('chart-click', {
        bubbles: true,
        composed: true,
        detail: {
          dataIndex: 0,
          name: '#1 user',
          evidenceLink: { label: 'Message #1 (user)', href: '#/sessions/s1#msg-msg-1' },
        },
      }),
    );
    await flush(view);
    await flush(drawer);

    // Drawer should now be open with message #1 details
    const panel = drawer.shadowRoot?.querySelector('.drawer-panel');
    expect(panel).not.toBeNull();
    expect(panel?.textContent).toContain('Message #1');
    expect(panel?.textContent).toContain('user');
    expect(panel?.textContent).toContain('Hello assistant');

    // Simulate drawer close
    drawer.dispatchEvent(
      new CustomEvent('drawer-close', {
        bubbles: true,
        composed: true,
      }),
    );
    await flush(view);
    await flush(drawer);

    // Drawer is closed
    expect(drawer.shadowRoot?.querySelector('.drawer-panel')).toBeNull();
  });

  it('supports opening drawer via chart-click with message name matching', async () => {
    const view = Object.assign(document.createElement('session-evidence-view'), {
      sessionId: 's1',
    }) as SessionEvidenceView;
    await mount(view);
    const root = view.shadowRoot as ShadowRoot;

    const drawer = root.querySelector('session-context-drawer') as LitElement;
    const chart = root.querySelector('analytics-chart');

    // Simulate chart-click for message #2
    chart?.dispatchEvent(
      new CustomEvent('chart-click', {
        bubbles: true,
        composed: true,
        detail: {
          name: '#2 assistant',
        },
      }),
    );
    await flush(view);
    await flush(drawer);

    const panel = drawer.shadowRoot?.querySelector('.drawer-panel');
    expect(panel).not.toBeNull();
    expect(panel?.textContent).toContain('Message #2');
    expect(panel?.textContent).toContain('assistant');
    expect(panel?.textContent).toContain('claude-3-7-sonnet');
    expect(panel?.textContent).toContain('I am here to help');
  });

  it('renders the transcript, and only the transcript, for ?view=transcript', async () => {
    sessionMock.getTranscriptPages.mockResolvedValue(transcriptPageFixture({ nextCursor: '2' }));
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

    // The Evidence section is gone: no evidence rows, no Evidence/Transcript
    // tabs, and no second fetch of the evidence page.
    expect(root.querySelector('session-evidence-evidence')).toBeNull();
    expect(root.textContent).not.toContain('Evidence');
    expect(root.querySelector('a.back-link[href="#/"]')).not.toBeNull();

    // Paging the transcript keeps the view parameter and advances the cursor.
    const nextButton = transcriptEl?.shadowRoot?.querySelector(
      'button:not(:disabled)',
    ) as HTMLButtonElement | null;
    expect(nextButton?.textContent?.trim()).toBe('Next');
    nextButton?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(window.location.hash).toContain('view=transcript');
    expect(window.location.hash).toContain('cursor=2');
  });

  it('resolves deleted/superseded evidence to a tombstone', async () => {
    sessionMock.getTranscriptPages.mockResolvedValue({
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
    window.location.hash = '#/sessions/s1?view=transcript';
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
    const transcriptEl = root.querySelector('session-evidence-transcript') as LitElement | null;
    const transcriptText = transcriptEl?.shadowRoot?.textContent ?? '';
    expect(transcriptText).toContain('no longer available');
  });

  it('shows loading and empty states', async () => {
    sessionMock.getSummary.mockResolvedValue(summaryFixture({ headlineMetrics: [] }));
    sessionMock.getComponentFacts.mockResolvedValue({
      items: [],
      generationToken: 'gen-1',
      analysisReleaseToken: 'rel-1',
    });
    window.location.hash = '#/sessions/s1?view=transcript';
    sessionMock.getValidationSummary.mockResolvedValue(validationFixture({ validations: [] }));
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
    const transcriptEl = root.querySelector('session-evidence-transcript') as LitElement | null;
    const transcriptText = transcriptEl?.shadowRoot?.textContent ?? '';
    expect(transcriptText).toContain('No transcript messages');
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
    // The "Component" column renders the `kind/nativeId` label, never the raw
    // canonical id (.agents/rules/never-display-raw-ids.md).
    const cells = rows.map((row) => row.querySelectorAll('td')[1]?.textContent?.trim());
    expect(cells).toContain('skill/add-e2e-test');
    expect(cells.some((cell) => cell?.startsWith('comp-'))).toBe(false);
  });

  it('renames the session from the header and shows the new title', async () => {
    const view = Object.assign(document.createElement('session-evidence-view'), {
      sessionId: 's1',
    }) as SessionEvidenceView;
    await mount(view);
    const root = view.shadowRoot as ShadowRoot;

    const editBtn = root.querySelector('.edit-title-btn') as HTMLButtonElement;
    expect(editBtn).not.toBeNull();
    editBtn.click();
    await flush(view);

    const input = root.querySelector('.title-edit-row input') as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.value).toBe('Quarterly report analysis');

    input.value = 'Renamed session';
    input.dispatchEvent(new Event('input'));
    await flush(view);

    (root.querySelector('.title-save') as HTMLButtonElement).click();
    await flush(view);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await flush(view);

    expect(mockSetSessionTitle).toHaveBeenCalledWith('s1', 'Renamed session');
    expect(root.querySelector('h1')?.textContent).toContain('Renamed session');
  });

  it('surfaces rename failures without leaving edit mode', async () => {
    mockSetSessionTitle.mockRejectedValue(new Error('rename failed'));
    const view = Object.assign(document.createElement('session-evidence-view'), {
      sessionId: 's1',
    }) as SessionEvidenceView;
    await mount(view);
    const root = view.shadowRoot as ShadowRoot;

    (root.querySelector('.edit-title-btn') as HTMLButtonElement).click();
    await flush(view);

    const input = root.querySelector('.title-edit-row input') as HTMLInputElement;
    input.value = 'New title';
    input.dispatchEvent(new Event('input'));
    await flush(view);

    (root.querySelector('.title-save') as HTMLButtonElement).click();
    await flush(view);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await flush(view);

    expect(root.querySelector('.title-edit-error')?.textContent).toContain('rename failed');
    expect(root.querySelector('.title-edit-row input')).not.toBeNull();
  });

  it('shows an error when the data source fails', async () => {
    sessionMock.getSummary.mockRejectedValue(new Error('summary failed'));
    sessionMock.getContextTimingSeries.mockRejectedValue(new Error('timing failed'));
    sessionMock.getComponentFacts.mockRejectedValue(new Error('components failed'));
    sessionMock.getValidationSummary.mockRejectedValue(new Error('validation failed'));
    sessionMock.getTranscriptPages.mockRejectedValue(new Error('transcript failed'));
    sessionMock.getUtilizationReport.mockRejectedValue(new Error('utilization failed'));

    const view = Object.assign(document.createElement('session-evidence-view'), {
      sessionId: 's1',
    }) as SessionEvidenceView;
    await mount(view);
    const root = view.shadowRoot as ShadowRoot;

    expect(root.textContent).toContain('summary failed');
    expect(root.textContent).toContain('Session evidence failed to load');
  });
});
