import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../../src/pages/projects-page';
import type { ProjectsPage } from '../../src/pages/projects-page';
import type { SyncManagerSnapshot } from '../../src/sync/sync-manager';
import type { Project } from '../../src/types';

const mockDbClient = vi.hoisted(() => ({
  ensureReady: vi.fn(),
  getProjects: vi.fn(),
  createProject: vi.fn(),
  deleteProject: vi.fn(),
  exportAndDownload: vi.fn(),
}));

vi.mock('../../src/db/db-client', () => ({ dbClient: mockDbClient }));

const mockAnalyticsClient = vi.hoisted(() => ({
  deleteProject: vi.fn(),
}));

vi.mock('../../src/db/analytics-client', () => ({ analyticsClient: mockAnalyticsClient }));

function emptySnapshot(): SyncManagerSnapshot {
  return {
    initialized: true,
    readOnly: false,
    projects: [],
    sessions: [],
    warnings: [],
    activeRun: null,
    queuedRuns: [],
    lastCompletedAt: null,
  } as unknown as SyncManagerSnapshot;
}

function snapshotWithRun(
  state: string,
  projects: { localProjectId: string; status?: string }[] = [],
): SyncManagerSnapshot {
  return {
    initialized: true,
    readOnly: false,
    projects,
    sessions: [],
    warnings: [],
    activeRun: { state },
    queuedRuns: [],
    lastCompletedAt: null,
  } as unknown as SyncManagerSnapshot;
}

const mockSyncManager = vi.hoisted(() => {
  const listeners: Record<string, EventListener[]> = {};
  return {
    addEventListener: vi.fn((type: string, listener: EventListener) => {
      listeners[type] = listeners[type] ?? [];
      listeners[type].push(listener);
    }),
    removeEventListener: vi.fn(),
    getSnapshot: vi.fn(emptySnapshot),
    emitChange: (detail?: unknown) => {
      for (const listener of listeners.change ?? []) {
        listener(new CustomEvent('change', { detail }));
      }
    },
  };
});

vi.mock('../../src/sync/sync-manager', () => ({ syncManager: mockSyncManager }));

const navigateToMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/router', () => ({ navigateTo: navigateToMock }));

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: 'Test Project',
    description: 'A test project',
    created_at: 1700000000000,
    updated_at: 1700000000000,
    session_count: 2,
    readable_id: 'test-project',
    ...overrides,
  };
}

