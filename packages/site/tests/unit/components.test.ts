import type { LitElement } from 'lit';
import { afterEach, describe, expect, it } from 'vitest';
import '../../src/components/metrics-card';
import '../../src/components/session-list';
import '../../src/components/events-table';
import '../../src/components/project-selector';
import '../../src/components/project-modal';
import '../../src/components/upload-zone';
import type { EventsTable } from '../../src/components/events-table';
import type { MetricsCard } from '../../src/components/metrics-card';
import type { ProjectModal } from '../../src/components/project-modal';
import type { ProjectSelector } from '../../src/components/project-selector';
import type { SessionList } from '../../src/components/session-list';
import type { UploadZone } from '../../src/components/upload-zone';
import type { UploadedFile } from '../../src/lib/subagents';
import type { DashboardSession, Project } from '../../src/types';

async function mount<T extends LitElement>(element: T): Promise<T> {
  document.body.appendChild(element);
  await element.updateComplete;
  return element;
}

afterEach(() => {
  document.body.innerHTML = '';
});

function shadow(element: LitElement): ShadowRoot {
  expect(element.shadowRoot).not.toBeNull();
  return element.shadowRoot as ShadowRoot;
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
    context_compactions: 0,
    total_turns: 1,
    files_read: 0,
    files_written: 0,
    agent_invocations: 0,
    tool_executions: [],
    events: [],
    messages: [],
    tasks: [],
    subagents: [],
    ...overrides,
  };
}

function projectFixture(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: 'Project One',
    description: 'First project',
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_000,
    session_count: 3,
    ...overrides,
  };
}

describe('metrics-card', () => {
  it('renders value, label, icon and sub-detail', async () => {
    const card = await mount(
      Object.assign(document.createElement('metrics-card'), {
        label: 'Total Tokens',
        value: '1,234',
        icon: '🔤',
        sub: 'extra detail',
      }) as MetricsCard,
    );

    const root = shadow(card);
    expect(root.textContent).toContain('1,234');
    expect(root.textContent).toContain('Total Tokens');
    expect(root.textContent).toContain('🔤');
    expect(root.textContent).toContain('extra detail');
  });

  it('renders as a non-interactive div by default', async () => {
    const card = await mount(document.createElement('metrics-card') as MetricsCard);
    const root = shadow(card);

    expect(root.querySelector('div.metrics-card')).not.toBeNull();
    expect(root.querySelector('button')).toBeNull();
  });

  it('renders as a button and emits card-click when clickable', async () => {
    const card = await mount(
      Object.assign(document.createElement('metrics-card'), {
        clickable: true,
        label: 'Files Written',
      }) as MetricsCard,
    );
    const root = shadow(card);

    const button = root.querySelector('button.metrics-card') as HTMLButtonElement;
    expect(button).not.toBeNull();

    let detail: unknown = null;
    card.addEventListener('card-click', (event) => {
      detail = (event as CustomEvent).detail;
    });
    button.click();

    expect(detail).toEqual({ label: 'Files Written' });
  });
});

describe('session-list', () => {
  it('shows an empty state without sessions', async () => {
    const list = await mount(document.createElement('session-list') as SessionList);
    expect(shadow(list).textContent).toContain('No sessions found');
  });

  it('renders rows and emits session-click with the session id', async () => {
    const list = await mount(
      Object.assign(document.createElement('session-list'), {
        sessions: [
          sessionFixture(),
          sessionFixture({ id: 's2', title: 'second.jsonl', source: 'mcp' }),
        ],
      }) as SessionList,
    );
    const root = shadow(list);

    const rows = root.querySelectorAll('.session-item');
    expect(rows.length).toBe(2);
    expect(root.textContent).toContain('fixture.jsonl');
    expect(root.textContent).toContain('second.jsonl');
    expect(root.textContent).toContain('mcp');

    let sessionId = '';
    list.addEventListener('session-click', (event) => {
      sessionId = (event as CustomEvent<{ sessionId: string }>).detail.sessionId;
    });
    (rows[1] as HTMLButtonElement).click();
    expect(sessionId).toBe('s2');
  });
});

