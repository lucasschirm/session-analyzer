/**
 * Pipeline test: the mandatory watcher daemon's (`bin/watcher`) actual poll
 * loop, driven against a changing fixture `sessions.db`. Covers the
 * SYNC-catalog entry registered for issue #326 in
 * `docs/superpowers/plans/2026-08-27-e2e-coverage-enhancement.md` §6:
 *
 *   SYNC-011 — watcher heartbeat advances (monotonic, timestamped,
 *              distinct poll lines in a bounded window, per
 *              `.agents/rules/sync-progress-observability.md`), a
 *              mid-run `sessions.db` change triggers a re-sync, and a
 *              poll failure after startup (unreadable `sessions.db`)
 *              surfaces per-poll stderr failure lines — never a silent
 *              stall and never a false-success heartbeat.
 *
 * Issue #340 (signature trusted `last_activity_at` for the `sessions` row
 * component, missing skill-only/effort-only mutations) is fixed — the
 * heartbeat/re-sync and startup-failure assertions above use a new
 * `message_nodes` row as their re-sync trigger (a row-id watermark,
 * orthogonal to #340), and the dedicated `cogs_json`-only mutation
 * regression below covers #340's own trigger directly.
 * Issue #339 (success signature advancing despite per-session
 * `outcome.errors`, e.g. a failed manifest upload) is fixed and covered
 * directly below by a dedicated fail→retry→stable regression sequence.
 */
import { rmSync } from 'node:fs';
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

import { createDevinHarnessProfile } from '../../src/devin-profile.js';
import { captureDevinModels } from '../../src/models/capture.js';
import { runDevinWatcher } from '../../src/watcher.js';
import { buildFixtureDb, type FixtureDbHandle } from '../extractor/fixtures/build-fixture-db.js';
import { devinModelsListFixture } from '../models/fixture.js';

class RecordingStorageAdapter implements StorageAdapter {
  readonly calls: PutObjectInput[] = [];

  async putObject(input: PutObjectInput): Promise<PutObjectResult> {
    const key = buildObjectKey(input);
    const sha256 = input.contentSha256 ?? sha256Hex(Buffer.from(input.body).toString('utf8'));
    this.calls.push(input);
    return { key, sha256, etag: `"${sha256}"` };
  }
}

/**
 * Fails only the manifest `putObject` call (`scope: 'manifest'`, unique to
 * the one manifest.json upload per sync, per `session-sync.test.ts`'s own
 * manifest-failure fixture) while `failManifest` is `true`, succeeding
 * normally (mirroring `RecordingStorageAdapter`) otherwise. Toggling
 * `failManifest` between polls simulates a transient manifest-upload
 * failure clearing — the #339 regression scenario.
 */
class ManifestFlakyStorageAdapter implements StorageAdapter {
  readonly calls: PutObjectInput[] = [];
  failManifest = true;

  async putObject(input: PutObjectInput): Promise<PutObjectResult> {
    this.calls.push(input);
    if (input.scope === 'manifest' && this.failManifest) {
      throw new Error('manifest upload failed');
    }
    const key = buildObjectKey(input);
    const sha256 = input.contentSha256 ?? sha256Hex(Buffer.from(input.body).toString('utf8'));
    return { key, sha256, etag: `"${sha256}"` };
  }
}

/** One parsed watcher heartbeat (per-poll summary) line. */
interface WatcherHeartbeat {
  at: number;
  poll: number;
  checked: number;
  changed: number;
  failed: number;
}

const HEARTBEAT_PATTERN =
  /^(\S+) devin-watcher: poll #(\d+): (\d+) session\(s\) checked, (\d+) changed, (\d+) failed$/;

/**
 * Parses the watcher's per-poll summary lines — the daemon's heartbeat
 * signal — out of the raw stdout stream (the pipeline-side counterpart
 * of the browser `assertHeartbeat` helper, per catalog §7.3).
 */
function parseWatcherHeartbeats(lines: string[]): WatcherHeartbeat[] {
  const beats: WatcherHeartbeat[] = [];
  for (const line of lines) {
    const match = HEARTBEAT_PATTERN.exec(line.trimEnd());
    if (!match) continue;
    beats.push({
      at: Date.parse(match[1]),
      poll: Number(match[2]),
      checked: Number(match[3]),
      changed: Number(match[4]),
      failed: Number(match[5]),
    });
  }
  return beats;
}

function assertMonotonicHeartbeats(beats: WatcherHeartbeat[], expectedPolls: number[]): void {
  // Advancing + distinct: the poll counter strictly increases per beat.
  expect(beats.map((b) => b.poll)).toEqual(expectedPolls);
  // Timestamped + monotonic: every beat carries a parseable timestamp and
  // they never go backwards.
  for (const [index, beat] of beats.entries()) {
    expect(Number.isNaN(beat.at), `heartbeat #${beat.poll} has no parseable timestamp`).toBe(false);
    if (index > 0) expect(beat.at).toBeGreaterThanOrEqual(beats[index - 1].at);
  }
}

