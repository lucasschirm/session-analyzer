/**
 * @vitest-environment node
 */

import type { SyncManifest } from '@lucasschirm/sal-sync-core';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseManager } from '../../src/db/database';
import { type DbClient, dbClient } from '../../src/db/db-client';
import type { DbRequest, DbResponse } from '../../src/db/db-protocol';
import { decryptField, isUnlocked, unlock } from '../../src/sync/credential-crypto';
import {
  type DownloadedFile,
  type S3Client,
  SyncManager,
  type SyncManagerOptions,
} from '../../src/sync/sync-manager';
import type {
  SessionSyncMessage,
  SyncMessageFromWorker,
  SyncMessageToWorker,
} from '../../src/sync/sync-protocol';
import type { Connection, StoredS3Credentials } from '../../src/types';
import { generateId } from '../../src/workers/session-builder';

const credentialCryptoMock = vi.hoisted(() => ({
  isUnlocked: vi.fn(),
  unlock: vi.fn(),
  decryptField: vi.fn(),
  createPasskey: vi.fn(),
  lock: vi.fn(),
  forgetPasskey: vi.fn(),
}));

vi.mock('../../src/sync/credential-crypto', () => credentialCryptoMock);

const INIT_TIMEOUT = 1000;

let sqlite3Module: Awaited<ReturnType<typeof sqlite3InitModule>>;

class TestDatabaseManager extends DatabaseManager {
  setSqlite3(sqlite3: typeof sqlite3Module): void {
    const self = this as unknown as { sqlite3: typeof sqlite3Module };
    self.sqlite3 = sqlite3;
  }
}

type DbRequestOf<K extends DbRequest['type']> = Extract<DbRequest, { type: K }>;

