import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../../src/components/header-project-selector';
import type { HeaderProjectSelector } from '../../src/components/header-project-selector';

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
  window.location.hash = '';
});

async function mount(): Promise<HeaderProjectSelector> {
  const el = document.createElement('header-project-selector') as HeaderProjectSelector;
  document.body.appendChild(el);
  await el.updateComplete;
  await new Promise((r) => setTimeout(r, 0));
  await el.updateComplete;
  return el;
}

describe('header-project-selector', () => {
  it('is hidden when there are no projects', async () => {
    const el = await mount();
    const root = el.shadowRoot as ShadowRoot;
    expect(root.querySelector('lit-typeahead')).toBeNull();
  });

  it('renders the typeahead when projects exist', async () => {
    mockDbClient.getProjects.mockResolvedValue([
      { id: 'p1', name: 'Project A', readable_id: 'p1' },
    ]);
    const el = await mount();
    const root = el.shadowRoot as ShadowRoot;
    expect(root.querySelector('lit-typeahead')).not.toBeNull();
  });

  it('includes an "All" default option', async () => {
    mockDbClient.getProjects.mockResolvedValue([
      { id: 'p1', name: 'Project A', readable_id: 'p1' },
    ]);
    const el = await mount();
    const root = el.shadowRoot as ShadowRoot;
    const typeahead = root.querySelector('lit-typeahead') as HTMLElement & {
      items: Array<{ label: string; value: string }>;
    };
    expect(typeahead.items[0].label).toBe('All');
    expect(typeahead.items[0].value).toBe('');
  });

  it('includes project names in the items list', async () => {
    mockDbClient.getProjects.mockResolvedValue([
      { id: 'p1', name: 'Project A', readable_id: 'p1' },
      { id: 'p2', name: 'Project B', readable_id: 'p2' },
    ]);
    const el = await mount();
    const root = el.shadowRoot as ShadowRoot;
    const typeahead = root.querySelector('lit-typeahead') as HTMLElement & {
      items: Array<{ label: string; value: string }>;
    };
    const labels = typeahead.items.map((i) => i.label);
    expect(labels).toContain('Project A');
    expect(labels).toContain('Project B');
  });
});
