import * as fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildObjectKey,
  type PutObjectInput,
  type PutObjectResult,
  type StorageAdapter,
  sha256Hex,
} from '@lucasschirm/sal-sync';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runSyncCommand } from '../../src/cli/sync-command.js';
import { buildFixtureDb, type FixtureDbHandle } from '../extractor/fixtures/build-fixture-db.js';

class RecordingStorageAdapter implements StorageAdapter {
  readonly calls: PutObjectInput[] = [];

  async putObject(input: PutObjectInput): Promise<PutObjectResult> {
    const key = buildObjectKey(input);
    const sha256 = input.contentSha256 ?? sha256Hex(Buffer.from(input.body).toString('utf8'));
    this.calls.push(input);
    return { key, sha256, etag: `"${sha256}"` };
  }
}

function writable(): { stream: NodeJS.WritableStream; lines: string[] } {
  const lines: string[] = [];
  return {
    stream: {
      write: (chunk: string) => {
        lines.push(chunk);
        return true;
      },
    } as NodeJS.WritableStream,
    lines,
  };
}

describe('runSyncCommand', () => {
  let dataDir: string;
  let homeDir: string;
  let fixture: FixtureDbHandle | undefined;

  beforeEach(async () => {
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'devin-sync-cmd-data-'));
    homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'devin-sync-cmd-home-'));
  });

  afterEach(async () => {
    fixture?.close();
    fixture = undefined;
    await fsp.rm(dataDir, { recursive: true, force: true });
    await fsp.rm(homeDir, { recursive: true, force: true });
  });

  function envFor(): Record<string, string> {
    return {
      SAL_PROJECT_ID: 'proj-sync',
      SAL_STORAGE_TYPE: 's3',
      SAL_STORAGE_BUCKET: 'test-bucket',
      SAL_STORAGE_REGION: 'us-east-1',
      SAL_STORAGE_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
      SAL_STORAGE_SECRET_ACCESS_KEY: 'secret',
      SAL_DATA_DIR: dataDir,
    };
  }

  it('reports no sessions found for an empty database', async () => {
    fixture = buildFixtureDb({});
    const { stream: stdout, lines } = writable();
    const code = await runSyncCommand({
      env: envFor(),
      sessionsDbPath: fixture.path,
      homeDir,
      stdout,
    });
    expect(code).toBe(0);
    expect(lines.join('')).toContain('No local Devin sessions found');
  });

  it('syncs every session found in sessions.db and uploads a manifest for each', async () => {
    fixture = buildFixtureDb({
      sessions: [
        {
          id: 'sess-1',
          working_directory: '/tmp/proj-a',
          backend_type: null,
          model: 'devin-1',
          agent_mode: null,
          created_at: 100,
          last_activity_at: 200,
          title: 'A',
          main_chain_id: null,
          cogs_json: null,
          workspace_dirs: null,
          hidden: 0,
          metadata: null,
        },
        {
          id: 'sess-2',
          working_directory: '/tmp/proj-b',
          backend_type: null,
          model: 'devin-1',
          agent_mode: null,
          created_at: 100,
          last_activity_at: 300,
          title: 'B',
          main_chain_id: null,
          cogs_json: null,
          workspace_dirs: null,
          hidden: 0,
          metadata: null,
        },
      ],
    });

    const storage = new RecordingStorageAdapter();
    const { stream: stdout, lines } = writable();
    const code = await runSyncCommand({
      env: envFor(),
      sessionsDbPath: fixture.path,
      homeDir,
      storageAdapter: storage,
      stdout,
    });

    expect(code).toBe(0);
    expect(lines.join('')).toContain('Synced 2 session(s)');
    const manifestCalls = storage.calls.filter((c) => c.scope === 'manifest');
    expect(manifestCalls).toHaveLength(2);
  });

  it('reports a configuration error and exits 1', async () => {
    const { stream: stderr, lines } = writable();
    const code = await runSyncCommand({ env: {}, stderr });
    expect(code).toBe(1);
    expect(lines.join('')).toContain('required');
  });

  it('reports a sessions.db read error and exits 1', async () => {
    const { stream: stderr, lines } = writable();
    const code = await runSyncCommand({
      env: envFor(),
      sessionsDbPath: path.join(dataDir, 'no-such-sessions.db'),
      homeDir,
      stderr,
    });
    expect(code).toBe(1);
    expect(lines.join('')).toContain('could not read Devin sessions.db');
  });

  it('clears local state with --force before syncing', async () => {
    fixture = buildFixtureDb({
      sessions: [
        {
          id: 'sess-1',
          working_directory: '/tmp/proj-a',
          backend_type: null,
          model: null,
          agent_mode: null,
          created_at: null,
          last_activity_at: null,
          title: null,
          main_chain_id: null,
          cogs_json: null,
          workspace_dirs: null,
          hidden: null,
          metadata: null,
        },
      ],
    });
    const storage = new RecordingStorageAdapter();
    const { stream: stdout } = writable();

    await runSyncCommand({
      env: envFor(),
      sessionsDbPath: fixture.path,
      homeDir,
      storageAdapter: storage,
      stdout,
    });
    const { stream: stdout2, lines: lines2 } = writable();
    const code = await runSyncCommand({
      env: envFor(),
      sessionsDbPath: fixture.path,
      homeDir,
      storageAdapter: storage,
      force: true,
      stdout: stdout2,
    });
    expect(code).toBe(0);
    expect(lines2.join('')).toContain('[force]');
  });

  it('falls back to resolveCliEnv when no env is explicitly provided', async () => {
    const originalEnv = { ...process.env };
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('SAL_')) delete process.env[key];
    }
    try {
      const { stream: stderr, lines } = writable();
      const code = await runSyncCommand({ cwd: dataDir, stderr });
      expect(code).toBe(1);
      expect(lines.join('')).toContain('required');
    } finally {
      process.env = originalEnv;
    }
  });

  it('reports a per-session failure without aborting the whole sync', async () => {
    fixture = buildFixtureDb({
      sessions: [
        {
          id: 'sess-bad',
          working_directory: '/tmp/proj-bad',
          backend_type: null,
          model: null,
          agent_mode: null,
          created_at: null,
          last_activity_at: null,
          title: null,
          main_chain_id: null,
          cogs_json: null,
          workspace_dirs: null,
          hidden: null,
          metadata: null,
        },
      ],
    });

    // Block transcript materialization by occupying its target path with a
    // file instead of a directory, forcing runDevinSessionSync to throw and
    // exercising syncOneSessionSafely's catch branch.
    const devinDir = path.join(dataDir, 'devin');
    await fsp.mkdir(dataDir, { recursive: true });
    await fsp.writeFile(devinDir, 'blocking file, not a directory');

    const { stream: stdout, lines } = writable();
    const code = await runSyncCommand({
      env: envFor(),
      sessionsDbPath: fixture.path,
      homeDir,
      stdout,
    });
    expect(code).toBe(1);
    expect(lines.join('')).toContain('[fail] session sess-bad');
  });
});