class FakeDbWorker {
  onmessage: ((ev: MessageEvent<DbResponse>) => void) | null = null;
  onerror: ((ev: ErrorEvent) => void) | null = null;

  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly manager: DatabaseManager) {}

  postMessage(request: DbRequest): void {
    this.queue = this.queue.then(async () => {
      const response = await this.handleRequest(request);
      const onmessage = this.onmessage;
      if (onmessage) {
        onmessage.call(this as unknown as Worker, { data: response } as MessageEvent<DbResponse>);
      }
    });
  }

  terminate(): void {
    // no-op for in-memory test worker
  }

  private async handleRequest(request: DbRequest): Promise<DbResponse> {
    try {
      return await this.dispatch(request);
    } catch (error) {
      return { id: request.id, ok: false, error: (error as Error).message };
    }
  }

  private async dispatch(request: DbRequest): Promise<DbResponse> {
    const m = this.manager;
    switch (request.type) {
      case 'init': {
        const storage = await m.initialize();
        return { id: request.id, ok: true, storage, fallbackReason: m.fallbackReason };
      }
      case 'createProject':
        m.createProject((request as DbRequestOf<'createProject'>).project);
        return { id: request.id, ok: true };
      case 'getProjects':
        return { id: request.id, ok: true, result: m.getProjects() };
      case 'getProject':
        return {
          id: request.id,
          ok: true,
          result: m.getProject((request as DbRequestOf<'getProject'>).projectId),
        };
      case 'updateProject': {
        const req = request as DbRequestOf<'updateProject'>;
        m.updateProject(req.projectId, req.fields);
        return { id: request.id, ok: true };
      }
      case 'deleteProject':
        m.deleteProject((request as DbRequestOf<'deleteProject'>).projectId);
        return { id: request.id, ok: true };
      case 'saveSession':
        m.saveSession((request as DbRequestOf<'saveSession'>).session);
        return { id: request.id, ok: true };
      case 'upsertSessionByExternalId':
        return {
          id: request.id,
          ok: true,
          result: m.upsertSessionByExternalId(
            (request as DbRequestOf<'upsertSessionByExternalId'>).session,
          ),
        };
      case 'replaceSession':
        m.replaceSession((request as DbRequestOf<'replaceSession'>).session);
        return { id: request.id, ok: true };
      case 'findSessionByExternalId': {
        const req = request as DbRequestOf<'findSessionByExternalId'>;
        return {
          id: request.id,
          ok: true,
          result: m.findSessionByExternalId(req.projectId, req.externalId),
        };
      }
      case 'getSessionsByProject':
        return {
          id: request.id,
          ok: true,
          result: m.getSessionsByProject(
            (request as DbRequestOf<'getSessionsByProject'>).projectId,
          ),
        };
      case 'searchSessions': {
        const req = request as DbRequestOf<'searchSessions'>;
        return { id: request.id, ok: true, result: m.searchSessions(req.projectId, req.query) };
      }
      case 'getSession':
        return {
          id: request.id,
          ok: true,
          result: m.getSession((request as DbRequestOf<'getSession'>).sessionId),
        };
      case 'deleteSession':
        m.deleteSession((request as DbRequestOf<'deleteSession'>).sessionId);
        return { id: request.id, ok: true };
      case 'getProjectMetrics':
        return {
          id: request.id,
          ok: true,
          result: m.getProjectMetrics((request as DbRequestOf<'getProjectMetrics'>).projectId),
        };
      case 'exportDatabase':
        return { id: request.id, ok: true, bytes: m.exportDatabase() };
      case 'createConnection':
        m.createConnection((request as DbRequestOf<'createConnection'>).connection);
        return { id: request.id, ok: true };
      case 'updateConnection': {
        const req = request as DbRequestOf<'updateConnection'>;
        m.updateConnection(req.connectionId, req.fields);
        return { id: request.id, ok: true };
      }
      case 'deleteConnection':
        m.deleteConnection((request as DbRequestOf<'deleteConnection'>).connectionId);
        return { id: request.id, ok: true };
      case 'getConnections':
        return { id: request.id, ok: true, result: m.getConnections() };
      case 'saveS3Credentials':
        m.saveS3Credentials((request as DbRequestOf<'saveS3Credentials'>).credentials);
        return { id: request.id, ok: true };
      case 'getS3Credentials':
        return {
          id: request.id,
          ok: true,
          result: m.getS3Credentials((request as DbRequestOf<'getS3Credentials'>).connectionId),
        };
      case 'deleteAllCredentials':
        m.deleteAllCredentials();
        return { id: request.id, ok: true };
      case 'getPasskeyState':
        return { id: request.id, ok: true, result: m.getPasskeyState() };
      case 'savePasskeyState':
        m.savePasskeyState((request as DbRequestOf<'savePasskeyState'>).state);
        return { id: request.id, ok: true };
      case 'getProjectByReadableId':
        return {
          id: request.id,
          ok: true,
          result: m.getProjectByReadableId(
            (request as DbRequestOf<'getProjectByReadableId'>).readableId,
          ),
        };
      case 'setProjectSyncStatus': {
        const req = request as DbRequestOf<'setProjectSyncStatus'>;
        m.setProjectSyncStatus(req.projectId, req.status);
        return { id: request.id, ok: true };
      }
      case 'backfillReadableIds':
        m.backfillReadableIds();
        return { id: request.id, ok: true };
      case 'getSessionBySyncId': {
        const req = request as DbRequestOf<'getSessionBySyncId'>;
        return {
          id: request.id,
          ok: true,
          result: m.getSessionBySyncId(req.projectId, req.syncSessionId),
        };
      }
      case 'upsertSessionStub':
        m.upsertSessionStub((request as DbRequestOf<'upsertSessionStub'>).stub);
        return { id: request.id, ok: true };
      case 'setSessionSyncStatus': {
        const req = request as DbRequestOf<'setSessionSyncStatus'>;
        m.setSessionSyncStatus(req.sessionId, req.status, req.details);
        return { id: request.id, ok: true };
      }
      case 'updateSessionManifest': {
        const req = request as DbRequestOf<'updateSessionManifest'>;
        m.updateSessionManifest(req.sessionId, req.manifest);
        return { id: request.id, ok: true };
      }
      case 'getSyncRunCount':
        return {
          id: request.id,
          ok: true,
          result: m.getSyncRunCount((request as DbRequestOf<'getSyncRunCount'>).sessionId),
        };
      case 'failStaleSessions': {
        const req = request as DbRequestOf<'failStaleSessions'>;
        m.failStaleSessions(req.projectId, req.details);
        return { id: request.id, ok: true };
      }
      case 'reconcileSyncStates':
        m.reconcileSyncStates((request as DbRequestOf<'reconcileSyncStates'>).sessionDetails);
        return { id: request.id, ok: true };
      case 'getSessionFiles':
        return {
          id: request.id,
          ok: true,
          result: m.getSessionFiles((request as DbRequestOf<'getSessionFiles'>).sessionId),
        };
      case 'upsertSessionFile':
        m.upsertSessionFile((request as DbRequestOf<'upsertSessionFile'>).file);
        return { id: request.id, ok: true };
      default:
        return { id: (request as DbRequest).id, ok: false, error: 'Unknown request type' };
    }
  }
}

