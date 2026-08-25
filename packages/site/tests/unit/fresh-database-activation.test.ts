// @vitest-environment node
/**
 * Tests for fresh analytics database activation, rollback, source-retention
 * controls, legacy export, and reload.
 */

import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  AnalyticsActivationState,
  SourceRetentionControls,
} from '../../src/db/activation-state';
import { DatabaseManager } from '../../src/db/database';
import { DbClient } from '../../src/db/db-client';
import type { DbRequest, DbResponse } from '../../src/db/db-protocol';
import { LegacyDatabase } from '../../src/db/legacy-database';
import type { LegacyDbRequest, LegacyDbResponse } from '../../src/db/legacy-db-client';
import { LegacyDbClient } from '../../src/db/legacy-db-client';
import type { Project } from '../../src/types';

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: `project-${Math.random().toString(36).slice(2)}`,
    name: 'Test Project',
    description: 'A test project',
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_000,
    session_count: 0,
    ...overrides,
  };
}

/** Fake main-thread worker for DbClient tests. */
class FakeWorker {
  onmessage: ((event: MessageEvent<DbResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  posted: DbRequest[] = [];

  postMessage(request: DbRequest): void {
    this.posted.push(request);
  }

  respond(response: DbResponse): void {
    this.onmessage?.({ data: response } as MessageEvent<DbResponse>);
  }

  fail(message: string): void {
    this.onerror?.({ message } as ErrorEvent);
  }
}

/** Fake worker for LegacyDbClient tests. */
class FakeLegacyWorker {
  onmessage: ((event: MessageEvent<LegacyDbResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  posted: LegacyDbRequest[] = [];

  postMessage(request: LegacyDbRequest): void {
    this.posted.push(request);
  }

  respond(response: LegacyDbResponse): void {
    this.onmessage?.({ data: response } as MessageEvent<LegacyDbResponse>);
  }
}

describe('DatabaseManager activation', () => {
  let manager: DatabaseManager;

  beforeEach(async () => {
    manager = new DatabaseManager();
    const storage = await manager.initialize();
    expect(storage).toBe('memory');
  });

  it('starts with no activation state', () => {
    expect(manager.getAnalyticsActivationState()).toBeNull();
    expect(manager.getSourceRetentionControls()).toEqual({
      retainTranscripts: true,
      retainSubAgents: true,
      retainConfigurationArtifacts: true,
    });
  });

  it('activates a fresh analytics database and resets existing rows', () => {
    const project = makeProject();
    manager.createProject(project);
    expect(manager.getProject(project.id)).not.toBeNull();

    const retention: SourceRetentionControls = {
      retainTranscripts: true,
      retainSubAgents: false,
      retainConfigurationArtifacts: true,
    };

    const state = manager.activateAnalyticsDatabase(retention);

    expect(state.mode).toBe('new');
    expect(state.disclosureConfirmed).toBe(true);
    expect(state.retention).toEqual(retention);
    expect(state.activatedAt).toBeGreaterThan(0);

    expect(manager.getProject(project.id)).toBeNull();
    expect(manager.getProjects()).toEqual([]);
    expect(manager.getAnalyticsActivationState()).toEqual(state);
  });

  it('preserves control data across activation', () => {
    const connection = {
      id: 'c1',
      name: 'S3 Dev',
      storage_type: 's3' as const,
      sync_only_new: false,
      created_at: 1,
      updated_at: 2,
    };
    manager.createConnection(connection);
    manager.savePasskeyState({
      id: 1,
      kdf_salt: 'salt',
      verifier_iv: 'iv',
      verifier_ct: 'ct',
      created_at: 1,
    });

    const retention: SourceRetentionControls = {
      retainTranscripts: false,
      retainSubAgents: false,
      retainConfigurationArtifacts: false,
    };

    manager.activateAnalyticsDatabase(retention);

    expect(manager.getConnections().map((c) => c.id)).toContain('c1');
    expect(manager.getPasskeyState()).not.toBeNull();
  });

  it('rolls back to legacy mode without losing the activation record', () => {
    const retention: SourceRetentionControls = {
      retainTranscripts: true,
      retainSubAgents: true,
      retainConfigurationArtifacts: false,
    };

    const activated = manager.activateAnalyticsDatabase(retention);
    const rolledBack = manager.rollbackToLegacyMode();

    expect(rolledBack.mode).toBe('legacy');
    expect(rolledBack.activatedAt).toBe(activated.activatedAt);
    expect(rolledBack.retention).toEqual(retention);
    expect(manager.getAnalyticsActivationState()).toEqual(rolledBack);
  });

  it('reloads source retention controls after activation', () => {
    const retention: SourceRetentionControls = {
      retainTranscripts: false,
      retainSubAgents: true,
      retainConfigurationArtifacts: true,
    };
    manager.activateAnalyticsDatabase(retention);
    expect(manager.getSourceRetentionControls()).toEqual(retention);

    manager.rollbackToLegacyMode();
    expect(manager.getSourceRetentionControls()).toEqual(retention);
  });
});

describe('DbClient activation protocol', () => {
  let worker: FakeWorker;
  let client: DbClient;

  beforeEach(() => {
    worker = new FakeWorker();
    client = new DbClient(() => worker as unknown as Worker);
  });

  function ensureInitialized(): void {
    void client.ensureReady();
    worker.respond({ id: worker.posted[0].id, ok: true, storage: 'memory' });
  }

  it('requests the activation state', async () => {
    ensureInitialized();

    const promise = client.getAnalyticsActivationState();
    expect(worker.posted[1]).toMatchObject({ type: 'getAnalyticsActivationState' });

    const state: AnalyticsActivationState = {
      mode: 'new',
      activatedAt: 1,
      retention: {
        retainTranscripts: true,
        retainSubAgents: false,
        retainConfigurationArtifacts: true,
      },
      disclosureConfirmed: true,
    };

    worker.respond({ id: worker.posted[1].id, ok: true, result: state });
    await expect(promise).resolves.toEqual(state);
  });

  it('sends an activation request with source retention', async () => {
    ensureInitialized();

    const retention: SourceRetentionControls = {
      retainTranscripts: true,
      retainSubAgents: true,
      retainConfigurationArtifacts: true,
    };

    const promise = client.activateAnalyticsDatabase(retention);
    expect(worker.posted[1]).toMatchObject({ type: 'activateAnalyticsDatabase', retention });

    const state: AnalyticsActivationState = {
      mode: 'new',
      activatedAt: 1,
      retention,
      disclosureConfirmed: true,
    };
    worker.respond({ id: worker.posted[1].id, ok: true, result: state });
    await expect(promise).resolves.toEqual(state);
  });

  it('rolls back to legacy mode', async () => {
    ensureInitialized();

    const promise = client.rollbackToLegacyMode();
    expect(worker.posted[1]).toMatchObject({ type: 'rollbackToLegacyMode' });

    const state: AnalyticsActivationState = {
      mode: 'legacy',
      activatedAt: 1,
      retention: {
        retainTranscripts: false,
        retainSubAgents: false,
        retainConfigurationArtifacts: false,
      },
      disclosureConfirmed: true,
    };
    worker.respond({ id: worker.posted[1].id, ok: true, result: state });
    await expect(promise).resolves.toEqual(state);
  });

  it('requests source retention controls', async () => {
    ensureInitialized();

    const promise = client.getSourceRetentionControls();
    expect(worker.posted[1]).toMatchObject({ type: 'getSourceRetentionControls' });

    const retention: SourceRetentionControls = {
      retainTranscripts: false,
      retainSubAgents: true,
      retainConfigurationArtifacts: false,
    };
    worker.respond({ id: worker.posted[1].id, ok: true, result: retention });
    await expect(promise).resolves.toEqual(retention);
  });

  it('does not leak SQL types in activation requests', () => {
    const request: DbRequest = {
      id: 1,
      type: 'activateAnalyticsDatabase',
      retention: {
        retainTranscripts: true,
        retainSubAgents: true,
        retainConfigurationArtifacts: true,
      },
    };

    // @ts-expect-error SQL rows must not leak into the protocol.
    const bad: DbRequest = { ...request, rows: [{ id: 1 }] };
    void bad;
    expect(request.retention.retainTranscripts).toBe(true);
  });
});

describe('LegacyDatabase export', () => {
  const filename = `/tmp/sal-legacy-${randomUUID()}.sqlite3`;
  let sqlite3: Awaited<ReturnType<typeof sqlite3InitModule>>;

  beforeAll(async () => {
    sqlite3 = await sqlite3InitModule();
  });

  beforeEach(async () => {
    const db = new sqlite3.oo1.DB(filename, 'c');
    db.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT);
      INSERT INTO projects VALUES ('p1', 'Legacy Pre-Split Project');
    `);
    db.close();
  });

  afterEach(async () => {
    try {
      await unlink(filename);
    } catch {
      // ignore
    }
  });

  it('exports a pre-split legacy database read-only', async () => {
    const legacy = new LegacyDatabase(sqlite3);
    const storage = await legacy.initialize(filename);
    expect(storage).toBe('memory');

    const bytes = legacy.exportDatabase();
    expect(bytes.length).toBeGreaterThan(0);
    const header = new TextDecoder().decode(bytes.slice(0, 16));
    expect(header).toBe('SQLite format 3\u0000');

    // Verify the database is read-only by trying to write.
    const db = (legacy as unknown as { db: { exec: (sql: string) => unknown } }).db;
    expect(() => db.exec("INSERT INTO projects VALUES ('p2', 'x')")).toThrow(/READONLY/);

    legacy.close();
  });
});

describe('LegacyDbClient export protocol', () => {
  let worker: FakeLegacyWorker;
  let client: LegacyDbClient;

  beforeEach(() => {
    worker = new FakeLegacyWorker();
    client = new LegacyDbClient(() => worker as unknown as Worker);
  });

  it('initializes, exports, and closes the legacy worker', async () => {
    const ready = client.ensureReady('/session-analyzer.sqlite3');
    expect(worker.posted[0]).toMatchObject({
      type: 'init',
      filename: '/session-analyzer.sqlite3',
    });
    worker.respond({ id: worker.posted[0].id, ok: true, storage: 'memory' });
    await expect(ready).resolves.toBe('memory');

    const exportPromise = client.exportDatabase();
    expect(worker.posted[1]).toMatchObject({ type: 'exportDatabase' });
    const bytes = new Uint8Array([83, 81, 76, 105, 116, 101]);
    worker.respond({ id: worker.posted[1].id, ok: true, bytes });
    await expect(exportPromise).resolves.toBe(bytes);

    const closePromise = client.close();
    expect(worker.posted[2]).toMatchObject({ type: 'close' });
    worker.respond({ id: worker.posted[2].id, ok: true });
    await expect(closePromise).resolves.toBeUndefined();
  });
});
