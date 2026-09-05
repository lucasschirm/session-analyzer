import { Buffer } from 'node:buffer';
import process from 'node:process';

import {
  buildObjectKey,
  DEFAULT_PLUGIN_VERSION,
  MANIFEST_SCHEMA_VERSION,
  type ManifestArtifact,
  parseObjectKey,
  type StorageAdapter,
  SYNC_VERSION,
  UNKNOWN_HARNESS_VERSION,
} from '@lucasschirm/sal-sync-core';
// NOTE: `sha256Hex` here is this package's own SYNCHRONOUS implementation
// (`../../hashing/sha256.js`) — deliberately NOT the isomorphic ASYNC
// `sha256Hex` also exported by `@lucasschirm/sal-sync-core` (see
// `packages/sync/src/index.ts`'s doc comment on why the two are never
// re-exported through the same name). The pre-hoist plugins imported this
// sync version via the `@lucasschirm/sal-sync` barrel; importing from
// `@lucasschirm/sal-sync-core` directly here would silently pick up the
// wrong (async, `Promise<string>`) one.
import { sha256Hex } from '../../hashing/index.js';
import { buildStorageAdapterFromStorage } from '../common.js';
import { validateStorageConfig } from '../config.js';
import { resolveCliEnv } from '../env.js';
import type { CliHarnessAdapter } from '../harness-adapter.js';

export interface MigrateCommandOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  storageAdapter?: StorageAdapter;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}

export interface MigrateArgs {
  projectId?: string;
  confirmed: boolean;
  deleteOld: boolean;
  manifests: boolean;
}

export type MigrateArgsResult = MigrateArgs | { error: string };

/**
 * Parse `migrate [options]` arguments.
 *
 * Accepted forms:
 *   migrate                                  Dry run: list old-format keys and missing manifests
 *   migrate --project=<project-id>           Dry run for a specific project
 *   migrate --yes                            Copy old keys to new format + generate missing manifests
 *   migrate --yes --delete-old              Copy and warn about old keys to delete manually
 *   migrate --manifests                     Dry run: only list sessions missing manifests
 *   migrate --yes --manifests               Only generate missing manifests (no key migration)
 *
 * Harness-agnostic — no `CliHarnessAdapter` needed.
 */
export function parseMigrateArgs(argv: string[]): MigrateArgsResult {
  let projectId: string | undefined;
  let confirmed = false;
  let deleteOld = false;
  let manifests = false;

  for (const arg of argv) {
    if (!arg) continue;

    if (arg === '--yes' || arg === '-y') {
      confirmed = true;
      continue;
    }
    if (arg === '--delete-old') {
      deleteOld = true;
      continue;
    }
    if (arg === '--manifests') {
      manifests = true;
      continue;
    }
    if (arg.startsWith('--project=')) {
      projectId = arg.slice('--project='.length);
      continue;
    }
    if (arg.startsWith('-')) {
      return { error: `Error: unknown option ${arg}.` };
    }
    return { error: `Error: unexpected argument ${arg}.` };
  }

  return { projectId, confirmed, deleteOld, manifests };
}

async function buildAdapter(
  adapter: CliHarnessAdapter,
  options: MigrateCommandOptions,
  cwd: string,
): Promise<StorageAdapter | { errorMessage: string }> {
  if (options.storageAdapter) return options.storageAdapter;

  const env = options.env ?? (await resolveCliEnv(adapter, cwd));
  const validation = validateStorageConfig(adapter, env);
  if (!validation.ok) {
    return { errorMessage: validation.errorMessage ?? 'Configuration error.' };
  }
  return buildStorageAdapterFromStorage(validation.storage, { retries: validation.retries });
}

interface OldFormatKey {
  oldKey: string;
  newKey: string;
  projectId: string;
  sessionId: string;
  relativePath: string;
  size: number;
}

interface SessionScan {
  projectId: string;
  sessionId: string;
  hasManifest: boolean;
  objects: {
    key: string;
    size: number;
    scope: 'session' | 'manifest' | 'other';
    relativePath: string;
  }[];
}

/**
 * List all objects and build a per-session view, detecting old-format keys
 * (with a `session/` segment) and sessions missing manifests.
 */