describe('events-table', () => {
  it('shows an empty state without events', async () => {
    const table = await mount(document.createElement('events-table') as EventsTable);
    expect(shadow(table).textContent).toContain('No events recorded');
  });

  it('renders rows with timestamps, types and descriptions', async () => {
    const table = await mount(
      Object.assign(document.createElement('events-table'), {
        events: [
          {
            id: 'e1',
            timestamp: 1_700_000_000_000,
            event_type: 'tool_exec',
            description: 'npm run build',
          },
          {
            id: 'e2',
            timestamp: 1_700_000_010_000,
            event_type: 'file_write',
            description: 'dist/main.js',
          },
        ],
      }) as EventsTable,
    );
    const root = shadow(table);

    expect(root.querySelectorAll('tbody tr').length).toBe(2);
    expect(root.textContent).toContain('tool_exec');
    expect(root.textContent).toContain('npm run build');
    expect(root.querySelectorAll('th').length).toBe(3);
  });

  it('adds a metadata column when showMetadata is set', async () => {
    const table = await mount(
      Object.assign(document.createElement('events-table'), {
        showMetadata: true,
        events: [
          {
            id: 'e1',
            timestamp: 1_700_000_000_000,
            event_type: 'message_start',
            description: 'x',
            metadata: { usage: { input_tokens: 5 } },
          },
        ],
      }) as EventsTable,
    );
    const root = shadow(table);

    expect(root.querySelectorAll('th').length).toBe(4);
    expect(root.textContent).toContain('Metadata');
    expect(root.textContent).toContain('input_tokens');
  });

  it('shows a full-content tooltip and expands the metadata cell inline on click', async () => {
    const metadata = { usage: { input_tokens: 5, output_tokens: 500_000 } };
    const table = await mount(
      Object.assign(document.createElement('events-table'), {
        showMetadata: true,
        events: [
          {
            id: 'e1',
            timestamp: 1_700_000_000_000,
            event_type: 'assistant_turn',
            description: 'x',
            metadata,
          },
        ],
      }) as EventsTable,
    );
    const root = shadow(table);
    const fullJson = JSON.stringify(metadata, null, 2);

    const cell = root.querySelector('.metadata-cell') as HTMLElement;
    expect(cell.title).toBe(fullJson);
    expect(cell.querySelector('.metadata-full')).toBeNull();
    expect(cell.querySelector('.metadata-preview')).not.toBeNull();

    cell.click();
    await table.updateComplete;

    expect(cell.querySelector('.metadata-full')?.textContent).toBe(fullJson);
    expect(cell.querySelector('.metadata-preview')).toBeNull();

    cell.click();
    await table.updateComplete;

    expect(cell.querySelector('.metadata-full')).toBeNull();
  });
});

describe('project-selector', () => {
  it('renders options and emits value-changed on selection', async () => {
    const selector = await mount(
      Object.assign(document.createElement('project-selector'), {
        projects: [
          projectFixture(),
          projectFixture({ id: 'p2', name: 'Project Two', session_count: 1 }),
        ],
      }) as ProjectSelector,
    );
    const root = shadow(selector);

    const options = root.querySelectorAll('option');
    expect(options.length).toBe(3); // placeholder + 2 projects
    expect(options[1].textContent).toContain('Project One');
    expect(options[1].textContent).toContain('3 sessions');
    expect(options[2].textContent).toContain('1 session');

    let emitted = '';
    selector.addEventListener('value-changed', (event) => {
      emitted = (event as CustomEvent<{ value: string }>).detail.value;
    });

    const select = root.querySelector('select') as HTMLSelectElement;
    select.value = 'p2';
    select.dispatchEvent(new Event('change'));

    expect(emitted).toBe('p2');
  });
});

