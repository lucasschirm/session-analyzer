import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  capture,
  sessionEnd,
  sessionStart,
  status,
  sync,
  watch,
  writeWatcherPid,
} from '../../src/cli/index.js';
import type { StorageAdapter } from '../../src/storage/index.js';

class InMemoryStorageAdapter implements StorageAdapter {
  readonly calls: Array<{
    projectId: string;
    sessionId: string;
    scope: string;
    relativePath: string;
    content: string;
  }> = [];

  async putObject(input: {
    projectId: string;
    sessionId: string;
    scope: string;
    relativePath: string;
    body: Uint8Array;
    contentSha256?: string;
  }) {
    this.calls.push({
      projectId: input.projectId,
      sessionId: input.sessionId,
      scope: input.scope,
      relativePath: input.relativePath,
      content: Buffer.from(input.body).toString('utf8'),
    });
    return {
      key: `${input.projectId}/${input.sessionId}/${input.scope}/${input.relativePath}`,
      sha256: input.contentSha256 ?? '0'.repeat(64),
    };
  }
}

function hookInput(overrides: Record<string, unknown> = {}) {
  return {
    session_id: 'sess-1',
    cwd: '',
    transcript_path: '',
    ...overrides,
  };
}

async function createFixture() {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'sal-sync-data-'));
  const workspaceDir = await mkdtemp(path.join(tmpdir(), 'sal-sync-ws-'));
  const claudeConfigDir = await mkdtemp(path.join(tmpdir(), 'sal-sync-cfg-'));
  const homeDir = await mkdtemp(path.join(tmpdir(), 'sal-sync-home-'));
  const transcriptDir = await mkdtemp(path.join(tmpdir(), 'sal-sync-tx-'));

  const transcriptPath = path.join(transcriptDir, 'transcript.jsonl');
  await writeFile(transcriptPath, '{"type":"message"}\n');

  await mkdir(path.join(workspaceDir, '.claude'));
  await writeFile(path.join(workspaceDir, 'CLAUDE.md'), 'secretKey=abc\n');
  await writeFile(path.join(workspaceDir, '.claude', 'settings.json'), '{"theme":"dark"}');

  await writeFile(path.join(claudeConfigDir, 'settings.json'), '{}');

  return { dataDir, workspaceDir, claudeConfigDir, homeDir, transcriptPath };
}

