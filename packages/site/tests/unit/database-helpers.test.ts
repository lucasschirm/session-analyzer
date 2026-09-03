// @vitest-environment node
/**
 * Unit tests for the pure helper functions and DatabaseManager class in
 * `src/db/database.ts`.
 *
 * The helper functions (parseTimestamp, safeJsonParseArray, safeJsonStringify,
 * safeJsonLength, isProjectSyncStatus, isSessionSyncStatus, generateReadableId,
 * isOpfsLockedError, isLockedMessage) are module-private, so they are exercised
 * indirectly through the public DatabaseManager API using an in-memory SQLite
 * WASM database. In Node, OPFS is unavailable so initialize() always falls back
 * to the in-memory backend.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DatabaseManager } from '../../src/db/database';
import type {
  Connection,
  PasskeyState,
  Project,
  SessionFileRecord,
  SessionStub,
  StoredS3Credentials,
  SyncManifest,
} from '../../src/types';

/** Creates and initializes a fresh in-memory DatabaseManager. */
async function createManager(): Promise<DatabaseManager> {
  const mgr = new DatabaseManager();
  await mgr.initialize();
  return mgr;
}

/** Builds a minimal valid Project object. */
function makeProject(overrides: Partial<Project> = {}): Project {
  const now = Date.now();
  return {
    id: `proj-${Math.random().toString(36).slice(2)}`,
    name: 'Test Project',
    description: 'A test project',
    created_at: now,
    updated_at: now,
    session_count: 0,
    ...overrides,
  };
}

