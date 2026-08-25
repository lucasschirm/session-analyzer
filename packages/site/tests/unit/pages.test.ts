import type { LitElement } from 'lit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbClient } from '../../src/db/db-client';
import '../../src/pages/home-page';
import '../../src/pages/portfolio/portfolio-view';
import '../../src/pages/project-behavior/project-behavior-view';
import '../../src/pages/project-view';
import '../../src/pages/session-dashboard';
import '../../src/pages/session-evidence/session-evidence-view';
import '../../src/pages/indicator-details';
import '../../src/pages/session-transcript-page';
import type { AnalyticsToken } from '@lucasschirm/sal-db';
import type { HomePage } from '../../src/pages/home-page';
import type { IndicatorDetails } from '../../src/pages/indicator-details';
import type { PortfolioView } from '../../src/pages/portfolio/portfolio-view';
import type { ProjectBehaviorPage } from '../../src/pages/project-behavior/project-behavior-view';
import type { ProjectView } from '../../src/pages/project-view';
import type { SessionDashboard } from '../../src/pages/session-dashboard';

import type { SessionTranscriptPage } from '../../src/pages/session-transcript-page';
import { isUnlocked } from '../../src/sync/credential-crypto';
import { syncManager } from '../../src/sync/sync-manager';
import type { DashboardSession, Project, SessionMetrics } from '../../src/types';

const credentialCryptoMock = vi.hoisted(() => ({
  isUnlocked: vi.fn(),
  unlock: vi.fn().mockResolvedValue(true),
  lock: vi.fn(),
  createPasskey: vi.fn().mockResolvedValue(undefined),
  forgetPasskey: vi.fn().mockResolvedValue(undefined),
  encryptField: vi.fn().mockResolvedValue({ iv: '', ct: '' }),
  decryptField: vi.fn().mockResolvedValue(''),
  isWebAuthnPrfSupported: vi.fn().mockResolvedValue(false),
  hasDeviceUnlockCredential: vi.fn().mockResolvedValue(false),
  createWebAuthnCredentialAndWrapKey: vi.fn().mockResolvedValue(false),
  unlockWithWebAuthnDevice: vi.fn().mockResolvedValue(false),
}));

vi.mock('../../src/sync/credential-crypto', () => credentialCryptoMock);

const portfolioMock = vi.hoisted(() => ({
  getOverview: vi.fn(),
  getTrends: vi.fn(),
  getComponentUtilization: vi.fn(),
  getModelHarnessCohorts: vi.fn(),
  getProjectList: vi.fn(),
}));

const projectMock = vi.hoisted(() => ({
  getSummary: vi.fn(),
  getSessionTrendSeries: vi.fn(),
  getConfigurationTimeline: vi.fn(),
  getOutliers: vi.fn(),
  getComparisons: vi.fn(),
}));

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
  analyticsClient: {
    portfolio: portfolioMock,
    project: projectMock,
    session: sessionMock,
    search: searchMock,
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
  // Allow async lifecycle handlers (connectedCallback / willUpdate loads)
  // and nested child element render cycles to settle.
  await flush(element);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await flush(element);
  await flush(element);
  return element;
}

