import process from 'node:process';
import type { StorageAdapter } from '@lucasschirm/sal-sync-core';
import { CAS_NAMESPACE_ROOT } from '@lucasschirm/sal-sync-core';

import { buildStorageAdapterFromStorage } from '../common.js';
import { validateStorageConfig } from '../config.js';
import { resolveCliEnv } from '../env.js';
import type { CliHarnessAdapter } from '../harness-adapter.js';

export interface RemoveCommandOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  storageAdapter?: StorageAdapter;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}

export interface RemoveArgs {
  projectId: string;
  sessionId?: string;
  confirmed: boolean;
}

export type RemoveArgsResult = RemoveArgs | { error: string };

/**
 * Parse `remove <project-id> [--session=<session-id>] [--yes]` arguments.
 *
 * Accepted forms:
 *   remove <project-id>
 *   remove <project-id> --session=<session-id>
 *   remove <project-id> --session <session-id>
 *   remove <project-id> [--session=<id>] --yes|-y
 *
 * Harness-agnostic — no `CliHarnessAdapter` needed.
 */
export function parseRemoveArgs(argv: string[]): RemoveArgsResult {
  let projectId: string | undefined;
  let sessionId: string | undefined;
  let confirmed = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg) continue;

    if (arg === '--yes' || arg === '-y') {
      confirmed = true;
      continue;
    }
    if (arg.startsWith('--session=')) {
      sessionId = arg.slice('--session='.length);
      continue;
    }
    if (arg === '--session') {
      const next = argv[i + 1];
      if (!next) return { error: 'Error: --session requires a value.' };
      sessionId = next;
      i++;
      continue;
    }
    if (arg.startsWith('-')) {
      return { error: `Error: unknown option ${arg}.` };
    }
    if (projectId !== undefined) {
      return { error: 'Error: only one project id may be provided.' };
    }
    projectId = arg;
  }

  if (projectId === undefined) {
    return { error: 'Error: remove requires a project id, e.g. `remove my-project`.' };
  }
  if (projectId === CAS_NAMESPACE_ROOT) {
    return {
      error: `Error: "${CAS_NAMESPACE_ROOT}" is reserved for shared content-addressed storage and cannot be removed.`,
    };
  }

  return { projectId, sessionId, confirmed };
}

function describeScope(args: RemoveArgs): string {
  return args.sessionId ? `${args.projectId}/${args.sessionId}` : args.projectId;
}

async function buildAdapter(
  adapter: CliHarnessAdapter,
  options: RemoveCommandOptions,
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

async function dryRunPreview(
  storageAdapter: StorageAdapter,
  args: RemoveArgs,
  stdout: NodeJS.WritableStream,
): Promise<number> {
  const result = await storageAdapter.listObjects?.({
    projectId: args.projectId,
    sessionId: args.sessionId,
  });
  const objects = result?.objects ?? [];

  if (objects.length === 0) {
    stdout.write(`No objects found under "${describeScope(args)}". Nothing to remove.\n`);
    return 0;
  }

  stdout.write(
    `Dry run: ${objects.length} object(s) would be removed under "${describeScope(args)}":\n`,
  );
  for (const entry of objects.slice(0, 20)) {
    stdout.write(`  ${entry.key}\n`);
  }
  if (objects.length > 20) {
    stdout.write(`  ... and ${objects.length - 20} more\n`);
  }
  stdout.write(
    '\nPass --yes to actually delete these objects. Content-addressed workspace/global\n',
  );
  stdout.write('files under global/cas/ are never touched, since other projects may share them.\n');
  return 0;
}

async function performDelete(
  storageAdapter: StorageAdapter,
  args: RemoveArgs,
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
): Promise<number> {
  const result = await storageAdapter.deleteObjects?.({
    projectId: args.projectId,
    sessionId: args.sessionId,
  });
  if (!result) {
    stderr.write('Error: the configured storage adapter does not support deleting objects.\n');
    return 1;
  }

  stdout.write(`Deleted ${result.deletedKeys.length} object(s) under "${describeScope(args)}".\n`);
  if (result.errors.length === 0) return 0;

  for (const error of result.errors) {
    stdout.write(`[fail] ${error.key} — ${error.message}\n`);
  }
  stderr.write(`${result.errors.length} object(s) failed to delete.\n`);
  return 1;
}

/**
 * Remove every object stored for a project (or a single session within it)
 * from S3. Never deletes content-addressed `global/cas/<hash>` objects,
 * since those may be shared with other projects/sessions.
 *
 * Without `--yes`, performs a dry run: lists what would be deleted and exits
 * 0 without deleting anything.
 *
 * Hoisted (#354) from `claude-session-sync`/`devin-session-sync` — logic is
 * byte-identical between the two pre-hoist plugins (no harness-specific
 * content beyond env/config resolution, which is why this is the only
 * function here that takes `adapter`).
 */
export async function runRemoveCommand(
  adapter: CliHarnessAdapter,
  argv: string[],
  options: RemoveCommandOptions = {},
): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;

  const args = parseRemoveArgs(argv);
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

  if (!args.confirmed) {
    return dryRunPreview(storageAdapter, args, stdout);
  }
  return performDelete(storageAdapter, args, stdout, stderr);
}
