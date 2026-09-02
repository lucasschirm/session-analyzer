/**
 * Pipeline test: parse (fixture sessions.db) -> extract -> discover ->
 * upload -> manifest, exercised through the plugin's public hook and CLI
 * entry points. Covers the SYNC-catalog user journeys registered for this
 * issue in `docs/superpowers/plans/2026-08-27-e2e-coverage-enhancement.md`
 * §6:
 *
 *   SYNC-006 — hook-triggered sync -> manifest -> artifact set (local CLI session)
 *   SYNC-007 — Stop-hook-only mitigation path (simulated Cloud session: no
 *              SessionStart/SessionEnd, only Stop + bulk `devin-sync sync`)
 *   SYNC-008 — devin-sync sync/list/download/remove/migrate CLI verb smoke pipeline
 */
import * as fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildObjectKey,
  type DeleteObjectsInput,
  type DeleteObjectsResult,
  type GetObjectInput,
  type GetObjectResult,
  type ListObjectsInput,
  type ListObjectsResult,
  type PutObjectInput,
  type PutObjectResult,
  type StorageAdapter,
  sha256Hex,
} from '@lucasschirm/sal-sync';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runDownloadCommand } from '../../src/cli/download-command.js';
import { runListCommand } from '../../src/cli/list-command.js';
import { runMigrateCommand } from '../../src/cli/migrate-command.js';
import { runRemoveCommand } from '../../src/cli/remove-command.js';
import { runSyncCommand } from '../../src/cli/sync-command.js';
import { runHook } from '../../src/hook.js';
import { runSessionEnd } from '../../src/session-end.js';
import { runSessionStart } from '../../src/session-start.js';
import { buildFixtureDb, type FixtureDbHandle } from '../extractor/fixtures/build-fixture-db.js';

class InMemoryStorageAdapter implements StorageAdapter {
  readonly calls: PutObjectInput[] = [];
  private readonly objects = new Map<string, Uint8Array>();

  async putObject(input: PutObjectInput): Promise<PutObjectResult> {
    const key = buildObjectKey(input);
    const sha256 = input.contentSha256 ?? sha256Hex(Buffer.from(input.body).toString('utf8'));
    this.calls.push(input);
    this.objects.set(key, input.body);
    return { key, sha256, etag: `"${sha256}"` };
  }

  async getObject(input: GetObjectInput): Promise<GetObjectResult | undefined> {
    const key = buildObjectKey(input);
    const body = this.objects.get(key);
    return body ? { body } : undefined;
  }

  async listObjects(input: ListObjectsInput): Promise<ListObjectsResult> {
    const prefix = input.sessionId
      ? `${input.projectId}/${input.sessionId}/`
      : input.projectId
        ? `${input.projectId}/`
        : '';
    const objects = [...this.objects.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, body]) => ({ key, size: body.length }));
    return { objects };
  }

  async deleteObjects(input: DeleteObjectsInput): Promise<DeleteObjectsResult> {
    const prefix = input.sessionId
      ? `${input.projectId}/${input.sessionId}/`
      : `${input.projectId}/`;
    const deletedKeys: string[] = [];
    for (const key of [...this.objects.keys()]) {
      if (key.startsWith(prefix)) {
        this.objects.delete(key);
        deletedKeys.push(key);
      }
    }
    return { deletedKeys, errors: [] };
  }

  hasKeyEndingWith(suffix: string): boolean {
    return [...this.objects.keys()].some((k) => k.endsWith(suffix));
  }
}

