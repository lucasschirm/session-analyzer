import { type ChildProcess, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildObjectKey,
  capture,
  type GetObjectInput,
  type GetObjectResult,
  type HeadObjectInput,
  type HeadObjectResult,
  type PutObjectInput,
  type PutObjectResult,
  type StorageAdapter,
  StorageError,
  sessionEnd,
  sessionStart,
  sha256Hex,
} from '../../src/index.js';

const packageRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const watchScriptPath = path.resolve(packageRoot, 'dist', 'cli', 'watch.js');

class InMemoryStorageAdapter implements StorageAdapter {
  readonly calls: PutObjectInput[] = [];
  private readonly objects = new Map<
    string,
    {
      body: Uint8Array;
      sha256: string;
      contentType?: string;
      metadata?: Record<string, string>;
    }
  >();
  private readonly pathCallCounts = new Map<string, number>();
  private readonly failureRules: Array<{ path: string; nth: number; error: StorageError }> = [];

  failOnNthPut(relativePath: string, nth: number, error: StorageError): void {
    this.failureRules.push({ path: relativePath, nth, error });
  }

  clearFailures(): void {
    this.failureRules.length = 0;
  }

  async putObject(input: PutObjectInput): Promise<PutObjectResult> {
    const count = (this.pathCallCounts.get(input.relativePath) ?? 0) + 1;
    this.pathCallCounts.set(input.relativePath, count);

    for (const rule of this.failureRules) {
      if (rule.path === input.relativePath && count === rule.nth) {
        throw rule.error;
      }
    }

    const key = buildObjectKey(input);
    const actualSha256 = sha256Hex(Buffer.from(input.body).toString('utf8'));
    if (input.contentSha256 && input.contentSha256 !== actualSha256) {
      throw new StorageError(
        'SYNC_STORAGE_ERROR',
        `SHA256 mismatch for ${input.relativePath}: provided ${input.contentSha256}, actual ${actualSha256}`,
        false,
      );
    }

    this.calls.push(input);
    this.objects.set(key, {
      body: input.body,
      sha256: actualSha256,
      contentType: input.contentType,
      metadata: input.metadata,
    });

    return { key, sha256: actualSha256, etag: `"${actualSha256}"` };
  }

  async getObject(input: GetObjectInput): Promise<GetObjectResult | undefined> {
    const key = buildObjectKey(input);
    const existing = this.objects.get(key);
    if (!existing) return undefined;
    return {
      body: existing.body,
      sha256: existing.sha256,
      etag: existing.etag,
      contentType: existing.contentType,
      metadata: existing.metadata,
    };
  }

  async headObject(input: HeadObjectInput): Promise<HeadObjectResult | undefined> {
    const key = buildObjectKey(input);
    const existing = this.objects.get(key);
    if (!existing) return undefined;
    return {
      contentLength: existing.body.length,
      sha256: existing.sha256,
      etag: existing.etag,
      contentType: existing.contentType,
      metadata: existing.metadata,
    };
  }

  getStoredContent(relativePath: string, scope: PutObjectInput['scope']): string | undefined {
    const projectId = 'proj-e2e';
    const sessionId = 'sess-e2e';
    const key = buildObjectKey({ projectId, sessionId, scope, relativePath });
    const existing = this.objects.get(key);
    if (!existing) return undefined;
    return Buffer.from(existing.body).toString('utf8');
  }

  wasPathUploaded(relativePath: string, scope: PutObjectInput['scope']): boolean {
    return this.getStoredContent(relativePath, scope) !== undefined;
  }
}

function defaultTestEnv(): Record<string, string> {
  return {
    SAL_PROJECT_ID: 'proj-e2e',
    SAL_STORAGE_TYPE: 's3',
    SAL_STORAGE_BUCKET: 'test-bucket',
    SAL_STORAGE_ENDPOINT: 'http://localhost:4566',
    SAL_STORAGE_REGION: 'us-east-1',
    SAL_STORAGE_ID: 'AKIAIOSFODNN7EXAMPLE',
    SAL_STORAGE_SECRET: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    SAL_SYNC_TIMEOUT: '5000',
    SAL_SESSION_END_BUDGET_MS: '5000',
    SAL_HOOK_UPLOAD_TIMEOUT: '5000',
    SAL_MAX_FILE_BYTES: '10485760',
    SAL_MAX_TOTAL_BYTES: '104857600',
    SAL_MAX_FILES: '1000',
  };
}