function collectingStream(lines: string[], onLine?: (line: string) => void): NodeJS.WritableStream {
  return {
    write: (chunk: string) => {
      lines.push(chunk);
      onLine?.(chunk);
      return true;
    },
  } as NodeJS.WritableStream;
}

function watcherEnv(): Record<string, string> {
  return {
    SAL_PROJECT_ID: 'proj-watcher-pipeline',
    SAL_STORAGE_TYPE: 's3',
    SAL_STORAGE_BUCKET: 'test-bucket',
    SAL_STORAGE_REGION: 'us-east-1',
    SAL_STORAGE_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
    SAL_STORAGE_SECRET_ACCESS_KEY: 'secret',
  };
}

const harnessProfile = createDevinHarnessProfile('v1');

const HEARTBEAT_WINDOW_MS = 5000;

describe('Devin watcher daemon poll loop: heartbeat + failure visibility (SYNC-011)', () => {
  let fixture: FixtureDbHandle;
  let dataDir: string;
  let homeDir: string;

  beforeEach(async () => {
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'devin-watcher-pipeline-data-'));
    homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'devin-watcher-pipeline-home-'));
    // Pre-warm the models cache so the watcher's per-poll capture is a cache
    // hit — the real `devin` binary is never invoked by this test.
    await captureDevinModels({
      dataDir,
      devinCliVersion: harnessProfile.harnessVersion,
      runModelsList: async () => devinModelsListFixture,
    });
    fixture = buildFixtureDb({
      sessions: [
        {
          id: 'sess-cloud',
          working_directory: '/tmp/cloud-project',
          backend_type: null,
          model: null,
          agent_mode: null,
          created_at: 100,
          last_activity_at: 100,
          title: 'Cloud session',
          main_chain_id: null,
          cogs_json: null,
          workspace_dirs: null,
          hidden: null,
          metadata: null,
        },
      ],
      messageNodes: [
        {
          row_id: 1,
          session_id: 'sess-cloud',
          node_id: 1,
          parent_node_id: null,
          chat_message: 'first message',
          created_at: 100,
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

  /** Appends a new `message_nodes` row — a row-id watermark advance. */
  function appendMessageNode(nodeId: number, message: string): void {
    fixture.db
      .prepare(
        `INSERT INTO message_nodes
         (session_id, node_id, parent_node_id, chat_message, created_at, metadata)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run('sess-cloud', nodeId, null, message, 200, null);
  }

  /** Makes `sessions.db` unreadable for every subsequent poll. */
  function removeSessionsDb(): void {
    for (const suffix of ['', '-wal', '-shm']) {
      rmSync(`${fixture.path}${suffix}`, { force: true });
    }
  }

  function onHeartbeat(poll: number, action: () => void): (line: string) => void {
    const marker = ` devin-watcher: poll #${poll}: `;
    return (line) => {
      if (line.includes(marker)) action();
    };
  }

  it('emits an advancing, timestamped, monotonic heartbeat and re-syncs when sessions.db changes mid-run', async () => {
    const storage = new RecordingStorageAdapter();
    const stdoutLines: string[] = [];
    // Deterministic mid-run mutation: as soon as poll #1's heartbeat is
    // written (before the inter-poll delay), the fixture db gains a row, so
    // poll #2 must detect the watermark change and re-sync; poll #3 sees an
    // unchanged db and must not.
    const stdout = collectingStream(
      stdoutLines,
      onHeartbeat(1, () => appendMessageNode(2, 'cloud activity between polls')),
    );

    const startedAt = Date.now();
    const exitCode = await runDevinWatcher({
      env: watcherEnv(),
      dataDir,
      homeDir,
      sessionsDbPath: fixture.path,
      storageAdapter: storage,
      profile: harnessProfile,
      maxPolls: 3,
      pollIntervalMs: 5,
      stdout,
    });
    const elapsedMs = Date.now() - startedAt;

    expect(exitCode).toBe(0);
    const beats = parseWatcherHeartbeats(stdoutLines);
    assertMonotonicHeartbeats(beats, [1, 2, 3]);
    // Distinct values within a bounded window, per sync-progress-observability.
    expect(elapsedMs).toBeLessThan(HEARTBEAT_WINDOW_MS);
    // Poll #1 syncs the never-seen session, poll #2 re-syncs the mutated one,
    // poll #3 (unchanged db) syncs nothing.
    expect(beats.map((b) => b.changed)).toEqual([1, 1, 0]);
    expect(beats.map((b) => b.failed)).toEqual([0, 0, 0]);
    expect(storage.calls.filter((c) => c.scope === 'manifest')).toHaveLength(2);
  }, 15000);

  it('surfaces a per-poll stderr failure line when sessions.db becomes unreadable — never a silent stall or a false-success heartbeat', async () => {
    const storage = new RecordingStorageAdapter();
    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];
    // After poll #1's heartbeat, every later snapshot read fails.
    const stdout = collectingStream(stdoutLines, onHeartbeat(1, removeSessionsDb));
    const stderr = collectingStream(stderrLines);

    const exitCode = await runDevinWatcher({
      env: watcherEnv(),
      dataDir,
      homeDir,
      sessionsDbPath: fixture.path,
      storageAdapter: storage,
      profile: harnessProfile,
      maxPolls: 3,
      pollIntervalMs: 5,
      stdout,
      stderr,
    });

    // Documented contract: a per-poll failure is reported but only a startup
    // configuration error is fatal to the daemon.
    expect(exitCode).toBe(0);
    // Every stalled poll re-signals on stderr, naming the poll and the cause
    // — the stall is continuously observable, not a one-shot warning.
    const stderrText = stderrLines.join('');
    expect(stderrText).toContain('devin-watcher: poll #2 failed:');
    expect(stderrText).toContain('devin-watcher: poll #3 failed:');
    expect(stderrText, 'failure line does not name the unreadable sessions.db').toContain(
      fixture.path,
    );
    // The heartbeat must never report a failed poll as a success: only
    // poll #1 (which completed) emits a summary line.
    const beats = parseWatcherHeartbeats(stdoutLines);
    assertMonotonicHeartbeats(beats, [1]);
    expect(storage.calls.filter((c) => c.scope === 'manifest')).toHaveLength(1);
  }, 15000);

  it('withholds the signature on a manifest-upload failure, retries next poll, and stabilizes once cleared (#339)', async () => {
    const storage = new ManifestFlakyStorageAdapter();
    const stdoutLines: string[] = [];
    // The manifest upload fails on poll #1. As soon as poll #1's heartbeat
    // is written, clear the failure so poll #2's retry of the very same
    // (still un-stored) session succeeds.
    const stdout = collectingStream(
      stdoutLines,
      onHeartbeat(1, () => {
        storage.failManifest = false;
      }),
    );

    const exitCode = await runDevinWatcher({
      env: watcherEnv(),
      dataDir,
      homeDir,
      sessionsDbPath: fixture.path,
      storageAdapter: storage,
      profile: harnessProfile,
      maxPolls: 3,
      pollIntervalMs: 5,
      stdout,
    });

    expect(exitCode).toBe(0);
    const beats = parseWatcherHeartbeats(stdoutLines);
    assertMonotonicHeartbeats(beats, [1, 2, 3]);
    // Poll 1: the manifest upload fails (`outcome.errors` non-empty even
    // though `outcome.failed === 0`) — the signature must be withheld, not
    // advanced past a false success.
    // Poll 2: the signature was never stored, so the unchanged session is
    // seen as still-changed and retried — this time the manifest upload
    // succeeds, so the signature is finally stored.
    // Poll 3: the now-stored signature matches — stable, no re-sync.
    expect(beats.map((b) => b.changed)).toEqual([1, 1, 0]);
    expect(beats.map((b) => b.failed)).toEqual([1, 0, 0]);
    // Exactly 2 manifest attempts total (poll 1's failed attempt + poll 2's
    // successful retry) — a 3rd would mean poll 3 wrongly re-synced a
    // session whose signature had already stabilized.
    expect(storage.calls.filter((c) => c.scope === 'manifest')).toHaveLength(2);
    // The failure must be visible in the watcher's own stdout output, not
    // just in telemetry/outcome.errors — per the issue's acceptance
    // criteria and `.agents/rules/sync-progress-observability.md`.
    expect(stdoutLines.join('')).toContain('1 error(s)');
  }, 15000);

  it('re-syncs a session whose only change between polls is cogs_json — last_activity_at and row counts unchanged (#340)', async () => {
    const storage = new RecordingStorageAdapter();
    const stdoutLines: string[] = [];
    // last_activity_at and every row-id watermark are untouched by this
    // mutation — only the signature's session-row content hash can detect
    // it (#340's exact regression scenario).
    const stdout = collectingStream(
      stdoutLines,
      onHeartbeat(1, () => {
        fixture.db
          .prepare('UPDATE sessions SET cogs_json = ? WHERE id = ?')
          .run('{"skill":"changed-between-polls"}', 'sess-cloud');
      }),
    );

    const exitCode = await runDevinWatcher({
      env: watcherEnv(),
      dataDir,
      homeDir,
      sessionsDbPath: fixture.path,
      storageAdapter: storage,
      profile: harnessProfile,
      maxPolls: 3,
      pollIntervalMs: 5,
      stdout,
    });

    expect(exitCode).toBe(0);
    const beats = parseWatcherHeartbeats(stdoutLines);
    assertMonotonicHeartbeats(beats, [1, 2, 3]);
    // Poll 1 syncs the never-seen session; poll 2 re-syncs after the
    // cogs_json-only mutation (no new row anywhere, last_activity_at
    // untouched); poll 3 (unchanged again) syncs nothing.
    expect(beats.map((b) => b.changed)).toEqual([1, 1, 0]);
    expect(storage.calls.filter((c) => c.scope === 'manifest')).toHaveLength(2);
  }, 15000);
});
