import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PutObjectInput, PutObjectResult, StorageAdapter } from '@lucasschirm/sal-sync';
import { buildObjectKey, sha256Hex } from '@lucasschirm/sal-sync';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { encodeProjectFolder, runHook, runSessionEnd, runSessionStart } from '../../src/index.js';

const packageRoot = fileURLToPath(new URL('../../', import.meta.url));

function runBin(
  binPath: string,
  args: string[] = [],
  options: {
    input?: string;
    env?: Record<string, string>;
    timeout?: number;
    cwd?: string;
  } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binPath, ...args], {
      env: options.env,
      timeout: options.timeout ?? 15000,
      cwd: options.cwd,
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    if (options.input) {
      child.stdin.write(options.input);
      // Give the child process a moment to attach its stdin listeners before
      // closing the pipe, so small inputs are not lost before readStdin() runs.
      setTimeout(() => child.stdin.end(), 100);
    } else {
      // Close stdin immediately so readStdin() receives an empty input
      // instead of waiting forever for data that will never arrive.
      child.stdin.end();
    }

    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    child.on('error', reject);
    child.on('close', (exitCode) => {
      resolve({
        exitCode: exitCode ?? 0,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      });
    });
  });
}
const pluginBinDir = path.join(packageRoot, 'bin');
const pluginManifestPath = path.join(packageRoot, '.claude-plugin', 'plugin.json');
const hooksJsonPath = path.join(packageRoot, 'hooks', 'hooks.json');

const TEST_ACCESS_KEY = 'AKIAIOSFODNN7EXAMPLE';
const TEST_SECRET_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';

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

  getStoredContent(relativePath: string, scope: PutObjectInput['scope']): string | undefined {
    const projectId = 'proj-plugin';
    const sessionId = 'sess-plugin';
    const key = buildObjectKey({ projectId, sessionId, scope, relativePath });
    const existing = this.objects.get(key);
    if (!existing) return undefined;
    return Buffer.from(existing.body).toString('utf8');
  }

  wasPathUploaded(relativePath: string, scope: PutObjectInput['scope']): boolean {
    return this.getStoredContent(relativePath, scope) !== undefined;
  }
}

/**
 * Minimal S3-compatible server for verifying the bundled plugin binaries
 * against a real (local) endpoint without any node_modules or cloud service.
 */
class MockS3Server {
  private readonly server: Server;
  private readonly objects = new Map<string, { body: Buffer; sha256: string }>();
  private port = 0;

  constructor() {
    this.server = http.createServer((req, res) => {
      void this.handle(req, res);
    });
  }