describe('CLI commands', () => {
  beforeEach(() => {
    vi.stubEnv('SAL_PROJECT_ID', 'proj-1');
    vi.stubEnv('SAL_STORAGE_TYPE', 's3');
    vi.stubEnv('SAL_STORAGE_BUCKET', 'my-bucket');
    vi.stubEnv('SAL_STORAGE_ACCESS_KEY_ID', 'AKIAIOSFODNN7EXAMPLE');
    vi.stubEnv('SAL_STORAGE_SECRET_ACCESS_KEY', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');
    vi.stubEnv('SAL_STORAGE_REGION', 'us-east-1');
    vi.stubEnv('SAL_STORAGE_ENDPOINT', 'http://localhost:4566');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('capture', () => {
    it('exits 0 and uploads changed workspace artifacts', async () => {
      const { dataDir, workspaceDir, claudeConfigDir, homeDir, transcriptPath } =
        await createFixture();
      vi.stubEnv('CLAUDE_CONFIG_DIR', claudeConfigDir);
      vi.stubEnv('HOME', homeDir);

      const storage = new InMemoryStorageAdapter();
      const result = await capture({
        dataDir,
        input: hookInput({ cwd: workspaceDir, transcript_path: transcriptPath }),
        storageAdapter: storage,
      });

      expect(result.exitCode).toBe(0);
      expect(result.run?.filesUploaded).toBeGreaterThanOrEqual(1);
      expect(storage.calls.length).toBeGreaterThanOrEqual(1);
      expect(storage.calls.some((call) => call.scope === 'workspace')).toBe(true);
    });

    it('skips and exits 0 when hook input is malformed', async () => {
      const dataDir = await mkdtemp(path.join(tmpdir(), 'sal-sync-data-'));
      const result = await capture({
        dataDir,
        input: hookInput({ session_id: 'sess-1' }),
        storageAdapter: new InMemoryStorageAdapter(),
      });

      expect(result.exitCode).toBe(0);
      expect(result.skipped).toBe(true);
    });

    it('times out per upload and continues when hook upload timeout is exceeded', async () => {
      const { dataDir, workspaceDir, claudeConfigDir, homeDir, transcriptPath } =
        await createFixture();
      vi.stubEnv('CLAUDE_CONFIG_DIR', claudeConfigDir);
      vi.stubEnv('HOME', homeDir);
      vi.stubEnv('SAL_HOOK_UPLOAD_TIMEOUT', '1');

      const storage: StorageAdapter = {
        putObject: () => new Promise(() => {}), // never resolves
      };

      const result = await capture({
        dataDir,
        input: hookInput({ cwd: workspaceDir, transcript_path: transcriptPath }),
        storageAdapter: storage,
      });

      expect(result.exitCode).toBe(0);
      expect(result.run?.filesFailed).toBeGreaterThanOrEqual(1);
      expect(result.run?.errors).toContain('SYNC_NETWORK_TIMEOUT');
    });

    it('prevents duplicate capture spawns for the same session', async () => {
      const { dataDir, workspaceDir, claudeConfigDir, homeDir, transcriptPath } =
        await createFixture();
      vi.stubEnv('CLAUDE_CONFIG_DIR', claudeConfigDir);
      vi.stubEnv('HOME', homeDir);

      // Seed a lock file held by the current process so the duplicate guard
      // fires within the 0ms acquire timeout.
      const lockDir = path.join(dataDir, 'locks');
      await mkdir(lockDir, { recursive: true });
      await writeFile(
        path.join(lockDir, `${encodeURIComponent('sess-1')}.sync.lock`),
        JSON.stringify({ pid: process.pid, startedAt: Date.now() }),
      );

      const result = await capture({
        dataDir,
        input: hookInput({ cwd: workspaceDir, transcript_path: transcriptPath }),
        storageAdapter: new InMemoryStorageAdapter(),
      });

      expect(result.exitCode).toBe(0);
      expect(result.skipped).toBe(true);
    });
  });

  describe('sessionStart', () => {
    it('records session metadata, spawns a watcher, and uploads the initial bulk', async () => {
      const { dataDir, workspaceDir, claudeConfigDir, homeDir, transcriptPath } =
        await createFixture();
      vi.stubEnv('CLAUDE_CONFIG_DIR', claudeConfigDir);
      vi.stubEnv('HOME', homeDir);

      const storage = new InMemoryStorageAdapter();
      const spawnArgs: string[] = [];
      const spawnWatcher = vi.fn((args: string[]) => {
        spawnArgs.push(...args);
        return { unref: vi.fn(), pid: 1234 };
      });

      const result = await sessionStart({
        dataDir,
        input: hookInput({ cwd: workspaceDir, transcript_path: transcriptPath }),
        storageAdapter: storage,
        spawnWatcher,
      });

      expect(result.exitCode).toBe(0);
      expect(result.run?.trigger).toBe('session-start');
      expect(spawnWatcher).toHaveBeenCalled();
      expect(spawnArgs).toContain('--session-id');
      expect(spawnArgs).toContain('sess-1');
    });

    it('exits 0 with malformed input', async () => {
      const dataDir = await mkdtemp(path.join(tmpdir(), 'sal-sync-data-'));
      const result = await sessionStart({
        dataDir,
        input: hookInput({ cwd: '' }),
        storageAdapter: new InMemoryStorageAdapter(),
      });

      expect(result.exitCode).toBe(0);
      expect(result.skipped).toBe(true);
    });
  });

  describe('sessionEnd', () => {
    it('performs final delta, uploads manifest, and shuts down the watcher', async () => {
      const { dataDir, workspaceDir, claudeConfigDir, homeDir, transcriptPath } =
        await createFixture();
      vi.stubEnv('CLAUDE_CONFIG_DIR', claudeConfigDir);
      vi.stubEnv('HOME', homeDir);

      const storage = new InMemoryStorageAdapter();
      const terminator = vi.fn();

      const fakeWatcherPid = 1234;
      await sessionStart({
        dataDir,
        input: hookInput({ cwd: workspaceDir, transcript_path: transcriptPath }),
        storageAdapter: storage,
        spawnWatcher: () => {
          void writeWatcherPid(dataDir, 'sess-1', fakeWatcherPid);
          return { unref: vi.fn(), pid: fakeWatcherPid };
        },
      });

      const result = await sessionEnd({
        dataDir,
        input: hookInput({
          cwd: workspaceDir,
          transcript_path: transcriptPath,
          reason: 'completed',
        }),
        storageAdapter: storage,
        watcherTerminator: terminator,
      });

      expect(result.exitCode).toBe(0);
      expect(result.budgetExhausted).toBe(false);
      expect(terminator).toHaveBeenCalledWith(1234);
      expect(storage.calls.some((call) => call.relativePath === 'manifest.json')).toBe(true);
    });

    it('exits 0 when budget is exhausted, leaving remaining delta pending', async () => {
      const { dataDir, workspaceDir, claudeConfigDir, homeDir, transcriptPath } =
        await createFixture();
      vi.stubEnv('CLAUDE_CONFIG_DIR', claudeConfigDir);
      vi.stubEnv('HOME', homeDir);
      vi.stubEnv('SAL_SESSION_END_BUDGET_MS', '0');

      const storage = new InMemoryStorageAdapter();

      await sessionStart({
        dataDir,
        input: hookInput({ cwd: workspaceDir, transcript_path: transcriptPath }),
        storageAdapter: new InMemoryStorageAdapter(),
        spawnWatcher: () => ({ unref: vi.fn(), pid: 1234 }),
      });

      const result = await sessionEnd({
        dataDir,
        input: hookInput({
          cwd: workspaceDir,
          transcript_path: transcriptPath,
          reason: 'completed',
        }),
        storageAdapter: storage,
      });

      expect(result.exitCode).toBe(0);
      expect(result.budgetExhausted).toBe(true);
      expect(storage.calls.length).toBe(0);
    });
  });

  describe('sync', () => {
    it('performs a full capture + manifest upload', async () => {
      const { dataDir, workspaceDir, claudeConfigDir, homeDir, transcriptPath } =
        await createFixture();
      vi.stubEnv('CLAUDE_CONFIG_DIR', claudeConfigDir);
      vi.stubEnv('HOME', homeDir);

      const storage = new InMemoryStorageAdapter();
      const result = await sync({
        dataDir,
        input: hookInput({ cwd: workspaceDir, transcript_path: transcriptPath }),
        storageAdapter: storage,
      });

      expect(result.exitCode).toBe(0);
      expect(result.manifest).toBeDefined();
      expect(storage.calls.some((call) => call.relativePath === 'manifest.json')).toBe(true);
    });
  });

  describe('watch', () => {
    it('parses argv, writes a pid file, and invokes the watcher', async () => {
      const dataDir = await mkdtemp(path.join(tmpdir(), 'sal-sync-data-'));
      const transcriptPath = path.join(dataDir, 'transcript.jsonl');
      await writeFile(transcriptPath, '');

      const watcher = vi.fn().mockResolvedValue(undefined);

      const result = await watch({
        dataDir,
        argv: ['--session-id', 'sess-1', '--transcript-path', transcriptPath],
        watcher,
      });

      expect(result.exitCode).toBe(0);
      expect(watcher).toHaveBeenCalledWith({
        dataDir,
        sessionId: 'sess-1',
        transcriptPath,
      });
    });
  });

  describe('status', () => {
    it('reports watcher and sync state', async () => {
      const { dataDir, workspaceDir, claudeConfigDir, homeDir, transcriptPath } =
        await createFixture();
      vi.stubEnv('CLAUDE_CONFIG_DIR', claudeConfigDir);
      vi.stubEnv('HOME', homeDir);

      await sync({
        dataDir,
        input: hookInput({ cwd: workspaceDir, transcript_path: transcriptPath }),
        storageAdapter: new InMemoryStorageAdapter(),
      });

      const result = await status({
        dataDir,
        argv: [
          '--session-id',
          'sess-1',
          '--cwd',
          workspaceDir,
          '--transcript-path',
          transcriptPath,
        ],
      });

      expect(result.exitCode).toBe(0);
      expect(result.status).toBeDefined();
      expect(result.status?.pendingBytes).toBe(0);
    });
  });

  describe('readHookInput', () => {
    it('reads JSON from stdin when no input object is provided', async () => {
      const { dataDir, workspaceDir, claudeConfigDir, homeDir, transcriptPath } =
        await createFixture();
      vi.stubEnv('CLAUDE_CONFIG_DIR', claudeConfigDir);
      vi.stubEnv('HOME', homeDir);

      const storage = new InMemoryStorageAdapter();
      const stdin = Readable.from([
        JSON.stringify({
          session_id: 'sess-stdin',
          cwd: workspaceDir,
          transcript_path: transcriptPath,
        }),
      ]);

      const result = await capture({
        dataDir,
        stdin,
        storageAdapter: storage,
      });

      expect(result.exitCode).toBe(0);
    });
  });
});
