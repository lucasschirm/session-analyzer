import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildManifest,
  buildManifestArtifacts,
  buildObjectKey,
  createEmptySyncState,
  MANIFEST_SCHEMA_VERSION,
  type ManifestArtifact,
  ManifestGenerator,
  type PutObjectInput,
  type PutObjectResult,
  recordArtifactDiscovered,
  recordArtifactFailure,
  recordArtifactUploaded,
  type SessionData,
  StateStore,
  type StorageAdapter,
  StorageError,
  SYNC_VERSION,
  type SyncRun,
  type SyncTrigger,
  UNKNOWN_HARNESS_VERSION,
} from '../../src/index.js';

function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function makeSession(overrides: Partial<SessionData> = {}): SessionData {
  return {
    sessionId: 'sess-1',
    projectId: 'proj-1',
    harness: 'claude',
    harnessVersion: '1.2.3',
    ...overrides,
  };
}

function makeArtifact(overrides: Partial<ManifestArtifact> = {}): ManifestArtifact {
  return {
    projectId: 'proj-1',
    sessionId: 'sess-1',
    scope: 'workspace',
    relativePath: '.claude/settings.json',
    sha256: 'hash-1',
    size: 123,
    status: 'pending',
    ...overrides,
  };
}

function makeRun(trigger: SyncTrigger, overrides: Partial<SyncRun> = {}): SyncRun {
  return {
    trigger,
    filesDiscovered: 1,
    filesChanged: 1,
    filesUploaded: 1,
    filesFailed: 0,
    filesSkipped: 0,
    bytesDiscovered: 100,
    bytesChanged: 100,
    bytesUploaded: 100,
    discoveryDurationMs: 1,
    sanitizationDurationMs: 2,
    hashDurationMs: 3,
    uploadDurationMs: 4,
    totalDurationMs: 10,
    ...overrides,
  };
}

class InMemoryStorageAdapter implements StorageAdapter {
  private readonly objects = new Map<string, PutObjectResult>();

  async putObject(input: PutObjectInput): Promise<PutObjectResult> {
    const key = buildObjectKey(input);
    const sha256 = input.contentSha256 ?? sha256Hex(input.body);
    const result: PutObjectResult = { key, sha256, etag: `"${sha256}"` };
    this.objects.set(key, result);
    return result;
  }

  getKeys(): string[] {
    return [...this.objects.keys()];
  }
}

class FailingStorageAdapter implements StorageAdapter {
  async putObject(): Promise<PutObjectResult> {
    throw new StorageError('SYNC_STORAGE_ERROR', 'simulated manifest upload failure', false);
  }
}

