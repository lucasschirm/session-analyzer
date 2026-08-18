import { spawn } from 'node:child_process';
import fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  type ArtifactIdentity,
  advanceLastUploadedHash,
  createEmptySyncState,
  FileLock,
  getArtifactRecord,
  getPendingArtifacts,
  isArtifactPending,
  recordArtifactDiscovered,
  recordArtifactFailure,
  recordArtifactUploaded,
  recordArtifactUploading,
  type SessionData,
  StateStore,
  SyncStateError,
  writeFileAtomic,
} from '../../src/index.js';

function makeArtifact(overrides: Partial<ArtifactIdentity> = {}): ArtifactIdentity {
  return {
    projectId: 'proj-1',
    sessionId: 'sess-1',
    scope: 'workspace',
    relativePath: '.claude/settings.json',
    sha256: 'hash-1',
    ...overrides,
  };
}

function makeSession(overrides: Partial<SessionData> = {}): SessionData {
  return {
    sessionId: 'sess-1',
    projectId: 'proj-1',
    harness: 'claude',
    harnessVersion: 'unknown',
    ...overrides,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe('StateStore', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sal-state-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates the persistent directory tree', async () => {
    const store = new StateStore(tempDir);
    await store.ensureDirectories();

    for (const dir of ['state', 'sessions', 'locks', 'watcher', 'logs']) {
      expect(fs.existsSync(path.join(tempDir, dir))).toBe(true);
    }
  });

  it('returns an empty sync state when none exists', async () => {
    const store = new StateStore(tempDir);
    const state = await store.readState();
    expect(state.version).toBe(1);
    expect(Object.keys(state.artifacts)).toHaveLength(0);
  });

  it('persists artifact records through withState', async () => {
    const store = new StateStore(tempDir);
    const artifact = makeArtifact();

    await store.withState((state) => {
      recordArtifactDiscovered(state, artifact);
    });

    const state = await store.readState();
    const record = getArtifactRecord(state, artifact);
    expect(record).toBeDefined();
    expect(record?.status).toBe('discovered');
    expect(record?.lastDiscoveredHash).toBe(artifact.sha256);
  });

  it('computes pending artifacts and advances lastUploadedHash on upload', async () => {
    const state = createEmptySyncState();
    const a1 = makeArtifact({ relativePath: 'a.json', sha256: 'h1' });
    const a2 = makeArtifact({ relativePath: 'b.json', sha256: 'h2' });

    recordArtifactDiscovered(state, a1);
    recordArtifactDiscovered(state, a2);
    recordArtifactUploading(state, a1);
    advanceLastUploadedHash(state, a1);

    expect(getPendingArtifacts(state, [a1, a2])).toEqual([a2]);
    expect(getArtifactRecord(state, a1)?.status).toBe('uploaded');
    expect(getArtifactRecord(state, a1)?.lastUploadedHash).toBe('h1');
  });

  it('records failures and retries without advancing lastUploadedHash', async () => {
    const state = createEmptySyncState();
    const artifact = makeArtifact();

    recordArtifactDiscovered(state, artifact);
    recordArtifactFailure(state, artifact, 'SYNC_AUTH_FAILED');

    const record = getArtifactRecord(state, artifact);
    expect(record?.status).toBe('failed');
    expect(record?.lastError).toBe('SYNC_AUTH_FAILED');
    expect(record?.attemptCount).toBe(1);
    expect(record?.lastUploadedHash).toBeUndefined();
    expect(isArtifactPending(record, artifact.sha256)).toBe(true);

    recordArtifactFailure(state, artifact, 'SYNC_STORAGE_ERROR');
    expect(getArtifactRecord(state, artifact)?.attemptCount).toBe(2);
  });

  it('resets attemptCount and lastError when the content hash changes', async () => {
    const state = createEmptySyncState();
    const oldVersion = makeArtifact({ sha256: 'h1' });
    recordArtifactDiscovered(state, oldVersion);
    recordArtifactFailure(state, oldVersion, 'SYNC_STORAGE_ERROR');

    const newVersion = makeArtifact({ sha256: 'h2' });
    recordArtifactDiscovered(state, newVersion);

    const record = getArtifactRecord(state, newVersion);
    expect(record?.attemptCount).toBe(0);
    expect(record?.lastError).toBeUndefined();
  });

  it('does not advance state when the withState callback throws', async () => {
    const store = new StateStore(tempDir);
    const artifact = makeArtifact();

    await store.withState((state) => {
      recordArtifactDiscovered(state, artifact);
    });

    await expect(
      store.withState((state) => {
        recordArtifactUploaded(state, artifact);
        throw new Error('upload simulated failure');
      }),
    ).rejects.toThrow('upload simulated failure');

    const state = await store.readState();
    expect(getArtifactRecord(state, artifact)?.status).toBe('discovered');
    expect(getArtifactRecord(state, artifact)?.lastUploadedHash).toBeUndefined();
  });

  it('writes and reads session records with per-session concurrency', async () => {
    const store = new StateStore(tempDir);

    await Promise.all([
      store.setSession('sess-a', makeSession({ sessionId: 'sess-a' })),
      store.setSession('sess-b', makeSession({ sessionId: 'sess-b' })),
    ]);

    const [a, b] = await Promise.all([store.getSession('sess-a'), store.getSession('sess-b')]);

    expect(a?.sessionId).toBe('sess-a');
    expect(b?.sessionId).toBe('sess-b');
  });

  it('survives re-instantiation of the store', async () => {
    const artifact = makeArtifact();

    const first = new StateStore(tempDir);
    await first.withState((state) => {
      recordArtifactDiscovered(state, artifact);
      recordArtifactUploaded(state, artifact);
    });

    const second = new StateStore(tempDir);
    const state = await second.readState();
    const record = getArtifactRecord(state, artifact);
    expect(record?.status).toBe('uploaded');
    expect(record?.lastUploadedHash).toBe(artifact.sha256);
  });

  it('recovers from corrupt state.json and treats all artifacts as pending', async () => {
    const store = new StateStore(tempDir);
    const a1 = makeArtifact({ relativePath: 'a.json', sha256: 'h1' });
    const a2 = makeArtifact({ relativePath: 'b.json', sha256: 'h2' });

    await store.withState((state) => {
      recordArtifactUploaded(state, a1);
      recordArtifactUploaded(state, a2);
    });

    const statePath = path.join(tempDir, 'state', 'state.json');
    fs.writeFileSync(statePath, 'this is not json');

    const state = await store.readState();
    expect(state.errors).toContain('SYNC_STATE_CORRUPT');
    expect(Object.keys(state.artifacts)).toHaveLength(0);
    expect(getPendingArtifacts(state, [a1, a2])).toHaveLength(2);

    const preserved = (await fsp.readdir(path.join(tempDir, 'state'))).filter((name) =>
      name.startsWith('state.json.corrupt-'),
    );
    expect(preserved.length).toBe(1);
  });

  it('persists SYNC_STATE_CORRUPT across state writes', async () => {
    const store = new StateStore(tempDir);
    const statePath = path.join(tempDir, 'state', 'state.json');

    await store.ensureDirectories();
    fs.writeFileSync(statePath, 'this is not json');

    // A withState call triggers corruption recovery and then saves the marker.
    await store.withState((state) => {
      expect(state.errors).toContain('SYNC_STATE_CORRUPT');
    });

    // The marker must survive a subsequent write and reload.
    await store.withState((state) => {
      expect(state.errors).toContain('SYNC_STATE_CORRUPT');
    });

    const reloaded = await store.readState();
    expect(reloaded.errors).toContain('SYNC_STATE_CORRUPT');
  });

  it('handles partial success and failure across multiple artifacts', async () => {
    const store = new StateStore(tempDir);
    const a1 = makeArtifact({ relativePath: 'a.json', sha256: 'h1' });
    const a2 = makeArtifact({ relativePath: 'b.json', sha256: 'h2' });
    const a3 = makeArtifact({ relativePath: 'c.json', sha256: 'h3' });

    await store.withState((state) => {
      recordArtifactDiscovered(state, a1);
      recordArtifactDiscovered(state, a2);
      recordArtifactDiscovered(state, a3);
    });

    await store.withState((state) => {
      recordArtifactUploaded(state, a1);
      recordArtifactUploaded(state, a3);
      recordArtifactFailure(state, a2, 'SYNC_NETWORK_TIMEOUT');
    });

    const state = await store.readState();
    expect(getPendingArtifacts(state, [a1, a2, a3])).toEqual([a2]);
    expect(getArtifactRecord(state, a2)?.attemptCount).toBe(1);
    expect(getArtifactRecord(state, a2)?.lastError).toBe('SYNC_NETWORK_TIMEOUT');
  });
});

