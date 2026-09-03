import { Buffer } from 'node:buffer';
import process from 'node:process';

import {
  buildObjectKey,
  buildStorageAdapterFromStorage,
  DEFAULT_PLUGIN_VERSION,
  MANIFEST_SCHEMA_VERSION,
  type ManifestArtifact,
  parseObjectKey,
  type StorageAdapter,
  SYNC_VERSION,
  sha256Hex,
  UNKNOWN_HARNESS_VERSION,
} from '@lucasschirm/sal-sync';

import { DevinHarnessProfile } from '../devin-profile.js';
import { validateStorageConfig } from './config.js';
import { resolveCliEnv } from './env.js';

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
  options: MigrateCommandOptions,
  cwd: string,
): Promise<StorageAdapter | { errorMessage: string }> {
  if (options.storageAdapter) return options.storageAdapter;

  const env = options.env ?? (await resolveCliEnv(cwd));
  const validation = validateStorageConfig(env);
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
 * available. `harness` is read from `DevinHarnessProfile`, never a literal
 * (the DS-B5 #143 pattern this plugin must not reintroduce);
 * `UNKNOWN_HARNESS_VERSION` is the correct sentinel here since the original
 * `harnessVersion` genuinely cannot be recovered for an orphaned session.
 */
function buildManifestForSession(session: SessionScan, artifacts: ManifestArtifact[]): unknown {
  const mainTranscript = artifacts.find(
    (a) => a.scope === 'session' && a.relativePath === 'transcript.jsonl',
  );
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    projectId: session.projectId,
    sessionId: session.sessionId,
    harness: DevinHarnessProfile.harness,
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
  adapter: StorageAdapter,
  sessions: SessionScan[],
  stdout: NodeJS.WritableStream,
): Promise<{ generated: number; skipped: number; failed: number }> {
  let generated = 0;
  let skipped = 0;
  let failed = 0;

  for (const session of sessions) {
    try {
      const { artifacts, skipped: artifactsSkipped } = await buildSessionManifestArtifacts(
        adapter,
        session,
        stdout,
      );
      skipped += artifactsSkipped;
      if (artifacts.length === 0) {
        skipped++;
        stdout.write(`[skip] ${session.projectId}/${session.sessionId} — no session artifacts\n`);
        continue;
      }

      const manifestJson = JSON.stringify(buildManifestForSession(session, artifacts));
      const manifestBytes = Buffer.from(manifestJson, 'utf8');
      await adapter.putObject({
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

async function performMigration(
  adapter: StorageAdapter,
  args: MigrateArgs,
  oldKeys: OldFormatKey[],
  missingManifests: SessionScan[],
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
): Promise<number> {
  if (!adapter.getObject || !adapter.putObject) {
    stderr.write('Error: the configured storage adapter does not support getObject/putObject.\n');
    return 1;
  }

  let copied = 0;
  let skippedKeys = 0;
  let failedKeys = 0;
  let generated = 0;
  let skippedManifests = 0;
  let failedManifests = 0;

  if (!args.manifests && oldKeys.length > 0) {
    stdout.write(`\n=== Copying ${oldKeys.length} old-format key(s) ===\n`);
    const result = await copyOldKeys(adapter, oldKeys, stdout);
    copied = result.copied;
    skippedKeys = result.skipped;
    failedKeys = result.failed;
  }

  if (missingManifests.length > 0) {
    stdout.write(`\n=== Generating ${missingManifests.length} missing manifest(s) ===\n`);
    const result = await generateManifests(adapter, missingManifests, stdout);
    generated = result.generated;
    skippedManifests = result.skipped;
    failedManifests = result.failed;
  }

  stdout.write('\n');
  const parts: string[] = [];
  if (!args.manifests) {
    parts.push(`${copied} keys copied`);
    if (skippedKeys > 0) parts.push(`${skippedKeys} keys skipped`);
    if (failedKeys > 0) parts.push(`${failedKeys} keys failed`);
  }
  parts.push(`${generated} manifests generated`);
  if (skippedManifests > 0) parts.push(`${skippedManifests} manifests skipped`);
  if (failedManifests > 0) parts.push(`${failedManifests} manifests failed`);
  stdout.write(`Migration complete: ${parts.join(', ')}.\n`);

  if (args.deleteOld) {
    stdout.write('\nNote: old keys were not deleted. Please verify the migrated data and\n');
    stdout.write('delete old keys manually if no longer needed.\n');
  }

  return failedKeys > 0 || failedManifests > 0 ? 1 : 0;
}

/**
 * Migrate old-format S3 keys (with `session/` segment) to the new format
 * (without `session/` segment), and generate missing manifests for sessions
 * that were uploaded before manifest upload was added.
 */
export async function runMigrateCommand(
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

  const adapter = await buildAdapter(options, cwd);
  if ('errorMessage' in adapter) {
    stderr.write(`${adapter.errorMessage}\n`);
    return 1;
  }

  if (!adapter.listObjects) {
    stderr.write('Error: the configured storage adapter does not support listing objects.\n');
    return 1;
  }

  stdout.write('Scanning bucket for old-format keys and missing manifests...\n\n');
  const { oldKeys, sessions } = await scanBucket(adapter, args.projectId);
  const missingManifests = sessionsMissingManifests(sessions);

  if (!args.confirmed) {
    return dryRunPreview(oldKeys, missingManifests, stdout);
  }
  return performMigration(adapter, args, oldKeys, missingManifests, stdout, stderr);
}