describe('buildManifest', () => {
  it('emits the §24 schema with session metadata and version fields', () => {
    const session = makeSession({
      model: 'claude-3-5-sonnet',
      startedAt: '2026-08-17T00:00:00Z',
      endedAt: '2026-08-17T01:00:00Z',
      durationMs: 3_600_000,
      endReason: 'completed',
    });
    const state = createEmptySyncState();
    const runs = [makeRun('session-start'), makeRun('session-end')];
    const artifact = makeArtifact();

    const manifest = buildManifest(session, [artifact], state, runs, {
      pluginVersion: 'plugin-1.0.0',
    });

    expect(manifest.schemaVersion).toBe(MANIFEST_SCHEMA_VERSION);
    expect(manifest.syncVersion).toBe(SYNC_VERSION);
    expect(manifest.pluginVersion).toBe('plugin-1.0.0');
    expect(manifest.projectId).toBe('proj-1');
    expect(manifest.sessionId).toBe('sess-1');
    expect(manifest.harness).toBe('claude');
    expect(manifest.harnessVersion).toBe('1.2.3');
    expect(manifest.model).toBe('claude-3-5-sonnet');
    expect(manifest.startedAt).toBe('2026-08-17T00:00:00Z');
    expect(manifest.endedAt).toBe('2026-08-17T01:00:00Z');
    expect(manifest.durationMs).toBe(3_600_000);
    expect(manifest.endReason).toBe('completed');
    expect(manifest.transcriptsCaptured).toBe(true);
    expect(manifest.artifacts).toHaveLength(1);
    expect(manifest.syncRuns).toHaveLength(2);
  });

  it('defaults harnessVersion to unknown when empty', () => {
    const session = makeSession({ harnessVersion: '' });
    const manifest = buildManifest(session, [makeArtifact()], createEmptySyncState(), []);

    expect(manifest.harnessVersion).toBe(UNKNOWN_HARNESS_VERSION);
  });

  it('excludes session artifacts and sets transcriptsCaptured false', () => {
    const state = createEmptySyncState();
    const workspaceArtifact = makeArtifact({
      scope: 'workspace',
      relativePath: 'CLAUDE.md',
      sha256: 'workspace-hash',
    });
    const sessionArtifact = makeArtifact({
      scope: 'session',
      relativePath: 'transcript.jsonl',
      sha256: 'session-hash',
    });

    const manifest = buildManifest(makeSession(), [workspaceArtifact, sessionArtifact], state, [], {
      captureTranscripts: false,
    });

    expect(manifest.transcriptsCaptured).toBe(false);
    expect(manifest.artifacts).toHaveLength(1);
    expect(manifest.artifacts[0].scope).toBe('workspace');
    expect(manifest.artifacts[0].sha256).toBe('workspace-hash');
  });

  it('aggregates per-trigger sync-run metrics', () => {
    const runs: SyncRun[] = [
      makeRun('session-start', { filesDiscovered: 10, filesUploaded: 10 }),
      makeRun('file-changed', { filesDiscovered: 1, filesUploaded: 1 }),
      makeRun('session-end', { filesDiscovered: 2, filesUploaded: 2 }),
    ];
    const manifest = buildManifest(makeSession(), [makeArtifact()], createEmptySyncState(), runs);

    expect(manifest.syncRuns).toHaveLength(3);
    expect(manifest.syncRuns[0].trigger).toBe('session-start');
    expect(manifest.syncRuns[0].filesDiscovered).toBe(10);
    expect(manifest.syncRuns[1].trigger).toBe('file-changed');
    expect(manifest.syncRuns[2].trigger).toBe('session-end');
  });
});

describe('buildManifestArtifacts', () => {
  it('reflects uploaded artifacts with matching hashes', () => {
    const state = createEmptySyncState();
    const artifact = makeArtifact({ sha256: 'hash-1' });
    recordArtifactUploaded(state, artifact);

    const result = buildManifestArtifacts([artifact], state);

    expect(result).toHaveLength(1);
    expect(result[0].status).toBe('uploaded');
    expect(result[0].sha256).toBe('hash-1');
    expect(result[0].size).toBe(123);
  });

  it('reflects failed artifacts', () => {
    const state = createEmptySyncState();
    const artifact = makeArtifact({ sha256: 'hash-1' });
    recordArtifactFailure(state, artifact, 'SYNC_AUTH_FAILED');

    const result = buildManifestArtifacts([{ ...artifact, sha256: 'hash-2' }], state);

    expect(result[0].status).toBe('failed');
  });

  it('reflects skipped artifacts when unchanged but not uploaded', () => {
    const state = createEmptySyncState();
    const uploaded = makeArtifact({ sha256: 'hash-1' });
    recordArtifactUploaded(state, uploaded);
    // Re-discover the same hash and mark it as merely discovered.
    const rediscovered = makeArtifact({ sha256: 'hash-1' });
    recordArtifactDiscovered(state, rediscovered);

    const result = buildManifestArtifacts([rediscovered], state);

    expect(result[0].status).toBe('skipped');
  });

  it('marks new artifacts as pending', () => {
    const state = createEmptySyncState();
    const artifact = makeArtifact({ sha256: 'hash-1' });

    const result = buildManifestArtifacts([artifact], state);

    expect(result[0].status).toBe('pending');
  });
});