beforeEach(() => {
  vi.mocked(isUnlocked).mockReturnValue(true);
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Reads the rendered text of a Lit child element's shadow root. */
function childText(parent: ShadowRoot, selector: string): string {
  const child = parent.querySelector(selector) as LitElement | null;
  expect(child).not.toBeNull();
  return (child?.shadowRoot?.textContent ?? '') as string;
}

function allChildTexts(parent: ShadowRoot, selector: string): string[] {
  return Array.from(parent.querySelectorAll(selector)).map(
    (child) => ((child as LitElement).shadowRoot?.textContent ?? '') as string,
  );
}

function projectFixture(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: 'Project One',
    description: 'First project',
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_000,
    session_count: 1,
    ...overrides,
  };
}

function sessionFixture(overrides: Partial<DashboardSession> = {}): DashboardSession {
  return {
    id: 's1',
    project_id: 'p1',
    source: 'claude',
    title: 'fixture.jsonl',
    started_at: 1_700_000_000_000,
    ended_at: 1_700_000_600_000,
    input_tokens: 100,
    output_tokens: 50,
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
    total_tokens: 150,
    models: [],
    context_compactions: 1,
    total_turns: 4,
    files_read: 2,
    files_written: 1,
    agent_invocations: 1,
    tool_executions: [
      {
        id: 't1',
        session_id: 's1',
        timestamp: 1_700_000_010_000,
        tool_name: 'read_file',
        tool_type: 'tool_use',
        target: 'src/a.ts',
        success: true,
      },
      {
        id: 't2',
        session_id: 's1',
        timestamp: 1_700_000_020_000,
        tool_name: 'file_write',
        tool_type: 'tool_use',
        target: 'src/b.ts',
        success: true,
      },
      {
        id: 't3',
        session_id: 's1',
        timestamp: 1_700_000_030_000,
        tool_name: 'read_file',
        tool_type: 'tool_use',
        target: 'src/c.ts',
        success: true,
      },
      {
        id: 't4',
        session_id: 's1',
        timestamp: 1_700_000_040_000,
        tool_name: 'dispatch_agent',
        tool_type: 'tool_use',
        success: true,
      },
    ],
    events: [
      {
        id: 'e1',
        session_id: 's1',
        timestamp: 1_700_000_005_000,
        event_type: 'context_compaction',
        description: 'Context compaction: 15000 tokens saved',
        metadata: { tokens_saved: 15000 },
      },
    ],
    messages: [
      {
        id: 'm1',
        session_id: 's1',
        role: 'user',
        content: 'Fix the bug',
        timestamp: 1_700_000_001_000,
      },
      {
        id: 'm2',
        session_id: 's1',
        role: 'assistant',
        content: 'Fixed it.',
        timestamp: 1_700_000_002_000,
      },
    ],
    tasks: [],
    subagents: [],
    ...overrides,
  };
}

const metricsFixture: SessionMetrics = {
  total_sessions: 1,
  total_input_tokens: 100,
  total_output_tokens: 50,
  total_cache_creation_tokens: 0,
  total_cache_read_tokens: 0,
  total_tokens: 150,
  total_cost_usd: 0,
  total_tool_executions: 4,
  avg_session_duration_ms: 60_000,
  models_used: ['claude'],
};

describe('home-page', () => {
  it('lists projects from the database', async () => {
    vi.spyOn(dbClient, 'ensureReady').mockResolvedValue('memory');
    vi.spyOn(dbClient, 'getProjects').mockResolvedValue([
      projectFixture(),
      projectFixture({ id: 'p2', name: 'Project Two', description: '', session_count: 0 }),
    ]);

    const page = await mount(document.createElement('home-page') as HomePage);
    const root = page.shadowRoot as ShadowRoot;

    expect(root.textContent).toContain('Project One');
    expect(root.textContent).toContain('First project');
    expect(root.textContent).toContain('Project Two');
    expect(root.textContent).toContain('No description');
    expect(root.querySelectorAll('.project-card').length).toBe(2);
  });

  it('shows an empty state without projects', async () => {
    vi.spyOn(dbClient, 'getProjects').mockResolvedValue([]);

    const page = await mount(document.createElement('home-page') as HomePage);
    expect((page.shadowRoot as ShadowRoot).textContent).toContain('No projects yet');
  });

  it('navigates using readable_id when a project card is clicked', async () => {
    vi.spyOn(dbClient, 'ensureReady').mockResolvedValue('memory');
    vi.spyOn(dbClient, 'getProjects').mockResolvedValue([
      projectFixture({ id: 'internal-123', readable_id: 'my-cool-project' }),
    ]);

    const page = await mount(document.createElement('home-page') as HomePage);
    const root = page.shadowRoot as ShadowRoot;
    const card = root.querySelector('.project-card') as HTMLElement;
    card.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(window.location.hash).toBe('#/projects/my-cool-project');
  });

  it('falls back to internal id when readable_id is missing', async () => {
    vi.spyOn(dbClient, 'ensureReady').mockResolvedValue('memory');
    vi.spyOn(dbClient, 'getProjects').mockResolvedValue([
      projectFixture({ id: 'internal-456', readable_id: undefined }),
    ]);

    const page = await mount(document.createElement('home-page') as HomePage);
    const root = page.shadowRoot as ShadowRoot;
    const card = root.querySelector('.project-card') as HTMLElement;
    card.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(window.location.hash).toBe('#/projects/internal-456');
  });

  it('opens the modal and creates a project', async () => {
    vi.spyOn(dbClient, 'ensureReady').mockResolvedValue('memory');
    const getProjects = vi.spyOn(dbClient, 'getProjects').mockResolvedValue([]);
    const createProject = vi.spyOn(dbClient, 'createProject').mockResolvedValue();

    const page = await mount(document.createElement('home-page') as HomePage);
    const root = page.shadowRoot as ShadowRoot;

    const newButton = Array.from(root.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('+ New Project'),
    );
    newButton?.click();
    await page.updateComplete;

    const modal = root.querySelector('project-modal');
    expect(modal).not.toBeNull();

    modal?.dispatchEvent(
      new CustomEvent('project-create', {
        detail: { name: 'Created', description: 'From modal' },
        bubbles: true,
        composed: true,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(createProject).toHaveBeenCalledTimes(1);
    const created = createProject.mock.calls[0][0];
    expect(created.name).toBe('Created');
    expect(created.description).toBe('From modal');
    expect(getProjects).toHaveBeenCalledTimes(3); // initial + modal local ids + refresh
  });

  it('deletes a project after confirmation', async () => {
    vi.spyOn(dbClient, 'ensureReady').mockResolvedValue('memory');
    vi.spyOn(dbClient, 'getProjects').mockResolvedValue([projectFixture()]);
    const deleteProject = vi.spyOn(dbClient, 'deleteProject').mockResolvedValue();
    // happy-dom has no window.confirm implementation.
    vi.stubGlobal(
      'confirm',
      vi.fn(() => true),
    );

    const page = await mount(document.createElement('home-page') as HomePage);
    const root = page.shadowRoot as ShadowRoot;

    (root.querySelector('.delete-button') as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(deleteProject).toHaveBeenCalledWith('p1');
  });

  it('does not delete when the confirmation is dismissed', async () => {
    vi.spyOn(dbClient, 'ensureReady').mockResolvedValue('memory');
    vi.spyOn(dbClient, 'getProjects').mockResolvedValue([projectFixture()]);
    const deleteProject = vi.spyOn(dbClient, 'deleteProject').mockResolvedValue();
    vi.stubGlobal(
      'confirm',
      vi.fn(() => false),
    );

    const page = await mount(document.createElement('home-page') as HomePage);
    ((page.shadowRoot as ShadowRoot).querySelector('.delete-button') as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(deleteProject).not.toHaveBeenCalled();
  });

  it('exports the database', async () => {
    vi.spyOn(dbClient, 'getProjects').mockResolvedValue([]);
    const exportAndDownload = vi.spyOn(dbClient, 'exportAndDownload').mockResolvedValue();

    const page = await mount(document.createElement('home-page') as HomePage);
    const root = page.shadowRoot as ShadowRoot;

    const exportButton = Array.from(root.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Export Database'),
    );
    exportButton?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(exportAndDownload).toHaveBeenCalled();
  });

  it('reloads projects when new sessions appear during a sync run', async () => {
    vi.spyOn(dbClient, 'ensureReady').mockResolvedValue('memory');
    const getProjects = vi
      .spyOn(dbClient, 'getProjects')
      .mockResolvedValue([projectFixture({ session_count: 0 })]);

    // Initial snapshot: no sessions yet
    vi.spyOn(syncManager, 'getSnapshot').mockReturnValue({
      initialized: true,
      readOnly: false,
      activeRun: { connectionId: 'c1', state: 'running', warnings: [], startedAt: 1 },
      projects: [
        {
          projectId: 'proj1',
          localProjectId: 'p1',
          status: 'running',
          totalSessions: 0,
          sessionsDone: 0,
          sessionsFailed: 0,
          filesFound: 0,
          filesDownloaded: 0,
          filesFailed: 0,
          bytesReceived: 0,
        },
      ],
      sessions: [],
      queuedRuns: [],
      warnings: [],
    });

    const page = await mount(document.createElement('home-page') as HomePage);
    expect(getProjects).toHaveBeenCalledTimes(1);

    // Simulate a sync change event with a new session discovered
    getProjects.mockResolvedValue([projectFixture({ session_count: 1 })]);
    vi.spyOn(syncManager, 'getSnapshot').mockReturnValue({
      initialized: true,
      readOnly: false,
      activeRun: { connectionId: 'c1', state: 'running', warnings: [], startedAt: 1 },
      projects: [
        {
          projectId: 'proj1',
          localProjectId: 'p1',
          status: 'running',
          totalSessions: 1,
          sessionsDone: 0,
          sessionsFailed: 0,
          filesFound: 0,
          filesDownloaded: 0,
          filesFailed: 0,
          bytesReceived: 0,
        },
      ],
      sessions: [
        {
          projectId: 'proj1',
          sessionId: 's1',
          status: 'pending',
          filesFound: 0,
          filesDownloaded: 0,
          filesFailed: 0,
          bytesReceived: 0,
        },
      ],
      queuedRuns: [],
      warnings: [],
    });
    syncManager.dispatchEvent(new CustomEvent('change', { detail: syncManager.getSnapshot() }));

    await flush(page);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await flush(page);

    // getProjects should have been called again to pick up the updated session_count
    expect(getProjects.mock.calls.length).toBeGreaterThan(1);
    const root = page.shadowRoot as ShadowRoot;
    expect(root.textContent).toContain('1 session');
  });
});

describe('project-view', () => {
  function stubProjectLoad() {
    vi.spyOn(dbClient, 'ensureReady').mockResolvedValue('memory');
    vi.spyOn(dbClient, 'getProjectByReadableId').mockResolvedValue(projectFixture());
    vi.spyOn(dbClient, 'getProject').mockResolvedValue(projectFixture());
    vi.spyOn(dbClient, 'getSessionsByProject').mockResolvedValue([sessionFixture()]);
    vi.spyOn(dbClient, 'getProjectMetrics').mockResolvedValue(metricsFixture);
  }

  it('loads project, metrics and sessions', async () => {
    stubProjectLoad();

    const view = Object.assign(document.createElement('project-view'), {
      projectId: 'p1',
    }) as ProjectView;
    await mount(view);
    const root = view.shadowRoot as ShadowRoot;

    expect(root.textContent).toContain('Project One');
    expect(root.textContent).toContain('First project');
    expect(root.querySelector('upload-zone')).not.toBeNull();
    // Session rows live inside session-list's shadow DOM.
    expect(childText(root, 'session-list')).toContain('fixture.jsonl');
    // Metric values live inside metrics-card shadow DOMs.
    expect(allChildTexts(root, 'metrics-card').join(' ')).toContain('150');
  });

  it('resolves the route param via readable_id first, then falls back to internal id', async () => {
    vi.spyOn(dbClient, 'ensureReady').mockResolvedValue('memory');
    const getByReadable = vi
      .spyOn(dbClient, 'getProjectByReadableId')
      .mockResolvedValue(projectFixture({ readable_id: 'my-slug' }));
    const getById = vi.spyOn(dbClient, 'getProject').mockResolvedValue(null);
    vi.spyOn(dbClient, 'getSessionsByProject').mockResolvedValue([sessionFixture()]);
    vi.spyOn(dbClient, 'getProjectMetrics').mockResolvedValue(metricsFixture);

    const view = Object.assign(document.createElement('project-view'), {
      projectId: 'my-slug',
    }) as ProjectView;
    await mount(view);

    expect(getByReadable).toHaveBeenCalledWith('my-slug');
    expect(getById).not.toHaveBeenCalled();
    expect((view.shadowRoot as ShadowRoot).textContent).toContain('Project One');
  });

  it('falls back to internal id lookup when readable_id lookup fails', async () => {
    vi.spyOn(dbClient, 'ensureReady').mockResolvedValue('memory');
    vi.spyOn(dbClient, 'getProjectByReadableId').mockResolvedValue(null);
    const getById = vi
      .spyOn(dbClient, 'getProject')
      .mockResolvedValue(projectFixture({ id: 'old-id', readable_id: undefined }));
    vi.spyOn(dbClient, 'getSessionsByProject').mockResolvedValue([sessionFixture()]);
    vi.spyOn(dbClient, 'getProjectMetrics').mockResolvedValue(metricsFixture);

    const view = Object.assign(document.createElement('project-view'), {
      projectId: 'old-id',
    }) as ProjectView;
    await mount(view);

    expect(getById).toHaveBeenCalledWith('old-id');
    expect((view.shadowRoot as ShadowRoot).textContent).toContain('Project One');
  });

  it('shows a not-found notice for unknown projects', async () => {
    vi.spyOn(dbClient, 'ensureReady').mockResolvedValue('memory');
    vi.spyOn(dbClient, 'getProjectByReadableId').mockResolvedValue(null);
    vi.spyOn(dbClient, 'getProject').mockResolvedValue(null);

    const view = Object.assign(document.createElement('project-view'), {
      projectId: 'missing',
    }) as ProjectView;
    await mount(view);

    expect((view.shadowRoot as ShadowRoot).textContent).toContain('Project not found');
  });

  it('filters sessions through the search bar', async () => {
    stubProjectLoad();
    const searchSessions = vi
      .spyOn(dbClient, 'searchSessions')
      .mockResolvedValue([sessionFixture({ title: 'matched.jsonl' })]);

    const view = Object.assign(document.createElement('project-view'), {
      projectId: 'p1',
    }) as ProjectView;
    await mount(view);
    const root = view.shadowRoot as ShadowRoot;

    const searchInput = root.querySelector('.search-input') as HTMLInputElement;
    searchInput.value = 'match';
    searchInput.dispatchEvent(new Event('input'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await flush(view);

    expect(searchSessions).toHaveBeenCalledWith(
      'p1',
      'match',
      expect.any(Number),
      expect.any(Number),
    );
    expect(childText(root, 'session-list')).toContain('matched.jsonl');
  });

  it('resets to the full list when the search is cleared', async () => {
    stubProjectLoad();
    const getSessionsByProject = vi
      .spyOn(dbClient, 'getSessionsByProject')
      .mockResolvedValue([sessionFixture()]);

    const view = Object.assign(document.createElement('project-view'), {
      projectId: 'p1',
    }) as ProjectView;
    await mount(view);
    const root = view.shadowRoot as ShadowRoot;

    const searchInput = root.querySelector('.search-input') as HTMLInputElement;
    searchInput.value = '   ';
    searchInput.dispatchEvent(new Event('input'));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(getSessionsByProject).toHaveBeenCalledTimes(2); // initial + reset
  });
});

describe('session-dashboard', () => {
  it('renders metric cards from the session', async () => {
    vi.spyOn(dbClient, 'getSession').mockResolvedValue(sessionFixture());

    const dashboard = Object.assign(document.createElement('session-dashboard'), {
      sessionId: 's1',
    }) as SessionDashboard;
    await mount(dashboard);
    const root = dashboard.shadowRoot as ShadowRoot;

    expect(root.textContent).toContain('fixture.jsonl');
    // Metric card content lives inside each card's shadow DOM.
    const cardTexts = allChildTexts(root, 'metrics-card').join(' | ');
    expect(cardTexts).toContain('150'); // total tokens
    expect(cardTexts).toContain('↑ 100 in • ↓ 50 out');
    expect(cardTexts).toContain('most used: read_file (×2)');
    expect(root.querySelectorAll('metrics-card').length).toBe(8);
  });

  it('does not show task metric cards when the session has no tracked tasks', async () => {
    vi.spyOn(dbClient, 'getSession').mockResolvedValue(sessionFixture());

    const dashboard = Object.assign(document.createElement('session-dashboard'), {
      sessionId: 's1',
    }) as SessionDashboard;
    await mount(dashboard);
    const root = dashboard.shadowRoot as ShadowRoot;

    const cardLabels = Array.from(root.querySelectorAll('metrics-card')).map(
      (card) => (card as HTMLElement & { label: string }).label,
    );
    expect(cardLabels).not.toContain('Total Tasks');
  });

  it('shows Total Tasks, Tasks Completed and Avg Time / Task cards when the session tracked tasks', async () => {
    vi.spyOn(dbClient, 'getSession').mockResolvedValue(
      sessionFixture({
        tasks: [
          {
            id: '1',
            subject: 'Write parser',
            description: 'Parse the format',
            status: 'completed',
            first_seen_at: 1_700_000_000_000,
            completed_at: 1_700_000_060_000, // 60s
          },
          {
            id: '2',
            subject: 'Write tests',
            description: 'Cover the parser',
            status: 'completed',
            first_seen_at: 1_700_000_000_000,
            completed_at: 1_700_000_120_000, // 120s -> avg with above = 90s
          },
          {
            id: '3',
            subject: 'Ship it',
            description: 'Merge and deploy',
            status: 'pending',
            first_seen_at: 1_700_000_000_000,
          },
        ],
      }),
    );

    const dashboard = Object.assign(document.createElement('session-dashboard'), {
      sessionId: 's1',
    }) as SessionDashboard;
    await mount(dashboard);
    const root = dashboard.shadowRoot as ShadowRoot;

    expect(root.querySelectorAll('metrics-card').length).toBe(11);
    const cardTexts = allChildTexts(root, 'metrics-card').join(' | ');
    expect(cardTexts).toContain('Total Tasks');
    expect(cardTexts).toContain('Tasks Completed');
    expect(cardTexts).toContain('of 3 total');
    expect(cardTexts).toContain('Avg Time / Task');
    expect(cardTexts).toContain('1m 30s');
  });

  it('does not show a Subagents panel when the session has none', async () => {
    vi.spyOn(dbClient, 'getSession').mockResolvedValue(sessionFixture());

    const dashboard = Object.assign(document.createElement('session-dashboard'), {
      sessionId: 's1',
    }) as SessionDashboard;
    await mount(dashboard);

    expect((dashboard.shadowRoot as ShadowRoot).textContent).not.toContain('Subagents');
  });

  it('does not show a Tool Result Tokens panel when no tool execution has a result', async () => {
    vi.spyOn(dbClient, 'getSession').mockResolvedValue(sessionFixture());

    const dashboard = Object.assign(document.createElement('session-dashboard'), {
      sessionId: 's1',
    }) as SessionDashboard;
    await mount(dashboard);

    expect((dashboard.shadowRoot as ShadowRoot).textContent).not.toContain('Tool Result Tokens');
  });

  it('shows an estimated tool-result token breakdown, labeled as an estimate', async () => {
    vi.spyOn(dbClient, 'getSession').mockResolvedValue(
      sessionFixture({
        input_tokens: 100,
        cache_creation_tokens: 0,
        cache_read_tokens: 0,
        tool_executions: [
          {
            id: 't1',
            session_id: 's1',
            timestamp: 1_700_000_010_000,
            tool_name: 'read_file',
            tool_type: 'tool_use',
            target: 'src/a.ts',
            success: true,
            result: 'a'.repeat(40), // ceil(40/4) = 10 estimated tokens
          },
          {
            id: 't2',
            session_id: 's1',
            timestamp: 1_700_000_020_000,
            tool_name: 'grep',
            tool_type: 'tool_use',
            success: true,
            result: 'a'.repeat(20), // ceil(20/4) = 5 estimated tokens
          },
        ],
      }),
    );

    const dashboard = Object.assign(document.createElement('session-dashboard'), {
      sessionId: 's1',
    }) as SessionDashboard;
    await mount(dashboard);
    const root = dashboard.shadowRoot as ShadowRoot;

    expect(root.textContent).toContain('Tool Result Tokens');
    // 10 + 5 = 15 estimated tokens, out of 100 input-volume tokens -> 15.0%.
    expect(root.textContent).toContain('15');
    expect(root.textContent).toContain('15.0%');
    expect(root.textContent).toContain('(est.)');
  });

  it('shows a Subagents breakdown panel with description, type, model and token totals', async () => {
    vi.spyOn(dbClient, 'getSession').mockResolvedValue(
      sessionFixture({
        subagents: [
          {
            agent_id: 'agent-1',
            agent_type: 'general-purpose',
            description: 'Update AGENTS.md',
            model: 'claude-haiku-4-5',
            input_tokens: 5,
            output_tokens: 10,
            cache_creation_tokens: 2,
            cache_read_tokens: 1,
            total_tokens: 18,
            tool_call_count: 3,
          },
        ],
      }),
    );

    const dashboard = Object.assign(document.createElement('session-dashboard'), {
      sessionId: 's1',
    }) as SessionDashboard;
    await mount(dashboard);
    const root = dashboard.shadowRoot as ShadowRoot;

    expect(root.textContent).toContain('Subagents');
    expect(root.textContent).toContain('Update AGENTS.md');
    expect(root.textContent).toContain('general-purpose');
    expect(root.textContent).toContain('claude-haiku-4-5');
  });

  it('groups the Skills Used panel by skill name with a total usage count', async () => {
    vi.spyOn(dbClient, 'getSession').mockResolvedValue(
      sessionFixture({
        tool_executions: [
          {
            id: 'skill-1',
            session_id: 's1',
            timestamp: 1_700_000_010_000,
            tool_name: 'Skill',
            tool_type: 'tool_use',
            success: true,
            parameters: { skill: 'code-review', target: 'a.ts' },
          },
          {
            id: 'skill-2',
            session_id: 's1',
            timestamp: 1_700_000_020_000,
            tool_name: 'Skill',
            tool_type: 'tool_use',
            success: true,
            parameters: { skill: 'code-review', target: 'b.ts' },
          },
          {
            id: 'agent-1',
            session_id: 's1',
            timestamp: 1_700_000_030_000,
            tool_name: 'Agent',
            tool_type: 'tool_use',
            success: true,
          },
        ],
      }),
    );

    const dashboard = Object.assign(document.createElement('session-dashboard'), {
      sessionId: 's1',
    }) as SessionDashboard;
    await mount(dashboard);
    const root = dashboard.shadowRoot as ShadowRoot;

    // Only the Skill group is shown; Agent invocations are excluded from Skills Used.
    expect(root.querySelectorAll('.skill-item').length).toBe(1);

    const skillGroup = Array.from(root.querySelectorAll('.skill-item')).find((item) =>
      item.textContent?.includes('Skill'),
    );
    if (!skillGroup) throw new Error('Skill group item not found');
    expect(skillGroup.querySelector('.skill-usage')?.textContent).toContain('Total usage: 2');
    expect(skillGroup.querySelectorAll('.skill-params').length).toBe(2);

    expect(
      Array.from(root.querySelectorAll('.skill-item')).some((item) =>
        item.textContent?.includes('Agent'),
      ),
    ).toBe(false);
  });

  it('renders an upload-zone for attaching a session data folder', async () => {
    vi.spyOn(dbClient, 'getSession').mockResolvedValue(sessionFixture());

    const dashboard = Object.assign(document.createElement('session-dashboard'), {
      sessionId: 's1',
    }) as SessionDashboard;
    await mount(dashboard);

    expect((dashboard.shadowRoot as ShadowRoot).querySelector('upload-zone')).not.toBeNull();
  });

  it('shows an error for missing sessions', async () => {
    vi.spyOn(dbClient, 'getSession').mockResolvedValue(null);

    const dashboard = Object.assign(document.createElement('session-dashboard'), {
      sessionId: 'nope',
    }) as SessionDashboard;
    await mount(dashboard);

    expect((dashboard.shadowRoot as ShadowRoot).textContent).toContain('Session not found');
  });

  it('links to the dedicated Session Transcript page instead of expanding inline', async () => {
    vi.spyOn(dbClient, 'getSession').mockResolvedValue(sessionFixture());

    const dashboard = Object.assign(document.createElement('session-dashboard'), {
      sessionId: 's1',
    }) as SessionDashboard;
    await mount(dashboard);
    const root = dashboard.shadowRoot as ShadowRoot;

    expect(root.querySelector('session-transcript')).toBeNull();

    const link = root.querySelector('a.transcript-link') as HTMLAnchorElement | null;
    expect(link).not.toBeNull();
    expect(link?.textContent).toContain('View Session Transcript');
    expect(link?.getAttribute('href')).toBe('#/sessions/s1/transcript');
  });

  it('routes metric card clicks to indicator pages', async () => {
    vi.spyOn(dbClient, 'getSession').mockResolvedValue(sessionFixture());

    const dashboard = Object.assign(document.createElement('session-dashboard'), {
      sessionId: 's1',
    }) as SessionDashboard;
    await mount(dashboard);
    const root = dashboard.shadowRoot as ShadowRoot;

    const cards = root.querySelectorAll('metrics-card');
    const filesWrittenCard = Array.from(cards).find(
      (card) => (card as HTMLElement & { label: string }).label === 'Files Written',
    );
    filesWrittenCard?.dispatchEvent(
      new CustomEvent('card-click', {
        detail: { label: 'Files Written' },
        bubbles: true,
        composed: true,
      }),
    );

    expect(window.location.hash).toBe('#/sessions/s1/indicator/files_written');
  });

  it('retries a failed sync from the header when unlocked', async () => {
    vi.spyOn(dbClient, 'getSession').mockResolvedValue(
      sessionFixture({
        sync_status: 'failed',
        sync_details: 'MANIFEST_DOWNLOAD_ERROR: missing file',
        sync_session_id: 'sync-s1',
      }),
    );
    vi.spyOn(dbClient, 'getProject').mockResolvedValue(
      projectFixture({
        readable_id: 'proj1',
        connection_id: 'conn1',
      }),
    );
    const retrySession = vi.spyOn(syncManager, 'retrySession').mockResolvedValue(undefined);

    const dashboard = Object.assign(document.createElement('session-dashboard'), {
      sessionId: 's1',
    }) as SessionDashboard;
    await mount(dashboard);
    const root = dashboard.shadowRoot as ShadowRoot;

    const retryButton = Array.from(root.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Retry sync'),
    );
    expect(retryButton).not.toBeUndefined();
    retryButton?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(retrySession).toHaveBeenCalledWith('conn1', 'proj1', 'sync-s1');
  });

  it('opens the passkey modal for retry when locked and retries after unlock', async () => {
    vi.spyOn(dbClient, 'getSession').mockResolvedValue(
      sessionFixture({
        sync_status: 'failed',
        sync_details: 'MANIFEST_DOWNLOAD_ERROR: missing file',
        sync_session_id: 'sync-s1',
      }),
    );
    vi.spyOn(dbClient, 'getProject').mockResolvedValue(
      projectFixture({
        readable_id: 'proj1',
        connection_id: 'conn1',
      }),
    );
    const retrySession = vi.spyOn(syncManager, 'retrySession').mockResolvedValue(undefined);
    vi.mocked(isUnlocked).mockReturnValue(false);

    const dashboard = Object.assign(document.createElement('session-dashboard'), {
      sessionId: 's1',
    }) as SessionDashboard;
    await mount(dashboard);
    const root = dashboard.shadowRoot as ShadowRoot;

    const retryButton = Array.from(root.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Retry sync'),
    );
    retryButton?.click();
    await dashboard.updateComplete;

    const passkeyModal = root.querySelector('passkey-modal') as LitElement | null;
    expect(passkeyModal).not.toBeNull();
    expect((passkeyModal as unknown as { open: boolean }).open).toBe(true);
    expect(retrySession).not.toHaveBeenCalled();

    vi.mocked(isUnlocked).mockReturnValue(true);
    passkeyModal?.dispatchEvent(
      new CustomEvent('passkey-unlocked', { bubbles: true, composed: true }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(retrySession).toHaveBeenCalledWith('conn1', 'proj1', 'sync-s1');
  });

  it('hides the retry button for MANIFEST_UNSUPPORTED_SCHEMA', async () => {
    vi.spyOn(dbClient, 'getSession').mockResolvedValue(
      sessionFixture({
        sync_status: 'failed',
        sync_details: 'MANIFEST_UNSUPPORTED_SCHEMA: schema version not supported',
        sync_session_id: 'sync-s1',
      }),
    );
    vi.spyOn(dbClient, 'getProject').mockResolvedValue(
      projectFixture({
        readable_id: 'proj1',
        connection_id: 'conn1',
      }),
    );

    const dashboard = Object.assign(document.createElement('session-dashboard'), {
      sessionId: 's1',
    }) as SessionDashboard;
    await mount(dashboard);
    const root = dashboard.shadowRoot as ShadowRoot;

    const retryButton = Array.from(root.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Retry sync'),
    );
    expect(retryButton).toBeUndefined();
  });
});

describe('indicator-details', () => {
  it('shows tool executions for the tools indicator', async () => {
    vi.spyOn(dbClient, 'getSession').mockResolvedValue(sessionFixture());

    const page = Object.assign(document.createElement('indicator-details'), {
      sessionId: 's1',
      indicator: 'tools',
    }) as IndicatorDetails;
    await mount(page);
    const root = page.shadowRoot as ShadowRoot;

    expect(root.textContent).toContain('Tool Executions');
    expect(root.textContent).toContain('4 records');
    expect(root.textContent).toContain('src/a.ts');
    expect(root.querySelectorAll('.tool-row').length).toBe(4);
  });

  it('expands a tool row on click to show its inputs and result', async () => {
    vi.spyOn(dbClient, 'getSession').mockResolvedValue(
      sessionFixture({
        tool_executions: [
          {
            id: 't1',
            session_id: 's1',
            timestamp: 1_700_000_010_000,
            tool_name: 'Bash',
            tool_type: 'tool_use',
            target: 'git status',
            success: true,
            parameters: { command: 'git status' },
            result: 'nothing to commit',
          },
        ],
      }),
    );

    const page = Object.assign(document.createElement('indicator-details'), {
      sessionId: 's1',
      indicator: 'tools',
    }) as IndicatorDetails;
    await mount(page);
    const root = page.shadowRoot as ShadowRoot;

    expect(root.querySelector('.tool-detail-row')).toBeNull();

    const row = root.querySelector('.tool-row') as HTMLElement;
    row.click();
    await page.updateComplete;

    const detail = root.querySelector('.tool-detail-row');
    expect(detail).not.toBeNull();
    expect(detail?.textContent).toContain('git status');
    expect(detail?.textContent).toContain('nothing to commit');
  });

  it('flags failed tool executions with an error badge and highlighted row', async () => {
    vi.spyOn(dbClient, 'getSession').mockResolvedValue(
      sessionFixture({
        tool_executions: [
          {
            id: 't1',
            session_id: 's1',
            timestamp: 1_700_000_010_000,
            tool_name: 'Bash',
            tool_type: 'tool_use',
            target: 'false',
            success: false,
            result: 'command failed',
          },
        ],
      }),
    );

    const page = Object.assign(document.createElement('indicator-details'), {
      sessionId: 's1',
      indicator: 'tools',
    }) as IndicatorDetails;
    await mount(page);
    const root = page.shadowRoot as ShadowRoot;

    const row = root.querySelector('.tool-row') as HTMLElement;
    expect(row.classList.contains('tool-row-error')).toBe(true);
    expect(row.textContent).toContain('Error');
  });

  it('filters tool executions by tool name, error-only, and free text (combinable)', async () => {
    vi.spyOn(dbClient, 'getSession').mockResolvedValue(
      sessionFixture({
        tool_executions: [
          {
            id: 't1',
            session_id: 's1',
            timestamp: 1_700_000_010_000,
            tool_name: 'Bash',
            tool_type: 'tool_use',
            target: 'git status',
            success: true,
            parameters: { command: 'git status' },
            result: 'clean',
          },
          {
            id: 't2',
            session_id: 's1',
            timestamp: 1_700_000_020_000,
            tool_name: 'Bash',
            tool_type: 'tool_use',
            target: 'false',
            success: false,
            parameters: { command: 'false' },
            result: 'exit code 1',
          },
          {
            id: 't3',
            session_id: 's1',
            timestamp: 1_700_000_030_000,
            tool_name: 'Read',
            tool_type: 'tool_use',
            target: 'src/app.ts',
            success: true,
            parameters: { file_path: 'src/app.ts' },
            result: 'export const x = 1;',
          },
        ],
      }),
    );

    const page = Object.assign(document.createElement('indicator-details'), {
      sessionId: 's1',
      indicator: 'tools',
    }) as IndicatorDetails;
    await mount(page);
    const root = page.shadowRoot as ShadowRoot;

    expect(root.querySelectorAll('.tool-row').length).toBe(3);

    // By tool: narrow to Bash.
    const select = root.querySelector('.tool-filters select') as HTMLSelectElement;
    select.value = 'Bash';
    select.dispatchEvent(new Event('change'));
    await page.updateComplete;
    expect(root.querySelectorAll('.tool-row').length).toBe(2);

    // Combine with errors-only: down to the failed Bash call.
    const errorCheckbox = root.querySelector('.tool-filter-checkbox input') as HTMLInputElement;
    errorCheckbox.checked = true;
    errorCheckbox.dispatchEvent(new Event('change'));
    await page.updateComplete;
    let rows = root.querySelectorAll('.tool-row');
    expect(rows.length).toBe(1);
    expect(rows[0].textContent).toContain('false');

    // Reset tool/error filters, use free text against the result content instead.
    select.value = '';
    select.dispatchEvent(new Event('change'));
    errorCheckbox.checked = false;
    errorCheckbox.dispatchEvent(new Event('change'));
    await page.updateComplete;

    const textInput = root.querySelector('.tool-filters input[type="text"]') as HTMLInputElement;
    textInput.value = 'export const';
    textInput.dispatchEvent(new Event('input'));
    await page.updateComplete;
    rows = root.querySelectorAll('.tool-row');
    expect(rows.length).toBe(1);
    expect(rows[0].textContent).toContain('src/app.ts');
  });

  it('filters files_written rows to write tools', async () => {
    vi.spyOn(dbClient, 'getSession').mockResolvedValue(sessionFixture());

    const page = Object.assign(document.createElement('indicator-details'), {
      sessionId: 's1',
      indicator: 'files_written',
    }) as IndicatorDetails;
    await mount(page);
    const root = page.shadowRoot as ShadowRoot;

    expect(root.textContent).toContain('Files Written');
    const tableText = childText(root, 'events-table');
    expect(tableText).toContain('src/b.ts');
    expect(tableText).not.toContain('src/a.ts');
  });

  it('lists transcript messages for the turns indicator', async () => {
    vi.spyOn(dbClient, 'getSession').mockResolvedValue(sessionFixture());

    const page = Object.assign(document.createElement('indicator-details'), {
      sessionId: 's1',
      indicator: 'turns',
    }) as IndicatorDetails;
    await mount(page);
    const root = page.shadowRoot as ShadowRoot;

    expect(root.textContent).toContain('Interactions (Turns)');
    expect(root.textContent).toContain('user');
    expect(root.textContent).toContain('Fix the bug');
  });

  it('explains the gap when total_turns exceeds the visible-text assistant messages shown here', async () => {
    // The fixture's total_turns (4) is higher than its one text-bearing
    // assistant message - mirrors a tool-heavy session where most assistant
    // turns only call tools and never emit a `text` block. The page should
    // surface that gap instead of leaving "4 total interactions" vs "2
    // records" looking like a bug.
    vi.spyOn(dbClient, 'getSession').mockResolvedValue(sessionFixture());

    const page = Object.assign(document.createElement('indicator-details'), {
      sessionId: 's1',
      indicator: 'turns',
    }) as IndicatorDetails;
    await mount(page);
    const root = page.shadowRoot as ShadowRoot;
    // The notice's markup wraps across several lines in the template, so
    // collapse whitespace before matching phrases that span those breaks.
    const normalized = (root.textContent ?? '').replace(/\s+/g, ' ');

    expect(normalized).toContain('1 of 4 assistant turns produced visible text');
    expect(normalized).toContain('other 3');
    expect(normalized).toContain('Tool Executions');
  });

  it('omits the tool-only-turns notice when every assistant turn has visible text', async () => {
    vi.spyOn(dbClient, 'getSession').mockResolvedValue(sessionFixture({ total_turns: 1 }));

    const page = Object.assign(document.createElement('indicator-details'), {
      sessionId: 's1',
      indicator: 'turns',
    }) as IndicatorDetails;
    await mount(page);
    const root = page.shadowRoot as ShadowRoot;

    expect(root.textContent).not.toContain('produced visible text');
  });

  it('nests a reply under its parent only when the parent uuid is present in the session', async () => {
    vi.spyOn(dbClient, 'getSession').mockResolvedValue(
      sessionFixture({
        messages: [
          {
            id: 'm1',
            session_id: 's1',
            role: 'user',
            content: 'Fix the bug',
            timestamp: 1_700_000_001_000,
            uuid: 'u1',
            parent_uuid: undefined,
          },
          {
            id: 'm2',
            session_id: 's1',
            role: 'assistant',
            content: 'Fixed it.',
            timestamp: 1_700_000_002_000,
            uuid: 'u2',
            parent_uuid: 'u1',
          },
          {
            id: 'm3',
            session_id: 's1',
            role: 'user',
            content: 'Orphaned reply',
            timestamp: 1_700_000_003_000,
            uuid: 'u3',
            parent_uuid: 'missing-uuid',
          },
        ],
      }),
    );

    const page = Object.assign(document.createElement('indicator-details'), {
      sessionId: 's1',
      indicator: 'turns',
    }) as IndicatorDetails;
    await mount(page);
    const root = page.shadowRoot as ShadowRoot;

    // The reply (parent found) nests under its parent's node.
    const rootNodes = root.querySelectorAll('.message-tree > .message-node');
    expect(rootNodes.length).toBe(2); // "Fix the bug" root + orphaned "Orphaned reply" root
    const parentNode = Array.from(rootNodes).find((node) =>
      node.textContent?.includes('Fix the bug'),
    );
    expect(parentNode?.querySelector('.message-children')?.textContent).toContain('Fixed it.');

    // The orphaned reply (parent uuid not found) stays at the top level, not nested.
    const orphanNode = Array.from(rootNodes).find((node) =>
      node.textContent?.includes('Orphaned reply'),
    );
    expect(orphanNode?.querySelector('.message-children')).toBeNull();
  });

  it('lists compaction events for the compactions indicator', async () => {
    vi.spyOn(dbClient, 'getSession').mockResolvedValue(sessionFixture());

    const page = Object.assign(document.createElement('indicator-details'), {
      sessionId: 's1',
      indicator: 'compactions',
    }) as IndicatorDetails;
    await mount(page);
    const root = page.shadowRoot as ShadowRoot;

    expect(root.textContent).toContain('Context Compactions');
    expect(childText(root, 'events-table')).toContain('15000 tokens saved');
  });

  it('lists tasks with subject, status and duration for the tasks indicator', async () => {
    vi.spyOn(dbClient, 'getSession').mockResolvedValue(
      sessionFixture({
        tasks: [
          {
            id: '1',
            subject: 'Write parser',
            description: 'Parse the format',
            status: 'completed',
            first_seen_at: 1_700_000_000_000,
            completed_at: 1_700_000_060_000,
          },
          {
            id: '2',
            subject: 'Ship it',
            description: 'Merge and deploy',
            status: 'pending',
            first_seen_at: 1_700_000_000_000,
          },
        ],
      }),
    );

    const page = Object.assign(document.createElement('indicator-details'), {
      sessionId: 's1',
      indicator: 'tasks',
    }) as IndicatorDetails;
    await mount(page);
    const root = page.shadowRoot as ShadowRoot;

    expect(root.textContent).toContain('Tasks');
    const tableText = childText(root, 'events-table');
    expect(tableText).toContain('Write parser');
    expect(tableText).toContain('completed');
    expect(tableText).toContain('Ship it');
    expect(tableText).toContain('pending');
  });

  it('falls back to a summary row for tokens without usage events', async () => {
    vi.spyOn(dbClient, 'getSession').mockResolvedValue(sessionFixture({ events: [] }));

    const page = Object.assign(document.createElement('indicator-details'), {
      sessionId: 's1',
      indicator: 'tokens',
    }) as IndicatorDetails;
    await mount(page);
    const root = page.shadowRoot as ShadowRoot;

    const tableText = childText(root, 'events-table');
    expect(tableText).toContain('summary');
    expect(tableText).toContain('150');
  });

  it('rejects unknown indicators', async () => {
    const page = Object.assign(document.createElement('indicator-details'), {
      sessionId: 's1',
      indicator: 'bogus',
    }) as IndicatorDetails;
    await mount(page);

    expect((page.shadowRoot as ShadowRoot).textContent).toContain('Unknown indicator');
  });

  it('excludes Skill and Agent tool calls from the tools indicator', async () => {
    vi.spyOn(dbClient, 'getSession').mockResolvedValue(
      sessionFixture({
        tool_executions: [
          {
            id: 't1',
            session_id: 's1',
            timestamp: 1_700_000_010_000,
            tool_name: 'Bash',
            tool_type: 'tool_use',
            target: 'ls',
            success: true,
          },
          {
            id: 't2',
            session_id: 's1',
            timestamp: 1_700_000_020_000,
            tool_name: 'Skill',
            tool_type: 'tool_use',
            success: true,
            parameters: { skill: 'code-review' },
          },
          {
            id: 't3',
            session_id: 's1',
            timestamp: 1_700_000_030_000,
            tool_name: 'Agent',
            tool_type: 'tool_use',
            success: true,
            parameters: { subagent_type: 'general-purpose' },
          },
        ],
      }),
    );

    const page = Object.assign(document.createElement('indicator-details'), {
      sessionId: 's1',
      indicator: 'tools',
    }) as IndicatorDetails;
    await mount(page);
    const root = page.shadowRoot as ShadowRoot;

    expect(root.textContent).toContain('1 record');
    const rows = root.querySelectorAll('.tool-row');
    expect(rows.length).toBe(1);
    expect(rows[0].textContent).toContain('Bash');
  });

  it('shows skill invocations for the skills indicator, with inputs, result, and linked follow-up content', async () => {
    vi.spyOn(dbClient, 'getSession').mockResolvedValue(
      sessionFixture({
        tool_executions: [
          {
            id: 't1',
            session_id: 's1',
            timestamp: 1_700_000_010_000,
            tool_name: 'Skill',
            tool_type: 'tool_use',
            success: true,
            parameters: { skill: 'code-review', args: '--effort high' },
            result: 'skill loaded',
            result_uuid: 'u1',
          },
        ],
        messages: [
          {
            id: 'm1',
            session_id: 's1',
            role: 'assistant',
            content: 'Full skill instructions here.',
            timestamp: 1_700_000_011_000,
            uuid: 'a2',
            parent_uuid: 'u1',
          },
        ],
      }),
    );

    const page = Object.assign(document.createElement('indicator-details'), {
      sessionId: 's1',
      indicator: 'skills',
    }) as IndicatorDetails;
    await mount(page);
    const root = page.shadowRoot as ShadowRoot;

    expect(root.textContent).toContain('Skill Invocations');
    expect(root.textContent).toContain('1 record');
    const row = root.querySelector('.tool-row') as HTMLElement;
    expect(row.textContent).toContain('code-review');
    expect(row.textContent).toContain('--effort high');

    row.click();
    await page.updateComplete;
    const detail = root.querySelector('.tool-detail-row');
    expect(detail?.textContent).toContain('skill loaded');
    expect(detail?.textContent).toContain('Full skill instructions here.');
  });

  it('shows agent invocations for the agents indicator, with inputs, result, and linked follow-up content', async () => {
    vi.spyOn(dbClient, 'getSession').mockResolvedValue(
      sessionFixture({
        tool_executions: [
          {
            id: 't1',
            session_id: 's1',
            timestamp: 1_700_000_010_000,
            tool_name: 'Agent',
            tool_type: 'tool_use',
            success: true,
            parameters: { subagent_type: 'general-purpose', description: 'Investigate flaky test' },
            result: 'agent dispatched',
            result_uuid: 'u1',
          },
        ],
        messages: [
          {
            id: 'm1',
            session_id: 's1',
            role: 'assistant',
            content: 'Findings summarized here.',
            timestamp: 1_700_000_011_000,
            uuid: 'a2',
            parent_uuid: 'u1',
          },
        ],
      }),
    );

    const page = Object.assign(document.createElement('indicator-details'), {
      sessionId: 's1',
      indicator: 'agents',
    }) as IndicatorDetails;
    await mount(page);
    const root = page.shadowRoot as ShadowRoot;

    expect(root.textContent).toContain('Agent Invocations');
    expect(root.textContent).toContain('1 record');
    const row = root.querySelector('.tool-row') as HTMLElement;
    expect(row.textContent).toContain('general-purpose');
    expect(row.textContent).toContain('Investigate flaky test');

    row.click();
    await page.updateComplete;
    const detail = root.querySelector('.tool-detail-row');
    expect(detail?.textContent).toContain('agent dispatched');
    expect(detail?.textContent).toContain('Findings summarized here.');
  });
});

describe('session-transcript-page', () => {
  it('shows just the main transcript column when there are no subagents', async () => {
    vi.spyOn(dbClient, 'getSession').mockResolvedValue(sessionFixture());

    const page = Object.assign(document.createElement('session-transcript-page'), {
      sessionId: 's1',
    }) as SessionTranscriptPage;
    await mount(page);
    const root = page.shadowRoot as ShadowRoot;

    expect(root.querySelector('.subagent-row')).toBeNull();
    expect(root.querySelectorAll('.transcript-column').length).toBe(1);
    // session-transcript renders into its own shadow root, so the fixture's
    // message content only shows up there, not in this page's textContent.
    expect(childText(root, 'session-transcript')).toContain('Fix the bug');

    const transcript = root.querySelector('session-transcript') as unknown as {
      messages: DashboardSession['messages'];
    };
    expect(transcript.messages).toHaveLength(2);
  });

  it('shows an error for a missing session', async () => {
    vi.spyOn(dbClient, 'getSession').mockResolvedValue(null);

    const page = Object.assign(document.createElement('session-transcript-page'), {
      sessionId: 'nope',
    }) as SessionTranscriptPage;
    await mount(page);

    expect((page.shadowRoot as ShadowRoot).textContent).toContain('Session not found');
  });

  it('renders a subagent card inline in the main transcript, linking to its split-view route', async () => {
    vi.spyOn(dbClient, 'getSession').mockResolvedValue(
      sessionFixture({
        subagents: [
          {
            agent_id: 'agent-1',
            agent_type: 'general-purpose',
            description: 'Update AGENTS.md',
            model: 'claude-haiku-4-5',
            input_tokens: 5,
            output_tokens: 10,
            cache_creation_tokens: 2,
            cache_read_tokens: 1,
            total_tokens: 18,
            tool_call_count: 3,
            messages: [
              {
                id: 'sm1',
                session_id: 'agent-1',
                role: 'user',
                content: 'Subtask prompt',
                timestamp: 1_700_000_000_500,
              },
              {
                id: 'sm2',
                session_id: 'agent-1',
                role: 'assistant',
                content: 'Subtask done.',
                timestamp: 1_700_000_000_800,
              },
            ],
          },
        ],
      }),
    );

    const page = Object.assign(document.createElement('session-transcript-page'), {
      sessionId: 's1',
    }) as SessionTranscriptPage;
    await mount(page);
    const root = page.shadowRoot as ShadowRoot;

    // Only one (full-width) column by default - no split, no agentId set.
    expect(root.querySelectorAll('.transcript-column').length).toBe(1);

    // The card is rendered inline inside the main transcript's own shadow
    // root (via session-transcript's renderAfter hook), not as a top row on
    // the page itself.
    const mainTranscript = root.querySelector('session-transcript') as LitElement;
    const card = mainTranscript.shadowRoot?.querySelector('.subagent-card') as HTMLAnchorElement;
    expect(card).not.toBeNull();
    expect(card.textContent).toContain('Update AGENTS.md');
    expect(card.getAttribute('href')).toBe('#/sessions/s1/transcript/agent-1');
    expect(card.classList.contains('active')).toBe(false);
  });

  it('splits into two columns and marks the card active when agentId matches the route', async () => {
    vi.spyOn(dbClient, 'getSession').mockResolvedValue(
      sessionFixture({
        subagents: [
          {
            agent_id: 'agent-1',
            description: 'Update AGENTS.md',
            input_tokens: 5,
            output_tokens: 10,
            cache_creation_tokens: 0,
            cache_read_tokens: 0,
            total_tokens: 15,
            tool_call_count: 1,
            messages: [
              {
                id: 'sm1',
                session_id: 'agent-1',
                role: 'assistant',
                content: 'Subtask done.',
                timestamp: 1_700_000_000_800,
              },
            ],
          },
        ],
      }),
    );

    const page = Object.assign(document.createElement('session-transcript-page'), {
      sessionId: 's1',
      agentId: 'agent-1',
    }) as SessionTranscriptPage;
    await mount(page);
    const root = page.shadowRoot as ShadowRoot;

    expect(root.querySelectorAll('.transcript-column').length).toBe(2);
    // The second transcript-column's session-transcript renders the
    // subagent's own messages, into its own shadow root.
    const subagentTranscriptTexts = allChildTexts(root, 'session-transcript');
    expect(subagentTranscriptTexts[1]).toContain('Subtask done.');

    const mainTranscript = root.querySelector('session-transcript') as LitElement;
    const card = mainTranscript.shadowRoot?.querySelector('.subagent-card') as HTMLAnchorElement;
    expect(card.classList.contains('active')).toBe(true);
    // Clicking the active card should navigate back to the bare route, closing the column.
    expect(card.getAttribute('href')).toBe('#/sessions/s1/transcript');

    // The close (x) link on the open column does the same.
    const closeLink = root.querySelector('.column-close') as HTMLAnchorElement;
    expect(closeLink.getAttribute('href')).toBe('#/sessions/s1/transcript');
  });
});

function token(): AnalyticsToken {
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
  } as AnalyticsToken;
}

describe('portfolio-view', () => {
  beforeEach(() => {
    window.location.hash = '#/portfolio';
    portfolioMock.getOverview.mockResolvedValue({
      token: token(),
      headlineMetrics: [
        {
          ...token(),
          metricId: 'sessions',
          value: 10,
          unit: 'count',
          label: 'Sessions',
          isExact: true,
        },
      ],
      projectCount: 1,
      sessionCount: 10,
      componentCounts: {},
      unusedOfferedComponents: [],
    });
    portfolioMock.getTrends.mockResolvedValue({ token: token(), series: [] });
    portfolioMock.getComponentUtilization.mockResolvedValue({
      items: [],
      generationToken: 'gen-1',
      analysisReleaseToken: 'rel-1',
    });
    portfolioMock.getModelHarnessCohorts.mockResolvedValue({
      items: [],
      generationToken: 'gen-1',
      analysisReleaseToken: 'rel-1',
    });
    portfolioMock.getProjectList.mockResolvedValue({
      items: [
        {
          projectId: 'p1',
          name: 'Portfolio Project',
          sessionCount: 10,
          source: 'claude',
          harness: 'claude',
          completeness: 'complete',
          finality: 'final',
          reprocessing: 'unknown',
          issueState: 'clean',
          coverage: 'complete',
          token: token(),
        },
      ],
      generationToken: 'gen-1',
      analysisReleaseToken: 'rel-1',
    });
  });

  it('renders the portfolio summary and project list', async () => {
    const view = document.createElement('portfolio-view') as PortfolioView;
    await mount(view);
    const root = view.shadowRoot as ShadowRoot;

    expect(root.textContent).toContain('Portfolio');
    expect(allChildTexts(root, 'metrics-card').join(' ')).toContain('Sessions');
    expect(root.textContent).toContain('Portfolio Project');
  });

  it('updates the hash when a filter changes', async () => {
    const view = document.createElement('portfolio-view') as PortfolioView;
    await mount(view);
    const root = view.shadowRoot as ShadowRoot;

    const input = root.querySelector('input') as HTMLInputElement;
    input.value = 'p1';
    input.dispatchEvent(new Event('change'));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(window.location.hash).toMatch(/project=p1/);
  });
});

describe('project-behavior-view', () => {
  beforeEach(() => {
    window.location.hash = '#/projects/p1/behavior';
    projectMock.getSummary.mockResolvedValue({
      token: token(),
      headlineMetrics: [
        {
          ...token(),
          metricId: 'm-cost',
          value: 100,
          unit: 'usd',
          label: 'Cost',
          isExact: true,
        },
      ],
      trendToken: token(),
    });
    projectMock.getSessionTrendSeries.mockResolvedValue({ token: token(), series: [] });
    projectMock.getConfigurationTimeline.mockResolvedValue({ token: token(), events: [] });
    projectMock.getOutliers.mockResolvedValue({
      items: [],
      generationToken: 'gen-1',
      analysisReleaseToken: 'rel-1',
    });
    projectMock.getComparisons.mockResolvedValue({
      items: [],
      generationToken: 'gen-1',
      analysisReleaseToken: 'rel-1',
    });
  });

  it('renders the project behavior summary and metric cards', async () => {
    const view = Object.assign(document.createElement('project-behavior-view'), {
      projectId: 'p1',
    }) as ProjectBehaviorPage;
    await mount(view);
    const root = view.shadowRoot as ShadowRoot;

    expect(root.textContent).toContain('Project Behavior');
    expect(allChildTexts(root, 'metrics-card').join(' ')).toContain('Cost');
  });

  it('updates the hash when a filter changes', async () => {
    const view = Object.assign(document.createElement('project-behavior-view'), {
      projectId: 'p1',
    }) as ProjectBehaviorPage;
    await mount(view);
    const root = view.shadowRoot as ShadowRoot;

    const modelInput = Array.from(root.querySelectorAll('input')).find(
      (input) => input.parentElement?.textContent?.trim() === 'Model',
    );
    (modelInput as HTMLInputElement).value = 'claude';
    modelInput?.dispatchEvent(new Event('change'));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(window.location.hash).toMatch(/model=claude/);
  });

  it('navigates to session evidence from an outlier link', async () => {
    projectMock.getOutliers.mockResolvedValue({
      items: [
        {
          sessionId: 's1',
          metricId: 'm-cost',
          value: 100,
          deviation: 50,
          evidenceLinks: [
            { evidenceId: 's1', entityType: 'session', entityId: 's1', label: 'Session' },
          ],
        },
      ],
      generationToken: 'gen-1',
      analysisReleaseToken: 'rel-1',
    });

    const view = Object.assign(document.createElement('project-behavior-view'), {
      projectId: 'p1',
    }) as ProjectBehaviorPage;
    await mount(view);
    const root = view.shadowRoot as ShadowRoot;

    const link = root.querySelector('a[href^="#/sessions/"]') as HTMLAnchorElement;
    expect(link).not.toBeNull();
    link.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(window.location.hash).toBe('#/sessions/s1');
  });
});