async function mount(projects: Project[] = []): Promise<ProjectsPage> {
  mockDbClient.getProjects.mockResolvedValue(projects);
  const el = document.createElement('projects-page') as ProjectsPage;
  document.body.appendChild(el);
  await el.updateComplete;
  await new Promise((r) => setTimeout(r, 10));
  await el.updateComplete;
  return el;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDbClient.ensureReady.mockResolvedValue('opfs');
  mockDbClient.getProjects.mockResolvedValue([]);
  mockDbClient.createProject.mockResolvedValue(undefined);
  mockDbClient.deleteProject.mockResolvedValue(undefined);
  mockDbClient.exportAndDownload.mockResolvedValue(undefined);
  mockAnalyticsClient.deleteProject.mockResolvedValue(undefined);
  navigateToMock.mockReset();
  mockSyncManager.getSnapshot.mockReturnValue(emptySnapshot());
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('projects-page', () => {
  it('renders the page header with New Project and Export buttons', async () => {
    const el = await mount();
    const root = el.shadowRoot as ShadowRoot;
    expect(root.querySelector('h1')?.textContent).toBe('Projects');
    const buttons = root.querySelectorAll('.page-header-actions button');
    expect(buttons.length).toBe(2);
    expect(buttons[0]?.textContent).toContain('Export Database');
    expect(buttons[1]?.textContent).toContain('+ New Project');
  });

  it('renders the empty state when there are no projects', async () => {
    const el = await mount([]);
    const root = el.shadowRoot as ShadowRoot;
    expect(root.querySelector('.empty-state')).not.toBeNull();
    expect(root.textContent).toContain('No projects yet. Create one to get started!');
  });

  it('renders project cards when projects exist', async () => {
    const el = await mount([makeProject(), makeProject({ id: 'p2', name: 'Second' })]);
    const root = el.shadowRoot as ShadowRoot;
    const cards = root.querySelectorAll('.project-card');
    expect(cards.length).toBe(2);
    expect(cards[0]?.querySelector('h3')?.textContent).toContain('Test Project');
  });

  it('shows "No description" when a project has no description', async () => {
    const el = await mount([makeProject({ description: '' })]);
    const root = el.shadowRoot as ShadowRoot;
    expect(root.querySelector('.description')?.textContent).toBe('No description');
  });

  it('shows pluralized session count', async () => {
    const el = await mount([makeProject({ session_count: 3 })]);
    const root = el.shadowRoot as ShadowRoot;
    expect(root.querySelector('.project-meta')?.textContent).toContain('3 sessions');
  });

  it('shows singular session count', async () => {
    const el = await mount([makeProject({ session_count: 1 })]);
    const root = el.shadowRoot as ShadowRoot;
    expect(root.querySelector('.project-meta')?.textContent).toContain('1 session');
  });

  it('opens the project modal when New Project is clicked', async () => {
    const el = await mount();
    const root = el.shadowRoot as ShadowRoot;
    const newButton = root.querySelector('button.primary') as HTMLButtonElement;
    newButton.click();
    await el.updateComplete;
    const modal = root.querySelector('project-modal');
    expect(modal).not.toBeNull();
    expect((modal as HTMLElement & { open: boolean }).open).toBe(true);
  });

  it('closes the project modal on modal-close event', async () => {
    const el = await mount();
    const root = el.shadowRoot as ShadowRoot;
    const newButton = root.querySelector('button.primary') as HTMLButtonElement;
    newButton.click();
    await el.updateComplete;
    const modal = root.querySelector('project-modal') as HTMLElement & {
      open: boolean;
    };
    expect(modal.open).toBe(true);
    modal.dispatchEvent(new Event('modal-close', { bubbles: true, composed: true }));
    await el.updateComplete;
    expect(modal.open).toBe(false);
  });

  it('creates a project via project-create event and reloads', async () => {
    const el = await mount();
    const root = el.shadowRoot as ShadowRoot;
    const modal = root.querySelector('project-modal') as HTMLElement;
    modal.dispatchEvent(
      new CustomEvent('project-create', {
        detail: { name: 'New', description: 'desc', readableId: 'new' },
        bubbles: true,
        composed: true,
      }),
    );
    await new Promise((r) => setTimeout(r, 10));
    await el.updateComplete;
    expect(mockDbClient.createProject).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'New', description: 'desc', readable_id: 'new' }),
    );
    expect(mockDbClient.getProjects).toHaveBeenCalled();
  });

  it('shows an error when project creation fails', async () => {
    mockDbClient.createProject.mockRejectedValue(new Error('duplicate id'));
    const el = await mount();
    const root = el.shadowRoot as ShadowRoot;
    const modal = root.querySelector('project-modal') as HTMLElement;
    modal.dispatchEvent(
      new CustomEvent('project-create', {
        detail: { name: 'New', description: '', readableId: 'new' },
        bubbles: true,
        composed: true,
      }),
    );
    await new Promise((r) => setTimeout(r, 10));
    await el.updateComplete;
    expect(root.querySelector('.error')?.textContent).toContain('Failed to create project');
  });

  it('navigates to the project when a card is clicked', async () => {
    const el = await mount([makeProject()]);
    const root = el.shadowRoot as ShadowRoot;
    const card = root.querySelector('.project-card') as HTMLElement;
    card.click();
    expect(navigateToMock).toHaveBeenCalledWith('/projects/test-project');
  });

  it('navigates using project.id when readable_id is missing', async () => {
    const el = await mount([makeProject({ readable_id: undefined })]);
    const root = el.shadowRoot as ShadowRoot;
    const card = root.querySelector('.project-card') as HTMLElement;
    card.click();
    expect(navigateToMock).toHaveBeenCalledWith('/projects/p1');
  });

  it('opens the delete confirmation modal when delete is clicked', async () => {
    const el = await mount([makeProject()]);
    const root = el.shadowRoot as ShadowRoot;
    const deleteButton = root.querySelector('.delete-button') as HTMLButtonElement;
    deleteButton.click();
    await el.updateComplete;
    const modal = root.querySelector('delete-confirmation-modal') as HTMLElement & {
      open: boolean;
    };
    expect(modal).not.toBeNull();
    expect(modal.open).toBe(true);
  });

  it('cancels deletion on modal-close event', async () => {
    const el = await mount([makeProject()]);
    const root = el.shadowRoot as ShadowRoot;
    const deleteButton = root.querySelector('.delete-button') as HTMLButtonElement;
    deleteButton.click();
    await el.updateComplete;
    const modal = root.querySelector('delete-confirmation-modal') as HTMLElement & {
      open: boolean;
    };
    modal.dispatchEvent(new Event('modal-close', { bubbles: true, composed: true }));
    await el.updateComplete;
    expect(modal.open).toBe(false);
    expect(mockDbClient.deleteProject).not.toHaveBeenCalled();
  });

  it('deletes the project on delete-confirmed event and reloads', async () => {
    const el = await mount([makeProject()]);
    const root = el.shadowRoot as ShadowRoot;
    const deleteButton = root.querySelector('.delete-button') as HTMLButtonElement;
    deleteButton.click();
    await el.updateComplete;
    const modal = root.querySelector('delete-confirmation-modal') as HTMLElement;
    modal.dispatchEvent(new Event('delete-confirmed', { bubbles: true, composed: true }));
    await new Promise((r) => setTimeout(r, 10));
    await el.updateComplete;
    expect(mockDbClient.deleteProject).toHaveBeenCalledWith('p1');
    expect(mockAnalyticsClient.deleteProject).toHaveBeenCalledWith('p1');
    expect(mockDbClient.getProjects).toHaveBeenCalled();
  });

  it('continues deletion when analytics delete fails', async () => {
    mockAnalyticsClient.deleteProject.mockRejectedValue(new Error('no analytics db'));
    const el = await mount([makeProject()]);
    const root = el.shadowRoot as ShadowRoot;
    const deleteButton = root.querySelector('.delete-button') as HTMLButtonElement;
    deleteButton.click();
    await el.updateComplete;
    const modal = root.querySelector('delete-confirmation-modal') as HTMLElement;
    modal.dispatchEvent(new Event('delete-confirmed', { bubbles: true, composed: true }));
    await new Promise((r) => setTimeout(r, 10));
    await el.updateComplete;
    expect(mockDbClient.deleteProject).toHaveBeenCalledWith('p1');
    expect(root.querySelector('.error')).toBeNull();
  });

  it('shows an error when deletion fails', async () => {
    mockDbClient.deleteProject.mockRejectedValue(new Error('db locked'));
    const el = await mount([makeProject()]);
    const root = el.shadowRoot as ShadowRoot;
    const deleteButton = root.querySelector('.delete-button') as HTMLButtonElement;
    deleteButton.click();
    await el.updateComplete;
    const modal = root.querySelector('delete-confirmation-modal') as HTMLElement;
    modal.dispatchEvent(new Event('delete-confirmed', { bubbles: true, composed: true }));
    await new Promise((r) => setTimeout(r, 10));
    await el.updateComplete;
    expect(root.querySelector('.error')?.textContent).toContain('Failed to delete project');
  });

  it('exports the database when Export Database is clicked', async () => {
    const el = await mount();
    const root = el.shadowRoot as ShadowRoot;
    const exportButton = root.querySelector('button.secondary') as HTMLButtonElement;
    exportButton.click();
    await new Promise((r) => setTimeout(r, 10));
    expect(mockDbClient.exportAndDownload).toHaveBeenCalled();
  });

  it('shows an error when export fails', async () => {
    mockDbClient.exportAndDownload.mockRejectedValue(new Error('export failed'));
    const el = await mount();
    const root = el.shadowRoot as ShadowRoot;
    const exportButton = root.querySelector('button.secondary') as HTMLButtonElement;
    exportButton.click();
    await new Promise((r) => setTimeout(r, 10));
    await el.updateComplete;
    expect(root.querySelector('.error')?.textContent).toContain('Failed to export database');
  });

  it('shows a loading notice while projects are loading', async () => {
    mockDbClient.ensureReady.mockReturnValue(new Promise(() => undefined));
    const el = document.createElement('projects-page') as ProjectsPage;
    document.body.appendChild(el);
    await el.updateComplete;
    const root = el.shadowRoot as ShadowRoot;
    expect(root.querySelector('.notice')?.textContent).toContain('Loading projects');
  });

  it('shows an error when loading projects fails', async () => {
    mockDbClient.ensureReady.mockResolvedValue('opfs');
    mockDbClient.getProjects.mockRejectedValue(new Error('db down'));
    const el = document.createElement('projects-page') as ProjectsPage;
    document.body.appendChild(el);
    await el.updateComplete;
    await new Promise((r) => setTimeout(r, 10));
    await el.updateComplete;
    const root = el.shadowRoot as ShadowRoot;
    expect(root.querySelector('.error')?.textContent).toContain('Failed to load projects');
  });

  it('reloads projects when a sync run ends', async () => {
    mockSyncManager.getSnapshot.mockReturnValue(snapshotWithRun('running'));
    const el = await mount();
    const callCountBefore = mockDbClient.getProjects.mock.calls.length;
    const ended = emptySnapshot();
    mockSyncManager.getSnapshot.mockReturnValue(ended);
    mockSyncManager.emitChange(ended);
    await new Promise((r) => setTimeout(r, 10));
    await el.updateComplete;
    expect(mockDbClient.getProjects.mock.calls.length).toBeGreaterThan(callCountBefore);
  });

  it('reloads projects when new projects appear in the sync snapshot', async () => {
    mockSyncManager.getSnapshot.mockReturnValue(snapshotWithRun('running'));
    const el = await mount();
    const callCountBefore = mockDbClient.getProjects.mock.calls.length;
    const withNew = snapshotWithRun('running', [{ localProjectId: 'new-p' }]);
    mockSyncManager.getSnapshot.mockReturnValue(withNew);
    mockSyncManager.emitChange(withNew);
    await new Promise((r) => setTimeout(r, 10));
    await el.updateComplete;
    expect(mockDbClient.getProjects.mock.calls.length).toBeGreaterThan(callCountBefore);
  });

  it('renders a sync indicator when a project is syncing', async () => {
    mockSyncManager.getSnapshot.mockReturnValue(
      snapshotWithRun('running', [{ localProjectId: 'p1', status: 'running' }]),
    );
    const el = await mount([makeProject()]);
    const root = el.shadowRoot as ShadowRoot;
    expect(root.querySelector('project-sync-indicator')).not.toBeNull();
  });

  it('does not render a sync indicator when the project is not syncing', async () => {
    const el = await mount([makeProject()]);
    const root = el.shadowRoot as ShadowRoot;
    expect(root.querySelector('project-sync-indicator')).toBeNull();
  });

  it('opens the sync status modal when the sync indicator is clicked', async () => {
    mockSyncManager.getSnapshot.mockReturnValue(
      snapshotWithRun('running', [{ localProjectId: 'p1', status: 'running' }]),
    );
    const el = await mount([makeProject()]);
    const root = el.shadowRoot as ShadowRoot;
    const indicator = root.querySelector('project-sync-indicator') as HTMLElement;
    indicator.dispatchEvent(new Event('indicator-click', { bubbles: true, composed: true }));
    await el.updateComplete;
    const modal = root.querySelector('project-sync-status-modal') as HTMLElement & {
      projectId: string;
    };
    expect(modal).not.toBeNull();
    expect(modal.projectId).toBe('test-project');
  });

  it('does not open the sync modal for projects without a readable_id', async () => {
    mockSyncManager.getSnapshot.mockReturnValue(
      snapshotWithRun('running', [{ localProjectId: 'p1', status: 'running' }]),
    );
    const el = await mount([makeProject({ readable_id: undefined })]);
    const root = el.shadowRoot as ShadowRoot;
    const indicator = root.querySelector('project-sync-indicator') as HTMLElement;
    indicator.dispatchEvent(new Event('indicator-click', { bubbles: true, composed: true }));
    await el.updateComplete;
    const modal = root.querySelector('project-sync-status-modal') as HTMLElement & {
      projectId: string;
    };
    expect(modal.projectId).toBe('');
  });

  it('closes the sync status modal on modal-close event', async () => {
    mockSyncManager.getSnapshot.mockReturnValue(
      snapshotWithRun('running', [{ localProjectId: 'p1', status: 'running' }]),
    );
    const el = await mount([makeProject()]);
    const root = el.shadowRoot as ShadowRoot;
    const indicator = root.querySelector('project-sync-indicator') as HTMLElement;
    indicator.dispatchEvent(new Event('indicator-click', { bubbles: true, composed: true }));
    await el.updateComplete;
    const modal = root.querySelector('project-sync-status-modal') as HTMLElement;
    modal.dispatchEvent(new Event('modal-close', { bubbles: true, composed: true }));
    await el.updateComplete;
    expect((modal as HTMLElement & { projectId: string }).projectId).toBe('');
  });

  it('navigates to the project on Enter keydown', async () => {
    const el = await mount([makeProject()]);
    const root = el.shadowRoot as ShadowRoot;
    const card = root.querySelector('.project-card') as HTMLElement;
    card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(navigateToMock).toHaveBeenCalledWith('/projects/test-project');
  });

  it('navigates to the project on Space keydown', async () => {
    const el = await mount([makeProject()]);
    const root = el.shadowRoot as ShadowRoot;
    const card = root.querySelector('.project-card') as HTMLElement;
    card.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    expect(navigateToMock).toHaveBeenCalledWith('/projects/test-project');
  });

  it('does not navigate on other keydown', async () => {
    const el = await mount([makeProject()]);
    const root = el.shadowRoot as ShadowRoot;
    const card = root.querySelector('.project-card') as HTMLElement;
    card.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    expect(navigateToMock).not.toHaveBeenCalled();
  });

  it('detects syncing via project.sync_status', async () => {
    const el = await mount([makeProject({ sync_status: 'syncing' })]);
    const root = el.shadowRoot as ShadowRoot;
    expect(root.querySelector('project-sync-indicator')).not.toBeNull();
  });
});
