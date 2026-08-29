import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  type StatusReport,
  sessionStart,
  status,
  type WatcherSpawner,
} from '@lucasschirm/sal-sync';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

let binDir: string;
let watcherBin: string;
let currentChild: ChildProcess | undefined;

beforeAll(async () => {
  binDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sal-crash-bin-'));
  const buildModule = (await import('../../build.mjs')) as {
    build?: (options?: { outdir?: string }) => Promise<unknown>;
  };
  if (typeof buildModule.build === 'function') {
    await buildModule.build({ outdir: binDir });
  }
  watcherBin = path.join(binDir, 'transcript-watcher');
}, 60000);

afterAll(async () => {
  if (binDir) await fsp.rm(binDir, { recursive: true, force: true });
});

interface MockS3Server {
  endpoint: string;
  stop: () => void;
  getTranscript: () => Buffer | undefined;
}

function s3Handler(objects: Map<string, Buffer>, req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', `http://127.0.0.1`);
  const key = url.pathname.split('/').filter(Boolean).slice(1).join('/');
  if (req.method === 'PUT') {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const sha256 = createHash('sha256').update(body).digest('hex');
      objects.set(key, body);
      res.writeHead(200, { 'Content-Type': 'application/xml', ETag: `"${sha256}"` });
      res.end(`<?xml version="1.0"?><PutObjectOutput><ETag>${sha256}</ETag></PutObjectOutput>`);
    });
    return;
  }
  if (req.method === 'GET' || req.method === 'HEAD') {
    const body = objects.get(key);
    if (!body) {
      res.writeHead(404);
      res.end();
      return;
    }
    const sha256 = createHash('sha256').update(body).digest('hex');
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(body.length),
      ETag: `"${sha256}"`,
    });
    res.end(req.method === 'GET' ? body : undefined);
    return;
  }
  res.writeHead(405);
  res.end();
}

function startMockS3Server(): Promise<MockS3Server> {
  const objects = new Map<string, Buffer>();
  const server = createServer((req, res) => s3Handler(objects, req, res));
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', (err) => {
      if (err) return reject(err);
      const addr = server.address();
      resolve({
        endpoint: `http://127.0.0.1:${(addr as { port: number }).port}`,
        stop: () => server.close(),
        getTranscript: () => objects.get('proj-crash/sess-crash/transcript.jsonl'),
      });
    });
  });
}

function buildEnv(endpoint: string, dataDir: string): Record<string, string> {
  return {
    SAL_PROJECT_ID: 'proj-crash',
    SAL_STORAGE_TYPE: 's3',
    SAL_STORAGE_BUCKET: 'test-bucket',
    SAL_STORAGE_ENDPOINT: endpoint,
    SAL_STORAGE_REGION: 'us-east-1',
    SAL_STORAGE_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
    SAL_STORAGE_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    SAL_SYNC_TIMEOUT: '5000',
    SAL_SESSION_END_BUDGET_MS: '5000',
    SAL_HOOK_UPLOAD_TIMEOUT: '5000',
    SAL_SYNC_RETRIES: '0',
    SAL_DATA_DIR: dataDir,
    SAL_CAPTURE_TRANSCRIPTS: 'true',
  };
}

function makeWatcherSpawner(bin: string, env: Record<string, string>, cwd: string): WatcherSpawner {
  return (args) => {
    currentChild = spawn(process.execPath, [bin, ...args], {
      env,
      cwd,
      detached: true,
      stdio: 'ignore',
    });
    return { unref: () => currentChild?.unref(), pid: currentChild?.pid };
  };
}

async function waitForFile(file: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fsp.stat(file);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`Timeout waiting for ${file}`);
}

async function waitForUpload(
  getTranscript: () => Buffer | undefined,
  expected: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const body = getTranscript();
    if (body?.toString().includes(expected)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timeout waiting for transcript upload');
}

async function waitForExit(child: ChildProcess, timeoutMs = 5000): Promise<number | string | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Timeout waiting for watcher exit'));
    }, timeoutMs);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve(signal ?? code ?? null);
    });
  });
}

describe('watcher mid-session crash visibility (SYNC-001)', () => {
  let tempRoot: string;
  let workspace: string;
  let dataDir: string;
  let transcriptPath: string;
  let server: MockS3Server;

  beforeEach(async () => {
    currentChild = undefined;
    server = await startMockS3Server();
    tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'sal-watcher-crash-'));
    workspace = path.join(tempRoot, 'workspace');
    dataDir = path.join(tempRoot, 'data');
    transcriptPath = path.join(workspace, 'sess-crash.jsonl');
    await fsp.mkdir(workspace, { recursive: true });
    await fsp.mkdir(dataDir, { recursive: true });
    await fsp.mkdir(path.join(workspace, '.claude'), { recursive: true });
    await fsp.writeFile(path.join(workspace, '.claude', 'settings.json'), '{}');
    await fsp.writeFile(transcriptPath, '');
  });

  afterEach(async () => {
    if (currentChild && !currentChild.killed) currentChild.kill('SIGKILL');
    server.stop();
    await fsp.rm(tempRoot, { recursive: true, force: true });
  });

  async function crashAndGetReport(): Promise<{
    exit: number | string | null;
    report: StatusReport;
  }> {
    const env = buildEnv(server.endpoint, dataDir);
    const spawner = makeWatcherSpawner(watcherBin, env, workspace);

    await sessionStart({
      dataDir,
      env,
      input: { session_id: 'sess-crash', cwd: workspace, transcript_path: transcriptPath },
      spawnWatcher: spawner,
    });

    await waitForFile(path.join(dataDir, 'watcher', 'sess-crash.pid'));
    await new Promise((resolve) => setTimeout(resolve, 800));

    await fsp.appendFile(transcriptPath, '{"type":"message"}\n');
    await waitForUpload(server.getTranscript, '"type":"message"');

    const child = currentChild as ChildProcess;
    child.kill('SIGKILL');
    const exit = await waitForExit(child);

    await fsp.appendFile(transcriptPath, '{"type":"tool"}\n');
    const result = await status({
      dataDir,
      env,
      argv: ['--session-id', 'sess-crash', '--cwd', workspace, '--transcript-path', transcriptPath],
    });
    if (!result.status) throw new Error('status did not return a report');
    return { exit, report: result.status };
  }

  it('reports the watcher crash as a failed/stuck state, not silent pending_files', async () => {
    const { exit, report } = await crashAndGetReport();
    expect(exit).not.toBe(0);
    expect(report.watcherAlive).toBe(false);
    expect(report.pendingFiles).toBeGreaterThan(0);
    // The user-visible signal must be consistent with a dead watcher.
    // Currently status exits 0 with empty lastErrors — the silent gap.
    expect(report.lastErrors.length, 'watcher crashed but status reports no error').toBeGreaterThan(
      0,
    );
  }, 20000);
});