async function scanBucket(
  adapter: StorageAdapter,
  projectIdFilter?: string,
): Promise<{ oldKeys: OldFormatKey[]; sessions: Map<string, SessionScan> }> {
  if (!adapter.listObjects) return { oldKeys: [], sessions: new Map() };

  const result = await adapter.listObjects({ projectId: projectIdFilter ?? '', sessionId: '' });

  const oldKeys: OldFormatKey[] = [];
  const sessions = new Map<string, SessionScan>();

  for (const obj of result.objects) {
    const parsed = parseObjectKey(obj.key);
    if (!parsed?.projectId || !parsed.sessionId) continue;

    const sessionKey = `${parsed.projectId}/${parsed.sessionId}`;
    if (!sessions.has(sessionKey)) {
      sessions.set(sessionKey, {
        projectId: parsed.projectId,
        sessionId: parsed.sessionId,
        hasManifest: false,
        objects: [],
      });
    }
    const session = sessions.get(sessionKey) as SessionScan;

    const isManifest = parsed.scope === 'manifest';
    if (isManifest) session.hasManifest = true;

    session.objects.push({
      key: obj.key,
      size: obj.size ?? 0,
      scope: isManifest ? 'manifest' : parsed.scope === 'session' ? 'session' : 'other',
      relativePath: parsed.relativePath,
    });

    // Detect old-format keys: session scope with `/session/` in the key.
    if (parsed.scope === 'session' && obj.key.includes('/session/')) {
      const newKey = `${parsed.projectId}/${parsed.sessionId}/${parsed.relativePath}`;
      if (newKey !== obj.key) {
        oldKeys.push({
          oldKey: obj.key,
          newKey,
          projectId: parsed.projectId,
          sessionId: parsed.sessionId,
          relativePath: parsed.relativePath,
          size: obj.size ?? 0,
        });
      }
    }
  }

  return { oldKeys, sessions };
}

function sessionsMissingManifests(sessions: Map<string, SessionScan>): SessionScan[] {
  return [...sessions.values()].filter(
    (s) => !s.hasManifest && s.objects.some((o) => o.scope === 'session'),
  );
}

async function dryRunPreview(
  oldKeys: OldFormatKey[],
  missingManifests: SessionScan[],
  stdout: NodeJS.WritableStream,
): Promise<number> {
  const hasWork = oldKeys.length > 0 || missingManifests.length > 0;

  if (!hasWork) {
    stdout.write('No old-format keys or missing manifests found. Nothing to migrate.\n');
    return 0;
  }

  if (oldKeys.length > 0) {
    const projects = new Set(oldKeys.map((k) => k.projectId));
    stdout.write(`Found ${oldKeys.length} old-format key(s) across ${projects.size} project(s):\n`);
    for (const proj of projects) {
      stdout.write(`  ${proj}: ${oldKeys.filter((k) => k.projectId === proj).length} key(s)\n`);
    }
    stdout.write('\nSample keys (up to 20):\n');
    for (const k of oldKeys.slice(0, 20)) {
      stdout.write(`  ${k.oldKey}\n    -> ${k.newKey}\n`);
    }
    if (oldKeys.length > 20) {
      stdout.write(`  ... and ${oldKeys.length - 20} more\n`);
    }
    stdout.write('\n');
  }

  if (missingManifests.length > 0) {
    const projects = new Set(missingManifests.map((s) => s.projectId));
    stdout.write(
      `Found ${missingManifests.length} session(s) missing manifests across ${projects.size} project(s):\n`,
    );
    for (const proj of projects) {
      stdout.write(
        `  ${proj}: ${missingManifests.filter((s) => s.projectId === proj).length} session(s)\n`,
      );
    }
    stdout.write('\n');
  }

  stdout.write('Pass --yes to copy old keys and generate missing manifests.\n');
  stdout.write('Pass --yes --manifests to only generate manifests (skip key migration).\n');
  stdout.write('Pass --yes --delete-old to also warn about old keys to delete manually.\n');
  return 0;
}