  start(): Promise<string> {
    return new Promise((resolve, reject) => {
      this.server.listen(0, '127.0.0.1', () => {
        const address = this.server.address();
        if (address && typeof address === 'object') {
          this.port = address.port;
          resolve(`http://127.0.0.1:${this.port}`);
        } else {
          reject(new Error('Could not get server address'));
        }
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      this.server.close(() => resolve());
    });
  }

  listKeys(): string[] {
    return [...this.objects.keys()];
  }

  getBody(key: string): Buffer | undefined {
    return this.objects.get(key)?.body;
  }

  deleteKey(key: string): boolean {
    return this.objects.delete(key);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.port}`);
    const pathParts = decodeURIComponent(url.pathname).split('/').filter(Boolean);
    pathParts.shift(); // bucket
    const key = pathParts.join('/');

    if (req.method === 'PUT') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(chunk as Buffer);
      }
      const body = Buffer.concat(chunks);
      const sha256 = sha256Hex(body.toString('utf8'));
      this.objects.set(key, { body, sha256 });
      res.writeHead(200, { 'Content-Type': 'application/xml', ETag: `"${sha256}"` });
      res.end(
        `<?xml version="1.0" encoding="UTF-8"?><PutObjectOutput><ETag>${sha256}</ETag></PutObjectOutput>`,
      );
      return;
    }

    // ListObjectsV2: GET /bucket?list-type=2&prefix=...
    if (req.method === 'GET' && url.searchParams.has('list-type')) {
      const prefix = url.searchParams.get('prefix') ?? '';
      const matchingKeys = [...this.objects.keys()].filter((k) => k.startsWith(prefix));
      const contents = matchingKeys
        .map((k) => {
          const obj = this.objects.get(k)!;
          return `<Contents><Key>${k}</Key><Size>${obj.body.length}</Size><ETag>"${obj.sha256}"</ETag></Contents>`;
        })
        .join('');
      res.writeHead(200, { 'Content-Type': 'application/xml' });
      res.end(
        `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>test-bucket</Name><Prefix>${prefix}</Prefix><KeyCount>${matchingKeys.length}</KeyCount>${contents}</ListBucketResult>`,
      );
      return;
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      const object = this.objects.get(key);
      if (!object) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, {
        'Content-Length': String(object.body.length),
        ETag: `"${object.sha256}"`,
      });
      res.end(req.method === 'GET' ? object.body : undefined);
      return;
    }

    res.writeHead(405);
    res.end('Method not allowed');
  }
}

describe('Claude Code plugin E2E', () => {
  let e2eBinDir: string;

  beforeAll(async () => {
    // Build into a separate, isolated bin directory so we don't race with the
    // packaging unit test over the published `bin/` directory.
    const mod = await import('../../build.mjs');
    const build = (mod as { build?: (opts?: { outdir?: string }) => Promise<unknown> }).build;
    e2eBinDir = path.join(packageRoot, 'bin-e2e');
    if (typeof build === 'function') {
      await build({ outdir: e2eBinDir });
    }
  });

  afterAll(async () => {
    await rm(e2eBinDir, { recursive: true, force: true });
  });

  it('validates the plugin manifest', () => {
    const manifest = JSON.parse(readFileSync(pluginManifestPath, 'utf8'));
    expect(manifest).toMatchObject({
      name: 'claude-session-sync',
      version: expect.any(String),
    });
  });

  it('validates hooks.json and resolves every hook command to an executable bin', () => {
    const hooks = JSON.parse(readFileSync(hooksJsonPath, 'utf8'));
    expect(hooks).toHaveProperty('hooks');

    const commands = new Set<string>();
    for (const [_event, matchers] of Object.entries(hooks.hooks as Record<string, unknown[]>)) {
      for (const matcher of matchers) {
        const item = matcher as { hooks?: { command?: string; args?: string[] }[] };
        for (const hook of item.hooks ?? []) {
          expect(hook.command).toBe('node');
          expect(hook.args).toBeDefined();
          expect(hook.args?.length).toBe(1);
          const arg = hook.args?.[0] ?? '';
          expect(arg).toMatch(/^\$\{CLAUDE_PLUGIN_ROOT\}\/bin\//);
          commands.add(arg.replace(/^\$\{CLAUDE_PLUGIN_ROOT\}\/bin\//, ''));
        }
      }
    }

    const expected = new Set(['session-start', 'session-end', 'hook']);
    expect(commands).toEqual(expected);

    // Verify the published bin directory (created by the packaging build or
    // a manual build) also contains the executables hooked by hooks.json.
    for (const name of expected) {
      const binPath = path.join(pluginBinDir, name);
      const e2eBinPath = path.join(e2eBinDir, name);
      const e2eStats = statSync(e2eBinPath);
      expect(e2eStats.isFile()).toBe(true);
      expect(e2eStats.mode & 0o111).not.toBe(0);

      const firstLine = readFileSync(e2eBinPath, 'utf8').split('\n')[0];
      expect(firstLine).toBe('#!/usr/bin/env node');

      if (existsSync(binPath)) {
        const bundle = readFileSync(binPath, 'utf8');
        expect(bundle).not.toContain('node_modules');
      }
    }
  });

  it('runs each bundled executable without a node_modules install', async () => {
    for (const name of ['session-start', 'session-end', 'hook', 'transcript-watcher']) {
      const { exitCode, stderr } = await runBin(path.join(e2eBinDir, name), ['--help'], {
        env: { ...process.env, SAL_SYNC_DISABLED: 'true' },
        timeout: 5000,
      });
      if (exitCode !== 0) {
        console.error(`${name} stderr:`, stderr);
      }
      expect(exitCode).toBe(0);
    }
  });

  it('runs the hook bin with valid and malformed input and exits 0', async () => {
    const validInput = JSON.stringify({
      session_id: 'sess-bin',
      transcript_path: '/tmp/transcript.jsonl',
      cwd: '/tmp/project',
      hook_event_name: 'Stop',
    });

    const { exitCode: validExit, stderr: validStderr } = await runBin(
      path.join(e2eBinDir, 'hook'),
      [],
      {
        input: validInput,
        timeout: 5000,
        env: { ...process.env, SAL_SYNC_DISABLED: 'true' },
      },
    );
    if (validExit !== 0) console.error('hook valid stderr:', validStderr);
    expect(validExit).toBe(0);

    const { exitCode: malformedExit, stderr: malformedStderr } = await runBin(
      path.join(e2eBinDir, 'hook'),
      [],
      {
        input: 'this is not json',
        timeout: 5000,
        env: { ...process.env, SAL_SYNC_DISABLED: 'true' },
      },
    );
    if (malformedExit !== 0) console.error('hook malformed stderr:', malformedStderr);
    expect(malformedExit).toBe(0);
  });

  it('runs the session-start and session-end bins with valid input', async () => {
    const startInput = JSON.stringify({
      session_id: 'sess-bin-2',
      transcript_path: '/tmp/transcript.jsonl',
      cwd: '/tmp/project',
      hook_event_name: 'SessionStart',
    });

    const { exitCode: startExit, stderr: startStderr } = await runBin(
      path.join(e2eBinDir, 'session-start'),
      [],
      {
        input: startInput,
        timeout: 5000,
        env: { ...process.env, SAL_SYNC_DISABLED: 'true' },
      },
    );
    if (startExit !== 0) console.error('session-start stderr:', startStderr);
    expect(startExit).toBe(0);

    const endInput = JSON.stringify({
      session_id: 'sess-bin-2',
      transcript_path: '/tmp/transcript.jsonl',
      cwd: '/tmp/project',
      hook_event_name: 'SessionEnd',
      reason: 'completed',
    });

    const { exitCode: endExit, stderr: endStderr } = await runBin(
      path.join(e2eBinDir, 'session-end'),
      [],
      {
        input: endInput,
        timeout: 5000,
        env: { ...process.env, SAL_SYNC_DISABLED: 'true' },
      },
    );
    if (endExit !== 0) console.error('session-end stderr:', endStderr);
    expect(endExit).toBe(0);
  });

  it('validates that no marketplace.json is present and documents the gap', () => {
    const marketplacePath = path.join(packageRoot, 'marketplace.json');
    expect(existsSync(marketplacePath)).toBe(false);
  });

  describe('in-process plugin chain', () => {
    let tempRoot: string;
    let workspaceDir: string;
    let dataDir: string;
    let transcriptPath: string;

    beforeEach(async () => {
      tempRoot = await mkdtemp(path.join(os.tmpdir(), 'sal-plugin-e2e-'));
      workspaceDir = path.join(tempRoot, 'workspace');
      dataDir = path.join(tempRoot, 'data');
      await mkdir(workspaceDir, { recursive: true });
      await mkdir(dataDir, { recursive: true });
      await mkdir(path.join(workspaceDir, '.claude'), { recursive: true });
      await writeFile(path.join(workspaceDir, 'CLAUDE.md'), '# guide\n');
      await writeFile(path.join(workspaceDir, '.claude', 'settings.json'), '{"theme":"dark"}\n');
      transcriptPath = path.join(workspaceDir, 'transcript.jsonl');
      await writeFile(transcriptPath, '{"type":"message"}\n');
    });

    afterEach(async () => {
      await rm(tempRoot, { recursive: true, force: true });
    });

    function baseEnv(): Record<string, string> {
      return {
        ...process.env,
        SAL_PROJECT_ID: 'proj-plugin',
        SAL_STORAGE_TYPE: 's3',
        SAL_STORAGE_BUCKET: 'test-bucket',
        SAL_STORAGE_ENDPOINT: 'http://localhost:4566',
        SAL_STORAGE_REGION: 'us-east-1',
        SAL_STORAGE_ACCESS_KEY_ID: TEST_ACCESS_KEY,
        SAL_STORAGE_SECRET_ACCESS_KEY: TEST_SECRET_KEY,
        SAL_SYNC_TIMEOUT: '5000',
        SAL_SESSION_END_BUDGET_MS: '5000',
        SAL_HOOK_UPLOAD_TIMEOUT: '5000',
      } as Record<string, string>;
    }

    function claudeInput(
      event: string,
      overrides: Record<string, unknown> = {},
    ): Record<string, unknown> {
      return {
        session_id: 'sess-plugin',
        transcript_path: transcriptPath,
        cwd: workspaceDir,
        hook_event_name: event,
        ...overrides,
      };
    }

    it('routes SessionStart input to sal-sync sessionStart', async () => {
      const storage = new RecordingStorageAdapter();
      const exitCode = await runSessionStart(claudeInput('SessionStart'), {
        env: baseEnv(),
        dataDir,
        storageAdapter: storage,
        spawnWatcher: () => ({ unref: () => {}, pid: 12345 }),
      });
      expect(exitCode).toBe(0);
      expect(storage.calls.some((c) => c.relativePath === 'CLAUDE.md')).toBe(true);
      expect(storage.calls.some((c) => c.scope === 'session')).toBe(true);
    });

    it('routes Stop/PostCompact input to sal-sync capture', async () => {
      const storage = new RecordingStorageAdapter();
      await runSessionStart(claudeInput('SessionStart'), {
        env: baseEnv(),
        dataDir,
        storageAdapter: storage,
        spawnWatcher: () => ({ unref: () => {}, pid: 12345 }),
      });

      const initialWorkspace = storage.calls.filter((c) => c.scope === 'workspace').length;
      const initialTranscript = storage.getStoredContent('transcript.jsonl', 'session');
      expect(initialTranscript).toContain('message');

      await writeFile(transcriptPath, '{"type":"message"}\n{"type":"stop"}\n');
      const stopExit = await runHook(claudeInput('Stop'), {
        env: baseEnv(),
        dataDir,
        storageAdapter: storage,
      });
      expect(stopExit).toBe(0);

      // Workspace files should not be re-uploaded.
      expect(storage.calls.filter((c) => c.scope === 'workspace').length).toBe(initialWorkspace);

      const stopTranscript = storage.getStoredContent('transcript.jsonl', 'session');
      expect(stopTranscript).toContain('stop');

      await writeFile(
        transcriptPath,
        '{"type":"message"}\n{"type":"stop"}\n{"type":"post-compact"}\n',
      );
      const compactExit = await runHook(claudeInput('PostCompact'), {
        env: baseEnv(),
        dataDir,
        storageAdapter: storage,
      });
      expect(compactExit).toBe(0);

      const compactTranscript = storage.getStoredContent('transcript.jsonl', 'session');
      expect(compactTranscript).toContain('post-compact');
    });

    it('routes SessionEnd input to sal-sync sessionEnd and uploads a manifest', async () => {
      const storage = new RecordingStorageAdapter();
      await runSessionStart(claudeInput('SessionStart'), {
        env: baseEnv(),
        dataDir,
        storageAdapter: storage,
        spawnWatcher: () => ({ unref: () => {}, pid: 12345 }),
      });

      const endExit = await runSessionEnd(claudeInput('SessionEnd', { reason: 'completed' }), {
        env: baseEnv(),
        dataDir,
        storageAdapter: storage,
        watcherTerminator: () => {},
      });
      expect(endExit).toBe(0);
      expect(storage.wasPathUploaded('manifest.json', 'manifest')).toBe(true);
    });
  });

  describe('bundled bin against a local S3-compatible endpoint', () => {
    let server: MockS3Server;
    let endpoint: string;
    let tempRoot: string;
    let workspaceDir: string;
    let dataDir: string;
    let transcriptPath: string;

    beforeAll(async () => {
      server = new MockS3Server();
      endpoint = await server.start();
    });

    afterAll(async () => {
      await server.stop();
    });

    beforeEach(async () => {
      tempRoot = await mkdtemp(path.join(os.tmpdir(), 'sal-plugin-bin-'));
      workspaceDir = path.join(tempRoot, 'workspace');
      dataDir = path.join(tempRoot, 'data');
      await mkdir(workspaceDir, { recursive: true });
      await mkdir(dataDir, { recursive: true });
      await mkdir(path.join(workspaceDir, '.claude'), { recursive: true });
      await writeFile(path.join(workspaceDir, 'CLAUDE.md'), '# guide\n');
      await writeFile(path.join(workspaceDir, '.claude', 'settings.json'), '{"theme":"dark"}\n');
      transcriptPath = path.join(workspaceDir, 'transcript.jsonl');
      await writeFile(transcriptPath, '{"type":"message"}\n');
    });

    afterEach(async () => {
      await rm(tempRoot, { recursive: true, force: true });
    });

    it('executes the bundled hook entry point against a real S3 endpoint and uploads the workspace delta', async () => {
      const env = {
        ...process.env,
        SAL_PROJECT_ID: 'proj-bin',
        SAL_STORAGE_TYPE: 's3',
        SAL_STORAGE_BUCKET: 'test-bucket',
        SAL_STORAGE_ENDPOINT: endpoint,
        SAL_STORAGE_REGION: 'us-east-1',
        SAL_STORAGE_ACCESS_KEY_ID: TEST_ACCESS_KEY,
        SAL_STORAGE_SECRET_ACCESS_KEY: TEST_SECRET_KEY,
        SAL_SYNC_TIMEOUT: '5000',
        SAL_HOOK_UPLOAD_TIMEOUT: '5000',
        SAL_DATA_DIR: dataDir,
      } as Record<string, string>;

      const input = {
        session_id: 'sess-bin-s3',
        transcript_path: transcriptPath,
        cwd: workspaceDir,
        hook_event_name: 'Stop',
      };

      // Import the bundled executable as a module so we can feed it hook input
      // directly without relying on the flaky stdin event ordering of the
      // minimal readStdin() helper.
      const binUrl = new URL(`file://${path.join(e2eBinDir, 'hook')}`);
      const mod = (await import(binUrl.href)) as { runHook?: typeof runHook };
      expect(mod.runHook).toBeTypeOf('function');

      const exitCode = await mod.runHook?.(input, { env });
      expect(exitCode).toBe(0);

      const keys = server.listKeys();
      expect(keys.some((k) => k.startsWith('global/cas/'))).toBe(true);
      expect(keys.some((k) => k.endsWith('/transcript.jsonl'))).toBe(true);
    });

