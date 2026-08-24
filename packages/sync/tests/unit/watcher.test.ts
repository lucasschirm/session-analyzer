import fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StorageAdapter } from '../../src/storage/index.js';
import {
  createWatcherMatcher,
  getWatchedRelativePath,
  isPathWatched,
  TranscriptWatcher,
  watchTranscripts,
} from '../../src/watcher/index.js';
import { getWatcherPidPath } from '../../src/watcher/pid.js';

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

function baseEnv(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    SAL_PROJECT_ID: 'proj-1',
    SAL_STORAGE_TYPE: 's3',
    SAL_STORAGE_BUCKET: 'my-bucket',
    SAL_STORAGE_ENDPOINT: 'http://localhost:4566',
    SAL_STORAGE_REGION: 'us-east-1',
    SAL_STORAGE_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
    SAL_STORAGE_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    SAL_CAPTURE_TRANSCRIPTS: 'true',
    SAL_MAX_TRANSCRIPT_BYTES: '1000000',
    SAL_HOOK_UPLOAD_TIMEOUT: '5000',
    ...overrides,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function appendFile(filePath: string, data: string): Promise<void> {
  const handle = await fsp.open(filePath, 'a');
  try {
    await handle.write(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

describe('matcher', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sal-matcher-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('accepts the session transcript and per-session subagent files', () => {
    const matcher = createWatcherMatcher(tempDir, 'sess-1');

    expect(isPathWatched(matcher, path.join(tempDir, 'sess-1.jsonl'))).toBe(true);
    expect(isPathWatched(matcher, path.join(tempDir, 'sess-1', 'subagents', 'agent-1.jsonl'))).toBe(
      true,
    );
    expect(
      isPathWatched(matcher, path.join(tempDir, 'sess-1', 'subagents', 'agent-1.meta.json')),
    ).toBe(true);
  });

  it('rejects files outside the session transcript directory', () => {
    const matcher = createWatcherMatcher(tempDir, 'sess-1');
    const outside = path.join(tempDir, '..', 'evil.jsonl');

    expect(isPathWatched(matcher, outside)).toBe(false);
    expect(getWatchedRelativePath(matcher, outside)).toBeUndefined();
  });

  it('rejects paths which resolve elsewhere', async () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sal-matcher-out-'));
    const outsideFile = path.join(outsideDir, 'leaked.jsonl');
    fs.writeFileSync(outsideFile, '{}\n');

    const linkPath = path.join(tempDir, 'link.jsonl');
    fs.symlinkSync(outsideFile, linkPath);

    const matcher = createWatcherMatcher(tempDir, 'sess-1');

    expect(isPathWatched(matcher, linkPath)).toBe(false);
    expect(getWatchedRelativePath(matcher, linkPath)).toBeUndefined();

    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  it('rejects non-watched and sibling-session filenames', () => {
    const matcher = createWatcherMatcher(tempDir, 'sess-1');

    expect(isPathWatched(matcher, path.join(tempDir, 'config.json'))).toBe(false);
    expect(isPathWatched(matcher, path.join(tempDir, 'sess-2.jsonl'))).toBe(false);
    expect(isPathWatched(matcher, path.join(tempDir, 'sess-2', 'subagents', 'agent-1.jsonl'))).toBe(
      false,
    );
    expect(isPathWatched(matcher, path.join(tempDir, 'sess-1', 'subagents', 'agent-1.txt'))).toBe(
      false,
    );
    expect(isPathWatched(matcher, path.join(tempDir, 'deep', 'subagents', 'agent-1.jsonl'))).toBe(
      false,
    );
    // A sibling session's flat subagents directory should be rejected.
    expect(isPathWatched(matcher, path.join(tempDir, 'subagents', 'agent-1.jsonl'))).toBe(false);
  });
});

describe('TranscriptWatcher', () => {
  let dataDir: string;
  let transcriptDir: string;
  let transcriptPath: string;

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sal-watcher-data-'));
    transcriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sal-watcher-tx-'));
    transcriptPath = path.join(transcriptDir, 'sess-1.jsonl');
    await fsp.writeFile(transcriptPath, '');
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(transcriptDir, { recursive: true, force: true });
  });

  it('exits early when SAL_CAPTURE_TRANSCRIPTS=false', async () => {
    const env = baseEnv({ SAL_CAPTURE_TRANSCRIPTS: 'false' });
    const watcher = new TranscriptWatcher({
      dataDir,
      sessionId: 'sess-1',
      transcriptPath,
      env,
    });

    await expect(watcher.start()).resolves.toBeUndefined();
    expect(fs.existsSync(getWatcherPidPath(dataDir, 'sess-1'))).toBe(false);
  });

  it('debounces and uploads appended transcript deltas with byte-offset tracking', async () => {
    const storage = new InMemoryStorageAdapter();
    const watcher = new TranscriptWatcher({
      dataDir,
      sessionId: 'sess-1',
      transcriptPath,
      env: baseEnv(),
      storageAdapter: storage,
      debounceMs: 50,
      pollIntervalMs: 20,
      livenessIntervalMs: 10_000,
    });

    const startPromise = watcher.start();

    // Let initial scan complete before appending.
    await sleep(50);
    await appendFile(transcriptPath, '{"type":"message"}\n');
    await sleep(400);

    await appendFile(transcriptPath, '{"type":"tool"}\n');
    await sleep(400);

    await watcher.stop();
    await startPromise.catch(() => {});

    const transcriptCalls = storage.calls.filter(
      (call) => call.scope === 'session' && call.relativePath === 'transcript.jsonl',
    );

    expect(transcriptCalls.length).toBeGreaterThanOrEqual(2);
    expect(transcriptCalls[0]?.content).toBe('{"type":"message"}\n');
    expect(transcriptCalls[1]?.content).toBe('{"type":"tool"}\n');

    const offsetsPath = path.join(dataDir, 'watcher', `${encodeURIComponent('sess-1')}.state.json`);
    const offsets = JSON.parse(await fsp.readFile(offsetsPath, 'utf8')) as {
      offsets: Record<string, { offset: number; lastProcessedSize: number }>;
    };
    expect(offsets.offsets['sess-1.jsonl'].offset).toBeGreaterThan(0);
  });

  it('strips the project-root prefix from appended transcript deltas when cwd is provided', async () => {
    const storage = new InMemoryStorageAdapter();
    const projectRoot = transcriptDir;
    const watcher = new TranscriptWatcher({
      dataDir,
      sessionId: 'sess-1',
      transcriptPath,
      cwd: projectRoot,
      env: baseEnv(),
      storageAdapter: storage,
      debounceMs: 50,
      pollIntervalMs: 20,
      livenessIntervalMs: 10_000,
    });

    const startPromise = watcher.start();
    await sleep(50);

    await appendFile(
      transcriptPath,
      `{"tool_use":{"file_path":"${projectRoot}/src/app.ts","cwd":"${projectRoot}"}}\n`,
    );
    await sleep(400);

    await watcher.stop();
    await startPromise.catch(() => {});

    const transcriptCalls = storage.calls.filter(
      (call) => call.scope === 'session' && call.relativePath === 'transcript.jsonl',
    );
    expect(transcriptCalls.length).toBeGreaterThanOrEqual(1);
    expect(transcriptCalls[0]?.content).toBe(
      '{"tool_use":{"file_path":"/src/app.ts","cwd":"/"}}\n',
    );
  });

  it('uploads per-session subagent transcript deltas', async () => {
    const subagentsDir = path.join(transcriptDir, 'sess-1', 'subagents');
    await fsp.mkdir(subagentsDir, { recursive: true });
    const agentPath = path.join(subagentsDir, 'agent-1.jsonl');
    await fsp.writeFile(agentPath, '');

    const storage = new InMemoryStorageAdapter();
    const watcher = new TranscriptWatcher({
      dataDir,
      sessionId: 'sess-1',
      transcriptPath,
      env: baseEnv(),
      storageAdapter: storage,
      debounceMs: 50,
      pollIntervalMs: 20,
      livenessIntervalMs: 10_000,
    });

    const startPromise = watcher.start();
    await sleep(50);

    await appendFile(agentPath, '{"type":"subagent"}\n');
    await sleep(400);

    await watcher.stop();
    await startPromise.catch(() => {});

    const agentCalls = storage.calls.filter(
      (call) => call.relativePath === 'subagents/agent-1.jsonl',
    );
    expect(agentCalls.length).toBeGreaterThanOrEqual(1);
    expect(agentCalls[0]?.content).toBe('{"type":"subagent"}\n');
  });

  it('self-terminates when the owning process is gone', async () => {
    const watcher = new TranscriptWatcher({
      dataDir,
      sessionId: 'sess-1',
      transcriptPath,
      env: baseEnv(),
      ownerPid: 999_999,
      pollIntervalMs: 10_000,
      livenessIntervalMs: 50,
    });

    const startPromise = watcher.start();
    // Liveness interval is 50ms; wait for it to fire and stop the watcher.
    await sleep(300);

    await startPromise.catch(() => {});

    expect(fs.existsSync(getWatcherPidPath(dataDir, 'sess-1'))).toBe(false);
  });

  it('exits when its PID file is replaced by another watcher', async () => {
    const watcher = new TranscriptWatcher({
      dataDir,
      sessionId: 'sess-1',
      transcriptPath,
      env: baseEnv(),
      pollIntervalMs: 10_000,
      livenessIntervalMs: 50,
    });

    const startPromise = watcher.start();
    await sleep(100);

    // Simulate another watcher taking over the session.
    await fsp.writeFile(
      getWatcherPidPath(dataDir, 'sess-1'),
      JSON.stringify({ pid: 12345, startedAt: Date.now() }),
    );
    await sleep(300);

    await startPromise.catch(() => {});
    expect(fs.existsSync(getWatcherPidPath(dataDir, 'sess-1'))).toBe(false);
  });

  it('performs a clean shutdown with a final transcript flush', async () => {
    const storage = new InMemoryStorageAdapter();
    const watcher = new TranscriptWatcher({
      dataDir,
      sessionId: 'sess-1',
      transcriptPath,
      env: baseEnv(),
      storageAdapter: storage,
      debounceMs: 5000,
      pollIntervalMs: 20,
      livenessIntervalMs: 10_000,
    });

    const startPromise = watcher.start();
    await sleep(50);

    await appendFile(transcriptPath, '{"type":"final"}\n');
    // Wait for the poll to pick up the change but not for the debounce to fire.
    await sleep(100);

    await watcher.stop();
    await startPromise.catch(() => {});

    const calls = storage.calls.filter((call) => call.relativePath === 'transcript.jsonl');
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls.some((call) => call.content.includes('"type":"final"'))).toBe(true);
    expect(fs.existsSync(getWatcherPidPath(dataDir, 'sess-1'))).toBe(false);
  });

  it('replaces a stale PID file on startup', async () => {
    const stalePidPath = getWatcherPidPath(dataDir, 'sess-1');
    await fsp.mkdir(path.dirname(stalePidPath), { recursive: true });
    await fsp.writeFile(
      stalePidPath,
      JSON.stringify({ pid: 999_999, startedAt: Date.now() - 10_000 }),
    );

    const watcher = new TranscriptWatcher({
      dataDir,
      sessionId: 'sess-1',
      transcriptPath,
      env: baseEnv(),
      pollIntervalMs: 10_000,
      livenessIntervalMs: 10_000,
    });

    const startPromise = watcher.start();
    await sleep(100);

    const pidFile = JSON.parse(await fsp.readFile(stalePidPath, 'utf8')) as { pid: number };
    expect(pidFile.pid).toBe(process.pid);

    await watcher.stop();
    await startPromise.catch(() => {});
  });
});

describe('watchTranscripts', () => {
  it('returns the running watcher promise', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sal-watch-fn-'));
    const txDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sal-watch-tx-'));
    const txPath = path.join(txDir, 'sess-fn.jsonl');
    fs.writeFileSync(txPath, '');

    const env = baseEnv({ SAL_CAPTURE_TRANSCRIPTS: 'false' });
    const startPromise = watchTranscripts({
      dataDir: tempDir,
      sessionId: 'sess-fn',
      transcriptPath: txPath,
      env,
    });

    // With capture disabled, the promise resolves immediately.
    await expect(startPromise).resolves.toBeUndefined();

    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(txDir, { recursive: true, force: true });
  });
});
