import { existsSync, readFileSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildObjectKey,
  type PutObjectInput,
  type PutObjectResult,
  type StorageAdapter,
  sha256Hex,
} from '@lucasschirm/sal-sync';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runSyncCommand } from '../../src/cli/sync-command.js';
import { DevinHarnessProfile } from '../../src/devin-profile.js';
import { runDevinHookSync } from '../../src/hook-common.js';
import { runDevinWatcher } from '../../src/watcher.js';
import { buildFixtureDb, type FixtureDbHandle } from '../extractor/fixtures/build-fixture-db.js';
import { devinModelsListFixture } from '../models/fixture.js';

const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
const hooksJsonPath = path.join(packageRoot, 'hooks.json');

class RecordingStorageAdapter implements StorageAdapter {
  readonly calls: PutObjectInput[] = [];

  async putObject(input: PutObjectInput): Promise<PutObjectResult> {
    const key = buildObjectKey(input);
    const sha256 = input.contentSha256 ?? sha256Hex(Buffer.from(input.body).toString('utf8'));
    this.calls.push(input);
    return { key, sha256, etag: `"${sha256}"` };
  }
}

interface TelemetryEntry {
  timestamp: string;
  command: string;
  trigger: string;
  sessionId: string;
  filesUploaded: number;
  filesFailed: number;
  errors: string[];
}

async function readTelemetryLog(dataDir: string): Promise<TelemetryEntry[]> {
  const logPath = path.join(dataDir, 'logs', 'telemetry.jsonl');
  if (!existsSync(logPath)) return [];
  const content = await fsp.readFile(logPath, 'utf8');
  return content
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as TelemetryEntry);
}

function sessionRow(id: string, workdir: string) {
  return {
    id,
    working_directory: workdir,
    backend_type: null,
    model: null,
    agent_mode: null,
    created_at: null,
    last_activity_at: 100,
    title: null,
    main_chain_id: null,
    cogs_json: null,
    workspace_dirs: null,
    hidden: null,
    metadata: null,
  };
}