function envFor(dataDir: string): Record<string, string> {
  return {
    SAL_PROJECT_ID: 'proj-pipeline',
    SAL_STORAGE_TYPE: 's3',
    SAL_STORAGE_BUCKET: 'test-bucket',
    SAL_STORAGE_REGION: 'us-east-1',
    SAL_STORAGE_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
    SAL_STORAGE_SECRET_ACCESS_KEY: 'secret',
    SAL_DATA_DIR: dataDir,
  };
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

describe('Devin sync pipeline: sessions.db -> manifest -> artifact set', () => {
  let dataDir: string;
  let homeDir: string;
  let fixture: FixtureDbHandle;

  beforeEach(async () => {
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'devin-pipeline-data-'));
    homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'devin-pipeline-home-'));
    fixture = buildFixtureDb({
      sessions: [
        {
          id: 'sess-local',
          working_directory: '/tmp/local-project',
          backend_type: 'anthropic',
          model: 'devin-1',
          agent_mode: 'default',
          created_at: 100,
          last_activity_at: 200,
          title: 'Local CLI session',
          main_chain_id: null,
          cogs_json: null,
          workspace_dirs: null,
          hidden: 0,
          metadata: null,
        },
      ],
      messageNodes: [
        {
          row_id: 1,
          session_id: 'sess-local',
          node_id: 1,
          parent_node_id: null,
          chat_message: 'hello from Devin',
          created_at: 200,
          metadata: null,
        },
      ],
    });
  });

  afterEach(async () => {
    fixture.close();
    await fsp.rm(dataDir, { recursive: true, force: true });
    await fsp.rm(homeDir, { recursive: true, force: true });
  });

  it('SYNC-006: SessionStart -> Stop -> SessionEnd hook chain produces a manifest with the expected artifact set', async () => {
    const storage = new InMemoryStorageAdapter();
    const hookInput = {
      session_id: 'sess-local',
      cwd: '/tmp/local-project',
      hook_event_name: 'SessionStart',
    };

    const startExit = await runSessionStart(hookInput, {
      env: envFor(dataDir),
      storageAdapter: storage,
      sessionsDbPath: fixture.path,
      homeDir,
    });
    expect(startExit).toBe(0);

    const stopExit = await runHook(
      { ...hookInput, hook_event_name: 'Stop' },
      { env: envFor(dataDir), storageAdapter: storage, sessionsDbPath: fixture.path, homeDir },
    );
    expect(stopExit).toBe(0);

    const endExit = await runSessionEnd(
      { ...hookInput, hook_event_name: 'SessionEnd', reason: 'completed' },
      { env: envFor(dataDir), storageAdapter: storage, sessionsDbPath: fixture.path, homeDir },
    );
    expect(endExit).toBe(0);

    expect(storage.hasKeyEndingWith('manifest.json')).toBe(true);
    expect(storage.hasKeyEndingWith('transcript.jsonl')).toBe(true);
    expect(storage.hasKeyEndingWith('native/schema-descriptor.json')).toBe(true);

    const manifestKey = [...storage.calls]
      .reverse()
      .find((c) => c.scope === 'manifest')?.relativePath;
    expect(manifestKey).toBe('manifest.json');
  });

  it('SYNC-007: Stop-hook-only mitigation completes sync when SessionStart/SessionEnd never fire (simulated Devin Cloud gap)', async () => {
    const storage = new InMemoryStorageAdapter();
    // No SessionStart/SessionEnd call at all — only Stop, matching the
    // verified Cloud-session caveat (Part A3).
    const stopExit = await runHook(
      { session_id: 'sess-local', cwd: '/tmp/local-project', hook_event_name: 'Stop' },
      { env: envFor(dataDir), storageAdapter: storage, sessionsDbPath: fixture.path, homeDir },
    );
    expect(stopExit).toBe(0);
    expect(storage.hasKeyEndingWith('transcript.jsonl')).toBe(true);
    expect(storage.hasKeyEndingWith('manifest.json')).toBe(true);

    // The bulk `devin-sync sync` catch-up path must also independently
    // complete the session (e.g. run on a schedule to catch anything Stop
    // missed), never relying on SessionEnd having fired.
    const { stream: stdout } = writable();
    const syncCode = await runSyncCommand({
      env: envFor(dataDir),
      sessionsDbPath: fixture.path,
      homeDir,
      storageAdapter: storage,
      stdout,
    });
    expect(syncCode).toBe(0);
  });

  it('SYNC-008: devin-sync sync/list/download/remove/migrate CLI verb smoke pipeline', async () => {
    const storage = new InMemoryStorageAdapter();
    const env = envFor(dataDir);

    const syncCode = await runSyncCommand({
      env,
      sessionsDbPath: fixture.path,
      homeDir,
      storageAdapter: storage,
    });
    expect(syncCode).toBe(0);

    const { stream: listStdout, lines: listLines } = writable();
    const listCode = await runListCommand(['proj-pipeline'], {
      env,
      storageAdapter: storage,
      stdout: listStdout,
    });
    expect(listCode).toBe(0);
    expect(listLines.join('')).toContain('sess-local');

    const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'devin-pipeline-download-'));
    try {
      const downloadCode = await runDownloadCommand(
        ['--session-id=sess-local', `--output=${outputDir}`],
        {
          env,
          storageAdapter: storage,
        },
      );
      expect(downloadCode).toBe(0);
      const manifest = await fsp.readFile(
        path.join(outputDir, 'proj-pipeline', 'sess-local', 'manifest.json'),
        'utf8',
      );
      expect(JSON.parse(manifest).harness).toBe('devin');
    } finally {
      await fsp.rm(outputDir, { recursive: true, force: true });
    }

    const { stream: migrateStdout, lines: migrateLines } = writable();
    const migrateCode = await runMigrateCommand([], {
      env,
      storageAdapter: storage,
      stdout: migrateStdout,
    });
    expect(migrateCode).toBe(0);
    expect(migrateLines.join('')).toContain('Nothing to migrate');

    const { stream: removeStdout } = writable();
    const removeCode = await runRemoveCommand(['proj-pipeline', '--yes'], {
      env,
      storageAdapter: storage,
      stdout: removeStdout,
    });
    expect(removeCode).toBe(0);

    const { stream: listAfterStdout, lines: listAfterLines } = writable();
    await runListCommand(['proj-pipeline'], {
      env,
      storageAdapter: storage,
      stdout: listAfterStdout,
    });
    expect(listAfterLines.join('')).toContain('No sessions found');
  });
});