interface WorkspaceFixture {
  workspaceDir: string;
  claudeConfigDir: string;
  homeDir: string;
  dataDir: string;
  transcriptPath: string;
  storage: InMemoryStorageAdapter;
  env: Record<string, string>;
  spawned: ChildProcess[];
}

async function writeWorkspace(workspaceDir: string): Promise<void> {
  await mkdir(path.join(workspaceDir, '.claude', 'agents'), { recursive: true });
  await mkdir(path.join(workspaceDir, '.claude', 'skills'), { recursive: true });
  await mkdir(path.join(workspaceDir, '.claude', 'rules'), { recursive: true });
  await mkdir(path.join(workspaceDir, 'subagents'), { recursive: true });

  await writeFile(
    path.join(workspaceDir, 'CLAUDE.md'),
    ['# Workspace guide', 'Authorization: Bearer token123', 'apiKey=sk-abc123'].join('\n'),
  );

  await writeFile(
    path.join(workspaceDir, '.mcp.json'),
    JSON.stringify({
      mcpServers: {
        fetch: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-fetch'],
          env: { API_KEY: 'super-secret' },
          headers: { Authorization: 'Bearer mcp-token' },
        },
      },
    }),
  );

  await writeFile(
    path.join(workspaceDir, '.claude', 'settings.json'),
    JSON.stringify({ theme: 'dark', apiKey: 'settings-key-123' }),
  );

  await writeFile(
    path.join(workspaceDir, '.claude', 'settings.local.json'),
    JSON.stringify({ localOnly: true, secretKey: 'local-secret' }),
  );

  await writeFile(
    path.join(workspaceDir, '.claude', 'agents', 'agent.json'),
    JSON.stringify({ name: 'test-agent', instructions: 'Be helpful.' }),
  );

  await writeFile(
    path.join(workspaceDir, '.claude', 'skills', 'skill.json'),
    JSON.stringify({ name: 'test-skill', steps: [] }),
  );

  await writeFile(
    path.join(workspaceDir, '.claude', 'rules', 'rule.json'),
    JSON.stringify({ name: 'test-rule', pattern: '.*' }),
  );

  await writeFile(
    path.join(workspaceDir, 'transcript.jsonl'),
    `${JSON.stringify({ type: 'message', role: 'user', content: 'hello' })}\n`,
  );

  await writeFile(
    path.join(workspaceDir, 'secret.txt'),
    'this file is outside the capture boundary',
  );

  await writeFile(
    path.join(workspaceDir, 'subagents', 'agent-1.jsonl'),
    `${JSON.stringify({ type: 'message', role: 'assistant', content: 'subagent line' })}\n`,
  );
}

async function writeGlobalConfig(claudeConfigDir: string, homeDir: string): Promise<void> {
  await mkdir(claudeConfigDir, { recursive: true });
  await writeFile(
    path.join(claudeConfigDir, 'settings.json'),
    JSON.stringify({ global: true, apiKey: 'global-key' }),
  );
  await writeFile(
    path.join(claudeConfigDir, 'CLAUDE.md'),
    ['# Global guide', 'Authorization: Bearer global-token'].join('\n'),
  );
  await mkdir(path.join(claudeConfigDir, 'agents'), { recursive: true });
  await writeFile(
    path.join(claudeConfigDir, 'agents', 'agent.json'),
    JSON.stringify({ name: 'global-agent' }),
  );

  await writeFile(
    path.join(homeDir, '.claude.json'),
    JSON.stringify({ homeApiKey: 'home-secret' }),
  );
}

function spawnRealWatcher(
  args: string[],
  onSpawn: (child: ChildProcess) => void,
): {
  unref(): void;
  pid?: number;
  on?(event: 'error' | 'exit', listener: (code?: number, signal?: string) => void): unknown;
} {
  const child = spawn(process.execPath, [watchScriptPath, ...args], {
    detached: true,
    stdio: 'ignore',
  });
  onSpawn(child);
  const handle: {
    unref(): void;
    pid?: number;
    on?(event: 'error' | 'exit', listener: (code?: number, signal?: string) => void): unknown;
  } = {
    unref: () => child.unref(),
    pid: child.pid ?? undefined,
    on: (event: 'error' | 'exit', listener: (code?: number, signal?: string) => void) => {
      child.on(event, listener as () => void);
      return handle;
    },
  };
  return handle;
}

function hookInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: 'sess-e2e',
    cwd: '',
    transcript_path: '',
    ...overrides,
  };
}

async function createFixture(): Promise<WorkspaceFixture> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'sal-sync-e2e-'));
  const workspaceDir = path.join(tempRoot, 'workspace');
  const claudeConfigDir = path.join(tempRoot, 'claude-config');
  const homeDir = path.join(tempRoot, 'home');
  const dataDir = path.join(tempRoot, 'data');
  await mkdir(workspaceDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });

  await writeWorkspace(workspaceDir);
  await writeGlobalConfig(claudeConfigDir, homeDir);

  const transcriptPath = path.join(workspaceDir, 'transcript.jsonl');
  const storage = new InMemoryStorageAdapter();
  const env = {
    ...process.env,
    ...defaultTestEnv(),
    HOME: homeDir,
    CLAUDE_CONFIG_DIR: claudeConfigDir,
  } as Record<string, string>;

  return {
    workspaceDir,
    claudeConfigDir,
    homeDir,
    dataDir,
    transcriptPath,
    storage,
    env,
    spawned: [],
  };
}

function _sha256HexFromString(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

async function appendTranscript(transcriptPath: string, lines: unknown[]): Promise<void> {
  const text = `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`;
  await fsp.appendFile(transcriptPath, text);
}

describe('sync E2E lifecycle', () => {
  let fixture: WorkspaceFixture;

  beforeEach(async () => {
    fixture = await createFixture();
  });

  afterEach(async () => {
    for (const child of fixture?.spawned ?? []) {
      try {
        if (!child.killed) {
          process.kill(child.pid as number, 'SIGKILL');
        }
      } catch {
        // already gone
      }
    }
    await fsp.rm(path.dirname(fixture?.workspaceDir ?? ''), { recursive: true, force: true });
  });

  it('runs the full simulated session lifecycle through the real CLI', async () => {
    const { workspaceDir, dataDir, transcriptPath, storage, env } = fixture;

    // 1. session-start: record session metadata, spawn watcher, initial bulk upload.
    const startResult = await sessionStart({
      dataDir,
      env,
      input: hookInput({ cwd: workspaceDir, transcript_path: transcriptPath }),
      storageAdapter: storage,
      spawnWatcher: (args) => {
        return spawnRealWatcher(args, (child) => {
          fixture.spawned.push(child);
        });
      },
    });

    expect(startResult.exitCode).toBe(0);
    expect(startResult.run?.trigger).toBe('session-start');
    expect(startResult.run?.filesUploaded).toBeGreaterThan(0);

    const startCallCount = storage.calls.length;
    expect(startCallCount).toBeGreaterThan(0);

    // Verify all allowed workspace artifacts were uploaded and nothing else.
    const allowedPaths = new Set([
      'CLAUDE.md',
      '.mcp.json',
      '.claude/settings.json',
      '.claude/settings.local.json',
      '.claude/agents/agent.json',
      '.claude/skills/skill.json',
      '.claude/rules/rule.json',
      'transcript.jsonl',
      'subagents/agent-1.jsonl',
    ]);
    const uploadedPaths = new Set(
      storage.calls
        .filter((call) => call.scope === 'workspace' || call.scope === 'session')
        .map((call) => call.relativePath),
    );
    for (const p of allowedPaths) {
      expect(uploadedPaths.has(p)).toBe(true);
    }
    expect(uploadedPaths.has('secret.txt')).toBe(false);

    // Verify sanitization happened and hashes match.
    const claudeMd = storage.getStoredContent('CLAUDE.md', 'workspace');
    expect(claudeMd).toBeDefined();
    expect(claudeMd).not.toContain('Bearer token123');
    expect(claudeMd).toContain('[REDACTED]');

    const mcpJson = storage.getStoredContent('.mcp.json', 'workspace');
    expect(mcpJson).toBeDefined();
    const mcpParsed = JSON.parse(mcpJson as string);
    expect(mcpParsed.mcpServers.fetch.env.API_KEY).toBe('[REDACTED]');
    expect(mcpParsed.mcpServers.fetch.headers.Authorization).toBeUndefined();

    const settings = storage.getStoredContent('.claude/settings.json', 'workspace');
    expect(settings).toBeDefined();
    const settingsParsed = JSON.parse(settings as string);
    expect(settingsParsed.apiKey).toBe('[REDACTED]');

    const transcript = storage.getStoredContent('transcript.jsonl', 'session');
    expect(transcript).toContain('hello');

    // 2. Append to transcript and trigger a `stop` capture.
    // Simulate a fire-and-forget failure on the *second* transcript upload (the
    // first was session-start, the second is this `stop`). The next trigger must
    // recover it.
    storage.failOnNthPut(
      'transcript.jsonl',
      2,
      new StorageError('SYNC_STORAGE_ERROR', 'Simulated stop upload failure', true),
    );

    await appendTranscript(transcriptPath, [
      { type: 'message', role: 'assistant', content: 'stop line' },
    ]);

    const stopResult = await capture({
      dataDir,
      env,
      input: hookInput({
        cwd: workspaceDir,
        transcript_path: transcriptPath,
        trigger: 'stop',
      }),
      storageAdapter: storage,
    });

    expect(stopResult.exitCode).toBe(0);
    expect(stopResult.run?.filesFailed).toBe(1);
    expect(stopResult.run?.errors.length).toBeGreaterThan(0);

    // The failed attempt should still have persisted durable state.
    const stateAfterStop = JSON.parse(
      await fsp.readFile(path.join(dataDir, 'state', 'state.json'), 'utf8'),
    );
    expect(stateAfterStop.version).toBe(1);
    expect(Object.keys(stateAfterStop.artifacts).length).toBeGreaterThan(0);

    storage.clearFailures();

    // 3. Append more and run a `post-compact` capture.
    await appendTranscript(transcriptPath, [
      { type: 'message', role: 'user', content: 'post-compact line' },
    ]);

    const postCompactResult = await capture({
      dataDir,
      env,
      input: hookInput({
        cwd: workspaceDir,
        transcript_path: transcriptPath,
        trigger: 'post-compact',
      }),
      storageAdapter: storage,
    });

    expect(postCompactResult.exitCode).toBe(0);
    expect(postCompactResult.run?.filesUploaded).toBeGreaterThanOrEqual(1);
    expect(postCompactResult.run?.errors).toHaveLength(0);

    const postCompactTranscript = storage.getStoredContent('transcript.jsonl', 'session');
    expect(postCompactTranscript).toContain('stop line');
    expect(postCompactTranscript).toContain('post-compact line');

    // Workspace files should not have been re-uploaded (delta only).
    const postCompactWorkspaceUploads = storage.calls.filter(
      (call, index) => call.scope === 'workspace' && index >= startCallCount,
    );
    expect(postCompactWorkspaceUploads).toHaveLength(0);

    // 4. Session end: final small delta, manifest upload, watcher teardown.
    const endResult = await sessionEnd({
      dataDir,
      env,
      input: hookInput({
        cwd: workspaceDir,
        transcript_path: transcriptPath,
        reason: 'completed',
        trigger: 'session-end',
      }),
      storageAdapter: storage,
    });

    expect(endResult.exitCode).toBe(0);
    expect(endResult.budgetExhausted).toBe(false);
    expect(endResult.manifest).toBeDefined();
    expect(storage.wasPathUploaded('manifest.json', 'manifest')).toBe(true);

    // After successful incrementals, the final artifact delta should be empty.
    expect(endResult.run?.filesChanged).toBe(0);

    // Verify the watcher pid was written and then removed (watcher terminated).
    const watcherPidPath = path.join(dataDir, 'watcher', `${encodeURIComponent('sess-e2e')}.pid`);
    expect(
      await fsp.stat(watcherPidPath).then(
        () => false,
        () => true,
      ),
    ).toBe(true);

    // Verify state is clean (no stray .tmp files from atomic writes).
    const stateFiles = await fsp.readdir(path.join(dataDir, 'state'));
    expect(stateFiles).toEqual(['state.json']);

    // Verify only allowed files discovered and out-of-boundary file was never uploaded.
    expect(storage.wasPathUploaded('secret.txt', 'workspace')).toBe(false);

    // Verify the manifest contains the recovered transcript.
    const manifestContent = storage.getStoredContent('manifest.json', 'manifest');
    expect(manifestContent).toBeDefined();
    const manifest = JSON.parse(manifestContent as string);
    const transcriptArtifact = manifest.artifacts.find(
      (a: { scope: string; relativePath: string }) =>
        a.scope === 'session' && a.relativePath === 'transcript.jsonl',
    );
    expect(transcriptArtifact).toBeDefined();
    expect(['uploaded', 'skipped']).toContain(transcriptArtifact.status);
  });
});
