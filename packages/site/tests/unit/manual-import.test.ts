import type {
  IngestionReceipt,
  ManualIngestionDetection,
  ProjectListItem,
} from '@lucasschirm/sal-db';
import type { LitElement } from 'lit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnalyticsClient } from '../../src/db/analytics-client';
import type { AnalyticsRequest, AnalyticsResponse } from '../../src/db/analytics-protocol';
import '../../src/components/manual-import/manual-import-harness-selector';
import '../../src/components/manual-import/manual-import-project-workspace';
import '../../src/components/manual-import/manual-import-state';
import '../../src/components/manual-import/manual-import-upload';
import '../../src/pages/manual-import/manual-import-page';
import type { ManualImportHarnessSelector } from '../../src/components/manual-import/manual-import-harness-selector';
import type { ManualImportProjectWorkspace } from '../../src/components/manual-import/manual-import-project-workspace';
import type { ManualImportState } from '../../src/components/manual-import/manual-import-state';
import type {
  ManualImportUpload,
  ManualUploadSelection,
} from '../../src/components/manual-import/manual-import-upload';
import type { UploadedFile } from '../../src/lib/uploaded-file';
import type { ManualImportPage } from '../../src/pages/manual-import/manual-import-page';

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

function fakeFile(name: string, content: string): File {
  const blob = new Blob([content], { type: 'application/jsonl' });
  return new File([blob], name, { type: 'application/jsonl' });
}

function fakeUploaded(name: string, relativePath: string, content: string): UploadedFile {
  return { file: fakeFile(name, content), relativePath };
}

