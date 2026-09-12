import type { ProjectSessionListPage } from '@lucasschirm/sal-db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../../src/pages/project-sessions-page';
import type { ProjectSessionsPage } from '../../src/pages/project-sessions-page';

const mockGetProjectSessionList = vi.fn();
const mockResolveProjectId = vi.fn();
const mockGetProject = vi.fn();
const mockGetProjectByReadableId = vi.fn();

vi.mock('../../src/db/analytics-client', () => ({
  analyticsClient: {
    resolveProjectId: (...args: unknown[]) => mockResolveProjectId(...args),
    search: {
      getProjectSessionList: (...args: unknown[]) => mockGetProjectSessionList(...args),
    },
  },
}));

vi.mock('../../src/db/db-client', () => ({
  dbClient: {
    getProject: (...args: unknown[]) => mockGetProject(...args),
    getProjectByReadableId: (...args: unknown[]) => mockGetProjectByReadableId(...args),
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveProjectId.mockResolvedValue('project-1');
  mockGetProject.mockResolvedValue({ id: 'project-1', name: 'Alpha Project' });
  mockGetProjectByReadableId.mockResolvedValue({ id: 'project-1', name: 'Alpha Project' });
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
  } as ProjectSessionListPage);
});

afterEach(() => {
  document.body.innerHTML = '';
});

async function mountPage(projectId = 'project-1'): Promise<ProjectSessionsPage> {
  const el = document.createElement('project-sessions-page') as ProjectSessionsPage;
  el.projectId = projectId;
  document.body.appendChild(el);
  await el.updateComplete;
  await new Promise((r) => setTimeout(r, 0));
  await el.updateComplete;
  return el;
}

describe('project-sessions-page', () => {
  it('renders breadcrumbs with < Dashboard option', async () => {
    const el = await mountPage('alpha');
    const root = el.shadowRoot as ShadowRoot;
    const links = Array.from(root.querySelectorAll('.back-link')).map((l) => l.textContent?.trim());
    expect(links).toContain('< Dashboard');
    expect(links).toContain('← Project Behavior');
  });

  it('renders the session list with columns: title, start date, sub agents', async () => {
    const el = await mountPage('alpha');
    const root = el.shadowRoot as ShadowRoot;
    const table = root.querySelector('project-sessions-table');
    expect(table).not.toBeNull();

    const tableRoot = table?.shadowRoot as ShadowRoot;
    const headers = Array.from(tableRoot.querySelectorAll('th')).map((th) =>
      th.textContent?.trim(),
    );
    expect(headers).toEqual(['Title', 'Start date', 'Sub agents']);

    const rows = Array.from(tableRoot.querySelectorAll('tbody tr'));
    expect(rows.length).toBe(2);
    expect(rows[0]?.querySelector('.session-title-link')?.textContent?.trim()).toBe(
      'Fix issue with login',
    );
    expect(rows[0]?.querySelector('.subagents-badge')?.textContent?.trim()).toBe('2');
  });

  it('filters sessions when typing in the search input', async () => {
    const el = await mountPage('alpha');
    const root = el.shadowRoot as ShadowRoot;
    const searchInput = root.querySelector('.search-label input') as HTMLInputElement;
    expect(searchInput).not.toBeNull();

    searchInput.value = 'login';
    searchInput.dispatchEvent(new Event('input'));

    await new Promise((r) => setTimeout(r, 300));
    await el.updateComplete;

    expect(mockGetProjectSessionList).toHaveBeenCalledWith(
      'project-1',
      expect.objectContaining({
        filters: expect.arrayContaining([
          expect.objectContaining({ field: 'search', value: 'login' }),
        ]),
      }),
    );
  });

  it('paginates when there are multiple pages', async () => {
    mockGetProjectSessionList.mockResolvedValue({
      items: Array.from({ length: 20 }, (_, i) => ({
        sessionId: `sess-${i}`,
        rootSessionId: `sess-${i}`,
        harness: 'claude',
        finality: 'final',
        title: `Session ${i}`,
        subagentCount: 0,
        startedAt: '2026-09-10T10:00:00Z',
        coverage: 'complete',
      })),
      totalCount: 45,
      generationToken: 'gen-1',
      analysisReleaseToken: 'rel-1',
    } as ProjectSessionListPage);

    const el = await mountPage('alpha');
    const root = el.shadowRoot as ShadowRoot;
    const paginationBar = root.querySelector('.pagination-bar');
    expect(paginationBar?.textContent).toContain('Page 1 of 3');

    const nextBtn = root.querySelectorAll<HTMLButtonElement>('.pagination-btn')[1];
    expect(nextBtn?.disabled).toBe(false);

    nextBtn.click();
    await el.updateComplete;
    await new Promise((r) => setTimeout(r, 0));
    await el.updateComplete;

    expect(mockGetProjectSessionList).toHaveBeenCalledWith(
      'project-1',
      expect.objectContaining({ cursor: '20' }),
    );
  });
});