async function copyOldKeys(
  adapter: StorageAdapter,
  oldKeys: OldFormatKey[],
  stdout: NodeJS.WritableStream,
): Promise<{ copied: number; skipped: number; failed: number }> {
  if (!adapter.getObject || !adapter.putObject) {
    return { copied: 0, skipped: 0, failed: oldKeys.length };
  }

  let copied = 0;
  let skipped = 0;
  let failed = 0;

  for (const keyInfo of oldKeys) {
    try {
      if (adapter.headObject) {
        const head = await adapter.headObject({
          projectId: keyInfo.projectId,
          sessionId: keyInfo.sessionId,
          scope: 'session',
          relativePath: keyInfo.relativePath,
        });
        if (head) {
          skipped++;
          continue;
        }
      }

      // Download the old object. The old key format is
      // `<projectId>/<sessionId>/session/<relativePath>`. Since
      // `buildObjectKey` omits the `session/` segment for session scope,
      // passing `relativePath: 'session/<relativePath>'` produces the old
      // key — the `session/` becomes part of the relativePath rather than
      // a scope segment.
      const oldObj = await adapter.getObject({
        projectId: keyInfo.projectId,
        sessionId: keyInfo.sessionId,
        scope: 'session',
        relativePath: `session/${keyInfo.relativePath}`,
      });
      if (!oldObj) {
        skipped++;
        continue;
      }

      await adapter.putObject({
        projectId: keyInfo.projectId,
        sessionId: keyInfo.sessionId,
        scope: 'session',
        relativePath: keyInfo.relativePath,
        body: oldObj.body,
        contentType: oldObj.contentType,
      });
      copied++;
      stdout.write(`[ok]   ${keyInfo.oldKey} -> ${keyInfo.newKey}\n`);
    } catch (err) {
      failed++;
      const message = err instanceof Error ? err.message : String(err);
      stdout.write(`[fail] ${keyInfo.oldKey} — ${message}\n`);
    }
  }

  return { copied, skipped, failed };
}

/**
 * Backfills a manifest for a legacy session with no other harness metadata
 * available.
 *
 * `harness` comes from `adapter.migrateManifestHarness` — NEVER
 * `adapter.profile.harness`. The two are deliberately independent per
 * harness (see `CliHarnessAdapter.migrateManifestHarness`'s doc comment):
 * Claude's adapter hardcodes the literal `'claude-code'` because
 * `packages/db`'s `classifyManifestArtifact` exact-string-matches that
 * literal (NOT `profile.harness`, which is `'claude'`) to run Claude-specific
 * classification; Devin's adapter correctly sources this from
 * `profile.harness` (`'devin'`), the DS-B5 #143 pattern. A hoist that
 * "cleans up" this asymmetry by deriving both from `profile.harness` would
 * silently degrade every migrated Claude session's artifacts to
 * `unclassified` — see
 * `packages/sync/tests/unit/cli/commands/migrate-command.test.ts`'s
 * `migrateManifestHarness` assertions, and each plugin's own
 * `migrate-command.test.ts`, for the regression this must never reintroduce.
 *
 * `UNKNOWN_HARNESS_VERSION` is the correct sentinel for `harnessVersion`
 * here (never a literal), since the original version genuinely cannot be
 * recovered for an orphaned session.
 */
function buildManifestForSession(
  adapter: CliHarnessAdapter,
  session: SessionScan,
  artifacts: ManifestArtifact[],
): unknown {
  const mainTranscript = artifacts.find(
    (a) => a.scope === 'session' && a.relativePath === 'transcript.jsonl',
  );
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    projectId: session.projectId,
    sessionId: session.sessionId,
    harness: adapter.migrateManifestHarness,
    harnessVersion: UNKNOWN_HARNESS_VERSION,
    syncVersion: SYNC_VERSION,
    pluginVersion: DEFAULT_PLUGIN_VERSION,
    transcriptsCaptured: true,
    mainTranscriptRelativePath: mainTranscript?.relativePath,
    artifacts,
    syncRuns: [],
  };
}

async function downloadSessionArtifactBody(
  adapter: StorageAdapter,
  session: SessionScan,
  relativePath: string,
): Promise<Uint8Array | undefined> {
  if (!adapter.getObject) return undefined;
  const newObj = await adapter.getObject({
    projectId: session.projectId,
    sessionId: session.sessionId,
    scope: 'session',
    relativePath,
  });
  if (newObj) return newObj.body;
  // Try old format (with session/ prefix in relativePath) — the key
  // migration should have already run if --manifests wasn't passed alone.
  const oldObj = await adapter.getObject({
    projectId: session.projectId,
    sessionId: session.sessionId,
    scope: 'session',
    relativePath: `session/${relativePath}`,
  });
  return oldObj?.body;
}

