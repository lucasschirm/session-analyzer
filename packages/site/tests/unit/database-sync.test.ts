/**
 * @vitest-environment node
 *
 * Sync, connection, passkey and OPFS-fallback tests for the in-memory
 * SQLite database. These run inside the Node/Vitest environment because
 * sqlite-wasm works there, and because the Web Worker harness is not
 * available in this test runner.
 */

import type { Database } from '@sqlite.org/sqlite-wasm';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseManager } from '../../src/db/database';
import type {
  Connection,
  DashboardSession,
  PasskeyState,
  Project,
  SessionFileRecord,
  SessionStub,
  StoredS3Credentials,
  SyncManifest,
} from '../../src/types';

let realSqlite3: Awaited<ReturnType<typeof sqlite3InitModule>>;

beforeAll(async () => {
  realSqlite3 = await sqlite3InitModule();
});

/** Exposes the protected sqlite3 field and a db accessor for tests. */
class TestDatabaseManager extends DatabaseManager {
  setSqlite3(sqlite3: Awaited<ReturnType<typeof sqlite3InitModule>> | null): void {
    this.sqlite3 = sqlite3;
  }

  getDb(): Database {
    return (this as unknown as { db: Database }).db;
  }

  runMigrate(): void {
    (this as unknown as { migrate(): void }).migrate();
  }
}

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: `project-${Math.random().toString(36).slice(2)}`,
    name: overrides.name ?? 'Test Project',
    description: '',
    created_at: Date.now(),
    updated_at: Date.now(),
    session_count: 0,
    ...overrides,
  };
}

function makeSession(
  projectId: string,
  overrides: Partial<DashboardSession> = {},
): DashboardSession {
  const now = Date.now();
  return {
    id: `session-${Math.random().toString(36).slice(2)}`,
    project_id: projectId,
    source: 'claude' as const,
    title: 'Test Session',
    started_at: now,
    ended_at: now + 60_000,
    input_tokens: 10,
    output_tokens: 5,
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
    total_tokens: 15,
    cost_usd: 0.001,
    model: 'claude-sonnet-4-20250514',
    models: [],
    tool_executions: [],
    events: [],
    messages: [],
    tasks: [],
    subagents: [],
    context_compactions: 0,
    total_turns: 1,
    files_read: 0,
    files_written: 0,
    agent_invocations: 0,
    ...overrides,
  };
}

function makeConnection(overrides: Partial<Connection> = {}): Connection {
  return {
    id: `conn-${Math.random().toString(36).slice(2)}`,
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
    access_key_id: 'AKIA...',
    secret_access_key_ct: 'ct',
    secret_access_key_iv: 'iv',
    created_at: Date.now(),
    updated_at: Date.now(),
  };
}

function makePasskeyState(): PasskeyState {
  return {
    id: 1,
    kdf_salt: 'salt',
    verifier_iv: 'iv',
    verifier_ct: 'ct',
    created_at: Date.now(),
  };
}

function makeSessionStub(projectId: string): SessionStub {
  const now = new Date(Date.now()).toISOString();
  return {
    id: `sync-${projectId}-stub`,
    project_id: projectId,
    source: 'sync',
    title: 'Stub Session',
    started_at: now,
    ended_at: now,
    sync_session_id: 'remote-stub',
    sync_status: 'pending',
  };
}

function makeSyncManifest(overrides: Partial<SyncManifest> = {}): SyncManifest {
  return {
    sessionId: 'remote-stub',
    schemaVersion: 1,
    harness: 'claude-code',
    harnessVersion: '1.0.0',
    model: 'claude-sonnet-4-20250514',
    startedAt: new Date(Date.now()).toISOString(),
    endedAt: new Date(Date.now() + 60_000).toISOString(),
    durationMs: 60_000,
    endReason: 'completed',
    syncVersion: '0.1.0',
    pluginVersion: '0.1.0',
    transcriptsCaptured: 1,
    mainTranscriptRelativePath: 'transcript.json',
    artifacts: [{ type: 'transcript', path: 'transcript.json' }],
    syncRuns: [{ id: 'run-1' }],
    ...overrides,
  };
}

