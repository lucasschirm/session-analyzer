import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StorageAdapter } from '@lucasschirm/sal-sync';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getTranscriptWatcherPath,
  runHook,
  runSessionEnd,
  runSessionStart,
  runTranscriptWatcher,
} from '../../src/index.js';

const packageRoot = fileURLToPath(new URL('../../', import.meta.url));

const TEST_ACCESS_KEY = 'AKIAIOSFODNN7EXAMPLE';
const TEST_SECRET_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const TEST_SESSION_TOKEN = 'FwoGZXIvYXdzEBYaDL...';

class InMemoryStorageAdapter implements StorageAdapter {
  readonly calls: Array<{
    projectId: string;
    sessionId: string;
    scope: string;
    relativePath: string;
    content: string;
    key: string;
  }> = [];

  async putObject(input: {
    projectId: string;
    sessionId: string;
    scope: string;
    relativePath: string;
    body: Uint8Array;
    contentSha256?: string;
  }) {
    const key = `${input.projectId}/${input.sessionId}/${input.scope}/${input.relativePath}`;
    this.calls.push({
      projectId: input.projectId,
      sessionId: input.sessionId,
      scope: input.scope,
      relativePath: input.relativePath,
      content: Buffer.from(input.body).toString('utf8'),
      key,
    });
    return {
      key,
      sha256: input.contentSha256 ?? '0'.repeat(64),
    };
  }
}

function containsNone(haystack: string, needles: string[]): boolean {
  return !needles.some((needle) => haystack.includes(needle));
}

function baseEnv(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    SAL_PROJECT_ID: 'proj-1',
    SAL_STORAGE_TYPE: 's3',
    SAL_STORAGE_BUCKET: 'my-bucket',
    SAL_STORAGE_REGION: 'us-east-1',
    SAL_STORAGE_ID: TEST_ACCESS_KEY,
    SAL_STORAGE_SECRET: TEST_SECRET_KEY,
    SAL_STORAGE_SESSION_TOKEN: TEST_SESSION_TOKEN,
    SAL_CAPTURE_TRANSCRIPTS: 'true',
    SAL_MAX_TRANSCRIPT_BYTES: '1000000',
    SAL_HOOK_UPLOAD_TIMEOUT: '5000',
    SAL_SYNC_TIMEOUT: '5000',
    SAL_SESSION_END_BUDGET_MS: '10000',
    ...overrides,
  };
}

function claudeHookInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: 'sess-1',
    transcript_path: '',
    cwd: '',
    ...overrides,
  };
}

async function writeFixture(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
}