/** Builds a minimal valid Connection object. */
function makeConnection(overrides: Partial<Connection> = {}): Connection {
  const now = Date.now();
  return {
    id: `conn-${Math.random().toString(36).slice(2)}`,
    name: 'Test Connection',
    storage_type: 's3',
    sync_only_new: false,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

/** Builds a minimal valid SessionStub object. */
function makeSessionStub(projectId: string, overrides: Partial<SessionStub> = {}): SessionStub {
  return {
    id: `sess-${Math.random().toString(36).slice(2)}`,
    project_id: projectId,
    source: 'claude',
    title: 'Test Session',
    started_at: '2024-01-01T00:00:00.000Z',
    ended_at: '2024-01-01T01:00:00.000Z',
    sync_session_id: `sync-${Math.random().toString(36).slice(2)}`,
    sync_status: 'pending',
    ...overrides,
  };
}

/** Builds a minimal valid StoredS3Credentials object. */
function makeS3Credentials(connectionId: string): StoredS3Credentials {
  const now = Date.now();
  return {
    connection_id: connectionId,
    region: 'us-east-1',
    endpoint: undefined,
    bucket: 'test-bucket',
    access_key_id: 'AKIATEST',
    secret_access_key_ct: 'encrypted-secret',
    secret_access_key_iv: 'iv-value',
    created_at: now,
    updated_at: now,
  };
}

/** Builds a minimal valid PasskeyState object. */
function makePasskeyState(): PasskeyState {
  return {
    id: 1,
    kdf_salt: 'salt-value',
    verifier_iv: 'verifier-iv',
    verifier_ct: 'verifier-ct',
    created_at: Date.now(),
  };
}

/** Builds a minimal valid SessionFileRecord object. */
function makeSessionFile(projectId: string, sessionId: string): SessionFileRecord {
  return {
    id: `file-${Math.random().toString(36).slice(2)}`,
    project_id: projectId,
    session_id: sessionId,
    path: 'transcript.jsonl',
    scope: 'session',
    sha256: 'abc123',
    size: 1024,
    status: 'downloaded',
    updated_at: Date.now(),
  };
}

/** Builds a minimal valid SyncManifest object. */
function makeSyncManifest(sessionId: string): SyncManifest {
  return {
    sessionId,
    schemaVersion: 1,
    harness: 'claude',
    harnessVersion: '1.0.0',
    model: 'claude-sonnet-4',
    startedAt: '2024-01-01T00:00:00.000Z',
    endedAt: '2024-01-01T01:00:00.000Z',
    durationMs: 3600000,
    endReason: 'completed',
    syncVersion: '1.0.0',
    pluginVersion: '1.0.0',
    transcriptsCaptured: 1,
    mainTranscriptRelativePath: 'transcript.jsonl',
    artifacts: [{ type: 'file', path: 'output.txt' }],
    syncRuns: [{ id: 'run-1', status: 'ok' }],
  };
}

describe('DatabaseManager', () => {
  let mgr: DatabaseManager;

  beforeAll(async () => {
    mgr = await createManager();
  });

  afterAll(() => {
    mgr.close();
  });

  // ================================================================
  // initialize() — exercises isOpfsLockedError / isLockedMessage
  // (OPFS is unavailable in Node, so it falls back to memory)
  // ================================================================
  describe('initialize', () => {
    it('falls back to in-memory backend when OPFS is unavailable', async () => {
      const m = new DatabaseManager();
      const backend = await m.initialize();
      expect(backend).toBe('memory');
      expect(m.storage).toBe('memory');
      expect(m.fallbackReason).toBe('unsupported');
      m.close();
    });

    it('is idempotent — calling twice returns the same backend', async () => {
      const m = new DatabaseManager();
      const first = await m.initialize();
      const second = await m.initialize();
      expect(first).toBe(second);
      m.close();
    });

    it('throws if a method is called before initialize', () => {
      const m = new DatabaseManager();
      expect(() => m.getProjects()).toThrow('Database not initialized');
    });
  });

  // ================================================================
  // Project CRUD — exercises generateReadableId (via backfill),
  // isProjectSyncStatus (via row mapping), tryExecReadableId
  // ================================================================
  describe('projects', () => {
    it('creates and retrieves a project', () => {
      const project = makeProject({ id: 'proj-crud-1', name: 'CRUD Project' });
      mgr.createProject(project);

      const fetched = mgr.getProject('proj-crud-1');
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe('proj-crud-1');
      expect(fetched!.name).toBe('CRUD Project');
      expect(fetched!.description).toBe('A test project');
      expect(fetched!.session_count).toBe(0);
    });

    it('lists projects ordered by updated_at desc', () => {
      const early = makeProject({ id: 'proj-list-1', name: 'Early', updated_at: 1000 });
      const late = makeProject({ id: 'proj-list-2', name: 'Late', updated_at: 2000 });
      mgr.createProject(early);
      mgr.createProject(late);

      const all = mgr.getProjects();
      const ids = all.map((p) => p.id);
      expect(ids).toContain('proj-list-1');
      expect(ids).toContain('proj-list-2');
      const lateIdx = ids.indexOf('proj-list-2');
      const earlyIdx = ids.indexOf('proj-list-1');
      expect(lateIdx).toBeLessThan(earlyIdx);
    });

    it('returns null for a non-existent project', () => {
      expect(mgr.getProject('does-not-exist')).toBeNull();
    });

    it('updates a project name and description', () => {
      const project = makeProject({ id: 'proj-update-1', name: 'Before Update' });
      mgr.createProject(project);

      mgr.updateProject('proj-update-1', { name: 'After Update', description: 'Updated desc' });
      const fetched = mgr.getProject('proj-update-1');
      expect(fetched!.name).toBe('After Update');
      expect(fetched!.description).toBe('Updated desc');
    });

    it('preserves existing fields when only some are updated', () => {
      const project = makeProject({
        id: 'proj-update-2',
        name: 'Keep Name',
        description: 'Keep Desc',
      });
      mgr.createProject(project);

      mgr.updateProject('proj-update-2', { name: 'New Name' });
      const fetched = mgr.getProject('proj-update-2');
      expect(fetched!.name).toBe('New Name');
      expect(fetched!.description).toBe('Keep Desc');
    });

    it('throws when updating a non-existent project', () => {
      expect(() => mgr.updateProject('nope', { name: 'x' })).toThrow('Project not found');
    });

    it('deletes a project and cascades to sessions', () => {
      const project = makeProject({ id: 'proj-delete-1', name: 'Delete Me' });
      mgr.createProject(project);
      const stub = makeSessionStub('proj-delete-1', { id: 'sess-delete-1' });
      mgr.upsertSessionStub(stub);

      mgr.deleteProject('proj-delete-1');
      expect(mgr.getProject('proj-delete-1')).toBeNull();
      expect(mgr.getSessionBySyncId('proj-delete-1', stub.sync_session_id)).toBeNull();
    });

    it('looks up a project by readable_id', () => {
      const project = makeProject({
        id: 'proj-readable-1',
        name: 'Readable',
        readable_id: 'my-slug',
      });
      mgr.createProject(project);

      const found = mgr.getProjectByReadableId('my-slug');
      expect(found).not.toBeNull();
      expect(found!.id).toBe('proj-readable-1');
    });

    it('throws a user-facing error on duplicate readable_id', () => {
      const p1 = makeProject({ id: 'proj-dup-1', readable_id: 'dup-slug' });
      const p2 = makeProject({ id: 'proj-dup-2', readable_id: 'dup-slug' });
      mgr.createProject(p1);
      expect(() => mgr.createProject(p2)).toThrow('This project ID is already in use');
    });
  });

  // ================================================================
  // generateReadableId — exercised via backfillReadableIds
  // ================================================================
  describe('backfillReadableIds (generateReadableId)', () => {
    it('slugifies project names into readable ids', () => {
      const p1 = makeProject({ id: 'proj-bf-1', name: 'My Cool Project!' });
      const p2 = makeProject({ id: 'proj-bf-2', name: 'Another Project' });
      mgr.createProject(p1);
      mgr.createProject(p2);

      mgr.backfillReadableIds();

      expect(mgr.getProjectByReadableId('my-cool-project')).not.toBeNull();
      expect(mgr.getProjectByReadableId('another-project')).not.toBeNull();
    });

    it('resolves collisions with -2, -3 suffixes', () => {
      mgr.createProject(makeProject({ id: 'proj-col-1', name: 'Duplicate Name' }));
      mgr.createProject(makeProject({ id: 'proj-col-2', name: 'Duplicate Name' }));
      mgr.createProject(makeProject({ id: 'proj-col-3', name: 'Duplicate Name' }));

      mgr.backfillReadableIds();

      expect(mgr.getProjectByReadableId('duplicate-name')).not.toBeNull();
      expect(mgr.getProjectByReadableId('duplicate-name-2')).not.toBeNull();
      expect(mgr.getProjectByReadableId('duplicate-name-3')).not.toBeNull();
    });

    it('does not reassign existing readable ids', () => {
      mgr.createProject(
        makeProject({ id: 'proj-keep-1', name: 'Will Not Change', readable_id: 'custom-id' }),
      );
      mgr.backfillReadableIds();
      const fetched = mgr.getProject('proj-keep-1');
      expect(fetched!.readable_id).toBe('custom-id');
    });

    it('falls back to "project" for names with no alphanumeric chars', () => {
      mgr.createProject(makeProject({ id: 'proj-empty-1', name: '!!! ### ???' }));
      mgr.backfillReadableIds();
      expect(mgr.getProjectByReadableId('project')).not.toBeNull();
    });
  });

  // ================================================================
  // setProjectSyncStatus + isProjectSyncStatus (via row mapping)
  // ================================================================
  describe('setProjectSyncStatus', () => {
    it('sets sync_status to in_sync', () => {
      const project = makeProject({ id: 'proj-sync-1', name: 'Sync Project' });
      mgr.createProject(project);
      mgr.setProjectSyncStatus('proj-sync-1', 'in_sync');
      const fetched = mgr.getProject('proj-sync-1');
      expect(fetched!.sync_status).toBe('in_sync');
    });

    it('sets sync_status to syncing', () => {
      const project = makeProject({ id: 'proj-sync-2', name: 'Sync Project 2' });
      mgr.createProject(project);
      mgr.setProjectSyncStatus('proj-sync-2', 'syncing');
      const fetched = mgr.getProject('proj-sync-2');
      expect(fetched!.sync_status).toBe('syncing');
    });

    it('maps an invalid sync_status to undefined on read', () => {
      const project = makeProject({ id: 'proj-sync-3', name: 'Sync Project 3' });
      mgr.createProject(project);
      // Write an invalid status directly via the raw db handle
      mgr.getControlDb().exec({
        sql: "UPDATE projects SET sync_status = 'bogus' WHERE id = ?",
        bind: ['proj-sync-3'],
      });
      const fetched = mgr.getProject('proj-sync-3');
      expect(fetched!.sync_status).toBeUndefined();
    });
  });

  // ================================================================
  // Connection CRUD
  // ================================================================
  describe('connections', () => {
    it('creates and lists connections', () => {
      const conn = makeConnection({ id: 'conn-1', name: 'My S3' });
      mgr.createConnection(conn);

      const all = mgr.getConnections();
      const found = all.find((c) => c.id === 'conn-1');
      expect(found).toBeDefined();
      expect(found!.name).toBe('My S3');
      expect(found!.storage_type).toBe('s3');
      expect(found!.sync_only_new).toBe(false);
    });

    it('updates a connection name and sync_only_new', () => {
      const conn = makeConnection({ id: 'conn-2', name: 'Before', sync_only_new: false });
      mgr.createConnection(conn);

      mgr.updateConnection('conn-2', { name: 'After', sync_only_new: true });
      const all = mgr.getConnections();
      const found = all.find((c) => c.id === 'conn-2');
      expect(found!.name).toBe('After');
      expect(found!.sync_only_new).toBe(true);
    });

    it('updates last_sync_at on a connection', () => {
      const conn = makeConnection({ id: 'conn-3', name: 'Sync Conn' });
      mgr.createConnection(conn);

      const ts = Date.now();
      mgr.updateConnection('conn-3', { last_sync_at: ts });
      const all = mgr.getConnections();
      const found = all.find((c) => c.id === 'conn-3');
      expect(found!.last_sync_at).toBe(ts);
    });

    it('throws when updating a non-existent connection', () => {
      expect(() => mgr.updateConnection('nope', { name: 'x' })).toThrow('Connection not found');
    });

    it('deletes a connection', () => {
      const conn = makeConnection({ id: 'conn-4', name: 'Delete Me' });
      mgr.createConnection(conn);
      mgr.deleteConnection('conn-4');
      const all = mgr.getConnections();
      expect(all.find((c) => c.id === 'conn-4')).toBeUndefined();
    });
  });

  // ================================================================
  // S3 Credentials
  // ================================================================
  describe('S3 credentials', () => {
    it('saves and retrieves S3 credentials', () => {
      const conn = makeConnection({ id: 'conn-cred-1', name: 'Cred Conn' });
      mgr.createConnection(conn);
      const creds = makeS3Credentials('conn-cred-1');
      mgr.saveS3Credentials(creds);

      const fetched = mgr.getS3Credentials('conn-cred-1');
      expect(fetched).not.toBeNull();
      expect(fetched!.connection_id).toBe('conn-cred-1');
      expect(fetched!.region).toBe('us-east-1');
      expect(fetched!.bucket).toBe('test-bucket');
      expect(fetched!.access_key_id).toBe('AKIATEST');
    });

    it('returns null for a connection with no credentials', () => {
      expect(mgr.getS3Credentials('no-creds-here')).toBeNull();
    });

    it('replaces credentials on conflict (upsert)', () => {
      const conn = makeConnection({ id: 'conn-cred-2', name: 'Cred Conn 2' });
      mgr.createConnection(conn);
      mgr.saveS3Credentials(makeS3Credentials('conn-cred-2'));
      mgr.saveS3Credentials({
        ...makeS3Credentials('conn-cred-2'),
        region: 'eu-west-1',
        bucket: 'new-bucket',
      });

      const fetched = mgr.getS3Credentials('conn-cred-2');
      expect(fetched!.region).toBe('eu-west-1');
      expect(fetched!.bucket).toBe('new-bucket');
    });

    it('deleteAllCredentials wipes all S3 credentials and passkey state', () => {
      const conn = makeConnection({ id: 'conn-cred-3', name: 'Cred Conn 3' });
      mgr.createConnection(conn);
      mgr.saveS3Credentials(makeS3Credentials('conn-cred-3'));
      mgr.savePasskeyState(makePasskeyState());

      mgr.deleteAllCredentials();

      expect(mgr.getS3Credentials('conn-cred-3')).toBeNull();
      expect(mgr.getPasskeyState()).toBeNull();
    });

    it('cascades credential deletion when a connection is deleted', () => {
      const conn = makeConnection({ id: 'conn-cred-4', name: 'Cred Conn 4' });
      mgr.createConnection(conn);
      mgr.saveS3Credentials(makeS3Credentials('conn-cred-4'));

      mgr.deleteConnection('conn-cred-4');
      expect(mgr.getS3Credentials('conn-cred-4')).toBeNull();
    });
  });

  // ================================================================
  // Passkey state
  // ================================================================
  describe('passkey state', () => {
    it('returns null when no passkey state exists', async () => {
      // Use a fresh manager to guarantee a clean table
      const m = await createManager();
      expect(m.getPasskeyState()).toBeNull();
      m.close();
    });

    it('saves and retrieves passkey state', () => {
      const state = makePasskeyState();
      mgr.savePasskeyState(state);

      const fetched = mgr.getPasskeyState();
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(1);
      expect(fetched!.kdf_salt).toBe('salt-value');
      expect(fetched!.verifier_ct).toBe('verifier-ct');
    });

    it('replaces passkey state on conflict (singleton upsert)', () => {
      mgr.savePasskeyState(makePasskeyState());
      mgr.savePasskeyState({
        ...makePasskeyState(),
        kdf_salt: 'new-salt',
        verifier_ct: 'new-ct',
      });

      const fetched = mgr.getPasskeyState();
      expect(fetched!.kdf_salt).toBe('new-salt');
      expect(fetched!.verifier_ct).toBe('new-ct');
    });

    it('preserves optional webauthn fields when set', () => {
      mgr.savePasskeyState({
        ...makePasskeyState(),
        webauthn_credential_id: 'cred-id',
        webauthn_wrapped_key: 'wrapped-key',
        webauthn_expires_at: 999999,
      });

      const fetched = mgr.getPasskeyState();
      expect(fetched!.webauthn_credential_id).toBe('cred-id');
      expect(fetched!.webauthn_wrapped_key).toBe('wrapped-key');
      expect(fetched!.webauthn_expires_at).toBe(999999);
    });
  });

  // ================================================================
  // Session stubs — exercises parseTimestamp (ISO + numeric),
  // isSessionSyncStatus (via row mapping)
  // ================================================================
  describe('session stubs', () => {
    it('inserts a new session stub and retrieves it by sync id', () => {
      const project = makeProject({ id: 'proj-stub-1', name: 'Stub Project' });
      mgr.createProject(project);
      const stub = makeSessionStub('proj-stub-1', {
        id: 'sess-stub-1',
        sync_session_id: 'sync-1',
      });
      mgr.upsertSessionStub(stub);

      const fetched = mgr.getSessionBySyncId('proj-stub-1', 'sync-1');
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe('sess-stub-1');
      expect(fetched!.sync_session_id).toBe('sync-1');
      expect(fetched!.sync_status).toBe('pending');
    });

    it('stores a missing context_compactions as null, never a fabricated 0 (missing-is-never-zero)', () => {
      const project = makeProject({ id: 'proj-stub-1b', name: 'Stub Project 1b' });
      mgr.createProject(project);
      const stub = makeSessionStub('proj-stub-1b', {
        id: 'sess-stub-1b',
        sync_session_id: 'sync-1b',
      });
      expect(stub.context_compactions).toBeUndefined();
      mgr.upsertSessionStub(stub);

      const fetched = mgr.getSessionBySyncId('proj-stub-1b', 'sync-1b');
      expect(fetched!.context_compactions).toBeNull();
    });

    it('preserves an explicit context_compactions: 0 as a confirmed zero, distinct from missing', () => {
      const project = makeProject({ id: 'proj-stub-1c', name: 'Stub Project 1c' });
      mgr.createProject(project);
      const stub = makeSessionStub('proj-stub-1c', {
        id: 'sess-stub-1c',
        sync_session_id: 'sync-1c',
        context_compactions: 0,
      });
      mgr.upsertSessionStub(stub);

      const fetched = mgr.getSessionBySyncId('proj-stub-1c', 'sync-1c');
      expect(fetched!.context_compactions).toBe(0);
      expect(fetched!.context_compactions).not.toBeNull();
    });

    it('parseTimestamp: converts ISO-8601 strings to milliseconds', () => {
      const project = makeProject({ id: 'proj-stub-2', name: 'Stub Project 2' });
      mgr.createProject(project);
      const stub = makeSessionStub('proj-stub-2', {
        id: 'sess-stub-2',
        started_at: '2024-06-15T12:30:00.000Z',
        ended_at: '2024-06-15T13:00:00.000Z',
      });
      mgr.upsertSessionStub(stub);

      const fetched = mgr.getSessionBySyncId('proj-stub-2', stub.sync_session_id);
      expect(fetched!.started_at).toBe(Date.parse('2024-06-15T12:30:00.000Z'));
      expect(fetched!.ended_at).toBe(Date.parse('2024-06-15T13:00:00.000Z'));
    });

    it('parseTimestamp: passes through numeric timestamp strings', () => {
      const project = makeProject({ id: 'proj-stub-3', name: 'Stub Project 3' });
      mgr.createProject(project);
      const numericStart = 1718450000000;
      const numericEnd = 1718453600000;
      const stub = makeSessionStub('proj-stub-3', {
        id: 'sess-stub-3',
        started_at: String(numericStart),
        ended_at: String(numericEnd),
      });
      mgr.upsertSessionStub(stub);

      const fetched = mgr.getSessionBySyncId('proj-stub-3', stub.sync_session_id);
      expect(fetched!.started_at).toBe(numericStart);
      expect(fetched!.ended_at).toBe(numericEnd);
    });

    it('increments the project session_count on insert', () => {
      const project = makeProject({ id: 'proj-stub-4', name: 'Stub Project 4' });
      mgr.createProject(project);
      mgr.upsertSessionStub(makeSessionStub('proj-stub-4', { id: 'sess-stub-4a' }));
      mgr.upsertSessionStub(makeSessionStub('proj-stub-4', { id: 'sess-stub-4b' }));

      const fetched = mgr.getProject('proj-stub-4');
      expect(fetched!.session_count).toBe(2);
    });

    it('updates stub columns when a session with the same id already exists', () => {
      const project = makeProject({ id: 'proj-stub-5', name: 'Stub Project 5' });
      mgr.createProject(project);
      const stub = makeSessionStub('proj-stub-5', {
        id: 'sess-stub-5',
        title: 'Original Title',
        sync_session_id: 'sync-5',
      });
      mgr.upsertSessionStub(stub);

      // Upsert again with same id, different title
      mgr.upsertSessionStub(
        makeSessionStub('proj-stub-5', {
          id: 'sess-stub-5',
          title: 'Updated Title',
          sync_session_id: 'sync-5',
        }),
      );

      const fetched = mgr.getSessionBySyncId('proj-stub-5', 'sync-5');
      expect(fetched!.title).toBe('Updated Title');
      // session_count should not increment on update
      expect(mgr.getProject('proj-stub-5')!.session_count).toBe(1);
    });

    it('updates stub columns when a session with the same sync_session_id already exists', () => {
      const project = makeProject({ id: 'proj-stub-6', name: 'Stub Project 6' });
      mgr.createProject(project);
      mgr.upsertSessionStub(
        makeSessionStub('proj-stub-6', {
          id: 'sess-stub-6',
          sync_session_id: 'sync-6',
          title: 'Old',
        }),
      );
      // Different id, same sync_session_id
      mgr.upsertSessionStub(
        makeSessionStub('proj-stub-6', {
          id: 'sess-stub-6-new',
          sync_session_id: 'sync-6',
          title: 'New',
        }),
      );

      const fetched = mgr.getSessionBySyncId('proj-stub-6', 'sync-6');
      expect(fetched!.title).toBe('New');
    });

    it('isSessionSyncStatus: maps invalid sync_status to undefined on read', () => {
      const project = makeProject({ id: 'proj-stub-7', name: 'Stub Project 7' });
      mgr.createProject(project);
      const stub = makeSessionStub('proj-stub-7', { id: 'sess-stub-7' });
      mgr.upsertSessionStub(stub);

      // Write an invalid status directly
      mgr.getControlDb().exec({
        sql: "UPDATE sessions SET sync_status = 'bogus' WHERE id = ?",
        bind: ['sess-stub-7'],
      });
      const fetched = mgr.getSessionBySyncId('proj-stub-7', stub.sync_session_id);
      expect(fetched!.sync_status).toBeUndefined();
    });
  });

  // ================================================================
  // Session sync status + manifest
  // Exercises safeJsonStringify, safeJsonParseArray, safeJsonLength
  // ================================================================
  describe('session sync status and manifest', () => {
    it('setSessionSyncStatus updates status and details', () => {
      const project = makeProject({ id: 'proj-manifest-1', name: 'Manifest Project' });
      mgr.createProject(project);
      const stub = makeSessionStub('proj-manifest-1', { id: 'sess-manifest-1' });
      mgr.upsertSessionStub(stub);

      mgr.setSessionSyncStatus('sess-manifest-1', 'failed', 'Network error');
      const fetched = mgr.getSessionBySyncId('proj-manifest-1', stub.sync_session_id);
      expect(fetched!.sync_status).toBe('failed');
      expect(fetched!.sync_details).toBe('Network error');
    });

    it('setSessionSyncStatus sets details to null when omitted', () => {
      const project = makeProject({ id: 'proj-manifest-2', name: 'Manifest Project 2' });
      mgr.createProject(project);
      const stub = makeSessionStub('proj-manifest-2', { id: 'sess-manifest-2' });
      mgr.upsertSessionStub(stub);

      mgr.setSessionSyncStatus('sess-manifest-2', 'in_sync');
      const fetched = mgr.getSessionBySyncId('proj-manifest-2', stub.sync_session_id);
      expect(fetched!.sync_status).toBe('in_sync');
      expect(fetched!.sync_details).toBeUndefined();
    });

    it('updateSessionManifest writes and getSessionSyncManifest reads back all fields', () => {
      const project = makeProject({ id: 'proj-manifest-3', name: 'Manifest Project 3' });
      mgr.createProject(project);
      const stub = makeSessionStub('proj-manifest-3', { id: 'sess-manifest-3' });
      mgr.upsertSessionStub(stub);

      const manifest = makeSyncManifest('sess-manifest-3');
      mgr.updateSessionManifest('sess-manifest-3', manifest);

      const read = mgr.getSessionSyncManifest('sess-manifest-3');
      expect(read).not.toBeNull();
      expect(read!.sessionId).toBe('sess-manifest-3');
      expect(read!.schemaVersion).toBe(1);
      expect(read!.harness).toBe('claude');
      expect(read!.harnessVersion).toBe('1.0.0');
      expect(read!.model).toBe('claude-sonnet-4');
      expect(read!.startedAt).toBe('2024-01-01T00:00:00.000Z');
      expect(read!.endedAt).toBe('2024-01-01T01:00:00.000Z');
      expect(read!.durationMs).toBe(3600000);
      expect(read!.endReason).toBe('completed');
      expect(read!.syncVersion).toBe('1.0.0');
      expect(read!.pluginVersion).toBe('1.0.0');
      expect(read!.transcriptsCaptured).toBe(true);
      expect(read!.mainTranscriptRelativePath).toBe('transcript.jsonl');
    });

    it('safeJsonStringify/safeJsonParseArray: round-trips artifacts array', () => {
      const project = makeProject({ id: 'proj-manifest-4', name: 'Manifest Project 4' });
      mgr.createProject(project);
      const stub = makeSessionStub('proj-manifest-4', { id: 'sess-manifest-4' });
      mgr.upsertSessionStub(stub);

      const artifacts = [
        { type: 'file', path: 'a.txt' },
        { type: 'file', path: 'b.txt' },
      ];
      mgr.updateSessionManifest('sess-manifest-4', {
        ...makeSyncManifest('sess-manifest-4'),
        artifacts,
        syncRuns: [],
      });

      const read = mgr.getSessionSyncManifest('sess-manifest-4');
      expect(read!.artifacts).toEqual(artifacts);
    });

    it('safeJsonStringify: returns null for empty arrays (syncRuns)', () => {
      const project = makeProject({ id: 'proj-manifest-5', name: 'Manifest Project 5' });
      mgr.createProject(project);
      const stub = makeSessionStub('proj-manifest-5', { id: 'sess-manifest-5' });
      mgr.upsertSessionStub(stub);

      mgr.updateSessionManifest('sess-manifest-5', {
        ...makeSyncManifest('sess-manifest-5'),
        artifacts: [],
        syncRuns: [],
      });

      const read = mgr.getSessionSyncManifest('sess-manifest-5');
      // safeJsonParseArray returns [] for null/missing
      expect(read!.artifacts).toEqual([]);
      expect(read!.syncRuns).toEqual([]);
    });

    it('safeJsonLength: getSyncRunCount counts sync runs', () => {
      const project = makeProject({ id: 'proj-manifest-6', name: 'Manifest Project 6' });
      mgr.createProject(project);
      const stub = makeSessionStub('proj-manifest-6', { id: 'sess-manifest-6' });
      mgr.upsertSessionStub(stub);

      mgr.updateSessionManifest('sess-manifest-6', {
        ...makeSyncManifest('sess-manifest-6'),
        syncRuns: [{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }],
      });

      expect(mgr.getSyncRunCount('sess-manifest-6')).toBe(3);
    });

    it('safeJsonLength: returns 0 when sync_runs is null', () => {
      const project = makeProject({ id: 'proj-manifest-7', name: 'Manifest Project 7' });
      mgr.createProject(project);
      const stub = makeSessionStub('proj-manifest-7', { id: 'sess-manifest-7' });
      mgr.upsertSessionStub(stub);
      // No manifest written, sync_runs is null
      expect(mgr.getSyncRunCount('sess-manifest-7')).toBe(0);
    });

    it('updateSessionManifest throws for a non-existent session', () => {
      expect(() =>
        mgr.updateSessionManifest('no-such-session', makeSyncManifest('no-such-session')),
      ).toThrow('Session not found');
    });

    it('getSessionSyncManifest returns null when sync_session_id is not set', () => {
      const project = makeProject({ id: 'proj-manifest-8', name: 'Manifest Project 8' });
      mgr.createProject(project);
      // Insert a session directly without sync_session_id (the stub API always sets it)
      mgr.getControlDb().exec({
        sql: `INSERT INTO sessions (id, project_id, source, title, started_at, ended_at)
              VALUES (?, ?, ?, ?, ?, ?)`,
        bind: ['sess-manifest-8', 'proj-manifest-8', 'claude', 'No Sync', 1000, 2000],
      });
      expect(mgr.getSessionSyncManifest('sess-manifest-8')).toBeNull();
    });
  });

  // ================================================================
  // Session files
  // ================================================================
  describe('session files', () => {
    it('upserts and retrieves session files', () => {
      const project = makeProject({ id: 'proj-files-1', name: 'Files Project' });
      mgr.createProject(project);
      const stub = makeSessionStub('proj-files-1', { id: 'sess-files-1' });
      mgr.upsertSessionStub(stub);

      const file = makeSessionFile('proj-files-1', 'sess-files-1');
      mgr.upsertSessionFile(file);

      const files = mgr.getSessionFiles('sess-files-1');
      expect(files).toHaveLength(1);
      expect(files[0].path).toBe('transcript.jsonl');
      expect(files[0].sha256).toBe('abc123');
      expect(files[0].status).toBe('downloaded');
    });

    it('updates an existing file on (session_id, path) conflict', () => {
      const project = makeProject({ id: 'proj-files-2', name: 'Files Project 2' });
      mgr.createProject(project);
      const stub = makeSessionStub('proj-files-2', { id: 'sess-files-2' });
      mgr.upsertSessionStub(stub);

      const file = makeSessionFile('proj-files-2', 'sess-files-2');
      mgr.upsertSessionFile(file);

      // Upsert with same session_id + path, different status
      mgr.upsertSessionFile({
        ...file,
        status: 'processed',
        etag: 'etag-123',
        size: 2048,
      });

      const files = mgr.getSessionFiles('sess-files-2');
      expect(files).toHaveLength(1);
      expect(files[0].status).toBe('processed');
      expect(files[0].etag).toBe('etag-123');
      expect(files[0].size).toBe(2048);
    });

    it('lists files ordered by path', () => {
      const project = makeProject({ id: 'proj-files-3', name: 'Files Project 3' });
      mgr.createProject(project);
      const stub = makeSessionStub('proj-files-3', { id: 'sess-files-3' });
      mgr.upsertSessionStub(stub);

      mgr.upsertSessionFile({ ...makeSessionFile('proj-files-3', 'sess-files-3'), path: 'z.txt' });
      mgr.upsertSessionFile({
        ...makeSessionFile('proj-files-3', 'sess-files-3'),
        id: 'file-aaa',
        path: 'a.txt',
      });

      const files = mgr.getSessionFiles('sess-files-3');
      expect(files).toHaveLength(2);
      expect(files[0].path).toBe('a.txt');
      expect(files[1].path).toBe('z.txt');
    });

    it('deletes all files for a session', () => {
      const project = makeProject({ id: 'proj-files-4', name: 'Files Project 4' });
      mgr.createProject(project);
      const stub = makeSessionStub('proj-files-4', { id: 'sess-files-4' });
      mgr.upsertSessionStub(stub);

      mgr.upsertSessionFile(makeSessionFile('proj-files-4', 'sess-files-4'));
      mgr.deleteSessionFiles('sess-files-4');

      expect(mgr.getSessionFiles('sess-files-4')).toHaveLength(0);
    });
  });

  // ================================================================
  // UI preferences
  // ================================================================
  describe('UI preferences', () => {
    it('sets and gets a preference', () => {
      mgr.setUiPreference('theme', 'dark');
      expect(mgr.getUiPreference('theme')).toBe('dark');
    });

    it('returns null for an unset preference', () => {
      expect(mgr.getUiPreference('never-set')).toBeNull();
    });

    it('overwrites an existing preference', () => {
      mgr.setUiPreference('lang', 'en');
      mgr.setUiPreference('lang', 'fr');
      expect(mgr.getUiPreference('lang')).toBe('fr');
    });
  });

  // ================================================================
  // Source checkpoints
  // ================================================================
  describe('source checkpoints', () => {
    it('commits and retrieves a checkpoint', () => {
      mgr.commitSourceCheckpoint(
        'src-1',
        {
          source_id: 'src-1',
          source_type: 'claude',
          last_sequence: 'seq-100',
        },
        { generationId: 'gen-1', committedAt: 1000 },
      );

      const cp = mgr.getSourceCheckpoint('src-1');
      expect(cp).not.toBeNull();
      expect(cp!.source_id).toBe('src-1');
      expect(cp!.source_type).toBe('claude');
      expect(cp!.last_sequence).toBe('seq-100');
      expect(cp!.committed_generation_id).toBe('gen-1');
      expect(cp!.committed_at).toBe(1000);
    });

    it('returns null for a non-existent checkpoint', () => {
      expect(mgr.getSourceCheckpoint('no-such-src')).toBeNull();
    });

    it('throws when receipt has an empty generationId', () => {
      expect(() =>
        mgr.commitSourceCheckpoint(
          'src-2',
          {
            source_id: 'src-2',
            source_type: 'claude',
          },
          { generationId: '  ' },
        ),
      ).toThrow('CommittedGenerationReceipt');
    });

    it('throws when receipt is null/undefined', () => {
      expect(() =>
        mgr.commitSourceCheckpoint(
          'src-3',
          {
            source_id: 'src-3',
            source_type: 'claude',
          },
          null as never,
        ),
      ).toThrow('CommittedGenerationReceipt');
    });

    it('upserts a checkpoint (preserves created_at, updates other fields)', () => {
      mgr.commitSourceCheckpoint(
        'src-4',
        {
          source_id: 'src-4',
          source_type: 'claude',
          last_sequence: 'seq-1',
        },
        { generationId: 'gen-4a', committedAt: 1000 },
      );

      const first = mgr.getSourceCheckpoint('src-4');
      expect(first!.created_at).toBeDefined();

      // Update with new generation
      mgr.commitSourceCheckpoint(
        'src-4',
        {
          source_id: 'src-4',
          source_type: 'claude',
          last_sequence: 'seq-2',
        },
        { generationId: 'gen-4b', committedAt: 2000 },
      );

      const second = mgr.getSourceCheckpoint('src-4');
      expect(second!.last_sequence).toBe('seq-2');
      expect(second!.committed_generation_id).toBe('gen-4b');
      expect(second!.committed_at).toBe(2000);
      // created_at should be preserved from the first insert
      expect(second!.created_at).toBe(first!.created_at);
    });

    it('lists all checkpoints ordered by updated_at desc', () => {
      mgr.commitSourceCheckpoint(
        'src-list-1',
        {
          source_id: 'src-list-1',
          source_type: 'claude',
        },
        { generationId: 'gen-list-1', committedAt: 1000 },
      );

      // Wait a moment to ensure updated_at differs
      mgr.commitSourceCheckpoint(
        'src-list-2',
        {
          source_id: 'src-list-2',
          source_type: 'claude',
        },
        { generationId: 'gen-list-2', committedAt: 2000 },
      );

      const all = mgr.getSourceCheckpoints();
      const ids = all.map((c) => c.source_id);
      expect(ids).toContain('src-list-1');
      expect(ids).toContain('src-list-2');
    });
  });

  // ================================================================
  // Sync reconciliation — exercises isProjectSyncStatus, isSessionSyncStatus
  // ================================================================
  describe('reconcileSyncStates', () => {
    it('sets syncing projects to in_sync and pending/processing sessions to failed', () => {
      const project = makeProject({ id: 'proj-recon-1', name: 'Recon Project' });
      mgr.createProject(project);
      mgr.setProjectSyncStatus('proj-recon-1', 'syncing');

      const stub1 = makeSessionStub('proj-recon-1', { id: 'sess-recon-1', sync_status: 'pending' });
      const stub2 = makeSessionStub('proj-recon-1', {
        id: 'sess-recon-2',
      });
      mgr.upsertSessionStub(stub1);
      mgr.upsertSessionStub(stub2);
      // SessionStub only allows 'pending'; switch to 'processing' via the status setter
      mgr.setSessionSyncStatus('sess-recon-2', 'processing');

      mgr.reconcileSyncStates('Crash recovery');

      const proj = mgr.getProject('proj-recon-1');
      expect(proj!.sync_status).toBe('in_sync');

      const s1 = mgr.getSessionBySyncId('proj-recon-1', stub1.sync_session_id);
      expect(s1!.sync_status).toBe('failed');
      expect(s1!.sync_details).toBe('Crash recovery');

      const s2 = mgr.getSessionBySyncId('proj-recon-1', stub2.sync_session_id);
      expect(s2!.sync_status).toBe('failed');
    });

    it('does not touch sessions that are already in_sync or failed', () => {
      const project = makeProject({ id: 'proj-recon-2', name: 'Recon Project 2' });
      mgr.createProject(project);

      const stub1 = makeSessionStub('proj-recon-2', { id: 'sess-recon-3', sync_status: 'pending' });
      mgr.upsertSessionStub(stub1);
      mgr.setSessionSyncStatus('sess-recon-3', 'in_sync');

      mgr.reconcileSyncStates('Crash recovery');

      const s = mgr.getSessionBySyncId('proj-recon-2', stub1.sync_session_id);
      expect(s!.sync_status).toBe('in_sync');
    });
  });

  // ================================================================
  // failStaleSessions
  // ================================================================
  describe('failStaleSessions', () => {
    it('marks pending and processing sessions as failed with details', () => {
      const project = makeProject({ id: 'proj-fail-1', name: 'Fail Project' });
      mgr.createProject(project);

      const stub1 = makeSessionStub('proj-fail-1', { id: 'sess-fail-1', sync_status: 'pending' });
      const stub2 = makeSessionStub('proj-fail-1', {
        id: 'sess-fail-2',
      });
      mgr.upsertSessionStub(stub1);
      mgr.upsertSessionStub(stub2);
      mgr.setSessionSyncStatus('sess-fail-2', 'processing');

      mgr.failStaleSessions('proj-fail-1', 'Timed out');

      const s1 = mgr.getSessionBySyncId('proj-fail-1', stub1.sync_session_id);
      expect(s1!.sync_status).toBe('failed');
      expect(s1!.sync_details).toBe('Timed out');

      const s2 = mgr.getSessionBySyncId('proj-fail-1', stub2.sync_session_id);
      expect(s2!.sync_status).toBe('failed');
    });

    it('does not affect sessions in other projects', () => {
      const proj1 = makeProject({ id: 'proj-fail-2', name: 'Fail Project 2' });
      const proj2 = makeProject({ id: 'proj-fail-3', name: 'Fail Project 3' });
      mgr.createProject(proj1);
      mgr.createProject(proj2);

      const stub = makeSessionStub('proj-fail-3', { id: 'sess-fail-3', sync_status: 'pending' });
      mgr.upsertSessionStub(stub);

      mgr.failStaleSessions('proj-fail-2', 'Timed out');

      const s = mgr.getSessionBySyncId('proj-fail-3', stub.sync_session_id);
      expect(s!.sync_status).toBe('pending');
    });
  });

  // ================================================================
  // Export
  // ================================================================
  describe('exportControlDatabase', () => {
    it('exports the database as a valid SQLite file (non-empty Uint8Array)', () => {
      mgr.createProject(makeProject({ id: 'proj-export-1', name: 'Export Project' }));
      const bytes = mgr.exportControlDatabase();
      expect(bytes).toBeInstanceOf(Uint8Array);
      expect(bytes.length).toBeGreaterThan(0);
      // SQLite file header
      expect(String.fromCharCode(...bytes.slice(0, 15))).toBe('SQLite format 3');
    });
  });

  // ================================================================
  // close
  // ================================================================
  describe('close', () => {
    it('closes the database and prevents further operations', async () => {
      const m = await createManager();
      m.close();
      expect(() => m.getProjects()).toThrow('Database not initialized');
    });
  });
});