class NotFoundError extends Error {
  status = 404;
}

class MockS3Client implements S3Client {
  private readonly store = new Map<string, ArrayBuffer>();

  putBuffer(key: string, buffer: ArrayBuffer): void {
    this.store.set(key, buffer);
  }

  getBuffer(key: string): ArrayBuffer {
    const buffer = this.store.get(key);
    if (!buffer) throw new NotFoundError(`No buffer stored for ${key}`);
    return buffer;
  }

  async listProjectFolders(): Promise<string[]> {
    const projects = new Set<string>();
    for (const key of this.store.keys()) {
      const first = key.split('/')[0];
      if (first) projects.add(first);
    }
    return Array.from(projects);
  }

  async listSessionFolders(projectId: string): Promise<string[]> {
    const sessions = new Set<string>();
    const prefix = `${projectId}/`;
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        const second = key.split('/')[1];
        if (second) sessions.add(second);
      }
    }
    return Array.from(sessions);
  }

  async getObject(key: string): Promise<ArrayBuffer> {
    const buffer = this.store.get(key);
    if (!buffer) throw new NotFoundError(`Object not found: ${key}`);
    return buffer;
  }

  async putObject(key: string, body: ArrayBuffer | Uint8Array): Promise<{ etag?: string }> {
    const buffer: ArrayBuffer =
      body instanceof ArrayBuffer
        ? body
        : (body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer);
    this.store.set(key, buffer);
    return { etag: '1' };
  }
}