describe('plugin does not leak credentials', () => {
  let dataDir: string;
  let workspaceDir: string;
  let transcriptDir: string;
  let transcriptPath: string;

  beforeEach(async () => {
    dataDir = mkdtempSync(path.join(os.tmpdir(), 'sal-plugin-sec-data-'));
    workspaceDir = mkdtempSync(path.join(os.tmpdir(), 'sal-plugin-sec-ws-'));
    transcriptDir = mkdtempSync(path.join(os.tmpdir(), 'sal-plugin-sec-tx-'));
    transcriptPath = path.join(transcriptDir, 'transcript.jsonl');

    await writeFixture(path.join(workspaceDir, 'CLAUDE.md'), '# rules');
    await writeFixture(
      path.join(workspaceDir, '.claude', 'settings.json'),
      JSON.stringify({ theme: 'dark' }),
    );
    await writeFixture(path.join(workspaceDir, '.mcp.json'), JSON.stringify({ mcpServers: {} }));
    await writeFixture(transcriptPath, '{"secret":"transcript-secret"}\n');
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(workspaceDir, { recursive: true, force: true });
    rmSync(transcriptDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it('runHook sanitizes workspace config and uploads raw transcripts by default', async () => {
    await writeFixture(
      path.join(workspaceDir, '.claude', 'settings.json'),
      JSON.stringify({ apiKey: 'workspace-secret' }),
    );

    const storage = new InMemoryStorageAdapter();
    const result = await runHook(
      claudeHookInput({
        hook_event_name: 'Stop',
        cwd: workspaceDir,
        transcript_path: transcriptPath,
      }),
      { env: baseEnv(), dataDir, storageAdapter: storage },
    );

    expect(result).toBe(0);

    const workspaceCalls = storage.calls.filter((c) => c.scope === 'workspace');
    const sessionCalls = storage.calls.filter((c) => c.scope === 'session');

    expect(workspaceCalls.length).toBeGreaterThan(0);
    for (const call of workspaceCalls) {
      expect(call.content).not.toContain('workspace-secret');
      expect(
        containsNone(call.content, [TEST_ACCESS_KEY, TEST_SECRET_KEY, TEST_SESSION_TOKEN]),
      ).toBe(true);
    }

    expect(sessionCalls.some((c) => c.relativePath === 'transcript.jsonl')).toBe(true);
    const transcriptCall = sessionCalls.find((c) => c.relativePath === 'transcript.jsonl');
    expect(transcriptCall?.content).toContain('transcript-secret');
  });

  it('runSessionStart does not upload storage credentials', async () => {
    const storage = new InMemoryStorageAdapter();
    const spawnWatcher = vi.fn().mockReturnValue({ unref: vi.fn(), pid: 1234 });

    const result = await runSessionStart(
      claudeHookInput({
        hook_event_name: 'SessionStart',
        cwd: workspaceDir,
        transcript_path: transcriptPath,
      }),
      { env: baseEnv(), dataDir, storageAdapter: storage, spawnWatcher },
    );

    expect(result).toBe(0);

    for (const call of storage.calls) {
      expect(
        containsNone(call.content, [TEST_ACCESS_KEY, TEST_SECRET_KEY, TEST_SESSION_TOKEN]),
      ).toBe(true);
    }
  });

  it('runSessionEnd excludes transcripts and records transcriptsCaptured=false when opted out', async () => {
    const storage = new InMemoryStorageAdapter();

    // First start the session so state exists.
    const startSpawner = vi.fn().mockReturnValue({ unref: vi.fn(), pid: 1234 });
    await runSessionStart(
      claudeHookInput({
        hook_event_name: 'SessionStart',
        cwd: workspaceDir,
        transcript_path: transcriptPath,
      }),
      {
        env: baseEnv(),
        dataDir,
        storageAdapter: new InMemoryStorageAdapter(),
        spawnWatcher: startSpawner,
      },
    );

    const result = await runSessionEnd(
      claudeHookInput({
        hook_event_name: 'SessionEnd',
        reason: 'completed',
        cwd: workspaceDir,
        transcript_path: transcriptPath,
      }),
      { env: baseEnv({ SAL_CAPTURE_TRANSCRIPTS: 'false' }), dataDir, storageAdapter: storage },
    );

    expect(result).toBe(0);
    const manifestCall = storage.calls.find((c) => c.relativePath === 'manifest.json');
    expect(manifestCall).toBeDefined();
    const manifest = JSON.parse(manifestCall?.content ?? '{}') as Record<string, unknown>;
    expect(manifest.transcriptsCaptured).toBe(false);
    expect(storage.calls.some((c) => c.scope === 'session')).toBe(false);
  });
});

describe('transcript capture policy in the plugin', () => {
  let dataDir: string;
  let workspaceDir: string;
  let transcriptDir: string;
  let transcriptPath: string;

  beforeEach(async () => {
    dataDir = mkdtempSync(path.join(os.tmpdir(), 'sal-plugin-tx-data-'));
    workspaceDir = mkdtempSync(path.join(os.tmpdir(), 'sal-plugin-tx-ws-'));
    transcriptDir = mkdtempSync(path.join(os.tmpdir(), 'sal-plugin-tx-tx-'));
    transcriptPath = path.join(transcriptDir, 'transcript.jsonl');
    await writeFixture(path.join(workspaceDir, 'CLAUDE.md'), '# rules');
    await writeFixture(path.join(workspaceDir, '.claude', 'settings.json'), '{}');
    await writeFixture(transcriptPath, '{}\n');
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(workspaceDir, { recursive: true, force: true });
    rmSync(transcriptDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it('runSessionStart with capture disabled does not upload session transcripts', async () => {
    const storage = new InMemoryStorageAdapter();
    const spawnWatcher = vi.fn().mockReturnValue({ unref: vi.fn(), pid: 1234 });

    const result = await runSessionStart(
      claudeHookInput({
        hook_event_name: 'SessionStart',
        cwd: workspaceDir,
        transcript_path: transcriptPath,
      }),
      {
        env: baseEnv({ SAL_CAPTURE_TRANSCRIPTS: 'false' }),
        dataDir,
        storageAdapter: storage,
        spawnWatcher,
      },
    );

    expect(result).toBe(0);
    expect(storage.calls.some((c) => c.scope === 'session')).toBe(false);
  });

  it('runTranscriptWatcher exits immediately when SAL_CAPTURE_TRANSCRIPTS=false', async () => {
    for (const [key, value] of Object.entries(baseEnv({ SAL_CAPTURE_TRANSCRIPTS: 'false' }))) {
      vi.stubEnv(key, value ?? '');
    }

    const result = await runTranscriptWatcher({
      argv: ['--session-id', 'sess-1', '--transcript-path', transcriptPath, '--data-dir', dataDir],
    });

    expect(result).toBe(0);
    const pidPath = path.join(dataDir, 'watcher', `${encodeURIComponent('sess-1')}.pid`);
    expect(existsSync(pidPath)).toBe(false);
  });
});

describe('upload destination is explicitly configured', () => {
  let dataDir: string;
  let workspaceDir: string;
  let transcriptDir: string;
  let transcriptPath: string;

  beforeEach(async () => {
    dataDir = mkdtempSync(path.join(os.tmpdir(), 'sal-plugin-dest-data-'));
    workspaceDir = mkdtempSync(path.join(os.tmpdir(), 'sal-plugin-dest-ws-'));
    transcriptDir = mkdtempSync(path.join(os.tmpdir(), 'sal-plugin-dest-tx-'));
    transcriptPath = path.join(transcriptDir, 'transcript.jsonl');
    await writeFixture(path.join(workspaceDir, 'CLAUDE.md'), '# rules');
    await writeFixture(transcriptPath, '{}\n');
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(workspaceDir, { recursive: true, force: true });
    rmSync(transcriptDir, { recursive: true, force: true });
  });

  it('runHook skips and makes no storage calls when SAL_STORAGE_TYPE is missing', async () => {
    const storage = new InMemoryStorageAdapter();
    const env = baseEnv();
    delete env.SAL_STORAGE_TYPE;

    const result = await runHook(
      claudeHookInput({
        hook_event_name: 'Stop',
        cwd: workspaceDir,
        transcript_path: transcriptPath,
      }),
      { env, dataDir, storageAdapter: storage },
    );

    expect(result).toBe(0);
    expect(storage.calls).toHaveLength(0);
  });

  it('runSessionStart skips when SAL_STORAGE_TYPE is missing', async () => {
    const storage = new InMemoryStorageAdapter();
    const env = baseEnv();
    delete env.SAL_STORAGE_TYPE;

    const result = await runSessionStart(
      claudeHookInput({
        hook_event_name: 'SessionStart',
        cwd: workspaceDir,
        transcript_path: transcriptPath,
      }),
      { env, dataDir, storageAdapter: storage },
    );

    expect(result).toBe(0);
    expect(storage.calls).toHaveLength(0);
  });

  it('runSessionEnd skips when the destination type is not configured', async () => {
    const storage = new InMemoryStorageAdapter();
    const env = baseEnv();
    delete env.SAL_STORAGE_TYPE;

    const result = await runSessionEnd(
      claudeHookInput({
        hook_event_name: 'SessionEnd',
        reason: 'completed',
        cwd: workspaceDir,
        transcript_path: transcriptPath,
      }),
      { env, dataDir, storageAdapter: storage },
    );

    expect(result).toBe(0);
    expect(storage.calls).toHaveLength(0);
  });
});

describe('watcher and plugin boundary', () => {
  let dataDir: string;
  let workspaceDir: string;
  let transcriptDir: string;
  let transcriptPath: string;

  beforeEach(async () => {
    dataDir = mkdtempSync(path.join(os.tmpdir(), 'sal-plugin-boundary-data-'));
    workspaceDir = mkdtempSync(path.join(os.tmpdir(), 'sal-plugin-boundary-ws-'));
    transcriptDir = mkdtempSync(path.join(os.tmpdir(), 'sal-plugin-boundary-tx-'));
    transcriptPath = path.join(transcriptDir, 'transcript.jsonl');
    await writeFixture(path.join(workspaceDir, 'CLAUDE.md'), '# rules');
    await writeFixture(transcriptPath, '{}\n');
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(workspaceDir, { recursive: true, force: true });
    rmSync(transcriptDir, { recursive: true, force: true });
  });

  it('runSessionStart spawns the watcher bound to the supplied transcript directory', async () => {
    const storage = new InMemoryStorageAdapter();
    const spawnWatcher = vi.fn().mockReturnValue({ unref: vi.fn(), pid: 1234 });

    await runSessionStart(
      claudeHookInput({
        hook_event_name: 'SessionStart',
        cwd: workspaceDir,
        transcript_path: transcriptPath,
      }),
      { env: baseEnv(), dataDir, storageAdapter: storage, spawnWatcher },
    );

    expect(spawnWatcher).toHaveBeenCalledOnce();
    const args = spawnWatcher.mock.calls[0][0] as string[];
    expect(args).toContain('--session-id');
    expect(args).toContain('sess-1');
    expect(args).toContain('--transcript-path');
    expect(args).toContain(transcriptPath);
    expect(args).toContain('--data-dir');
    expect(args).toContain(dataDir);

    // The watcher command is a bundled executable, not an arbitrary path.
    const watcherPath = getTranscriptWatcherPath();
    expect(watcherPath).toContain('transcript-watcher');
  });

  it('runTranscriptWatcher exits and removes the pid file when capture is disabled', async () => {
    for (const [key, value] of Object.entries(baseEnv({ SAL_CAPTURE_TRANSCRIPTS: 'false' }))) {
      vi.stubEnv(key, value ?? '');
    }

    const result = await runTranscriptWatcher({
      argv: ['--session-id', 'sess-1', '--transcript-path', transcriptPath, '--data-dir', dataDir],
    });

    expect(result).toBe(0);
    const pidPath = path.join(dataDir, 'watcher', `${encodeURIComponent('sess-1')}.pid`);
    expect(existsSync(pidPath)).toBe(false);
  });
});

describe('plugin manifest and hooks use minimum required surface', () => {
  it('plugin manifest only declares the standard metadata and hooks path', () => {
    const manifest = JSON.parse(
      readFileSync(path.join(packageRoot, '.claude-plugin', 'plugin.json'), 'utf8'),
    );
    expect(manifest.name).toBe('claude-session-sync');
    expect(manifest.version).toBeDefined();
    expect(manifest.description).toBeDefined();
    expect(manifest.hooks).toBe('hooks/hooks.json');
    // The manifest does not declare any additional permissions/capabilities.
    expect(Object.keys(manifest).sort()).toEqual(['description', 'hooks', 'name', 'version']);
  });

  it('hooks.json only invokes bundled plugin executables with fixed arguments', () => {
    const hooks = JSON.parse(readFileSync(path.join(packageRoot, 'hooks', 'hooks.json'), 'utf8'));
    const commands: string[] = [];

    for (const event of Object.values(hooks.hooks as Record<string, unknown>)) {
      for (const group of Array.isArray(event) ? event : [event]) {
        const hookGroup = group as { hooks?: Array<{ command?: string; args?: string[] }> };
        for (const hook of hookGroup.hooks ?? []) {
          if (hook.command) commands.push(hook.command);
          if (hook.args) {
            for (const arg of hook.args) {
              expect(arg === 'node' || arg.startsWith('$' + '{CLAUDE_PLUGIN_ROOT}/bin/')).toBe(
                true,
              );
            }
          }
        }
      }
    }

    expect(commands.length).toBeGreaterThan(0);
    expect(commands.every((c) => c === 'node')).toBe(true);
  });
});
