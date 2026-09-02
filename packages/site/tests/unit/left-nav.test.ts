import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../../src/components/left-nav';
import type { LeftNav } from '../../src/components/left-nav';

const mockDbClient = vi.hoisted(() => ({
  ensureReady: vi.fn(),
  getProjects: vi.fn(),
}));

vi.mock('../../src/db/db-client', () => ({ dbClient: mockDbClient }));

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
});

afterEach(() => {
  document.body.innerHTML = '';
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

  it('renders nothing on non-dashboard/settings routes', async () => {
    const el = await mount('/sessions/s1');
    const root = el.shadowRoot as ShadowRoot;
    expect(root.querySelector('nav')).toBeNull();
  });

  it('expands the Projects section on /projects routes', async () => {
    const el = await mount('/projects');
    const root = el.shadowRoot as ShadowRoot;
    const projectsItem = root.querySelector('a.nav-item');
    expect(projectsItem?.classList.contains('expanded')).toBe(true);
  });

  it('lists real projects when expanded', async () => {
    mockDbClient.getProjects.mockResolvedValue([
      { id: 'p1', name: 'Project A', readable_id: 'p1' },
      { id: 'p2', name: 'Project B', readable_id: 'p2' },
    ]);
    const el = await mount('/projects');
    const root = el.shadowRoot as ShadowRoot;
    const childLinks = Array.from(root.querySelectorAll('.nav-child')).map((a) => a.textContent);
    expect(childLinks).toContain('Project A');
    expect(childLinks).toContain('Project B');
  });

  it('highlights the active settings item', async () => {
    const el = await mount('/settings/storage');
    const root = el.shadowRoot as ShadowRoot;
    const activeItem = root.querySelector('a.nav-item.active');
    expect(activeItem?.textContent).toContain('Storage');
  });
});