/** Minimal Worker double that records posted messages and lets tests reply. */
class FakeWorker {
  onmessage: ((event: MessageEvent<AnalyticsResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  posted: AnalyticsRequest[] = [];

  postMessage(request: AnalyticsRequest): void {
    this.posted.push(request);
  }

  respond(response: AnalyticsResponse): void {
    this.onmessage?.({ data: response } as MessageEvent<AnalyticsResponse>);
  }

  fail(message: string): void {
    this.onerror?.({ message } as ErrorEvent);
  }
}

function backendReport(): AnalyticsResponse {
  return {
    id: 1,
    ok: true,
    backend: {
      backendName: 'wasm-memory',
      durability: 'ephemeral',
      journalMode: 'delete',
      storage: 'memory',
    },
    storage: 'memory',
  };
}

function matchedDetection(): ManualIngestionDetection {
  return {
    kind: 'matched',
    harness: 'claude-code',
    confidence: 1,
    reason: 'schema detection matched a single transformer',
  };
}

function committedReceipt(): IngestionReceipt {
  return {
    status: 'committed',
    generationId: 'gen-1',
    sessionId: 'se-1',
    analysisReleaseId: 'r1',
    issueIds: [],
  };
}

function conflictReceipt(): IngestionReceipt {
  return {
    status: 'failed',
    generationId: '',
    sessionId: 'se-1',
    analysisReleaseId: 'r1',
    issueIds: ['manual_conflict'],
  };
}

describe('manual-import components', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('manual-import-upload forwards uploads with path preservation', async () => {
    const upload = await mount(
      document.createElement('manual-import-upload') as ManualImportUpload,
    );
    const zone = upload.shadowRoot?.querySelector('upload-zone') as LitElement | null;
    expect(zone).not.toBeNull();

    const files: UploadedFile[] = [
      fakeUploaded('transcript.jsonl', 'transcript.jsonl', 'line1\nline2\n'),
    ];

    let selection: ManualUploadSelection | null = null;
    upload.addEventListener('manual-files-selected', (event) => {
      selection = (event as CustomEvent<ManualUploadSelection>).detail;
    });

    zone?.dispatchEvent(
      new CustomEvent('files-selected', {
        detail: { files, source: 'picker', pathPreserved: false },
        bubbles: true,
        composed: true,
      }),
    );

    await flush(upload);
    expect(selection).not.toBeNull();
    const selected = selection as unknown as ManualUploadSelection;
    expect(selected.files).toEqual(files);
    expect(selected.pathPreserved).toBe(false);

    const disclosure = upload.shadowRoot?.querySelector('.path-disclosure') as HTMLElement | null;
    expect(disclosure?.textContent).toContain('not');
  });

  it('manual-import-harness-selector renders matched detection', async () => {
    const selector = document.createElement(
      'manual-import-harness-selector',
    ) as ManualImportHarnessSelector;
    selector.detection = matchedDetection();
    selector.selectedHarness = 'claude-code';
    await mount(selector);

    const text = selector.shadowRoot?.textContent ?? '';
    expect(text).toContain('claude-code');
    expect(text).toContain('schema detection matched');
  });

  it('manual-import-harness-selector emits harness-changed for ambiguous detection', async () => {
    const selector = document.createElement(
      'manual-import-harness-selector',
    ) as ManualImportHarnessSelector;
    selector.detection = {
      kind: 'ambiguous',
      candidates: ['claude-code', 'mcp'],
      reason: 'multiple harnesses matched',
    };
    await mount(selector);

    let chosen: string | null = null;
    selector.addEventListener('harness-changed', (event) => {
      chosen = (event as CustomEvent<{ harness: string }>).detail.harness;
    });

    const input = selector.shadowRoot?.querySelector(
      'input[value="mcp"]',
    ) as HTMLInputElement | null;
    input?.click();
    await flush(selector);

    expect(chosen).toBe('mcp');
  });

  it('manual-import-project-workspace emits value-changed on user input', async () => {
    const selector = document.createElement(
      'manual-import-project-workspace',
    ) as ManualImportProjectWorkspace;
    selector.projects = [
      { projectId: 'prj-1', name: 'One', sessionCount: 0, harness: '' },
      { projectId: 'prj-2', name: 'Two', sessionCount: 3, harness: '' },
    ] as unknown as ProjectListItem[];
    await mount(selector);

    let value = (selector as unknown as { workspaceId: string }).workspaceId;
    expect(value).toBe('');

    const input = selector.shadowRoot?.querySelector('#workspace-input') as HTMLInputElement | null;
    if (input) {
      input.value = 'staging';
      input.dispatchEvent(new Event('input'));
    }
    await flush(selector);

    value = (selector as unknown as { workspaceId: string }).workspaceId;
    expect(value).toBe('staging');
  });

  it('manual-import-state renders the partial-snapshot label', async () => {
    const state = document.createElement('manual-import-state') as ManualImportState;
    state.phase = 'partial';
    state.receipt = committedReceipt();
    await mount(state);

    const text = state.shadowRoot?.textContent ?? '';
    expect(text).toContain('Partial Snapshot');
    expect(text).toContain('later authoritative sync');
  });

  it('manual-import-state emits conflict resolution', async () => {
    const state = document.createElement('manual-import-state') as ManualImportState;
    state.phase = 'conflict';
    state.error = 'manual_conflict';
    await mount(state);

    let resolution: 'replace' | 'keep' | null = null;
    state.addEventListener('conflict-resolution', (event) => {
      resolution = (event as CustomEvent<{ resolution: 'replace' | 'keep' }>).detail.resolution;
    });

    const button = state.shadowRoot?.querySelector('button.primary') as HTMLButtonElement | null;
    button?.click();
    await flush(state);

    expect(resolution).toBe('replace');
  });
});

describe('AnalyticsClient manual methods', () => {
  let worker: FakeWorker;
  let client: AnalyticsClient;

  beforeEach(() => {
    worker = new FakeWorker();
    client = new AnalyticsClient(() => worker as unknown as Worker);
  });

  it('detects a manual harness', async () => {
    void client.ensureReady();
    worker.respond(backendReport());

    const artifact = {
      relativePath: 'transcript.jsonl',
      mediaType: 'application/jsonl',
      content: '{}',
    };
    const detectionPromise = client.manual.detect([artifact]);

    expect(worker.posted[1].type).toBe('detectManualHarness');
    expect(
      (worker.posted[1] as Extract<AnalyticsRequest, { type: 'detectManualHarness' }>).artifacts,
    ).toEqual([artifact]);

    worker.respond({ id: worker.posted[1].id, ok: true, result: matchedDetection() });
    await expect(detectionPromise).resolves.toEqual(matchedDetection());
  });

  it('ingests a manual bundle', async () => {
    void client.ensureReady();
    worker.respond(backendReport());

    const bundle = {
      artifacts: [
        { relativePath: 'transcript.jsonl', mediaType: 'application/jsonl', content: '{}' },
      ],
      source: { sourceId: 'manual', projectId: 'p1', sessionId: 's1' },
      harness: 'claude-code',
      projectId: 'p1',
      sessionId: 's1',
    };
    const ingestPromise = client.manual.ingest(bundle);

    expect(worker.posted[1].type).toBe('ingestManualBundle');
    expect(
      (worker.posted[1] as Extract<AnalyticsRequest, { type: 'ingestManualBundle' }>).bundle,
    ).toEqual(bundle);

    worker.respond({ id: worker.posted[1].id, ok: true, result: committedReceipt() });
    await expect(ingestPromise).resolves.toEqual(committedReceipt());
  });

  it('resolves a manual conflict', async () => {
    void client.ensureReady();
    worker.respond(backendReport());

    const bundle = {
      artifacts: [
        { relativePath: 'transcript.jsonl', mediaType: 'application/jsonl', content: '{}' },
      ],
      source: { sourceId: 'manual', projectId: 'p1', sessionId: 's1' },
      harness: 'claude-code',
      projectId: 'p1',
      sessionId: 's1',
    };
    const resolvePromise = client.manual.resolveConflict(bundle, 'replace');

    expect(worker.posted[1].type).toBe('resolveManualConflict');
    const request = worker.posted[1] as Extract<
      AnalyticsRequest,
      { type: 'resolveManualConflict' }
    >;
    expect(request.bundle).toEqual(bundle);
    expect(request.resolution).toBe('replace');

    worker.respond({ id: worker.posted[1].id, ok: true, result: committedReceipt() });
    await expect(resolvePromise).resolves.toEqual(committedReceipt());
  });
});

describe('ManualImportPage flow', () => {
  let fakeClient: ManualImportPage['client'];

  beforeEach(() => {
    // The page constructor uses `new AnalyticsClient()`, which tries to create
    // a Web Worker. Provide a minimal Worker stub so the element can be
    // instantiated, then replace the client before the element is mounted.
    vi.stubGlobal(
      'Worker',
      class StubWorker {
        onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
        onerror: ((event: ErrorEvent) => void) | null = null;
        postMessage(): void {}
      },
    );

    fakeClient = {
      portfolio: { getProjectList: vi.fn().mockResolvedValue({ items: [] }) },
      manual: {
        detect: vi.fn().mockResolvedValue(matchedDetection()),
        ingest: vi.fn().mockResolvedValue(committedReceipt()),
        resolveConflict: vi.fn().mockResolvedValue(committedReceipt()),
      },
    } as unknown as ManualImportPage['client'];
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function mountPage(): Promise<ManualImportPage> {
    const page = document.createElement('manual-import-page') as ManualImportPage;
    page.client = fakeClient;
    await mount(page);
    return page;
  }

  function fakeFileWithText(name: string, text: string): File {
    return { name, size: text.length, text: async () => text } as unknown as File;
  }

  it('loads projects on mount', async () => {
    fakeClient.portfolio.getProjectList = vi.fn().mockResolvedValue({
      items: [
        { projectId: 'prj-1', name: 'Fixture', sessionCount: 2, harness: '' },
      ] as unknown as ProjectListItem[],
    });
    const page = await mountPage();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await flush(page);

    expect(fakeClient.portfolio.getProjectList).toHaveBeenCalled();
    const projectWorkspace = page.shadowRoot?.querySelector(
      'manual-import-project-workspace',
    ) as ManualImportProjectWorkspace | null;
    expect(projectWorkspace?.projects).toHaveLength(1);
  });

  it('detects harness and prepares a bundle from uploaded files', async () => {
    const page = await mountPage();
    const upload = page.shadowRoot?.querySelector(
      'manual-import-upload',
    ) as ManualImportUpload | null;
    expect(upload).not.toBeNull();

    const file = fakeFileWithText('transcript.jsonl', '{"type":"message"}\n');
    const files: UploadedFile[] = [{ file, relativePath: 'transcript.jsonl' }];
    upload?.dispatchEvent(
      new CustomEvent('manual-files-selected', {
        detail: { files, pathPreserved: false },
        bubbles: true,
        composed: true,
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    await flush(page);

    const detectMock = vi.mocked(fakeClient.manual.detect, true);
    expect(detectMock).toHaveBeenCalledTimes(1);
    const payload = detectMock.mock.calls[0][0];
    expect(payload).toHaveLength(1);
    expect(payload[0].relativePath).toBe('transcript.jsonl');
    expect(payload[0].mediaType).toBe('application/jsonl');

    const state = page.shadowRoot?.querySelector('manual-import-state') as ManualImportState | null;
    expect(state?.phase).toBe('ready');
    const selector = page.shadowRoot?.querySelector(
      'manual-import-harness-selector',
    ) as ManualImportHarnessSelector | null;
    expect(selector?.selectedHarness).toBe('claude-code');
  });

  it('imports a partial session and shows the partial label', async () => {
    const page = await mountPage();
    const file = fakeFileWithText('session-a.jsonl', '{"type":"message"}\n');
    const files: UploadedFile[] = [{ file, relativePath: 'session-a.jsonl' }];

    const upload = page.shadowRoot?.querySelector(
      'manual-import-upload',
    ) as ManualImportUpload | null;
    upload?.dispatchEvent(
      new CustomEvent('manual-files-selected', {
        detail: { files, pathPreserved: true },
        bubbles: true,
        composed: true,
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    await flush(page);

    // Set project/workspace/session via the workspace component event.
    const workspace = page.shadowRoot?.querySelector(
      'manual-import-project-workspace',
    ) as ManualImportProjectWorkspace | null;
    workspace?.dispatchEvent(
      new CustomEvent('value-changed', {
        detail: {
          value: {
            projectId: 'my-project',
            isNewProject: false,
            workspaceId: 'dev',
            sessionId: 'session-a',
          },
        },
        bubbles: true,
        composed: true,
      }),
    );
    await flush(page);

    const importButton = page.shadowRoot?.querySelector(
      'button.primary',
    ) as HTMLButtonElement | null;
    importButton?.click();

    await new Promise((resolve) => setTimeout(resolve, 0));
    await flush(page);

    const ingestMock = vi.mocked(fakeClient.manual.ingest, true);
    expect(ingestMock).toHaveBeenCalledTimes(1);
    const bundle = ingestMock.mock.calls[0][0];
    expect(bundle.projectId).toBe('my-project');
    expect(bundle.sessionId).toBe('session-a');
    expect(bundle.workspaceId).toBe('dev');
    expect(bundle.harness).toBe('claude-code');
    expect(bundle.artifacts).toHaveLength(1);

    const state = page.shadowRoot?.querySelector('manual-import-state') as ManualImportState | null;
    expect(state?.phase).toBe('partial');
  });

  it('surfaces a conflict and lets the user replace it', async () => {
    fakeClient.manual.ingest = vi.fn().mockResolvedValue(conflictReceipt());
    const page = await mountPage();

    const file = fakeFileWithText('session-b.jsonl', '{"type":"message"}\n');
    const files: UploadedFile[] = [{ file, relativePath: 'session-b.jsonl' }];
    const upload = page.shadowRoot?.querySelector(
      'manual-import-upload',
    ) as ManualImportUpload | null;
    upload?.dispatchEvent(
      new CustomEvent('manual-files-selected', {
        detail: { files, pathPreserved: true },
        bubbles: true,
        composed: true,
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    await flush(page);

    page.shadowRoot?.querySelector('manual-import-project-workspace')?.dispatchEvent(
      new CustomEvent('value-changed', {
        detail: {
          value: {
            projectId: 'my-project',
            isNewProject: false,
            workspaceId: '',
            sessionId: 'session-b',
          },
        },
        bubbles: true,
        composed: true,
      }),
    );
    await flush(page);

    (page.shadowRoot?.querySelector('button.primary') as HTMLButtonElement | null)?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await flush(page);

    const state = page.shadowRoot?.querySelector('manual-import-state') as ManualImportState | null;
    expect(state?.phase).toBe('conflict');

    (state?.shadowRoot?.querySelector('button.primary') as HTMLButtonElement | null)?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await flush(page);

    expect(vi.mocked(fakeClient.manual.resolveConflict, true)).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'my-project', sessionId: 'session-b' }),
      'replace',
    );

    const finalState = page.shadowRoot?.querySelector(
      'manual-import-state',
    ) as ManualImportState | null;
    expect(finalState?.phase).toBe('partial');
  });
});