describe('project-modal', () => {
  async function settle(modal: ProjectModal): Promise<void> {
    await modal.updateComplete;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it('renders nothing while closed', async () => {
    const modal = await mount(document.createElement('project-modal') as ProjectModal);
    expect(shadow(modal).querySelector('.project-modal')).toBeNull();
  });

  it('auto-fills a slug from the name as the user types', async () => {
    const modal = await mount(
      Object.assign(document.createElement('project-modal'), {
        open: true,
      }) as ProjectModal,
    );
    await settle(modal);
    const root = shadow(modal);

    const nameInput = root.querySelector('#project-name-input') as HTMLInputElement;
    const idInput = root.querySelector('#project-id-input') as HTMLInputElement;

    nameInput.value = 'My Project';
    nameInput.dispatchEvent(new Event('input'));
    await settle(modal);

    expect(idInput.value).toBe('my-project');
  });

  it('does not overwrite a manually edited id when the name changes', async () => {
    const modal = await mount(
      Object.assign(document.createElement('project-modal'), {
        open: true,
      }) as ProjectModal,
    );
    await settle(modal);
    const root = shadow(modal);

    const nameInput = root.querySelector('#project-name-input') as HTMLInputElement;
    const idInput = root.querySelector('#project-id-input') as HTMLInputElement;

    nameInput.value = 'My Project';
    nameInput.dispatchEvent(new Event('input'));
    await settle(modal);

    idInput.value = 'custom-id';
    idInput.dispatchEvent(new Event('input'));
    await settle(modal);

    nameInput.value = 'Other Project';
    nameInput.dispatchEvent(new Event('input'));
    await settle(modal);

    expect(idInput.value).toBe('custom-id');
  });

  it('emits project-create with trimmed values and readable id on submit', async () => {
    const modal = await mount(
      Object.assign(document.createElement('project-modal'), {
        open: true,
      }) as ProjectModal,
    );
    await settle(modal);
    const root = shadow(modal);

    const nameInput = root.querySelector('#project-name-input') as HTMLInputElement;
    const descriptionInput = root.querySelector(
      '#project-description-input',
    ) as HTMLTextAreaElement;
    expect(nameInput).not.toBeNull();

    nameInput.value = '  My Project  ';
    nameInput.dispatchEvent(new Event('input'));
    descriptionInput.value = ' Some description ';
    descriptionInput.dispatchEvent(new Event('input'));
    await settle(modal);

    let detail: { name: string; description: string; readableId: string } | null = null;
    modal.addEventListener('project-create', (event) => {
      detail = (event as CustomEvent<{ name: string; description: string; readableId: string }>)
        .detail;
    });

    const form = root.querySelector('form') as HTMLFormElement;
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(detail).toEqual({
      name: 'My Project',
      description: 'Some description',
      readableId: 'my-project',
    });
  });

  it('disables submit while the name or id is invalid', async () => {
    const modal = await mount(
      Object.assign(document.createElement('project-modal'), {
        open: true,
      }) as ProjectModal,
    );
    await settle(modal);

    const root = shadow(modal);
    const submit = root.querySelector('button.primary') as HTMLButtonElement;
    const idInput = root.querySelector('#project-id-input') as HTMLInputElement;
    expect(submit.disabled).toBe(true);

    idInput.value = 'invalid id!';
    idInput.dispatchEvent(new Event('input'));
    await settle(modal);

    expect(idInput.value).toBe('invalid id!');
    expect(submit.disabled).toBe(true);
    expect(root.textContent).toContain('lowercase letters, numbers, and hyphens');
  });

  it('rejects the reserved id global and treats it as taken by slug generation', async () => {
    const modal = await mount(
      Object.assign(document.createElement('project-modal'), {
        open: true,
      }) as ProjectModal,
    );
    await settle(modal);
    const root = shadow(modal);

    const nameInput = root.querySelector('#project-name-input') as HTMLInputElement;
    const idInput = root.querySelector('#project-id-input') as HTMLInputElement;

    nameInput.value = 'global';
    nameInput.dispatchEvent(new Event('input'));
    await settle(modal);

    // Slug generation skips the reserved value and auto-suffixes.
    expect(idInput.value).toBe('global-2');
    expect(root.textContent).not.toContain('reserved');

    idInput.value = 'global';
    idInput.dispatchEvent(new Event('input'));
    await settle(modal);

    expect(root.textContent).toContain('This project ID is reserved');
  });

  it('deduplicates against local and remote folder names for remote-aware slugs', async () => {
    const modal = await mount(
      Object.assign(document.createElement('project-modal'), {
        open: true,
        getLocalProjectIds: () => Promise.resolve(['alpha']),
        getRemoteFolderNames: () => Promise.resolve(['beta']),
      }) as ProjectModal,
    );
    await settle(modal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await settle(modal);

    const root = shadow(modal);
    const nameInput = root.querySelector('#project-name-input') as HTMLInputElement;
    const idInput = root.querySelector('#project-id-input') as HTMLInputElement;

    nameInput.value = 'alpha';
    nameInput.dispatchEvent(new Event('input'));
    await settle(modal);
    expect(idInput.value).toBe('alpha-2');

    nameInput.value = 'beta';
    nameInput.dispatchEvent(new Event('input'));
    await settle(modal);
    expect(idInput.value).toBe('beta-2');

    nameInput.value = 'gamma';
    nameInput.dispatchEvent(new Event('input'));
    await settle(modal);
    expect(idInput.value).toBe('gamma');
  });

  it('prefills the id read-only in sync-discovery mode', async () => {
    const modal = await mount(
      Object.assign(document.createElement('project-modal'), {
        open: true,
        mode: 'sync-discovery',
        initialReadableId: 'discovered-folder',
        readonlyId: true,
      }) as ProjectModal,
    );
    await settle(modal);

    const root = shadow(modal);
    const idInput = root.querySelector('#project-id-input') as HTMLInputElement;
    expect(idInput.value).toBe('discovered-folder');
    expect(idInput.readOnly || idInput.disabled).toBe(true);

    const nameInput = root.querySelector('#project-name-input') as HTMLInputElement;
    nameInput.value = 'Discovered Name';
    nameInput.dispatchEvent(new Event('input'));
    await settle(modal);

    expect(idInput.value).toBe('discovered-folder');
  });

  it('emits project-edit with the existing project id in edit mode', async () => {
    const modal = await mount(
      Object.assign(document.createElement('project-modal'), {
        open: true,
        mode: 'edit',
        projectId: 'p1',
        initialName: 'My Project',
        initialReadableId: 'my-project',
        initialDescription: 'Original description',
      }) as ProjectModal,
    );
    await settle(modal);

    const root = shadow(modal);
    const nameInput = root.querySelector('#project-name-input') as HTMLInputElement;
    nameInput.value = 'Renamed Project';
    nameInput.dispatchEvent(new Event('input'));
    await settle(modal);

    let detail: { projectId: string; name: string; readableId: string } | null = null;
    modal.addEventListener('project-edit', (event) => {
      detail = (event as CustomEvent<{ projectId: string; name: string; readableId: string }>)
        .detail;
    });

    const form = root.querySelector('form') as HTMLFormElement;
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(detail).toEqual({
      projectId: 'p1',
      name: 'Renamed Project',
      description: 'Original description',
      readableId: 'my-project',
    });
  });

  it('emits modal-close on cancel and overlay click', async () => {
    const modal = await mount(
      Object.assign(document.createElement('project-modal'), {
        open: true,
      }) as ProjectModal,
    );
    await settle(modal);
    const root = shadow(modal);

    let closed = 0;
    modal.addEventListener('modal-close', () => closed++);

    (root.querySelector('button.secondary') as HTMLButtonElement).click();
    expect(closed).toBe(1);

    const overlay = root.querySelector('.project-modal') as HTMLDivElement;
    overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(closed).toBe(2);
  });

  it('emits modal-close on Escape', async () => {
    const modal = await mount(
      Object.assign(document.createElement('project-modal'), {
        open: true,
      }) as ProjectModal,
    );
    await settle(modal);

    let closed = 0;
    modal.addEventListener('modal-close', () => closed++);

    const overlay = shadow(modal).querySelector('.project-modal') as HTMLDivElement;
    overlay.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(closed).toBe(1);
  });

  it('shows a client-side duplicate id error without a DB round-trip', async () => {
    const modal = await mount(
      Object.assign(document.createElement('project-modal'), {
        open: true,
        getLocalProjectIds: () => Promise.resolve(['taken']),
      }) as ProjectModal,
    );
    await settle(modal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await settle(modal);

    const root = shadow(modal);
    const nameInput = root.querySelector('#project-name-input') as HTMLInputElement;
    const idInput = root.querySelector('#project-id-input') as HTMLInputElement;

    nameInput.value = 'My Project';
    nameInput.dispatchEvent(new Event('input'));
    await settle(modal);

    idInput.value = 'taken';
    idInput.dispatchEvent(new Event('input'));
    await settle(modal);

    let created = 0;
    let edited = 0;
    modal.addEventListener('project-create', () => created++);
    modal.addEventListener('project-edit', () => edited++);

    const form = root.querySelector('form') as HTMLFormElement;
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(idInput.value).toBe('taken');
    expect(root.textContent).toContain('This project ID is already in use');
    expect((root.querySelector('button.primary') as HTMLButtonElement).disabled).toBe(true);
    expect(created).toBe(0);
    expect(edited).toBe(0);
  });

  it('emits only modal-close when dismissed in sync-discovery mode', async () => {
    const modal = await mount(
      Object.assign(document.createElement('project-modal'), {
        open: true,
        mode: 'sync-discovery',
        initialReadableId: 'discovered-folder',
        readonlyId: true,
      }) as ProjectModal,
    );
    await settle(modal);

    let closed = 0;
    let created = 0;
    let edited = 0;
    modal.addEventListener('modal-close', () => closed++);
    modal.addEventListener('project-create', () => created++);
    modal.addEventListener('project-edit', () => edited++);

    const root = shadow(modal);
    (root.querySelector('button.secondary') as HTMLButtonElement).click();
    expect(closed).toBe(1);
    expect(created).toBe(0);
    expect(edited).toBe(0);

    const overlay = root.querySelector('.project-modal') as HTMLDivElement;
    overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(closed).toBe(2);
    expect(created).toBe(0);
    expect(edited).toBe(0);
  });
});

describe('upload-zone', () => {
  function fileLike(name: string): File {
    return new File(['content'], name);
  }

  it('emits files-selected from the file picker, filtered by extension', async () => {
    const zone = await mount(document.createElement('upload-zone') as UploadZone);
    const root = shadow(zone);
    const input = root.querySelector('input[type="file"]') as HTMLInputElement;

    let selected: UploadedFile[] = [];
    zone.addEventListener('files-selected', (event) => {
      selected = (event as CustomEvent<{ files: UploadedFile[] }>).detail.files;
    });

    Object.defineProperty(input, 'files', {
      value: [fileLike('session.jsonl'), fileLike('notes.txt'), fileLike('data.log')],
      configurable: true,
    });
    input.dispatchEvent(new Event('change'));

    expect(selected.map((upload) => upload.file.name)).toEqual(['session.jsonl', 'data.log']);
    expect(selected.map((upload) => upload.relativePath)).toEqual(['session.jsonl', 'data.log']);
    expect(input.value).toBe('');
  });

  it('emits files-selected on drop', async () => {
    const zone = await mount(document.createElement('upload-zone') as UploadZone);
    const root = shadow(zone);
    const dropArea = root.querySelector('.upload-zone') as HTMLDivElement;

    let selected: UploadedFile[] = [];
    zone.addEventListener('files-selected', (event) => {
      selected = (event as CustomEvent<{ files: UploadedFile[] }>).detail.files;
    });

    const dropEvent = new Event('drop', { cancelable: true });
    Object.defineProperty(dropEvent, 'dataTransfer', {
      value: { files: [fileLike('claude.json')] },
    });
    dropArea.dispatchEvent(dropEvent);
    await zone.updateComplete;

    expect(selected.map((upload) => upload.file.name)).toEqual(['claude.json']);
  });

  it('ignores drops without supported files', async () => {
    const zone = await mount(document.createElement('upload-zone') as UploadZone);
    const dropArea = shadow(zone).querySelector('.upload-zone') as HTMLDivElement;

    let called = 0;
    zone.addEventListener('files-selected', () => called++);

    const dropEvent = new Event('drop', { cancelable: true });
    Object.defineProperty(dropEvent, 'dataTransfer', { value: { files: [fileLike('image.png')] } });
    dropArea.dispatchEvent(dropEvent);
    await zone.updateComplete;

    expect(called).toBe(0);
  });

  it('recursively reads a dropped folder via the File and Directory Entries API', async () => {
    const zone = await mount(document.createElement('upload-zone') as UploadZone);
    const dropArea = shadow(zone).querySelector('.upload-zone') as HTMLDivElement;

    let selected: UploadedFile[] = [];
    zone.addEventListener('files-selected', (event) => {
      selected = (event as CustomEvent<{ files: UploadedFile[] }>).detail.files;
    });

    const mainFile = fileLike('agent-abc.jsonl');
    const metaFile = fileLike('agent-abc.meta.json');
    const fileEntry = (file: File, name: string) => ({
      isFile: true,
      isDirectory: false,
      name,
      file: (resolve: (file: File) => void) => resolve(file),
    });
    const subagentsDirEntry = {
      isFile: false,
      isDirectory: true,
      name: 'subagents',
      createReader: () => {
        let read = false;
        return {
          readEntries: (callback: (entries: unknown[]) => void) => {
            if (read) {
              callback([]);
            } else {
              read = true;
              callback([
                fileEntry(mainFile, 'agent-abc.jsonl'),
                fileEntry(metaFile, 'agent-abc.meta.json'),
              ]);
            }
          },
        };
      },
    };

    const dropEvent = new Event('drop', { cancelable: true });
    Object.defineProperty(dropEvent, 'dataTransfer', {
      value: {
        items: [{ webkitGetAsEntry: () => subagentsDirEntry }],
        files: [],
      },
    });
    dropArea.dispatchEvent(dropEvent);
    await zone.updateComplete;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(selected.map((upload) => upload.relativePath).sort()).toEqual([
      'subagents/agent-abc.jsonl',
      'subagents/agent-abc.meta.json',
    ]);
  });

  it('toggles the dragging style on dragenter/dragleave', async () => {
    const zone = await mount(document.createElement('upload-zone') as UploadZone);
    const dropArea = shadow(zone).querySelector('.upload-zone') as HTMLDivElement;

    dropArea.dispatchEvent(new Event('dragenter', { cancelable: true }));
    await zone.updateComplete;
    expect(
      (shadow(zone).querySelector('.upload-zone') as HTMLDivElement).classList.contains('dragging'),
    ).toBe(true);

    dropArea.dispatchEvent(new Event('dragleave', { cancelable: true }));
    await zone.updateComplete;
    expect(
      (shadow(zone).querySelector('.upload-zone') as HTMLDivElement).classList.contains('dragging'),
    ).toBe(false);
  });

  it('accepts .json,.jsonl,.log files', async () => {
    const zone = await mount(document.createElement('upload-zone') as UploadZone);
    const input = shadow(zone).querySelector('input[type="file"]') as HTMLInputElement;
    expect(input.accept).toBe('.json,.jsonl,.log');
    expect(input.multiple).toBe(true);
  });
});