async function buildSessionManifestArtifacts(
  adapter: StorageAdapter,
  session: SessionScan,
  stdout: NodeJS.WritableStream,
): Promise<{ artifacts: ManifestArtifact[]; skipped: number }> {
  const artifacts: ManifestArtifact[] = [];
  let skipped = 0;
  for (const obj of session.objects) {
    if (obj.scope !== 'session') continue;
    const body = await downloadSessionArtifactBody(adapter, session, obj.relativePath);
    if (!body) {
      skipped++;
      stdout.write(
        `[skip] ${session.projectId}/${session.sessionId}/${obj.relativePath} — could not download\n`,
      );
      continue;
    }
    artifacts.push({
      projectId: session.projectId,
      sessionId: session.sessionId,
      scope: 'session',
      relativePath: obj.relativePath,
      sha256: sha256Hex(body),
      size: body.byteLength,
      status: 'uploaded',
    });
  }
  return { artifacts, skipped };
}

async function generateManifests(
  cliAdapter: CliHarnessAdapter,
  storageAdapter: StorageAdapter,
  sessions: SessionScan[],
  stdout: NodeJS.WritableStream,
): Promise<{ generated: number; skipped: number; failed: number }> {
  let generated = 0;
  let skipped = 0;
  let failed = 0;

  for (const session of sessions) {
    try {
      const { artifacts, skipped: artifactsSkipped } = await buildSessionManifestArtifacts(
        storageAdapter,
        session,
        stdout,
      );
      skipped += artifactsSkipped;
      if (artifacts.length === 0) {
        skipped++;
        stdout.write(`[skip] ${session.projectId}/${session.sessionId} — no session artifacts\n`);
        continue;
      }

      const manifestJson = JSON.stringify(buildManifestForSession(cliAdapter, session, artifacts));
      const manifestBytes = Buffer.from(manifestJson, 'utf8');
      await storageAdapter.putObject({
        projectId: session.projectId,
        sessionId: session.sessionId,
        scope: 'manifest',
        relativePath: 'manifest.json',
        body: manifestBytes,
        contentType: 'application/json',
        contentSha256: sha256Hex(manifestJson),
      });
      generated++;
      const manifestKey = buildObjectKey({
        projectId: session.projectId,
        sessionId: session.sessionId,
        scope: 'manifest',
        relativePath: 'manifest.json',
      });
      stdout.write(`[ok]   manifest -> ${manifestKey}\n`);
    } catch (err) {
      failed++;
      const message = err instanceof Error ? err.message : String(err);
      stdout.write(`[fail] manifest for ${session.projectId}/${session.sessionId} — ${message}\n`);
    }
  }

  return { generated, skipped, failed };
}

interface MigrationCounts {
  copied: number;
  skippedKeys: number;
  failedKeys: number;
  generated: number;
  skippedManifests: number;
  failedManifests: number;
}

/**
 * Write the final `Migration complete: ...` summary line (and, if
 * `--delete-old` was passed, the manual-cleanup reminder) for a completed
 * `performMigration` run. Split out of `performMigration` to keep both
 * functions under `.agents/rules/workspace-rules.md`'s 20/30-line function
 * cap.
 */
function reportMigrationSummary(
  args: MigrateArgs,
  counts: MigrationCounts,
  stdout: NodeJS.WritableStream,
): void {
  stdout.write('\n');
  const parts: string[] = [];
  if (!args.manifests) {
    parts.push(`${counts.copied} keys copied`);
    if (counts.skippedKeys > 0) parts.push(`${counts.skippedKeys} keys skipped`);
    if (counts.failedKeys > 0) parts.push(`${counts.failedKeys} keys failed`);
  }
  parts.push(`${counts.generated} manifests generated`);
  if (counts.skippedManifests > 0) parts.push(`${counts.skippedManifests} manifests skipped`);
  if (counts.failedManifests > 0) parts.push(`${counts.failedManifests} manifests failed`);
  stdout.write(`Migration complete: ${parts.join(', ')}.\n`);

  if (args.deleteOld) {
    stdout.write('\nNote: old keys were not deleted. Please verify the migrated data and\n');
    stdout.write('delete old keys manually if no longer needed.\n');
  }
}

