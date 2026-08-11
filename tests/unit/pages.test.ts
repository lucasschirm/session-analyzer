import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LitElement } from 'lit';
import { dbClient } from '../../src/db/db-client';
import '../../src/pages/home-page';
import '../../src/pages/project-view';
import '../../src/pages/session-dashboard';
import '../../src/pages/indicator-details';
import type { HomePage } from '../../src/pages/home-page';
import type { ProjectView } from '../../src/pages/project-view';
import type { SessionDashboard } from '../../src/pages/session-dashboard';
import type { IndicatorDetails } from '../../src/pages/indicator-details';
import type { DashboardSession, Project, SessionMetrics } from '../../src/types';

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
    (child) => ((child as LitElement).shadowRoot?.textContent ?? '') as string
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
    total_tokens: 150,
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
    ...overrides,
  };
}

const metricsFixture: SessionMetrics = {
  total_sessions: 1,
  total_input_tokens: 100,
  total_output_tokens: 50,
  total_cost_usd: 0,
  total_tool_executions: 4,
  avg_session_duration_ms: 60_000,
  models_used: ['claude'],
};

describe('home-page', () => {
  it('lists projects from the database', async () => {
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

  it('opens the modal and creates a project', async () => {
    const getProjects = vi.spyOn(dbClient, 'getProjects').mockResolvedValue([]);
    const createProject = vi.spyOn(dbClient, 'createProject').mockResolvedValue();

    const page = await mount(document.createElement('home-page') as HomePage);
    const root = page.shadowRoot as ShadowRoot;

    const newButton = Array.from(root.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('+ New Project')
    );
    newButton!.click();
    await page.updateComplete;

    const modal = root.querySelector('project-modal');
    expect(modal).not.toBeNull();

    modal!.dispatchEvent(
      new CustomEvent('project-create', {
        detail: { name: 'Created', description: 'From modal' },
        bubbles: true,
        composed: true,
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(createProject).toHaveBeenCalledTimes(1);
    const created = createProject.mock.calls[0][0];
    expect(created.name).toBe('Created');
    expect(created.description).toBe('From modal');
    expect(getProjects).toHaveBeenCalledTimes(2); // initial + refresh
  });

  it('deletes a project after confirmation', async () => {
    vi.spyOn(dbClient, 'getProjects').mockResolvedValue([projectFixture()]);
    const deleteProject = vi.spyOn(dbClient, 'deleteProject').mockResolvedValue();
    // happy-dom has no window.confirm implementation.
    vi.stubGlobal('confirm', vi.fn(() => true));

    const page = await mount(document.createElement('home-page') as HomePage);
    const root = page.shadowRoot as ShadowRoot;

    (root.querySelector('.delete-button') as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(deleteProject).toHaveBeenCalledWith('p1');
  });

  it('does not delete when the confirmation is dismissed', async () => {
    vi.spyOn(dbClient, 'getProjects').mockResolvedValue([projectFixture()]);
    const deleteProject = vi.spyOn(dbClient, 'deleteProject').mockResolvedValue();
    vi.stubGlobal('confirm', vi.fn(() => false));

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
      button.textContent?.includes('Export Database')
    );
    exportButton!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(exportAndDownload).toHaveBeenCalled();
  });
});

describe('project-view', () => {
  function stubProjectLoad() {
    vi.spyOn(dbClient, 'getProject').mockResolvedValue(projectFixture());
    vi.spyOn(dbClient, 'getSessionsByProject').mockResolvedValue([sessionFixture()]);
    vi.spyOn(dbClient, 'getProjectMetrics').mockResolvedValue(metricsFixture);
  }

  it('loads project, metrics and sessions', async () => {
    stubProjectLoad();

    const view = Object.assign(document.createElement('project-view'), { projectId: 'p1' }) as ProjectView;
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

  it('shows a not-found notice for unknown projects', async () => {
    vi.spyOn(dbClient, 'getProject').mockResolvedValue(null);
    vi.spyOn(dbClient, 'getSessionsByProject').mockResolvedValue([]);
    vi.spyOn(dbClient, 'getProjectMetrics').mockResolvedValue(metricsFixture);

    const view = Object.assign(document.createElement('project-view'), { projectId: 'missing' }) as ProjectView;
    await mount(view);

    expect((view.shadowRoot as ShadowRoot).textContent).toContain('Project not found');
  });

  it('filters sessions through the search bar', async () => {
    stubProjectLoad();
    const searchSessions = vi
      .spyOn(dbClient, 'searchSessions')
      .mockResolvedValue([sessionFixture({ title: 'matched.jsonl' })]);

    const view = Object.assign(document.createElement('project-view'), { projectId: 'p1' }) as ProjectView;
    await mount(view);
    const root = view.shadowRoot as ShadowRoot;

    const searchInput = root.querySelector('.search-input') as HTMLInputElement;
    searchInput.value = 'match';
    searchInput.dispatchEvent(new Event('input'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await flush(view);

    expect(searchSessions).toHaveBeenCalledWith('p1', 'match');
    expect(childText(root, 'session-list')).toContain('matched.jsonl');
  });

  it('resets to the full list when the search is cleared', async () => {
    stubProjectLoad();
    const getSessionsByProject = vi
      .spyOn(dbClient, 'getSessionsByProject')
      .mockResolvedValue([sessionFixture()]);

    const view = Object.assign(document.createElement('project-view'), { projectId: 'p1' }) as ProjectView;
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
    expect(root.querySelectorAll('metrics-card').length).toBe(7);
  });

  it('shows an error for missing sessions', async () => {
    vi.spyOn(dbClient, 'getSession').mockResolvedValue(null);

    const dashboard = Object.assign(document.createElement('session-dashboard'), {
      sessionId: 'nope',
    }) as SessionDashboard;
    await mount(dashboard);

    expect((dashboard.shadowRoot as ShadowRoot).textContent).toContain('Session not found');
  });

  it('toggles the transcript view', async () => {
    vi.spyOn(dbClient, 'getSession').mockResolvedValue(sessionFixture());

    const dashboard = Object.assign(document.createElement('session-dashboard'), {
      sessionId: 's1',
    }) as SessionDashboard;
    await mount(dashboard);
    const root = dashboard.shadowRoot as ShadowRoot;

    expect(root.querySelector('session-transcript')).toBeNull();

    const toggle = Array.from(root.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('View Session Transcript')
    );
    toggle!.click();
    await dashboard.updateComplete;

    expect(root.querySelector('session-transcript')).not.toBeNull();
    expect(root.textContent).toContain('Hide Session Transcript');
  });

  it('routes metric card clicks to indicator pages', async () => {
    vi.spyOn(dbClient, 'getSession').mockResolvedValue(sessionFixture());

    const dashboard = Object.assign(document.createElement('session-dashboard'), {
      sessionId: 's1',
    }) as SessionDashboard;
    await mount(dashboard);
    const root = dashboard.shadowRoot as ShadowRoot;

    const cards = root.querySelectorAll('metrics-card');
    const filesWrittenCard = Array.from(cards).find((card) =>
      (card as HTMLElement & { label: string }).label === 'Files Written'
    );
    filesWrittenCard!.dispatchEvent(
      new CustomEvent('card-click', { detail: { label: 'Files Written' }, bubbles: true, composed: true })
    );

    expect(window.location.hash).toBe('#/sessions/s1/indicator/files_written');
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
    expect(childText(root, 'events-table')).toContain('src/a.ts');
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
    const tableText = childText(root, 'events-table');
    expect(tableText).toContain('user message');
    expect(tableText).toContain('Fix the bug');
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
});
