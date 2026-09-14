import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../../src/components/left-nav';
import type { LeftNav } from '../../src/components/left-nav';

const mockDbClient = vi.hoisted(() => ({
  ensureReady: vi.fn(),
  getProjects: vi.fn(),
}));

vi.mock('../../src/db/db-client', () => ({ dbClient: mockDbClient }));

const mockGetProjectSessionList = vi.fn();
const mockGetSessionProjectRef = vi.fn();
const mockGetProjectList = vi.fn();
const mockResolveProjectId = vi.fn();

vi.mock('../../src/db/analytics-client', () => ({
  analyticsClient: {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    resolveProjectId: (...args: unknown[]) => mockResolveProjectId(...args),
    portfolio: {
      getProjectList: (...args: unknown[]) => mockGetProjectList(...args),
    },
    search: {
      getProjectSessionList: (...args: unknown[]) => mockGetProjectSessionList(...args),
      getSessionProjectRef: (...args: unknown[]) => mockGetSessionProjectRef(...args),
    },
  },
}));

const mockSyncManager = vi.hoisted(() => ({
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  getSnapshot: vi.fn(() => ({
    initialized: true,
    readOnly: false,
    projects: [],
    sessions: [],
    warnings: [],
    activeRun: null,
    queuedRuns: [],
  })),
}));

vi.mock('../../src/sync/sync-manager', () => ({ syncManager: mockSyncManager }));

beforeEach(() => {
  vi.clearAllMocks();
  mockDbClient.ensureReady.mockResolvedValue('opfs');
  mockDbClient.getProjects.mockResolvedValue([]);
  mockGetProjectList.mockResolvedValue({
    items: [],
    generationToken: 'gen-1',
    analysisReleaseToken: 'rel-1',
  });
  mockResolveProjectId.mockImplementation(async (id: string) => id);
  mockGetSessionProjectRef.mockResolvedValue(null);
  mockGetProjectSessionList.mockResolvedValue({
    items: [
      {
        sessionId: 'sess-1',
        rootSessionId: 'sess-1',
        harness: 'claude',
        finality: 'final',
        title: 'Fix issue with login',
        subagentCount: 2,
        startedAt: '2026-09-10T10:00:00Z',
        coverage: 'complete',
      },
      {
        sessionId: 'sess-2',
        rootSessionId: 'sess-2',
        harness: 'claude',
        finality: 'final',
        title: 'Refactor database',
        subagentCount: 0,
        startedAt: '2026-09-09T15:30:00Z',
        coverage: 'complete',
      },
      {
        sessionId: 'sess-3',
        rootSessionId: 'sess-3',
        harness: 'claude',
        finality: 'final',
        subagentCount: 0,
        startedAt: '2026-09-08T12:00:00Z',
        coverage: 'complete',
      },
    ],
    totalCount: 3,
    generationToken: 'gen-1',
    analysisReleaseToken: 'rel-1',
  });
});

afterEach(() => {
  document.body.innerHTML = '';
  window.location.hash = '';
});

async function mount(path = '/'): Promise<LeftNav> {
  const el = document.createElement('left-nav') as LeftNav;
  el.path = path;
  document.body.appendChild(el);
  await el.updateComplete;
  await new Promise((r) => setTimeout(r, 0));
  await el.updateComplete;
  return el;
}

async function flushElement(el: LeftNav): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await el.updateComplete;
}