/**
 * Run the two migration steps (copy old-format keys, generate missing
 * manifests) and tally the results. Split out of `performMigration` to keep
 * both functions under `.agents/rules/workspace-rules.md`'s 20/30-line
 * function cap — the caller still owns the getObject/putObject precondition
 * check, the summary report, and the exit-code decision.
 */
async function runMigrationSteps(
  cliAdapter: CliHarnessAdapter,
  storageAdapter: StorageAdapter,
  args: MigrateArgs,
  oldKeys: OldFormatKey[],
  missingManifests: SessionScan[],
  stdout: NodeJS.WritableStream,
): Promise<MigrationCounts> {
  const counts: MigrationCounts = {
    copied: 0,
    skippedKeys: 0,
    failedKeys: 0,
    generated: 0,
    skippedManifests: 0,
    failedManifests: 0,
  };

  if (!args.manifests && oldKeys.length > 0) {
    stdout.write(`\n=== Copying ${oldKeys.length} old-format key(s) ===\n`);
    const result = await copyOldKeys(storageAdapter, oldKeys, stdout);
    counts.copied = result.copied;
    counts.skippedKeys = result.skipped;
    counts.failedKeys = result.failed;
  }

  if (missingManifests.length > 0) {
    stdout.write(`\n=== Generating ${missingManifests.length} missing manifest(s) ===\n`);
    const result = await generateManifests(cliAdapter, storageAdapter, missingManifests, stdout);
    counts.generated = result.generated;
    counts.skippedManifests = result.skipped;
    counts.failedManifests = result.failed;
  }

  return counts;
}

async function performMigration(
  cliAdapter: CliHarnessAdapter,
  storageAdapter: StorageAdapter,
  args: MigrateArgs,
  oldKeys: OldFormatKey[],
  missingManifests: SessionScan[],
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
): Promise<number> {
  if (!storageAdapter.getObject || !storageAdapter.putObject) {
    stderr.write('Error: the configured storage adapter does not support getObject/putObject.\n');
    return 1;
  }

  const counts = await runMigrationSteps(
    cliAdapter,
    storageAdapter,
    args,
    oldKeys,
    missingManifests,
    stdout,
  );
  reportMigrationSummary(args, counts, stdout);

  return counts.failedKeys > 0 || counts.failedManifests > 0 ? 1 : 0;
}

/**
 * Migrate old-format S3 keys (with `session/` segment) to the new format
 * (without `session/` segment), and generate missing manifests for sessions
 * that were uploaded before manifest upload was added.
 *
 * Old key format: `<projectId>/<sessionId>/session/transcript.jsonl`
 * New key format: `<projectId>/<sessionId>/transcript.jsonl`
 *
 * Without `--yes`, performs a dry run: lists what would be migrated.
 * With `--yes`, copies old objects and generates missing manifests.
 * With `--yes --manifests`, only generates manifests (skip key migration).
 *
 * Hoisted (#354) from `claude-session-sync`/`devin-session-sync` — see
 * `buildManifestForSession`'s doc comment for the single most important
 * invariant this hoist must preserve.
 */
export async function runMigrateCommand(
  adapter: CliHarnessAdapter,
  argv: string[],
  options: MigrateCommandOptions = {},
): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;

  const args = parseMigrateArgs(argv);
  if ('error' in args) {
    stderr.write(`${args.error}\n`);
    return 1;
  }

  const storageAdapter = await buildAdapter(adapter, options, cwd);
  if ('errorMessage' in storageAdapter) {
    stderr.write(`${storageAdapter.errorMessage}\n`);
    return 1;
  }

  if (!storageAdapter.listObjects) {
    stderr.write('Error: the configured storage adapter does not support listing objects.\n');
    return 1;
  }

  stdout.write('Scanning bucket for old-format keys and missing manifests...\n\n');
  const { oldKeys, sessions } = await scanBucket(storageAdapter, args.projectId);
  const missingManifests = sessionsMissingManifests(sessions);

  if (!args.confirmed) {
    return dryRunPreview(oldKeys, missingManifests, stdout);
  }
  return performMigration(adapter, storageAdapter, args, oldKeys, missingManifests, stdout, stderr);
}
