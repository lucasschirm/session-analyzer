// @vitest-environment node
/**
 * Tests for the split database ownership: the analytics database holds
 * projects/sessions, while the control database holds connections, vault
 * state, source checkpoints and UI preferences.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type CommittedGenerationReceipt,
  DatabaseManager,
  type SourceCheckpoint,
} from '../../src/db/database';
import type { Connection, PasskeyState, Project, StoredS3Credentials } from '../../src/types';

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

function makeConnection(overrides: Partial<Connection> = {}): Connection {
  return {
    id: `conn-${Math.random().toString(36).slice(2)}`,
    name: 'S3 Dev',
    storage_type: 's3',
    sync_only_new: false,
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_000,
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
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_000,
  };
}

function makePasskeyState(): PasskeyState {
  return {
    id: 1,
    kdf_salt: 'salt',
    verifier_iv: 'iv',
    verifier_ct: 'ct',
    created_at: 1_700_000_000_000,
  };
}

describe('DatabaseManager split', () => {
  let manager: DatabaseManager;

  beforeEach(async () => {
    manager = new DatabaseManager();
    const storage = await manager.initialize();
    expect(storage).toBe('memory');
  });

  afterEach(() => {
    manager.close();
  });

  it('opens two distinct Database connections', () => {
    const analytics = manager.getAnalyticsDb();
    const control = manager.getControlDb();

    expect(analytics).not.toBe(control);

    const controlTables = control.selectObjects(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'connections'",
    ) as { name: string }[];
    expect(controlTables).toHaveLength(1);

    const analyticsTables = analytics.selectObjects(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'projects'",
    ) as { name: string }[];
    expect(analyticsTables).toHaveLength(1);
  });

  it('retains vault and connection state across an analytics reset', () => {
    const project = makeProject();
    manager.createProject(project);

    const connection = makeConnection();
    manager.createConnection(connection);
    manager.saveS3Credentials(makeS3Credentials(connection.id));
    manager.savePasskeyState(makePasskeyState());

    expect(manager.getProject(project.id)).not.toBeNull();
    expect(manager.getConnections().map((c) => c.id)).toContain(connection.id);
    expect(manager.getS3Credentials(connection.id)).not.toBeNull();
    expect(manager.getPasskeyState()).not.toBeNull();

    manager.resetAnalyticsDatabase();

    expect(manager.getProject(project.id)).toBeNull();
    expect(manager.getProjects()).toEqual([]);

    expect(manager.getConnections().map((c) => c.id)).toContain(connection.id);
    expect(manager.getS3Credentials(connection.id)).not.toBeNull();
    expect(manager.getPasskeyState()).not.toBeNull();
  });

  it('only commits a checkpoint after a valid generation receipt is supplied', () => {
    const checkpoint: SourceCheckpoint = {
      source_id: 'source-1',
      source_type: 's3',
      last_sequence: 'seq-42',
      last_cursor: 'cursor-99',
    };

    expect(() =>
      manager.commitSourceCheckpoint('source-1', checkpoint, { generationId: '' }),
    ).toThrow('A valid CommittedGenerationReceipt with a non-empty generationId is required');

    expect(manager.getSourceCheckpoint('source-1')).toBeNull();

    const receipt: CommittedGenerationReceipt = {
      generationId: 'gen-abc-123',
      committedAt: 1_700_000_000_000,
    };

    manager.commitSourceCheckpoint('source-1', checkpoint, receipt);

    const stored = manager.getSourceCheckpoint('source-1');
    expect(stored).not.toBeNull();
    expect(stored?.source_id).toBe('source-1');
    expect(stored?.source_type).toBe('s3');
    expect(stored?.last_sequence).toBe('seq-42');
    expect(stored?.last_cursor).toBe('cursor-99');
    expect(stored?.committed_generation_id).toBe('gen-abc-123');
    expect(stored?.committed_at).toBe(1_700_000_000_000);
    expect(stored?.created_at).toBeDefined();
    expect(stored?.updated_at).toBeDefined();

    const checkpoints = manager.getSourceCheckpoints();
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0].source_id).toBe('source-1');
  });

  it('updates an existing checkpoint without changing its created_at', () => {
    const receipt1: CommittedGenerationReceipt = { generationId: 'gen-1' };
    const receipt2: CommittedGenerationReceipt = { generationId: 'gen-2' };

    const checkpoint1: SourceCheckpoint = {
      source_id: 'source-2',
      source_type: 's3',
      last_sequence: 'seq-1',
    };

    manager.commitSourceCheckpoint('source-2', checkpoint1, receipt1);
    const first = manager.getSourceCheckpoint('source-2') as SourceCheckpoint;

    const checkpoint2: SourceCheckpoint = {
      source_id: 'source-2',
      source_type: 's3',
      last_sequence: 'seq-2',
    };

    manager.commitSourceCheckpoint('source-2', checkpoint2, receipt2);
    const second = manager.getSourceCheckpoint('source-2') as SourceCheckpoint;

    expect(second.last_sequence).toBe('seq-2');
    expect(second.committed_generation_id).toBe('gen-2');
    expect(second.created_at).toBe(first.created_at);
    expect(second.updated_at).toBeGreaterThanOrEqual(first.updated_at ?? 0);
  });

  it('stores UI preferences in the control database', () => {
    manager.setUiPreference('show_intro', 'false');
    expect(manager.getUiPreference('show_intro')).toBe('false');

    manager.setUiPreference('show_intro', 'true');
    expect(manager.getUiPreference('show_intro')).toBe('true');

    expect(manager.getUiPreference('missing_key')).toBeNull();
  });
});