function makeSessionFileRecord(projectId: string, sessionId: string): SessionFileRecord {
  return {
    id: `file-${Math.random().toString(36).slice(2)}`,
    project_id: projectId,
    session_id: sessionId,
    path: 'transcript.json',
    scope: 'session',
    sha256: 'deadbeef',
    size: 1024,
    status: 'downloaded',
    updated_at: Date.now(),
  };
}

describe('DatabaseManager sync and connections', () => {
  let manager: TestDatabaseManager;

  beforeEach(async () => {
    manager = new TestDatabaseManager();
    await manager.initialize();
  });

  afterEach(() => {
    manager.close();
  });

  describe('schema migrations', () => {
    it('creates all sync tables and columns on a fresh database', () => {
      const project = makeProject();
      manager.createProject(project);

      const db = manager.getDb();
      const projectRow = db.selectObject(
        'SELECT readable_id, sync_status, connection_id FROM projects WHERE id = ?',
        [project.id],
      ) as Record<string, unknown> | undefined;
      expect(projectRow).toBeDefined();
      expect(projectRow).toHaveProperty('readable_id');
      expect(projectRow).toHaveProperty('sync_status');
      expect(projectRow).toHaveProperty('connection_id');

      const indexes = db.selectValues(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_projects_readable_id'",
      );
      expect(indexes).toHaveLength(1);
    });

    it('migrates an existing database and backfills readable_id slugs', () => {
      const projects = [makeProject({ name: 'Alpha' }), makeProject({ name: 'Alpha' })];
      for (const project of projects) manager.createProject(project);

      const db = manager.getDb();
      db.exec('DROP INDEX IF EXISTS idx_projects_readable_id');
      db.exec('DROP INDEX IF EXISTS idx_sessions_sync_session');
      db.exec('DROP INDEX IF EXISTS idx_sessions_sync_status');
      db.exec('ALTER TABLE projects DROP COLUMN readable_id');
      db.exec('ALTER TABLE projects DROP COLUMN sync_status');
      db.exec('ALTER TABLE projects DROP COLUMN connection_id');
      db.exec('ALTER TABLE sessions DROP COLUMN sync_session_id');
      db.exec('ALTER TABLE sessions DROP COLUMN sync_status');
      db.exec('ALTER TABLE sessions DROP COLUMN sync_artifacts');

      manager.runMigrate();

      const row = db.selectObject('SELECT id, name, readable_id FROM projects WHERE id = ?', [
        projects[0].id,
      ]) as Record<string, unknown> | undefined;
      expect(row?.readable_id).toBe('alpha');

      const second = db.selectObject('SELECT readable_id FROM projects WHERE id = ?', [
        projects[1].id,
      ]) as Record<string, unknown> | undefined;
      expect(second?.readable_id).toMatch(/^alpha-\d+$/);

      const indexes = db.selectValues(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_projects_readable_id'",
      );
      expect(indexes).toHaveLength(1);
    });
  });

  describe('readable_id backfill', () => {
    it('generates slugs and deduplicates collisions', () => {
      manager.createProject(makeProject({ name: 'My Project' }));
      manager.createProject(makeProject({ name: 'My Project!' }));
      manager.createProject(makeProject({ name: 'my-project' }));

      manager.backfillReadableIds();

      const projects = manager.getProjects();
      const slugs = projects.map((project) => project.readable_id);
      const nonEmptySlugs = slugs.filter(Boolean) as string[];
      expect(new Set(nonEmptySlugs).size).toBe(nonEmptySlugs.length);
      expect(nonEmptySlugs).toContain('my-project');
    });
  });

  describe('connection and credential CRUD', () => {
    it('creates, updates, lists and deletes connections', () => {
      const connection = makeConnection({ name: 'Dev', sync_only_new: true });
      manager.createConnection(connection);

      expect(manager.getConnections()).toHaveLength(1);

      manager.updateConnection(connection.id, { name: 'Production', last_sync_at: Date.now() });
      const [updated] = manager.getConnections();
      expect(updated.name).toBe('Production');
      expect(updated.last_sync_at).toBeDefined();

      manager.deleteConnection(connection.id);
      expect(manager.getConnections()).toHaveLength(0);
    });

    it('saves and returns S3 credentials', () => {
      const connection = makeConnection();
      manager.createConnection(connection);

      const credentials = makeS3Credentials(connection.id);
      manager.saveS3Credentials(credentials);

      const found = manager.getS3Credentials(connection.id);
      expect(found?.connection_id).toBe(connection.id);
      expect(found?.region).toBe('us-east-1');
    });

    it('cascades credentials when a connection is deleted', () => {
      const connection = makeConnection();
      manager.createConnection(connection);
      manager.saveS3Credentials(makeS3Credentials(connection.id));

      manager.deleteConnection(connection.id);

      expect(manager.getS3Credentials(connection.id)).toBeNull();
    });

    it('wipes all credentials on forgot-passkey', () => {
      const connection = makeConnection();
      manager.createConnection(connection);
      manager.saveS3Credentials(makeS3Credentials(connection.id));
      manager.savePasskeyState(makePasskeyState());

      manager.deleteAllCredentials();

      expect(manager.getS3Credentials(connection.id)).toBeNull();
      expect(manager.getPasskeyState()).toBeNull();
    });
  });

  describe('passkey state', () => {
    it('saves and returns the singleton passkey vault', () => {
      const state = makePasskeyState();
      manager.savePasskeyState(state);

      const found = manager.getPasskeyState();
      expect(found?.id).toBe(1);
      expect(found?.kdf_salt).toBe('salt');
    });
  });

  describe('project sync', () => {
    it('looks up projects by readable_id and sync status', () => {
      const project = makeProject({ name: 'Unique Slug' });
      manager.createProject(project);
      manager.backfillReadableIds();

      const found = manager.getProjectByReadableId('unique-slug');
      expect(found?.id).toBe(project.id);

      manager.setProjectSyncStatus(project.id, 'syncing');
      const synced = manager.getProject(project.id);
      expect(synced?.sync_status).toBe('syncing');
    });
  });

  describe('session sync', () => {
    it('inserts a sync stub with default metrics', () => {
      const project = makeProject();
      manager.createProject(project);

      const stub = makeSessionStub(project.id);
      manager.upsertSessionStub(stub);

      const found = manager.getSessionBySyncId(project.id, stub.sync_session_id);
      expect(found).not.toBeNull();
      expect(found?.title).toBe(stub.title);
    });

    it('does not overwrite parsed metrics when upserting a stub', () => {
      const project = makeProject();
      manager.createProject(project);

      const session = makeSession(project.id, { input_tokens: 100 });
      manager.saveSession(session);
      manager.updateSessionManifest(session.id, makeSyncManifest());

      const stub = makeSessionStub(project.id);
      manager.upsertSessionStub(stub);

      const found = manager.getSession(session.id);
      expect(found?.input_tokens).toBe(100);
      expect(found?.title).toBe(stub.title);
    });

    it('sets session sync status and details', () => {
      const project = makeProject();
      manager.createProject(project);

      const stub = makeSessionStub(project.id);
      manager.upsertSessionStub(stub);

      manager.setSessionSyncStatus(stub.id, 'failed', 'transcript missing');

      const db = manager.getDb();
      const row = db.selectObject('SELECT sync_status, sync_details FROM sessions WHERE id = ?', [
        stub.id,
      ]) as Record<string, unknown> | undefined;
      expect(row?.sync_status).toBe('failed');
      expect(row?.sync_details).toBe('transcript missing');
    });

    it('writes and counts a session manifest', () => {
      const project = makeProject();
      manager.createProject(project);

      const stub = makeSessionStub(project.id);
      manager.upsertSessionStub(stub);

      const manifest = makeSyncManifest();
      manager.updateSessionManifest(stub.id, manifest);

      expect(manager.getSyncRunCount(stub.id)).toBe(1);

      const db = manager.getDb();
      const row = db.selectObject(
        'SELECT sync_harness, sync_schema_version FROM sessions WHERE id = ?',
        [stub.id],
      ) as Record<string, unknown> | undefined;
      expect(row?.sync_harness).toBe('claude-code');
      expect(row?.sync_schema_version).toBe(1);
    });

    it('fails stale sessions for a project', () => {
      const project = makeProject();
      manager.createProject(project);

      const stub1 = { ...makeSessionStub(project.id), id: 'stale-1' };
      const stub2 = { ...makeSessionStub(project.id), id: 'stale-2', sync_session_id: 'remote-2' };
      manager.upsertSessionStub(stub1);
      manager.upsertSessionStub(stub2);
      manager.setSessionSyncStatus(stub1.id, 'pending');
      manager.setSessionSyncStatus(stub2.id, 'processing');

      manager.failStaleSessions(project.id, 'worker lost');

      const db = manager.getDb();
      const rows = db.selectObjects(
        'SELECT sync_status, sync_details FROM sessions WHERE project_id = ?',
        [project.id],
      ) as Record<string, unknown>[];
      for (const row of rows) {
        expect(row.sync_status).toBe('failed');
        expect(row.sync_details).toBe('worker lost');
      }
    });

    it('reconciles sync states atomically', () => {
      const project = makeProject();
      manager.createProject(project);
      manager.setProjectSyncStatus(project.id, 'syncing');

      const stub = makeSessionStub(project.id);
      manager.upsertSessionStub(stub);
      manager.setSessionSyncStatus(stub.id, 'pending');

      manager.reconcileSyncStates('restarted');

      const db = manager.getDb();
      const projectRow = db.selectObject('SELECT sync_status FROM projects WHERE id = ?', [
        project.id,
      ]) as Record<string, unknown> | undefined;
      expect(projectRow?.sync_status).toBe('in_sync');

      const sessionRow = db.selectObject(
        'SELECT sync_status, sync_details FROM sessions WHERE id = ?',
        [stub.id],
      ) as Record<string, unknown> | undefined;
      expect(sessionRow?.sync_status).toBe('failed');
      expect(sessionRow?.sync_details).toBe('restarted');
    });
  });

  describe('session files', () => {
    it('creates and lists session files with conflict resolution', () => {
      const project = makeProject();
      manager.createProject(project);
      const session = makeSession(project.id);
      manager.saveSession(session);

      const file = makeSessionFileRecord(project.id, session.id);
      manager.upsertSessionFile(file);

      const files = manager.getSessionFiles(session.id);
      expect(files).toHaveLength(1);
      expect(files[0].sha256).toBe('deadbeef');

      const updated = { ...file, sha256: 'cafebabe', size: 2048 };
      manager.upsertSessionFile(updated);

      const [latest] = manager.getSessionFiles(session.id);
      expect(latest.sha256).toBe('cafebabe');
      expect(latest.size).toBe(2048);
    });
  });
});