describe('Devin plugin hooks.json format (regression guard)', () => {
  // This test guards against the regression that broke all four plugin hooks:
  // the hooks.json used `"command": "node"` with `"args": ["${DEVIN_PLUGIN_ROOT}/bin/hook"]`,
  // but Devin CLI does not expand `${DEVIN_PLUGIN_ROOT}` in the `args` field —
  // it passes the literal string to node, which fails with "Cannot find module"
  // (exit code 1). The fix is to use a single shell-expandable command string
  // like `"command": "node \"$DEVIN_PLUGIN_ROOT/bin/hook\""`.
  it('uses shell-expandable command strings with $DEVIN_PLUGIN_ROOT, never the args field', async () => {
    expect(existsSync(hooksJsonPath)).toBe(true);
    const hooks = JSON.parse(readFileSync(hooksJsonPath, 'utf8'));
    expect(hooks).toHaveProperty('hooks');

    const hookEvents = Object.keys(hooks.hooks as Record<string, unknown[]>);
    expect(hookEvents.length).toBeGreaterThanOrEqual(4);

    for (const [event, matchers] of Object.entries(hooks.hooks as Record<string, unknown[]>)) {
      for (const matcher of matchers) {
        const item = matcher as { hooks?: { type?: string; command?: string; args?: string[] }[] };
        for (const hook of item.hooks ?? []) {
          expect(hook.type).toBe('command');
          // The command must be a single shell-expandable string that
          // references $DEVIN_PLUGIN_ROOT — NOT a bare binary name with a
          // separate args array (Devin CLI does not expand ${...} in args).
          expect(hook.command).toBeTypeOf('string');
          expect(hook.command).toContain('$DEVIN_PLUGIN_ROOT');
          expect(hook.command).toMatch(/^node /);
          // The args field must NOT be present — it was the root cause of
          // the silent hook failure (commit 1e41871).
          expect(hook.args).toBeUndefined();
        }
      }
    }
  });

  it('every hook command resolves to an existing bin entry point when DEVIN_PLUGIN_ROOT is set', async () => {
    const hooks = JSON.parse(readFileSync(hooksJsonPath, 'utf8'));
    const binDir = path.join(packageRoot, 'bin');

    for (const matchers of Object.values(hooks.hooks as Record<string, unknown[]>)) {
      for (const matcher of matchers) {
        const item = matcher as { hooks?: { command?: string }[] };
        for (const hook of item.hooks ?? []) {
          // Extract the bin name from the command string:
          // `node "$DEVIN_PLUGIN_ROOT/bin/hook"` -> `hook`
          const match = hook.command?.match(/\$DEVIN_PLUGIN_ROOT\/bin\/(\S+)/);
          expect(match).not.toBeNull();
          const binName = match![1].replace(/["']/g, '');
          const binPath = path.join(binDir, binName);
          expect(existsSync(binPath)).toBe(true);
        }
      }
    }
  });
});

describe('Devin plugin telemetry from all sync paths', () => {
  let dataDir: string;
  let homeDir: string;
  let fixture: FixtureDbHandle;

  const stubModels = { runModelsList: async () => devinModelsListFixture };

  beforeEach(async () => {
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'devin-telemetry-data-'));
    homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'devin-telemetry-home-'));
    await fsp.mkdir(path.join(dataDir, 'logs'), { recursive: true });
    fixture = buildFixtureDb({
      sessions: [sessionRow('sess-telemetry', '/tmp/ws-telemetry')],
    });
  });

  afterEach(async () => {
    fixture.close();
    await fsp.rm(dataDir, { recursive: true, force: true });
    await fsp.rm(homeDir, { recursive: true, force: true });
  });

  function envFor(): Record<string, string> {
    return {
      SAL_PROJECT_ID: 'proj-telemetry',
      SAL_STORAGE_TYPE: 's3',
      SAL_STORAGE_BUCKET: 'test-bucket',
      SAL_STORAGE_REGION: 'us-east-1',
      SAL_STORAGE_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
      SAL_STORAGE_SECRET_ACCESS_KEY: 'secret',
      SAL_DATA_DIR: dataDir,
    };
  }

  it('emits a telemetry record from the hook path on success', async () => {
    const storage = new RecordingStorageAdapter();
    const result = await runDevinHookSync('hook', {
      sessionId: 'sess-telemetry',
      cwd: '/tmp/ws-telemetry',
      trigger: 'stop',
      storageAdapter: storage,
      sessionsDbPath: fixture.path,
      env: envFor(),
      models: stubModels,
    });

    expect(result.ok).toBe(true);
    const entries = await readTelemetryLog(dataDir);
    const hookEntry = entries.find((e) => e.command === 'hook' && e.sessionId === 'sess-telemetry');
    expect(hookEntry).toBeDefined();
    expect(hookEntry!.trigger).toBe('stop');
    expect(hookEntry!.filesUploaded).toBeGreaterThan(0);
    expect(hookEntry!.filesFailed).toBe(0);
    expect(hookEntry!.errors).toHaveLength(0);
  });

  it('emits a telemetry record from the hook path on failure', async () => {
    // Force a failure by pointing sessionsDbPath to a nonexistent database.
    const stderrLines: string[] = [];
    const stderr = {
      write: (chunk: string) => {
        stderrLines.push(chunk);
        return true;
      },
    } as NodeJS.WritableStream;

    await runDevinHookSync('hook', {
      sessionId: 'sess-telemetry',
      cwd: '/tmp/ws-telemetry',
      trigger: 'stop',
      sessionsDbPath: path.join(dataDir, 'no-such-sessions.db'),
      env: envFor(),
      stderr,
    });

    const entries = await readTelemetryLog(dataDir);
    const failureEntry = entries.find(
      (e) => e.command === 'hook' && e.sessionId === 'sess-telemetry',
    );
    expect(failureEntry).toBeDefined();
    expect(failureEntry!.filesUploaded).toBe(0);
    expect(failureEntry!.filesFailed).toBe(1);
    expect(failureEntry!.errors.length).toBeGreaterThan(0);
  });

  it('emits a telemetry record from the watcher path on success', async () => {
    const storage = new RecordingStorageAdapter();
    const stdout = { write: () => true } as NodeJS.WritableStream;

    const exitCode = await runDevinWatcher({
      env: envFor(),
      dataDir,
      homeDir,
      sessionsDbPath: fixture.path,
      storageAdapter: storage,
      profile: DevinHarnessProfile,
      maxPolls: 1,
      pollIntervalMs: 1,
      stdout,
      models: stubModels,
    });

    expect(exitCode).toBe(0);
    const entries = await readTelemetryLog(dataDir);
    const watcherEntry = entries.find(
      (e) => e.command === 'watcher' && e.sessionId === 'sess-telemetry',
    );
    expect(watcherEntry).toBeDefined();
    expect(watcherEntry!.trigger).toBe('file-changed');
    expect(watcherEntry!.filesUploaded).toBeGreaterThan(0);
    expect(watcherEntry!.filesFailed).toBe(0);
    expect(watcherEntry!.errors).toHaveLength(0);
  });

  it('emits a telemetry record from the manual sync path on success', async () => {
    const storage = new RecordingStorageAdapter();
    const stdout = { write: () => true } as NodeJS.WritableStream;

    const exitCode = await runSyncCommand({
      env: envFor(),
      sessionsDbPath: fixture.path,
      homeDir,
      storageAdapter: storage,
      stdout,
      models: stubModels,
      all: true,
    });

    expect(exitCode).toBe(0);
    const entries = await readTelemetryLog(dataDir);
    const syncEntry = entries.find((e) => e.command === 'sync' && e.sessionId === 'sess-telemetry');
    expect(syncEntry).toBeDefined();
    expect(syncEntry!.trigger).toBe('manual');
    expect(syncEntry!.filesUploaded).toBeGreaterThan(0);
    expect(syncEntry!.filesFailed).toBe(0);
    expect(syncEntry!.errors).toHaveLength(0);
  });

  it('emits a telemetry record from the manual sync path on failure', async () => {
    // Block transcript materialization by occupying its target path with a
    // file instead of a directory, forcing runDevinSessionSync to throw.
    const devinDir = path.join(dataDir, 'devin');
    await fsp.writeFile(devinDir, 'blocking file, not a directory');

    const stdout = { write: () => true } as NodeJS.WritableStream;
    await runSyncCommand({
      env: envFor(),
      sessionsDbPath: fixture.path,
      homeDir,
      stdout,
      models: stubModels,
      all: true,
    });

    const entries = await readTelemetryLog(dataDir);
    const failureEntry = entries.find(
      (e) => e.command === 'sync' && e.sessionId === 'sess-telemetry',
    );
    expect(failureEntry).toBeDefined();
    expect(failureEntry!.filesUploaded).toBe(0);
    expect(failureEntry!.filesFailed).toBe(1);
    expect(failureEntry!.errors.length).toBeGreaterThan(0);
  });
});
