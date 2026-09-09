import { fork } from 'node:child_process';
import fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * Cross-process regression for #327: the in-process stress test
 * (`unit/lock-stale-takeover.test.ts`) proves the takeover race is closed
 * between concurrent callers in one Node process, but the load-bearing
 * scenario the issue names — a Devin hook firing at the same moment the
 * watcher polls the same session — is inherently cross-process. This file
 * forks genuinely separate OS processes racing the real, built `FileLock`
 * against a shared append-only data file, mirroring
 * `materializeSessionTranscript`'s read-derive-append shape
 * (`packages/plugins/devin-session-sync/src/session-sync.ts`, guarded by
 * `new FileLock(`${transcriptPath}.lock`).withLock(...)`, added by PR #303).
 * Without correct mutual exclusion, both workers would read the data file
 * as empty before either appends, both compute `seq: 0`, and the worker's
 * artificial 50ms gap makes that interleaving deterministic-ish rather than
 * a rare fluke — so this test fails visibly (a duplicate `seq`) against a
 * broken lock, not just vacuously.
 */
const DIST_ENTRY = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const WORKER = fileURLToPath(new URL('./fixtures/lock-race-worker.mjs', import.meta.url));

interface WorkerResult {
  ok: boolean;
  pid?: number;
  message?: string;
}

function runWorker(lockPath: string, dataPath: string): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    const child = fork(WORKER, [lockPath, dataPath], { stdio: 'pipe' });
    let settled = false;
    child.on('message', (msg) => {
      settled = true;
      resolve(msg as WorkerResult);
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (!settled) reject(new Error(`worker exited (code ${code}) without reporting a result`));
    });
  });
}

function readDataLines(dataPath: string): Array<{ pid: number; seq: number }> {
  return fs
    .readFileSync(dataPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe('FileLock cross-process contention (#327)', () => {
  let tempDir: string;
  let lockPath: string;
  let dataPath: string;

  beforeAll(async () => {
    await fsp.access(DIST_ENTRY).catch(() => {
      throw new Error(
        `Missing ${DIST_ENTRY} — run "pnpm --filter @lucasschirm/sal-sync build" first.`,
      );
    });
  });

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sal-lock-cross-process-'));
    lockPath = path.join(tempDir, 'test.lock');
    dataPath = path.join(tempDir, 'data.jsonl');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('serializes a stale-lock takeover across two real processes without duplicating appends', async () => {
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999_999, startedAt: Date.now() - 10_000 }));

    const [a, b] = await Promise.all([
      runWorker(lockPath, dataPath),
      runWorker(lockPath, dataPath),
    ]);

    expect(a.ok, a.message).toBe(true);
    expect(b.ok, b.message).toBe(true);
    const lines = readDataLines(dataPath);
    expect(lines).toHaveLength(2);
    expect(new Set(lines.map((l) => l.seq))).toEqual(new Set([0, 1]));
    expect(fs.existsSync(lockPath)).toBe(false);
  }, 20_000);

  it('serializes two processes contending on a live (non-stale) lock', async () => {
    const [a, b] = await Promise.all([
      runWorker(lockPath, dataPath),
      runWorker(lockPath, dataPath),
    ]);

    expect(a.ok, a.message).toBe(true);
    expect(b.ok, b.message).toBe(true);
    const lines = readDataLines(dataPath);
    expect(lines).toHaveLength(2);
    expect(new Set(lines.map((l) => l.seq))).toEqual(new Set([0, 1]));
    expect(fs.existsSync(lockPath)).toBe(false);
  }, 20_000);
});
