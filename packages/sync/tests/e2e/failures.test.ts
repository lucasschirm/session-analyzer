import * as fsp from 'node:fs/promises';
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildObjectKey,
  capture,
  FileLock,
  type GetObjectInput,
  type GetObjectResult,
  type HeadObjectInput,
  type HeadObjectResult,
  type PutObjectInput,
  type PutObjectResult,
  StateStore,
  type StorageAdapter,
  StorageError,
  sessionEnd,
  sessionStart,
  sha256Hex,
} from '../../src/index.js';

class FailingStorageAdapter implements StorageAdapter {
  readonly calls: PutObjectInput[] = [];
  private readonly failureMode: 'auth' | 'unavailable';

  constructor(failureMode: 'auth' | 'unavailable') {
    this.failureMode = failureMode;
  }

  async putObject(input: PutObjectInput): Promise<PutObjectResult> {
    this.calls.push(input);
    if (this.failureMode === 'auth') {
      throw new StorageError(
        'SYNC_AUTH_FAILED',
        'Storage authentication failed; simulated missing credentials.',
        false,
      );
    }
    throw new StorageError('SYNC_STORAGE_ERROR', 'Storage service unavailable.', true);
  }

  async getObject(_input: GetObjectInput): Promise<GetObjectResult | undefined> {
    return undefined;
  }

  async headObject(_input: HeadObjectInput): Promise<HeadObjectResult | undefined> {
    return undefined;
  }
}

class RecordingStorageAdapter implements StorageAdapter {
  readonly calls: PutObjectInput[] = [];
  private readonly objects = new Map<
    string,
    { body: Uint8Array; sha256: string; contentType?: string }
  >();

  async putObject(input: PutObjectInput): Promise<PutObjectResult> {
    const key = buildObjectKey(input);
    const sha256 = input.contentSha256 ?? sha256Hex(Buffer.from(input.body).toString('utf8'));
    this.calls.push(input);
    this.objects.set(key, { body: input.body, sha256, contentType: input.contentType });
    return { key, sha256, etag: `"${sha256}"` };
  }

  async getObject(_input: GetObjectInput): Promise<GetObjectResult | undefined> {
    return undefined;
  }

  async headObject(_input: HeadObjectInput): Promise<HeadObjectResult | undefined> {
    return undefined;
  }
}

function baseEnv(): Record<string, string> {
  return {
    SAL_PROJECT_ID: 'proj-fail',
    SAL_STORAGE_TYPE: 's3',
    SAL_STORAGE_BUCKET: 'test-bucket',
    SAL_STORAGE_ENDPOINT: 'http://localhost:4566',
    SAL_STORAGE_REGION: 'us-east-1',
    SAL_STORAGE_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
    SAL_STORAGE_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    SAL_SYNC_TIMEOUT: '5000',
    SAL_SESSION_END_BUDGET_MS: '5000',
    SAL_HOOK_UPLOAD_TIMEOUT: '5000',
  };
}

interface Fixture {
  tempRoot: string;
  workspaceDir: string;
  claudeConfigDir: string;
  homeDir: string;
  dataDir: string;
  transcriptPath: string;
}

async function writeMinimalWorkspace(workspaceDir: string): Promise<void> {
  await mkdir(path.join(workspaceDir, '.claude'), { recursive: true });
  await writeFile(path.join(workspaceDir, 'CLAUDE.md'), '# guide\n');
  await writeFile(path.join(workspaceDir, '.claude', 'settings.json'), '{"ok":true}');
  await writeFile(path.join(workspaceDir, 'transcript.jsonl'), '{"type":"message"}\n');
}