describe('DatabaseManager OPFS fallback', () => {
  function makeMockSqlite3(opfsDb?: new (...args: unknown[]) => unknown) {
    return {
      ...realSqlite3,
      oo1: {
        ...realSqlite3.oo1,
        OpfsDb: opfsDb,
      },
    } as unknown as Awaited<ReturnType<typeof sqlite3InitModule>>;
  }

  function createSqlite3Error(code: number, message: string): Error {
    const error = new Error(message);
    error.name = 'SQLite3Error';
    (error as { resultCode?: number }).resultCode = code;
    return error;
  }

  it('falls back to memory and reports locked when OpfsDb throws a lock error', async () => {
    class LockedOpfsDb {
      constructor() {
        throw createSqlite3Error(realSqlite3.capi.SQLITE_BUSY, 'database is locked');
      }
    }

    const manager = new TestDatabaseManager();
    manager.setSqlite3(
      makeMockSqlite3(LockedOpfsDb as unknown as new (...args: unknown[]) => unknown),
    );

    const storage = await manager.initialize();
    expect(storage).toBe('memory');
    expect(manager.fallbackReason).toBe('locked');
    expect(manager.getProjects()).toEqual([]);
  });

  it('rethrows non-lock OPFS open errors', async () => {
    class BrokenOpfsDb {
      constructor() {
        throw createSqlite3Error(realSqlite3.capi.SQLITE_CORRUPT, 'malformed header');
      }
    }

    const manager = new TestDatabaseManager();
    manager.setSqlite3(
      makeMockSqlite3(BrokenOpfsDb as unknown as new (...args: unknown[]) => unknown),
    );

    await expect(manager.initialize()).rejects.toThrow('malformed header');
  });

  it('falls back to memory and reports unsupported when OpfsDb is absent', async () => {
    const manager = new TestDatabaseManager();
    manager.setSqlite3(makeMockSqlite3(undefined));

    const storage = await manager.initialize();
    expect(storage).toBe('memory');
    expect(manager.fallbackReason).toBe('unsupported');
  });
});