describe('ManifestGenerator', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sal-manifest-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('resolves artifact status from durable state when generating', async () => {
    const artifact = makeArtifact({ sha256: 'hash-1' });
    const store = new StateStore(tempDir);
    await store.withState((state) => {
      recordArtifactUploaded(state, artifact);
    });

    const generator = new ManifestGenerator(tempDir);
    const session = makeSession();
    const manifest = await generator.generate(session, [artifact]);

    expect(manifest.artifacts).toHaveLength(1);
    expect(manifest.artifacts[0].status).toBe('uploaded');
    expect(manifest.artifacts[0].sha256).toBe('hash-1');
  });

  it('records runs durably and includes them in the manifest', async () => {
    const generator = new ManifestGenerator(tempDir);
    await generator.recordRun('sess-1', makeRun('session-start', { filesDiscovered: 5 }));
    await generator.recordRun('sess-1', makeRun('file-changed', { filesDiscovered: 1 }));

    // Use a fresh generator to prove the run log is durable.
    const secondGenerator = new ManifestGenerator(tempDir);
    const manifest = await secondGenerator.generate(makeSession(), [makeArtifact()]);

    expect(manifest.syncRuns).toHaveLength(2);
    expect(manifest.syncRuns[0].trigger).toBe('session-start');
    expect(manifest.syncRuns[0].filesDiscovered).toBe(5);
    expect(manifest.syncRuns[1].trigger).toBe('file-changed');
  });

  it('uploads the manifest and records it as uploaded in durable state', async () => {
    const adapter = new InMemoryStorageAdapter();
    const generator = new ManifestGenerator(tempDir, { storageAdapter: adapter });
    await generator.recordRun('sess-1', makeRun('session-end'));

    const session = makeSession();
    const manifest = await generator.generate(session, [makeArtifact()]);
    const result = await generator.upload(manifest);

    expect(result.key).toBe('proj-1/sess-1/manifest.json');
    expect(adapter.getKeys()).toContain(result.key);

    // Verify durable state reflects a successful manifest upload.
    const afterState = await new StateStore(tempDir).readState();
    const manifestRecord = Object.values(afterState.artifacts).find(
      (record) => record.scope === 'runtime' && record.relativePath === 'manifest.json',
    );
    expect(manifestRecord).toBeDefined();
    expect(manifestRecord?.status).toBe('uploaded');
    expect(manifestRecord?.lastUploadedHash).toBe(result.sha256);
  });

  it('records manifest upload failure durably and allows recovery', async () => {
    const failingAdapter = new FailingStorageAdapter();
    const generator = new ManifestGenerator(tempDir, { storageAdapter: failingAdapter });
    await generator.recordRun('sess-1', makeRun('session-end'));

    const session = makeSession();
    const manifest = await generator.generate(session, [makeArtifact()]);
    await expect(generator.upload(manifest)).rejects.toThrow('simulated manifest upload failure');

    // Verify durable state shows failure, not a completed upload.
    const failedState = await new StateStore(tempDir).readState();
    const manifestRecord = Object.values(failedState.artifacts).find(
      (record) => record.scope === 'runtime' && record.relativePath === 'manifest.json',
    );
    expect(manifestRecord).toBeDefined();
    expect(manifestRecord?.status).toBe('failed');
    expect(manifestRecord?.lastUploadedHash).toBeUndefined();

    // Recovery: a later manual or SessionStart sync can regenerate and re-upload.
    const successAdapter = new InMemoryStorageAdapter();
    const recoveryGenerator = new ManifestGenerator(tempDir, { storageAdapter: successAdapter });
    const recoveredManifest = await recoveryGenerator.generate(session, [makeArtifact()]);
    const result = await recoveryGenerator.upload(recoveredManifest);

    expect(result.key).toBe('proj-1/sess-1/manifest.json');
    expect(recoveredManifest.syncRuns).toHaveLength(1);
  });

  it('throws when uploading without a storage adapter', async () => {
    const generator = new ManifestGenerator(tempDir);
    const manifest = await generator.generate(makeSession(), [makeArtifact()]);
    await expect(generator.upload(manifest)).rejects.toThrow('storage adapter is required');
  });

  it('keeps run history across upload failures so the manifest is regenerable', async () => {
    const failingAdapter = new FailingStorageAdapter();
    const generator = new ManifestGenerator(tempDir, { storageAdapter: failingAdapter });
    await generator.recordRun('sess-1', makeRun('session-start'));
    await generator.recordRun('sess-1', makeRun('session-end'));

    const session = makeSession();
    const manifest = await generator.generate(session, [makeArtifact()]);
    await expect(generator.upload(manifest)).rejects.toThrow();

    const afterState = await new StateStore(tempDir).readState();
    expect(Object.keys(afterState.artifacts)).toHaveLength(1);

    const recoveredManifest = await new ManifestGenerator(tempDir).generate(session, [
      makeArtifact(),
    ]);
    expect(recoveredManifest.syncRuns).toHaveLength(2);
    expect(recoveredManifest.artifacts[0].status).toBe('pending');
  });
});