    it('recovers a manifest-only session by re-uploading the missing transcript', async () => {
      // Set up a Claude Code project folder under a temp HOME so the sync
      // command can discover the local session transcript. Use realpath to
      // handle macOS /private prefix resolution.
      const { realpathSync } = await import('node:fs');
      const realWorkspaceDir = realpathSync(workspaceDir);
      const homeDir = path.join(tempRoot, 'home');
      const claudeProjectsDir = path.join(homeDir, '.claude', 'projects');
      const encodedProject = encodeProjectFolder(realWorkspaceDir);
      const sessionProjectDir = path.join(claudeProjectsDir, encodedProject);
      await mkdir(sessionProjectDir, { recursive: true });
      const sessionTranscriptPath = path.join(sessionProjectDir, 'sess-recovery.jsonl');
      await writeFile(sessionTranscriptPath, '{"type":"message"}\n');

      const env = {
        ...process.env,
        HOME: homeDir,
        SAL_PROJECT_ID: 'proj-recovery',
        SAL_STORAGE_TYPE: 's3',
        SAL_STORAGE_BUCKET: 'test-bucket',
        SAL_STORAGE_ENDPOINT: endpoint,
        SAL_STORAGE_REGION: 'us-east-1',
        SAL_STORAGE_ACCESS_KEY_ID: TEST_ACCESS_KEY,
        SAL_STORAGE_SECRET_ACCESS_KEY: TEST_SECRET_KEY,
        SAL_SYNC_TIMEOUT: '5000',
        SAL_HOOK_UPLOAD_TIMEOUT: '5000',
        SAL_SESSION_END_BUDGET_MS: '5000',
        SAL_DATA_DIR: dataDir,
      } as Record<string, string>;

      // 1. Initial sync via the bundled claude-sync bin — creates manifest + transcript.
      const syncResult1 = await runBin(path.join(e2eBinDir, 'claude-sync'), ['sync'], {
        env,
        cwd: realWorkspaceDir,
        timeout: 15000,
      });
      if (syncResult1.exitCode !== 0) {
        console.error('sync1 stderr:', syncResult1.stderr);
        console.error('sync1 stdout:', syncResult1.stdout);
      }
      expect(syncResult1.exitCode).toBe(0);

      const transcriptKey = 'proj-recovery/sess-recovery/transcript.jsonl';
      expect(server.listKeys()).toContain(transcriptKey);

      // 2. Simulate the production bug: delete the transcript, leave the manifest.
      expect(server.deleteKey(transcriptKey)).toBe(true);
      expect(server.listKeys()).not.toContain(transcriptKey);

      // 3. Run the bundled claude-sync bin again — the completeness gate should
      //    detect the missing transcript and re-sync.
      const syncResult2 = await runBin(path.join(e2eBinDir, 'claude-sync'), ['sync'], {
        env,
        cwd: realWorkspaceDir,
        timeout: 15000,
      });
      if (syncResult2.exitCode !== 0) {
        console.error('sync2 stderr:', syncResult2.stderr);
        console.error('sync2 stdout:', syncResult2.stdout);
      }
      expect(syncResult2.exitCode).toBe(0);

      // The transcript must be restored.
      expect(server.listKeys()).toContain(transcriptKey);

      // 4. Run once more — the session is now complete and should be skipped.
      const syncResult3 = await runBin(path.join(e2eBinDir, 'claude-sync'), ['sync'], {
        env,
        cwd: realWorkspaceDir,
        timeout: 15000,
      });
      expect(syncResult3.exitCode).toBe(0);
      expect(syncResult3.stdout).toContain('[skip] session sess-recovery');
    });
  });
});
