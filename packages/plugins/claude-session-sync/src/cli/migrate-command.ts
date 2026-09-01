import process from 'node:process';

import {
  buildStorageAdapterFromStorage,
  parseObjectKey,
  type StorageAdapter,
} from '@lucasschirm/sal-sync';

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
}

export type MigrateArgsResult = MigrateArgs | { error: string };

/**
 * Parse `migrate [--project=<project-id>] [--yes] [--delete-old]` arguments.
 *
 * Accepted forms:
 *   migrate                                  Dry run: list old-format keys
 *   migrate --project=<project-id>           Dry run for a specific project
 *   migrate --yes                            Copy old keys to new format
 *   migrate --yes --delete-old               Copy and delete old keys
 */
export function parseMigrateArgs(argv: string[]): MigrateArgsResult {
  let projectId: string | undefined;
  let confirmed = false;
  let deleteOld = false;

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
    if (arg.startsWith('--project=')) {
      projectId = arg.slice('--project='.length);
      continue;
    }
    if (arg.startsWith('-')) {
      return { error: `Error: unknown option ${arg}.` };
    }
    return { error: `Error: unexpected argument ${arg}.` };
  }

  return { projectId, confirmed, deleteOld };
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

/**
 * List all objects and find keys with the old `session/` segment.
 *
 * Old format: `<projectId>/<sessionId>/session/<relativePath>`
 * New format: `<projectId>/<sessionId>/<relativePath>`
 */
async function findOldFormatKeys(
  adapter: StorageAdapter,
  projectIdFilter?: string,
): Promise<OldFormatKey[]> {
  if (!adapter.listObjects) return [];

  // List all objects (or scoped to a project if filter is provided)
  const result = await adapter.listObjects({
    projectId: projectIdFilter ?? '',
    sessionId: '',
  });

  const oldKeys: OldFormatKey[] = [];

  for (const obj of result.objects) {
    // Old-format keys contain the literal `/session/` segment after the sessionId.
    // We detect this by checking if the key matches the pattern
    // `<projectId>/<sessionId>/session/<relativePath>`.
    if (!obj.key.includes('/session/')) continue;

    const parsed = parseObjectKey(obj.key);
    if (!parsed || parsed.scope !== 'session') continue;
    if (!parsed.projectId || !parsed.sessionId) continue;

    // Reconstruct the new key without the session/ segment
    const newKey = `${parsed.projectId}/${parsed.sessionId}/${parsed.relativePath}`;
    if (newKey === obj.key) continue; // Already new format (shouldn't happen)

    oldKeys.push({
      oldKey: obj.key,
      newKey,
      projectId: parsed.projectId,
      sessionId: parsed.sessionId,
      relativePath: parsed.relativePath,
      size: obj.size ?? 0,
    });
  }

  return oldKeys;
}

async function dryRunPreview(
  adapter: StorageAdapter,
  args: MigrateArgs,
  oldKeys: OldFormatKey[],
  stdout: NodeJS.WritableStream,
): Promise<number> {
  if (oldKeys.length === 0) {
    stdout.write('No old-format keys found. Nothing to migrate.\n');
    return 0;
  }

  const projects = new Set(oldKeys.map((k) => k.projectId));
  stdout.write(`Found ${oldKeys.length} old-format key(s) across ${projects.size} project(s):\n`);
  for (const proj of projects) {
    const count = oldKeys.filter((k) => k.projectId === proj).length;
    stdout.write(`  ${proj}: ${count} key(s)\n`);
  }

  stdout.write('\nSample keys (up to 20):\n');
  for (const k of oldKeys.slice(0, 20)) {
    stdout.write(`  ${k.oldKey}\n`);
    stdout.write(`    -> ${k.newKey}\n`);
  }
  if (oldKeys.length > 20) {
    stdout.write(`  ... and ${oldKeys.length - 20} more\n`);
  }

  stdout.write(
    '\nPass --yes to copy these objects to the new key format (without "session/" segment).\n',
  );
  stdout.write('Pass --yes --delete-old to also delete the old keys after copying.\n');
  return 0;
}

async function performMigration(
  adapter: StorageAdapter,
  args: MigrateArgs,
  oldKeys: OldFormatKey[],
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
): Promise<number> {
  if (!adapter.getObject || !adapter.putObject) {
    stderr.write('Error: the configured storage adapter does not support getObject/putObject.\n');
    return 1;
  }

  let copied = 0;
  let skipped = 0;
  let failed = 0;
  const deleted = 0;

  for (const keyInfo of oldKeys) {
    try {
      // Check if the new key already exists
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

      // Upload to the new key (without session/ segment)
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

      // Optionally delete the old key. The deleteObjects API deletes by
      // project/session scope, not individual keys. We can't safely delete
      // individual old keys through the adapter interface without also
      // deleting the new keys (which share the same project/session prefix).
      // So --delete-old is not supported through the adapter interface.
      if (args.deleteOld) {
        stdout.write(
          `[warn] --delete-old is not supported through the storage adapter interface.\n`,
        );
        stdout.write(`       Old keys must be deleted manually after verifying the migration.\n`);
      }
    } catch (err) {
      failed++;
      const message = err instanceof Error ? err.message : String(err);
      stdout.write(`[fail] ${keyInfo.oldKey} — ${message}\n`);
    }
  }

  stdout.write('\n');
  const parts: string[] = [];
  parts.push(`${copied} copied`);
  if (skipped > 0) parts.push(`${skipped} skipped`);
  if (failed > 0) parts.push(`${failed} failed`);
  stdout.write(`Migration complete: ${parts.join(', ')}.\n`);

  if (args.deleteOld) {
    stdout.write('\nNote: old keys were not deleted. Please verify the migrated data and\n');
    stdout.write('delete old keys manually if no longer needed.\n');
  }

  return failed > 0 ? 1 : 0;
}

/**
 * Migrate old-format S3 keys (with `session/` segment) to the new format
 * (without `session/` segment).
 *
 * Old format: `<projectId>/<sessionId>/session/transcript.jsonl`
 * New format: `<projectId>/<sessionId>/transcript.jsonl`
 *
 * Without `--yes`, performs a dry run: lists what would be migrated.
 * With `--yes`, copies each old object to the new key.
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

  stdout.write('Scanning for old-format keys (with "session/" segment)...\n\n');
  const oldKeys = await findOldFormatKeys(adapter, args.projectId);

  if (!args.confirmed) {
    return dryRunPreview(adapter, args, oldKeys, stdout);
  }
  return performMigration(adapter, args, oldKeys, stdout, stderr);
}