class MockWorker {
  onmessage: ((event: MessageEvent<SyncMessageFromWorker>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly posted: SyncMessageToWorker[] = [];
  terminated = false;

  postMessage(message: SyncMessageToWorker): void {
    this.posted.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  receive(message: SyncMessageFromWorker): void {
    if (this.onmessage) {
      this.onmessage({ data: message } as MessageEvent<SyncMessageFromWorker>);
    }
  }
}

class MockEventTarget {
  private listeners: Record<string, EventListener[]> = {};

  addEventListener(type: string, listener: EventListener): void {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(listener);
  }

  removeEventListener(type: string, listener: EventListener): void {
    const list = this.listeners[type];
    if (!list) return;
    const index = list.indexOf(listener);
    if (index !== -1) list.splice(index, 1);
  }

  dispatchEvent(event: Event): boolean {
    const list = this.listeners[event.type] ?? [];
    for (const listener of list) {
      if (typeof listener === 'function') {
        listener(event);
      } else if (listener && typeof listener === 'object' && 'handleEvent' in listener) {
        (listener as EventListenerObject).handleEvent(event);
      }
    }
    return true;
  }
}

class FakeBroadcastChannel {
  private static readonly channels = new Map<string, Set<FakeBroadcastChannel>>();

  onmessage: ((event: MessageEvent) => void) | null = null;
  readonly name: string;

  constructor(name: string) {
    this.name = name;
    if (!FakeBroadcastChannel.channels.has(name)) {
      FakeBroadcastChannel.channels.set(name, new Set());
    }
    FakeBroadcastChannel.channels.get(name)?.add(this);
  }

  postMessage(message: unknown): void {
    const others = FakeBroadcastChannel.channels.get(this.name);
    if (!others) return;
    for (const channel of others) {
      if (channel === this) continue;
      if (channel.onmessage) {
        channel.onmessage({ data: message } as MessageEvent);
      }
    }
  }

  close(): void {
    FakeBroadcastChannel.channels.get(this.name)?.delete(this);
  }

  static clear(): void {
    FakeBroadcastChannel.channels.clear();
  }
}

function textFromBuffer(buffer: ArrayBuffer): string {
  return new TextDecoder().decode(new Uint8Array(buffer));
}

function bufferFromText(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer;
}

function makeConnection(overrides: Partial<Connection> = {}): Connection {
  return {
    id: generateId(),
    name: 'S3 Dev',
    storage_type: 's3',
    sync_only_new: false,
    created_at: Date.now(),
    updated_at: Date.now(),
    ...overrides,
  };
}

function makeS3Credentials(connectionId: string): StoredS3Credentials {
  return {
    connection_id: connectionId,
    region: 'us-east-1',
    bucket: 'session-analyzer-dev',
    endpoint: undefined,
    access_key_id: 'AKIA...',
    secret_access_key_ct: 'ct',
    secret_access_key_iv: 'iv',
    session_token_ct: undefined,
    session_token_iv: undefined,
    created_at: Date.now(),
    updated_at: Date.now(),
  };
}

function makeManifest(
  projectId: string,
  sessionId: string,
  artifacts: Array<{
    relativePath: string;
    sha256: string;
    size: number;
    scope?: 'session' | 'workspace' | 'global' | 'runtime';
  }>,
): SyncManifest {
  return {
    schemaVersion: 2,
    projectId,
    sessionId,
    harness: 'claude',
    harnessVersion: '1',
    syncVersion: '0.1.0',
    pluginVersion: '0.1.0',
    transcriptsCaptured: true,
    mainTranscriptRelativePath: 'transcript.jsonl',
    syncRuns: [
      {
        trigger: 'session-end',
        filesDiscovered: 1,
        filesChanged: 1,
        filesUploaded: 1,
        filesFailed: 0,
        filesSkipped: 0,
        bytesDiscovered: 100,
        bytesChanged: 100,
        bytesUploaded: 100,
        discoveryDurationMs: 0,
        sanitizationDurationMs: 0,
        hashDurationMs: 0,
        uploadDurationMs: 0,
        totalDurationMs: 0,
      },
    ],
    artifacts: artifacts.map((a) => ({
      projectId,
      sessionId,
      scope: a.scope ?? 'session',
      relativePath: a.relativePath,
      sha256: a.sha256,
      size: a.size,
      status: 'uploaded' as const,
    })),
  };
}

function hashOf(value: string): string {
  const hex = Array.from(new TextEncoder().encode(value), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
  return hex.padEnd(64, 'a').slice(0, 64);
}

function makeProjectManifest(
  projectId: string,
  name: string,
  description = '',
): {
  schemaVersion: 1;
  projectId: string;
  name: string;
  description: string;
  createdAt: string;
  writtenBy: string;
} {
  return {
    schemaVersion: 1,
    projectId,
    name,
    description,
    createdAt: '2026-01-01T00:00:00.000Z',
    writtenBy: 'test-suite',
  };
}

function getWorker(workers: MockWorker[]): MockWorker {
  const worker = workers[0];
  if (!worker) throw new Error('Expected a worker');
  return worker;
}

async function setupConnectionAndCredentials(db: DbClient): Promise<{
  connection: Connection;
  credentials: StoredS3Credentials;
}> {
  const connection = makeConnection();
  const credentials = makeS3Credentials(connection.id);
  await db.createConnection(connection);
  await db.saveS3Credentials(credentials);
  return { connection, credentials };
}

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
  for (let i = 0; i < 50; i++) {
    await Promise.resolve();
  }
}

beforeAll(async () => {
  sqlite3Module = await sqlite3InitModule();
});

let manager: TestDatabaseManager;
const managersToDispose: SyncManager[] = [];

beforeEach(async () => {
  vi.useFakeTimers();
  vi.mocked(isUnlocked).mockReturnValue(true);
  vi.mocked(unlock).mockResolvedValue(true);
  vi.mocked(decryptField).mockResolvedValue('secret-access-key');

  manager = new TestDatabaseManager();
  manager.setSqlite3(sqlite3Module);
  await manager.initialize();

  const client = dbClient as unknown as {
    worker: Worker | null;
    initPromise: Promise<unknown> | null;
    pending: Map<number, unknown>;
    createWorker: () => Worker;
  };
  client.worker = null;
  client.initPromise = null;
  client.pending = new Map();
  client.createWorker = () => new FakeDbWorker(manager) as unknown as Worker;
  await dbClient.ensureReady();
});

afterEach(async () => {
  for (const mgr of managersToDispose) mgr.dispose();
  managersToDispose.length = 0;
  vi.useRealTimers();
  manager.close();
  FakeBroadcastChannel.clear();
});

function createTestManager(options: Partial<SyncManagerOptions> = {}) {
  const workers: MockWorker[] = [];
  const s3 = new MockS3Client();
  const offline = new MockEventTarget();

  const syncManager = new SyncManager({
    createWorker: () => {
      const worker = new MockWorker();
      workers.push(worker);
      return worker as unknown as Worker;
    },
    createS3Client: () => s3,
    createBroadcastChannel: (name) => new FakeBroadcastChannel(name) as unknown as BroadcastChannel,
    eventTarget: offline as unknown as EventTarget,
    ...options,
  });
  managersToDispose.push(syncManager);

  return { syncManager, workers, s3, offline };
}

describe('SyncManager', () => {
  it('initializes, reconciles stale sessions, and becomes idle', async () => {
    const { syncManager } = createTestManager();
    const initPromise = syncManager.init();
    await vi.advanceTimersByTimeAsync(INIT_TIMEOUT + 50);
    await initPromise;

    expect(syncManager.isReadOnly).toBe(false);
    expect(syncManager.getSnapshot().initialized).toBe(true);
  });

  it('fails a run when the connection does not exist', async () => {
    const { syncManager } = createTestManager();
    const initPromise = syncManager.init();
    await vi.advanceTimersByTimeAsync(INIT_TIMEOUT + 50);
    await initPromise;

    syncManager.requestRun('missing-id');
    await flush();

    const snapshot = syncManager.getSnapshot();
    expect(snapshot.activeRun?.state).toBe('failed');
    expect(snapshot.warnings).toContain('Connection not found');
  });

  it('discovers a project and dispatches a worker', async () => {
    const { syncManager, workers, s3 } = createTestManager();
    const initPromise = syncManager.init();
    await vi.advanceTimersByTimeAsync(INIT_TIMEOUT + 50);
    await initPromise;

    const { connection } = await setupConnectionAndCredentials(dbClient);
    const projectId = 'remote-proj';
    const manifest = makeProjectManifest(projectId, 'Remote Project', 'test');
    s3.putBuffer(`${projectId}/manifest.json`, bufferFromText(JSON.stringify(manifest)));

    syncManager.requestRun(connection.id);
    await flush();

    expect(workers).toHaveLength(1);
    const start = workers[0]?.posted.find((m) => m.type === 'START');
    expect(start).toBeTruthy();
    expect(start?.type).toBe('START');
    expect((start as { projectId: string }).projectId).toBe(projectId);
  });

  it('creates local projects for missing remote folders and puts a manifest', async () => {
    const { syncManager, s3 } = createTestManager();
    const initPromise = syncManager.init();
    await vi.advanceTimersByTimeAsync(INIT_TIMEOUT + 50);
    await initPromise;

    const { connection } = await setupConnectionAndCredentials(dbClient);
    s3.putBuffer('new-proj/session-1/session/manifest.json', bufferFromText('{}'));

    let createdName = '';
    const syncManagerWithModal = new SyncManager({
      createWorker: () => new MockWorker() as unknown as Worker,
      createS3Client: () => s3,
      createBroadcastChannel: (name) =>
        new FakeBroadcastChannel(name) as unknown as BroadcastChannel,
      onProjectMissing: async () => {
        createdName = 'New Project';
        return { name: 'New Project', description: '' };
      },
      onFileDownloaded: () => Promise.resolve(),
    });
    managersToDispose.push(syncManagerWithModal);

    syncManagerWithModal.requestRun(connection.id);
    await flush();

    expect(createdName).toBe('New Project');
    const putManifest = s3.getBuffer('new-proj/manifest.json');
    const parsed = JSON.parse(textFromBuffer(putManifest));
    expect(parsed.projectId).toBe('new-proj');
  });

  it('sends sync:true for a new session with files to download', async () => {
    const { syncManager, workers, s3 } = createTestManager();
    const initPromise = syncManager.init();
    await vi.advanceTimersByTimeAsync(INIT_TIMEOUT + 50);
    await initPromise;

    const { connection } = await setupConnectionAndCredentials(dbClient);
    const projectId = 'remote-proj';
    const manifestObj = makeProjectManifest(projectId, 'Remote Project');
    s3.putBuffer(`${projectId}/manifest.json`, bufferFromText(JSON.stringify(manifestObj)));

    syncManager.requestRun(connection.id);
    await flush();

    const worker = getWorker(workers);
    const manifest = makeManifest(projectId, 'session-1', [
      { relativePath: 'transcript.jsonl', sha256: hashOf('main'), size: 100 },
    ]);
    worker.receive({
      type: 'PROJECT_FOLDER_FOUND',
      projectId,
      totalSessions: 1,
    });
    worker.receive({
      type: 'SESSION_BATCH_FOUND',
      projectId,
      sessionIds: ['session-1'],
      final: true,
    });
    await flush();

    worker.receive({
      type: 'SESSION_MANIFEST_READY',
      projectId,
      sessionId: 'session-1',
      manifest,
    });
    await flush();

    const syncMessage = worker.posted.find((m) => m.type === 'SESSION_SYNC') as
      | SessionSyncMessage
      | undefined;
    expect(syncMessage).toBeTruthy();
    expect(syncMessage?.sync).toBe(true);
    expect(syncMessage?.exists).toBe(false);
    expect(syncMessage?.filesToDownload).toHaveLength(1);
    expect(syncMessage?.filesToDownload?.[0]?.file).toBe('session/transcript.jsonl');
  });

  it('completes a session after downloaded files and a complete summary', async () => {
    const onFileDownloaded = vi.fn().mockResolvedValue(undefined);
    const { syncManager, workers, s3 } = createTestManager({ onFileDownloaded });
    vi.mocked(decryptField).mockResolvedValue('secret-access-key');

    const initPromise = syncManager.init();
    await vi.advanceTimersByTimeAsync(INIT_TIMEOUT + 50);
    await initPromise;

    const { connection } = await setupConnectionAndCredentials(dbClient);
    const projectId = 'remote-proj';
    const manifestObj = makeProjectManifest(projectId, 'Remote Project');
    s3.putBuffer(`${projectId}/manifest.json`, bufferFromText(JSON.stringify(manifestObj)));

    syncManager.requestRun(connection.id);
    await flush();

    const worker = getWorker(workers);
    const sha = hashOf('main');
    const manifest = makeManifest(projectId, 'session-1', [
      { relativePath: 'transcript.jsonl', sha256: sha, size: 100 },
    ]);

    worker.receive({ type: 'PROJECT_FOLDER_FOUND', projectId, totalSessions: 1 });
    worker.receive({
      type: 'SESSION_BATCH_FOUND',
      projectId,
      sessionIds: ['session-1'],
      final: true,
    });
    await flush();

    worker.receive({
      type: 'SESSION_MANIFEST_READY',
      projectId,
      sessionId: 'session-1',
      manifest,
    });
    await flush();

    const content = bufferFromText('main transcript');
    worker.receive({
      type: 'SESSION_FILE_DOWNLOADED',
      projectId,
      sessionId: 'session-1',
      file: 'session/transcript.jsonl',
      hash: sha,
      content,
    });
    await flush();

    expect(onFileDownloaded).toHaveBeenCalledOnce();
    const [sessionIdArg, fileArg] = onFileDownloaded.mock.calls[0] as [string, DownloadedFile];
    expect(fileArg.path).toBe('session/transcript.jsonl');
    expect(fileArg.size).toBe(content.byteLength);

    worker.receive({
      type: 'SESSION_SYNC_COMPLETE',
      projectId,
      sessionId: 'session-1',
      files: [
        {
          file: 'session/transcript.jsonl',
          hash: sha,
          size: content.byteLength,
          status: 'downloaded',
        },
      ],
    });
    await flush();

    const snapshot = syncManager.getSnapshot();
    const session = snapshot.sessions.find((s) => s.sessionId === 'session-1');
    expect(session?.status).toBe('in_sync');

    const files = await dbClient.getSessionFiles(sessionIdArg);
    const file = files.find((f) => f.path === 'session/transcript.jsonl');
    expect(file?.status).toBe('processed');
  });

  it('marks a session as transcript_unavailable when the main artifact is missing', async () => {
    const { syncManager, workers, s3 } = createTestManager();
    const initPromise = syncManager.init();
    await vi.advanceTimersByTimeAsync(INIT_TIMEOUT + 50);
    await initPromise;

    const { connection } = await setupConnectionAndCredentials(dbClient);
    const projectId = 'remote-proj';
    const manifestObj = makeProjectManifest(projectId, 'Remote Project');
    s3.putBuffer(`${projectId}/manifest.json`, bufferFromText(JSON.stringify(manifestObj)));

    syncManager.requestRun(connection.id);
    await flush();

    const worker = getWorker(workers);
    const manifest = makeManifest(projectId, 'session-1', [
      { relativePath: 'subagents/agent-1.jsonl', sha256: hashOf('sub'), size: 100 },
    ]);

    worker.receive({ type: 'PROJECT_FOLDER_FOUND', projectId, totalSessions: 1 });
    worker.receive({
      type: 'SESSION_BATCH_FOUND',
      projectId,
      sessionIds: ['session-1'],
      final: true,
    });
    await flush();

    worker.receive({
      type: 'SESSION_MANIFEST_READY',
      projectId,
      sessionId: 'session-1',
      manifest,
    });
    await flush();

    const syncMessage = worker.posted.find((m) => m.type === 'SESSION_SYNC') as
      | SessionSyncMessage
      | undefined;
    expect(syncMessage?.sync).toBe(false);
    expect(syncMessage?.filesToDownload).toHaveLength(0);

    const snapshot = syncManager.getSnapshot();
    const session = snapshot.sessions.find((s) => s.sessionId === 'session-1');
    expect(session?.status).toBe('transcript_unavailable');
  });

  it('queues runs and caps parallel workers at 3', async () => {
    const { syncManager, workers, s3 } = createTestManager();
    const initPromise = syncManager.init();
    await vi.advanceTimersByTimeAsync(INIT_TIMEOUT + 50);
    await initPromise;

    const { connection } = await setupConnectionAndCredentials(dbClient);
    for (let index = 0; index < 4; index++) {
      const projectId = `project-${index}`;
      const manifestObj = makeProjectManifest(projectId, `Project ${index}`);
      s3.putBuffer(`${projectId}/manifest.json`, bufferFromText(JSON.stringify(manifestObj)));
    }

    syncManager.requestRun(connection.id);
    await flush();

    expect(workers.length).toBeLessThanOrEqual(3);

    // Complete first worker so the 4th project can start.
    if (workers[0]) {
      workers[0].receive({
        type: 'WORKER_DONE',
        projectId: workers[0].posted[0]?.projectId as string,
        synced: 0,
        failed: 0,
        skipped: 0,
      });
      await flush();
    }

    expect(workers).toHaveLength(4);
  });

  it('honors sync-only-new by skipping sessions that already exist', async () => {
    const { syncManager, workers, s3 } = createTestManager();
    const initPromise = syncManager.init();
    await vi.advanceTimersByTimeAsync(INIT_TIMEOUT + 50);
    await initPromise;

    const { connection } = await setupConnectionAndCredentials(dbClient);
    await dbClient.updateConnection(connection.id, { sync_only_new: true });

    const projectId = 'remote-proj';
    const manifestObj = makeProjectManifest(projectId, 'Remote Project');
    s3.putBuffer(`${projectId}/manifest.json`, bufferFromText(JSON.stringify(manifestObj)));

    syncManager.requestRun(connection.id);
    await flush();

    const worker = getWorker(workers);
    worker.receive({ type: 'PROJECT_FOLDER_FOUND', projectId, totalSessions: 1 });
    worker.receive({ type: 'SESSION_FOUND', projectId, sessionId: 'existing-session' });
    await flush();

    const continueMessage = worker.posted.find((m) => m.type === 'SESSION_SYNC_CONTINUE');
    expect(continueMessage).toBeTruthy();
    expect((continueMessage as { sync: boolean }).sync).toBe(true);
  });

  it('cancels the active run and clears queued runs', async () => {
    const { syncManager, workers, s3 } = createTestManager();
    const initPromise = syncManager.init();
    await vi.advanceTimersByTimeAsync(INIT_TIMEOUT + 50);
    await initPromise;

    const { connection } = await setupConnectionAndCredentials(dbClient);
    const manifestObj = makeProjectManifest('p1', 'P1');
    s3.putBuffer('p1/manifest.json', bufferFromText(JSON.stringify(manifestObj)));

    syncManager.requestRun(connection.id);
    syncManager.requestRun(connection.id); // duplicate, ignored
    await flush();

    syncManager.cancel();
    await flush();

    const worker = getWorker(workers);
    expect(worker.terminated).toBe(true);

    const snapshot = syncManager.getSnapshot();
    expect(snapshot.activeRun?.state).toBe('cancelled');
    expect(snapshot.queuedRuns).toHaveLength(0);
  });

  it('broadcasts run state and becomes a follower on peer heartbeat', async () => {
    const { syncManager } = createTestManager();
    const { syncManager: peer, workers: peerWorkers, s3: peerS3 } = createTestManager();

    const p1 = syncManager.init();
    const p2 = peer.init();
    await vi.advanceTimersByTimeAsync(INIT_TIMEOUT + 50);
    await Promise.all([p1, p2]);

    // Two managers share the fake broadcast network; peer starts a run.
    const { connection } = await setupConnectionAndCredentials(dbClient);
    const manifestObj = makeProjectManifest('p1', 'P1');
    peerS3.putBuffer('p1/manifest.json', bufferFromText(JSON.stringify(manifestObj)));

    peer.requestRun(connection.id);
    expect(syncManager.isReadOnly).toBe(true);

    await flush();

    expect(peerWorkers).toHaveLength(1);
  });

  it('aborts the run when offline', async () => {
    const { syncManager, workers, s3, offline } = createTestManager();
    const initPromise = syncManager.init();
    await vi.advanceTimersByTimeAsync(INIT_TIMEOUT + 50);
    await initPromise;

    const { connection } = await setupConnectionAndCredentials(dbClient);
    const manifestObj = makeProjectManifest('p1', 'P1');
    s3.putBuffer('p1/manifest.json', bufferFromText(JSON.stringify(manifestObj)));

    syncManager.requestRun(connection.id);
    await flush();

    offline.dispatchEvent(new Event('offline'));
    await flush();

    expect(workers[0]?.terminated).toBe(true);
    expect(syncManager.getSnapshot().activeRun?.state).toBe('cancelled');
  });
});