describe('left-nav', () => {
  it('renders the Projects section and dashboard links on /', async () => {
    const el = await mount('/');
    const root = el.shadowRoot as ShadowRoot;
    const labels = Array.from(root.querySelectorAll('.nav-section-label')).map((l) =>
      l.textContent?.trim(),
    );
    expect(labels).toContain('Projects');
    expect(labels).toContain('Dashboard');
    const links = Array.from(root.querySelectorAll('a')).map((a) =>
      a.textContent?.trim().replace(/\s+/g, ' '),
    );
    expect(links.some((l) => l?.includes('Agents'))).toBe(true);
    expect(links.some((l) => l?.includes('Skills'))).toBe(true);
    expect(links.some((l) => l?.includes('Tools'))).toBe(true);
    expect(links.some((l) => l?.includes('MCP'))).toBe(true);
  });

  it('lists projects with session-count and last-session stats on the home menu', async () => {
    mockDbClient.getProjects.mockResolvedValue([
      { id: 'p1', name: 'Project A', readable_id: 'p1', session_count: 3, updated_at: Date.now() },
      { id: 'p2', name: 'Project B', readable_id: 'p2', session_count: 1, updated_at: Date.now() },
    ]);
    mockGetProjectList.mockResolvedValue({
      items: [
        {
          projectId: 'prj-a',
          name: 'p1',
          sessionCount: 4,
          lastSessionAt: '2026-09-10T10:00:00Z',
          source: 'sync',
          harness: 'claude',
          completeness: 'complete',
          finality: 'final',
          reprocessing: 'local',
          issueState: 'clean',
          coverage: 'complete',
        },
      ],
      generationToken: 'gen-1',
      analysisReleaseToken: 'rel-1',
    });
    const el = await mount('/');
    await flushElement(el);
    const root = el.shadowRoot as ShadowRoot;

    const names = Array.from(root.querySelectorAll('.nav-project-name')).map((s) => s.textContent);
    expect(names).toContain('Project A');
    expect(names).toContain('Project B');

    const stats = Array.from(root.querySelectorAll('.nav-project-stats')).map((s) => s.textContent);
    expect(stats.some((s) => s?.includes('4 sessions'))).toBe(true);
    expect(stats.some((s) => s?.includes('last session'))).toBe(true);
    expect(stats.some((s) => s?.includes('1 session'))).toBe(true);
  });

  it('shows a project menu with a Dashboard back link and sessions on project routes', async () => {
    const el = await mount('/projects/p1');
    await flushElement(el);
    const root = el.shadowRoot as ShadowRoot;

    const backLink = root.querySelector('a.nav-back') as HTMLAnchorElement;
    expect(backLink).not.toBeNull();
    expect(backLink.textContent).toContain('< Dashboard');
    expect(backLink.getAttribute('href')).toBe('#/');

    const labels = Array.from(root.querySelectorAll('.nav-section-label')).map((l) =>
      l.textContent?.trim(),
    );
    expect(labels).toContain('Sessions');

    const sessionTitles = Array.from(root.querySelectorAll('.nav-session-title')).map(
      (s) => s.textContent,
    );
    expect(sessionTitles).toContain('Fix issue with login');
    expect(sessionTitles).toContain('Refactor database');
    // Title-less sessions fall back to "Unknown", never to a raw id.
    expect(sessionTitles).toContain('Unknown');
    // Projects are not listed on the project menu.
    expect(root.querySelector('.nav-project')).toBeNull();
    expect(mockGetProjectSessionList).toHaveBeenCalledWith('p1', { limit: 10 });
  });

  it('shows a session menu with a Project back link on session routes', async () => {
    mockGetSessionProjectRef.mockResolvedValue({
      sessionId: 'sess-1',
      projectId: 'prj-1',
      nativeProjectId: 'my-project',
    });
    const el = await mount('/sessions/sess-1');
    await flushElement(el);
    const root = el.shadowRoot as ShadowRoot;

    const backLink = root.querySelector('a.nav-back') as HTMLAnchorElement;
    expect(backLink).not.toBeNull();
    expect(backLink.textContent).toContain('< Project');
    expect(backLink.getAttribute('href')).toBe('#/projects/my-project');

    const sessionTitles = Array.from(root.querySelectorAll('.nav-session-title')).map(
      (s) => s.textContent,
    );
    expect(sessionTitles).toContain('Fix issue with login');
    expect(mockGetProjectSessionList).toHaveBeenCalledWith('prj-1', { limit: 10 });
  });

  it('falls back to a Dashboard back link when the session has no project', async () => {
    mockGetSessionProjectRef.mockResolvedValue(null);
    const el = await mount('/sessions/unknown-session');
    await flushElement(el);
    const root = el.shadowRoot as ShadowRoot;

    const backLink = root.querySelector('a.nav-back') as HTMLAnchorElement;
    expect(backLink.textContent).toContain('< Dashboard');
    expect(backLink.getAttribute('href')).toBe('#/');
  });

  it('highlights the current session in the sessions list', async () => {
    mockGetSessionProjectRef.mockResolvedValue({
      sessionId: 'sess-2',
      projectId: 'prj-1',
      nativeProjectId: 'my-project',
    });
    const el = await mount('/sessions/sess-2');
    await flushElement(el);
    const root = el.shadowRoot as ShadowRoot;

    const active = root.querySelector('.nav-session-item.active');
    expect(active?.textContent).toContain('Refactor database');
  });

  it('renders an error indicator when loading sessions fails', async () => {
    mockGetProjectSessionList.mockRejectedValueOnce(new Error('DB failure'));
    const el = await mount('/projects/p1');
    await flushElement(el);
    const root = el.shadowRoot as ShadowRoot;
    const errorEl = root.querySelector('.nav-session-error');
    expect(errorEl).not.toBeNull();
    expect(errorEl?.textContent).toContain('Failed to load sessions');
  });

  it('navigates to a session page when clicking a session in the menu', async () => {
    const el = await mount('/projects/p1');
    await flushElement(el);
    const root = el.shadowRoot as ShadowRoot;
    const sessionItem = root.querySelector('.nav-session-item') as HTMLElement;
    expect(sessionItem).not.toBeNull();
    sessionItem.click();
    expect(window.location.hash).toBe('#/sessions/sess-1');
  });

  it('renders settings nav items on /settings/data-sources', async () => {
    const el = await mount('/settings/data-sources');
    const root = el.shadowRoot as ShadowRoot;
    const links = Array.from(root.querySelectorAll('a')).map((a) => a.textContent?.trim());
    expect(links).toContain('Data Sources');
    expect(links).toContain('Storage');
  });

  it('renders settings nav items on /settings/storage', async () => {
    const el = await mount('/settings/storage');
    const root = el.shadowRoot as ShadowRoot;
    const links = Array.from(root.querySelectorAll('a')).map((a) => a.textContent?.trim());
    expect(links).toContain('Data Sources');
    expect(links).toContain('Storage');
  });

  it('highlights the active settings item', async () => {
    const el = await mount('/settings/storage');
    const root = el.shadowRoot as ShadowRoot;
    const activeItem = root.querySelector('a.nav-item.active');
    expect(activeItem?.textContent).toContain('Storage');
  });

  it('renders nothing on non-dashboard/settings routes (e.g. /artifacts)', async () => {
    const el = await mount('/artifacts');
    const root = el.shadowRoot as ShadowRoot;
    expect(root.querySelector('nav')).toBeNull();
  });
});