describe('atomic writes', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sal-atomic-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('writes a file and leaves no temp file behind', async () => {
    const target = path.join(tempDir, 'state.json');
    await writeFileAtomic(target, '{"ok":true}');

    const content = await fsp.readFile(target, 'utf8');
    expect(content).toBe('{"ok":true}');
    expect(fs.existsSync(`${target}.tmp`)).toBe(false);
  });

  it('replaces an existing file atomically', async () => {
    const target = path.join(tempDir, 'state.json');
    await writeFileAtomic(target, 'first');
    await writeFileAtomic(target, 'second');

    const content = await fsp.readFile(target, 'utf8');
    expect(content).toBe('second');
  });
});

describe('FileLock', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sal-lock-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('acquires and releases a lock', async () => {
    const lockFile = path.join(tempDir, 'test.lock');
    const lock = new FileLock(lockFile, { pollIntervalMs: 5 });

    await lock.acquire();
    expect(fs.existsSync(lockFile)).toBe(true);
    await lock.release();
    expect(fs.existsSync(lockFile)).toBe(false);
  });

  it('runs a callback and releases the lock afterwards', async () => {
    const lockFile = path.join(tempDir, 'test.lock');
    const lock = new FileLock(lockFile, { pollIntervalMs: 5 });

    await lock.withLock(async () => {
      expect(fs.existsSync(lockFile)).toBe(true);
    });

    expect(fs.existsSync(lockFile)).toBe(false);
  });

  it('serializes concurrent withLock calls in the same process', async () => {
    const lockFile = path.join(tempDir, 'test.lock');
    const lock = new FileLock(lockFile, { pollIntervalMs: 5 });
    const order: number[] = [];

    const p1 = lock.withLock(async () => {
      order.push(1);
      await sleep(50);
      order.push(2);
    });

    const p2 = lock.withLock(async () => {
      order.push(3);
    });

    await Promise.all([p1, p2]);
    expect(order).toEqual([1, 2, 3]);
  });

  it('reclaims a stale lock from a dead process', async () => {
    const lockFile = path.join(tempDir, 'test.lock');
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    fs.writeFileSync(lockFile, JSON.stringify({ pid: 999_999, startedAt: Date.now() - 10_000 }));

    const lock = new FileLock(lockFile, { pollIntervalMs: 5 });
    await lock.acquire();
    expect(fs.existsSync(lockFile)).toBe(true);

    const content = JSON.parse(await fsp.readFile(lockFile, 'utf8')) as { pid: number };
    expect(content.pid).toBe(process.pid);

    await lock.release();
    expect(fs.existsSync(lockFile)).toBe(false);
  });

  it('reclaims a stale lock with invalid content and old mtime', async () => {
    const lockFile = path.join(tempDir, 'test.lock');
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    fs.writeFileSync(lockFile, 'not-json');

    const oldTime = new Date(Date.now() - 10_000);
    fs.utimesSync(lockFile, oldTime, oldTime);

    const lock = new FileLock(lockFile, {
      staleMtimeThresholdMs: 0,
      pollIntervalMs: 5,
    });

    await lock.acquire();
    expect(fs.existsSync(lockFile)).toBe(true);
    await lock.release();
    expect(fs.existsSync(lockFile)).toBe(false);
  });

  it('times out when the lock is held by a live process', async () => {
    const lockFile = path.join(tempDir, 'test.lock');
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));

    const lock = new FileLock(lockFile, {
      acquireTimeoutMs: 100,
      pollIntervalMs: 10,
    });

    const err = await lock.acquire().catch((e) => e);
    expect(err).toBeInstanceOf(SyncStateError);
    expect(err.code).toBe('SYNC_STATE_ERROR');
  });

  it('recovers using a real child process pid', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 2000)']);
    await new Promise<void>((resolve) => child.on('spawn', resolve));
    child.kill('SIGKILL');
    await new Promise<void>((resolve) => child.on('exit', resolve));

    const lockFile = path.join(tempDir, 'real-pid.lock');
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    fs.writeFileSync(lockFile, JSON.stringify({ pid: child.pid, startedAt: Date.now() - 10_000 }));

    const lock = new FileLock(lockFile, { pollIntervalMs: 5 });
    await lock.acquire();
    expect(fs.existsSync(lockFile)).toBe(true);
    await lock.release();
    expect(fs.existsSync(lockFile)).toBe(false);
  });
});

describe('concurrency and overlapping writers', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sal-concurrent-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('handles parallel withState updates without corrupting state', async () => {
    const store = new StateStore(tempDir);
    const artifacts = Array.from({ length: 10 }, (_, i) =>
      makeArtifact({ relativePath: `file-${i}.json`, sha256: `hash-${i}` }),
    );

    await Promise.all(
      artifacts.map((artifact) =>
        store.withState((state) => {
          recordArtifactDiscovered(state, artifact);
          recordArtifactUploaded(state, artifact);
        }),
      ),
    );

    const state = await store.readState();
    for (const artifact of artifacts) {
      const record = getArtifactRecord(state, artifact);
      expect(record?.status).toBe('uploaded');
      expect(record?.lastUploadedHash).toBe(artifact.sha256);
    }
  });
});
