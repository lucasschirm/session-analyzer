import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../../src/components/left-nav';
import type { LeftNav } from '../../src/components/left-nav';

const mockDbClient = vi.hoisted(() => ({
  ensureReady: vi.fn(),
  getProjects: vi.fn(),
}));

vi.mock('../../src/db/db-client', () => ({ dbClient: mockDbClient }));

const mockGetProjectSessionList = vi.fn();
const mockResolveProjectId = vi.fn();

vi.mock('../../src/db/analytics-client', () => ({
  analyticsClient: {
    resolveProjectId: (...args: unknown[]) => mockResolveProjectId(...args),
    search: {
      getProjectSessionList: (...args: unknown[]) => mockGetProjectSessionList(...args),
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
  mockResolveProjectId.mockImplementation(async (id: string) => id);
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
    ],
    totalCount: 2,
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

describe('left-nav', () => {
  it('renders dashboard nav items on /', async () => {
    const el = await mount('/');
    const root = el.shadowRoot as ShadowRoot;
    const links = Array.from(root.querySelectorAll('a')).map((a) =>
      a.textContent?.trim().replace(/\s+/g, ' '),
    );
    expect(links.some((l) => l?.includes('Projects'))).toBe(true);
    expect(links.some((l) => l?.includes('Agents'))).toBe(true);
    expect(links.some((l) => l?.includes('Skills'))).toBe(true);
    expect(links.some((l) => l?.includes('Tools'))).toBe(true);
    expect(links.some((l) => l?.includes('MCP'))).toBe(true);
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

  it('renders nothing on non-dashboard/settings routes (e.g. /artifacts)', async () => {
    const el = await mount('/artifacts');
    const root = el.shadowRoot as ShadowRoot;
    expect(root.querySelector('nav')).toBeNull();
  });

  it('renders dashboard nav on session routes', async () => {
    const el = await mount('/sessions/s1');
    const root = el.shadowRoot as ShadowRoot;
    expect(root.querySelector('nav')).not.toBeNull();
  });

  it('does not auto-expand the Projects section on the /projects list route', async () => {
    const el = await mount('/projects');
    const root = el.shadowRoot as ShadowRoot;
    const projectsItem = root.querySelector('a.nav-item');
    expect(projectsItem?.classList.contains('expanded')).toBe(false);
  });

  it('auto-expands the Projects section on a specific project route', async () => {
    const el = await mount('/projects/p1');
    const root = el.shadowRoot as ShadowRoot;
    const projectsItem = root.querySelector('a.nav-item');
    expect(projectsItem?.classList.contains('expanded')).toBe(true);
  });

  it('lists real projects with stats when expanded', async () => {
    mockDbClient.getProjects.mockResolvedValue([
      { id: 'p1', name: 'Project A', readable_id: 'p1', session_count: 3, updated_at: Date.now() },
      { id: 'p2', name: 'Project B', readable_id: 'p2', session_count: 1, updated_at: Date.now() },
    ]);
    const el = await mount('/projects/p1');
    const root = el.shadowRoot as ShadowRoot;
    const childNames = Array.from(root.querySelectorAll('.nav-child-name')).map(
      (s) => s.textContent,
    );
    expect(childNames).toContain('Project A');
    expect(childNames).toContain('Project B');
    // Stats line should include session count
    const childStats = Array.from(root.querySelectorAll('.nav-child-stats')).map(
      (s) => s.textContent,
    );
    expect(childStats.some((s) => s?.includes('3 sessions'))).toBe(true);
    expect(childStats.some((s) => s?.includes('1 session'))).toBe(true);
  });

  it('highlights the active settings item', async () => {
    const el = await mount('/settings/storage');
    const root = el.shadowRoot as ShadowRoot;
    const activeItem = root.querySelector('a.nav-item.active');
    expect(activeItem?.textContent).toContain('Storage');
  });

  it('expands the Projects section when clicking on Projects in the left menu', async () => {
    mockDbClient.getProjects.mockResolvedValue([
      {
        id: 'p1',
        name: 'Alpha Project',
        readable_id: 'p1',
        session_count: 5,
        updated_at: Date.now(),
      },
    ]);
    const el = await mount('/');
    const root = el.shadowRoot as ShadowRoot;
    const projectsLink = root.querySelector('a.nav-item') as HTMLElement;
    expect(projectsLink?.classList.contains('expanded')).toBe(false);

    projectsLink.click();
    await el.updateComplete;
    el.path = '/projects';
    await el.updateComplete;

    expect(projectsLink?.classList.contains('expanded')).toBe(true);
    const childNames = Array.from(root.querySelectorAll('.nav-child-name')).map(
      (s) => s.textContent,
    );
    expect(childNames).toContain('Alpha Project');
  });

  async function flushElement(el: LeftNav): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await el.updateComplete;
  }

  it('loads and renders sessions under a project when expanded', async () => {
    mockDbClient.getProjects.mockResolvedValue([
      { id: 'p1', name: 'Project A', readable_id: 'p1', session_count: 2, updated_at: Date.now() },
    ]);
    const el = await mount('/projects/p1');
    await el.updateComplete;
    await flushElement(el);

    const root = el.shadowRoot as ShadowRoot;
    const sessionTitles = Array.from(root.querySelectorAll('.nav-session-title')).map(
      (s) => s.textContent,
    );
    expect(sessionTitles).toContain('Fix issue with login');
    expect(sessionTitles).toContain('Refactor database');
  });

  it('renders error indicator when loading sessions fails', async () => {
    mockDbClient.getProjects.mockResolvedValue([
      { id: 'p1', name: 'Project A', readable_id: 'p1', session_count: 2, updated_at: Date.now() },
    ]);
    mockGetProjectSessionList.mockRejectedValueOnce(new Error('DB failure'));
    const el = await mount('/projects/p1');
    await el.updateComplete;
    await flushElement(el);

    const root = el.shadowRoot as ShadowRoot;
    const errorEl = root.querySelector('.nav-session-error');
    expect(errorEl).not.toBeNull();
    expect(errorEl?.textContent).toContain('Failed to load sessions');
  });

  it('toggles project sessions on chevron click', async () => {
    mockDbClient.getProjects.mockResolvedValue([
      { id: 'p1', name: 'Project A', readable_id: 'p1', session_count: 2, updated_at: Date.now() },
    ]);
    const el = await mount('/projects');
    // Expand projects list
    const projectsLink = el.shadowRoot?.querySelector('a.nav-item') as HTMLElement;
    projectsLink.click();
    await el.updateComplete;

    const root = el.shadowRoot as ShadowRoot;
    const chevronBtn = root.querySelector('.project-chevron-btn') as HTMLElement;
    expect(chevronBtn).not.toBeNull();
    expect(chevronBtn.getAttribute('aria-expanded')).toBe('false');
    expect(root.querySelector('.nav-sessions-list')).toBeNull();

    // Click chevron to expand sessions
    chevronBtn.click();
    await el.updateComplete;
    await flushElement(el);

    expect(chevronBtn.getAttribute('aria-expanded')).toBe('true');
    expect(root.querySelector('.nav-sessions-list')).not.toBeNull();
    const sessionTitles = Array.from(root.querySelectorAll('.nav-session-title')).map(
      (s) => s.textContent,
    );
    expect(sessionTitles).toContain('Fix issue with login');

    // Click chevron to collapse sessions
    chevronBtn.click();
    await el.updateComplete;
    expect(chevronBtn.getAttribute('aria-expanded')).toBe('false');
    expect(root.querySelector('.nav-sessions-list')).toBeNull();
  });

  it('navigates to session page when clicking a session in left menu', async () => {
    window.location.hash = '#/projects/p1';
    mockDbClient.getProjects.mockResolvedValue([
      { id: 'p1', name: 'Project A', readable_id: 'p1', session_count: 2, updated_at: Date.now() },
    ]);
    const el = await mount('/projects/p1');
    await el.updateComplete;
    await flushElement(el);

    const root = el.shadowRoot as ShadowRoot;
    const sessionItem = root.querySelector('.nav-session-item') as HTMLElement;
    expect(sessionItem).not.toBeNull();
    sessionItem.click();

    expect(window.location.hash).toBe('#/sessions/sess-1');
  });
});