async function createFixture(): Promise<Fixture> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'sal-sync-fail-'));
  const workspaceDir = path.join(tempRoot, 'workspace');
  const claudeConfigDir = path.join(tempRoot, 'claude-config');
  const homeDir = path.join(tempRoot, 'home');
  const dataDir = path.join(tempRoot, 'data');
  await mkdir(workspaceDir, { recursive: true });
  await mkdir(claudeConfigDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });

  await writeMinimalWorkspace(workspaceDir);
  await writeFile(path.join(claudeConfigDir, 'settings.json'), '{}');

  return {
    tempRoot,
    workspaceDir,
    claudeConfigDir,
    homeDir,
    dataDir,
    transcriptPath: path.join(workspaceDir, 'transcript.jsonl'),
  };
}

function hookInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: 'sess-fail',
    cwd: '',
    transcript_path: '',
    ...overrides,
  };
}

function envForFixture(
  fixture: Fixture,
  overrides: Record<string, string | undefined> = {},
): Record<string, string> {
  return {
    ...process.env,
    ...baseEnv(),
    HOME: fixture.homeDir,
    CLAUDE_CONFIG_DIR: fixture.claudeConfigDir,
    ...overrides,
  } as Record<string, string>;
}

describe('sync E2E failure modes', () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await createFixture();
  });

  afterEach(async () => {
    await fsp.rm(fixture.tempRoot, { recursive: true, force: true });
  });

  it('exits 0 and skips when SAL_PROJECT_ID is missing', async () => {
    const env = envForFixture(fixture, { SAL_PROJECT_ID: undefined });
    const storage = new RecordingStorageAdapter();
    const result = await capture({
      dataDir: fixture.dataDir,
      env,
      input: hookInput({ cwd: fixture.workspaceDir, transcript_path: fixture.transcriptPath }),
      storageAdapter: storage,
    });
    expect(result.exitCode).toBe(0);
    expect(storage.calls).toHaveLength(0);
    expect(result.exitCode).not.toBe(2);
  });

  it('exits 0 and records auth failure when storage credentials are missing', async () => {
    const env = envForFixture(fixture, {
      SAL_STORAGE_ACCESS_KEY_ID: undefined,
      SAL_STORAGE_SECRET_ACCESS_KEY: undefined,
    });
    const result = await capture({
      dataDir: fixture.dataDir,
      env,
      input: hookInput({ cwd: fixture.workspaceDir, transcript_path: fixture.transcriptPath }),
      storageAdapter: new FailingStorageAdapter('auth'),
    });
    expect(result.exitCode).toBe(0);
    expect(result.run?.errors.some((e) => e === 'SYNC_AUTH_FAILED')).toBe(true);
    expect(result.run?.filesFailed).toBeGreaterThan(0);
    expect(result.exitCode).not.toBe(2);
  });

  it.skipIf(process.getuid?.() === 0)(
    'exits 0 and reports filesystem permission failures',
    async () => {
      const settingsPath = path.join(fixture.workspaceDir, '.claude', 'settings.json');
      await chmod(settingsPath, 0o000);

      const result = await capture({
        dataDir: fixture.dataDir,
        env: envForFixture(fixture),
        input: hookInput({ cwd: fixture.workspaceDir, transcript_path: fixture.transcriptPath }),
        storageAdapter: new RecordingStorageAdapter(),
      });

      // restore permission for cleanup
      await chmod(settingsPath, 0o644).catch(() => {});

      expect(result.exitCode).toBe(0);
      expect(result.run?.errors).toContain('SYNC_DISCOVERY_ERROR');
      expect(result.exitCode).not.toBe(2);
    },
  );

  it('exits 0 and skips when hook JSON is malformed', async () => {
    const result = await capture({
      dataDir: fixture.dataDir,
      env: envForFixture(fixture),
      input: '{ not valid json',
      storageAdapter: new RecordingStorageAdapter(),
    });
    expect(result.exitCode).toBe(0);
    expect(result.skipped).toBe(true);
    expect(result.exitCode).not.toBe(2);
  });

  it('exits 0 and reports malformed transcript or JSON files', async () => {
    await writeFile(
      path.join(fixture.workspaceDir, '.claude', 'settings.json'),
      '{ not valid json',
    );
    const result = await capture({
      dataDir: fixture.dataDir,
      env: envForFixture(fixture),
      input: hookInput({ cwd: fixture.workspaceDir, transcript_path: fixture.transcriptPath }),
      storageAdapter: new RecordingStorageAdapter(),
    });
    expect(result.exitCode).toBe(0);
    expect(result.run?.errors).toContain('SYNC_JSON_PARSE_FAILED');
    expect(result.exitCode).not.toBe(2);
  });

  it('exits 0 and records storage unavailability', async () => {
    const result = await capture({
      dataDir: fixture.dataDir,
      env: envForFixture(fixture),
      input: hookInput({ cwd: fixture.workspaceDir, transcript_path: fixture.transcriptPath }),
      storageAdapter: new FailingStorageAdapter('unavailable'),
    });
    expect(result.exitCode).toBe(0);
    expect(result.run?.filesFailed).toBeGreaterThan(0);
    expect(result.run?.errors.length).toBeGreaterThan(0);
    expect(result.exitCode).not.toBe(2);
  });

  it('recovers from corrupt local state and exits 0', async () => {
    const stateDir = path.join(fixture.dataDir, 'state');
    await mkdir(stateDir, { recursive: true });
    await writeFile(path.join(stateDir, 'state.json'), 'not json {{');

    const result = await capture({
      dataDir: fixture.dataDir,
      env: envForFixture(fixture),
      input: hookInput({ cwd: fixture.workspaceDir, transcript_path: fixture.transcriptPath }),
      storageAdapter: new RecordingStorageAdapter(),
    });

    expect(result.exitCode).toBe(0);
    const state = JSON.parse(await fsp.readFile(path.join(stateDir, 'state.json'), 'utf8'));
    expect(state.version).toBe(1);
    // The corrupt file is moved aside and an empty state is recovered.
    const corruptFiles = (await fsp.readdir(stateDir)).filter((f) =>
      f.startsWith('state.json.corrupt'),
    );
    expect(corruptFiles.length).toBeGreaterThan(0);
  });

  it('does not return exit code 2 for telemetry/storage failures', async () => {
    const result = await capture({
      dataDir: fixture.dataDir,
      env: envForFixture(fixture),
      input: hookInput({ cwd: fixture.workspaceDir, transcript_path: fixture.transcriptPath }),
      storageAdapter: new FailingStorageAdapter('unavailable'),
    });
    expect(result.exitCode).not.toBe(2);
    expect([0, 1]).toContain(result.exitCode);
  });

  it('handles session sync lock contention by exiting 0 (not 2)', async () => {
    const dataDir = fixture.dataDir;
    const env = envForFixture(fixture);
    const storage = new RecordingStorageAdapter();
    const lockPath = path.join(dataDir, 'locks', `${encodeURIComponent('sess-fail')}.sync.lock`);
    await mkdir(path.dirname(lockPath), { recursive: true });

    const lock = new FileLock(lockPath, { acquireTimeoutMs: 0 });
    await lock.acquire();
    try {
      const result = await capture({
        dataDir,
        env,
        input: hookInput({ cwd: fixture.workspaceDir, transcript_path: fixture.transcriptPath }),
        storageAdapter: storage,
      });
      expect(result.exitCode).toBe(0);
      expect(result.skipped).toBe(true);
      expect(result.exitCode).not.toBe(2);
    } finally {
      await lock.release();
    }
  });

  it('preserves remaining delta and exits 0 when SessionEnd budget is exhausted', async () => {
    const dataDir = fixture.dataDir;
    const env = envForFixture(fixture, { SAL_SESSION_END_BUDGET_MS: '0' });

    // Use a failing storage adapter so the initial bulk upload leaves a
    // remaining delta in durable state.
    await sessionStart({
      dataDir,
      env,
      input: hookInput({ cwd: fixture.workspaceDir, transcript_path: fixture.transcriptPath }),
      storageAdapter: new FailingStorageAdapter('unavailable'),
      spawnWatcher: () => ({ unref: () => {}, pid: 12345 }),
    });

    const endResult = await sessionEnd({
      dataDir,
      env,
      input: hookInput({
        cwd: fixture.workspaceDir,
        transcript_path: fixture.transcriptPath,
        reason: 'completed',
      }),
      storageAdapter: new FailingStorageAdapter('unavailable'),
      watcherTerminator: () => {},
    });

    expect(endResult.exitCode).toBe(0);
    expect(endResult.budgetExhausted).toBe(true);
    expect(endResult.exitCode).not.toBe(2);

    // The manifest upload was skipped, but the local state should still show
    // outstanding artifacts (the remaining delta from the failed session-start).
    const state = new StateStore(dataDir);
    const stateData = await state.readState();
    const pending = Object.values(stateData.artifacts).some((r) => r.status !== 'uploaded');
    expect(pending).toBe(true);
  });

  it('terminates a stale watcher PID without failing the hook', async () => {
    const dataDir = fixture.dataDir;
    const env = envForFixture(fixture);
    const storage = new RecordingStorageAdapter();
    const watcherDir = path.join(dataDir, 'watcher');
    await mkdir(watcherDir, { recursive: true });

    // Write a PID that does not exist (stale).
    const stalePid = 999_999_999;
    await writeFile(
      path.join(watcherDir, `${encodeURIComponent('sess-fail')}.pid`),
      JSON.stringify({ pid: stalePid, startedAt: Date.now() }),
    );

    const terminator = { called: false, pid: -1 };

    await sessionStart({
      dataDir,
      env,
      input: hookInput({ cwd: fixture.workspaceDir, transcript_path: fixture.transcriptPath }),
      storageAdapter: storage,
      spawnWatcher: () => ({ unref: () => {}, pid: 12345 }),
    });

    const endResult = await sessionEnd({
      dataDir,
      env,
      input: hookInput({
        cwd: fixture.workspaceDir,
        transcript_path: fixture.transcriptPath,
        reason: 'completed',
      }),
      storageAdapter: storage,
      watcherTerminator: (pid) => {
        terminator.called = true;
        terminator.pid = pid;
      },
    });

    expect(endResult.exitCode).toBe(0);
    expect(terminator.called).toBe(true);
    expect(terminator.pid).toBe(stalePid);

    const pidFile = path.join(watcherDir, `${encodeURIComponent('sess-fail')}.pid`);
    expect(
      await fsp.stat(pidFile).then(
        () => false,
        () => true,
      ),
    ).toBe(true);
    expect(endResult.exitCode).not.toBe(2);
  });

  it('propagates watcher spawn failures but does not return exit code 2', async () => {
    await expect(
      sessionStart({
        dataDir: fixture.dataDir,
        env: envForFixture(fixture),
        input: hookInput({ cwd: fixture.workspaceDir, transcript_path: fixture.transcriptPath }),
        storageAdapter: new RecordingStorageAdapter(),
        spawnWatcher: () => {
          throw new Error('Cannot spawn watcher');
        },
      }),
    ).rejects.toThrow('Cannot spawn watcher');
  });

  it('handles global state lock contention between hook and watcher', async () => {
    const dataDir = fixture.dataDir;
    const env = envForFixture(fixture);
    const storage = new RecordingStorageAdapter();
    const stateStore = new StateStore(dataDir);
    await stateStore.ensureDirectories();

    // Simulate a watcher holding the global state lock.
    const holdLock = stateStore.withState(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return 'held';
    });

    const capturePromise = capture({
      dataDir,
      env,
      input: hookInput({ cwd: fixture.workspaceDir, transcript_path: fixture.transcriptPath }),
      storageAdapter: storage,
    });

    const [held, result] = await Promise.all([holdLock, capturePromise]);
    expect(held).toBe('held');
    expect(result.exitCode).toBe(0);
    expect(result.exitCode).not.toBe(2);
  });
});
