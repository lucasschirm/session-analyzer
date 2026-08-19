import * as fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import {
  buildStorageAdapter,
  type GetObjectInput,
  type ListObjectEntry,
  parseObjectKey,
  type StorageAdapter,
  type StorageObjectScope,
} from '@lucasschirm/sal-sync';

import { validateCliConfig } from './config.js';
import { resolveCliEnv } from './env.js';

export interface DownloadCommandOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  storageAdapter?: StorageAdapter;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}

export interface DownloadArgs {
  /** Specific session ID to download, or `all` for every session. */
  target: string;
  /** Output directory (required). */
  output: string;
}

/**
 * Parse download command arguments.
 *
 * Accepted forms:
 *   download --session-id=<id> --output=<dir>
 *   download --session-id <id> --output <dir>
 *   download all --output=<dir>
 *   download all --output <dir>
 */
export function parseDownloadArgs(argv: string[]): DownloadArgs | undefined {
  let target: string | undefined;
  let output: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg) continue;

    if (arg === 'all') {
      target = 'all';
      continue;
    }

    if (arg.startsWith('--session-id=')) {
      target = arg.slice('--session-id='.length);
      continue;
    }
    if (arg === '--session-id') {
      const next = argv[i + 1];
      if (next) {
        target = next;
        i++;
      }
      continue;
    }

    if (arg.startsWith('--output=')) {
      output = arg.slice('--output='.length);
      continue;
    }
    if (arg === '--output') {
      const next = argv[i + 1];
      if (next) {
        output = next;
        i++;
      }
    }
  }

  if (!target || !output) return undefined;
  return { target, output };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Reconstruct the local file path for a downloaded object.
 *
 * Layout: `<output>/<projectId>/<sessionId>/<scope>/<relativePath>`
 * For manifest scope: `<output>/<projectId>/<sessionId>/manifest.json`
 */
function buildLocalPath(
  output: string,
  parsed: ReturnType<typeof parseObjectKey>,
): string | undefined {
  if (!parsed) return undefined;
  const { projectId, sessionId, scope, relativePath } = parsed;
  if (projectId === undefined || sessionId === undefined) {
    return undefined;
  }
  if (scope === 'manifest') {
    return path.join(output, projectId, sessionId, relativePath);
  }
  return path.join(output, projectId, sessionId, scope, relativePath);
}

/**
 * Download a single object from storage and write it to the local filesystem.
 */
async function downloadObject(
  storageAdapter: StorageAdapter,
  entry: ListObjectEntry,
  output: string,
  stdout: NodeJS.WritableStream,
): Promise<{ ok: boolean; bytes: number; error?: string }> {
  const parsed = parseObjectKey(entry.key);
  if (!parsed) {
    return { ok: false, bytes: 0, error: `could not parse key: ${entry.key}` };
  }

  if (parsed.projectId === undefined || parsed.sessionId === undefined) {
    return {
      ok: false,
      bytes: 0,
      error: `CAS object keys are not supported for download: ${entry.key}`,
    };
  }

  const localPath = buildLocalPath(output, parsed);
  if (!localPath) {
    return { ok: false, bytes: 0, error: `could not build local path for: ${entry.key}` };
  }

  const getObjectInput: GetObjectInput = {
    projectId: parsed.projectId,
    sessionId: parsed.sessionId,
    scope: parsed.scope as StorageObjectScope,
    relativePath: parsed.relativePath,
  };

  if (!storageAdapter.getObject) {
    return { ok: false, bytes: 0, error: 'storage adapter does not support getObject' };
  }

  let result: Awaited<ReturnType<NonNullable<StorageAdapter['getObject']>>> | undefined;
  try {
    result = await storageAdapter.getObject(getObjectInput);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, bytes: 0, error: message };
  }

  if (!result) {
    return { ok: false, bytes: 0, error: 'object not found' };
  }

  await fsp.mkdir(path.dirname(localPath), { recursive: true });
  await fsp.writeFile(localPath, result.body);

  const relativeDisplay = path.relative(output, localPath);
  stdout.write(`[download] ${relativeDisplay} (${formatBytes(result.body.length)})\n`);

  return { ok: true, bytes: result.body.length };
}

/**
 * Download session(s) from S3 storage to a local directory.
 *
 * - `download --session-id=<id> --output=<dir>` — download a specific session
 * - `download all --output=<dir>` — download all sessions for the project
 */
export async function runDownloadCommand(
  argv: string[],
  options: DownloadCommandOptions = {},
): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;

  const args = parseDownloadArgs(argv);
  if (!args) {
    stderr.write(
      'Usage: claude-sync download --session-id=<id> --output=<dir>\n' +
        '       claude-sync download all --output=<dir>\n',
    );
    return 1;
  }

  const env = options.env ?? (await resolveCliEnv(cwd));
  const validation = validateCliConfig(env, cwd);
  if (!validation.ok || !validation.config) {
    stderr.write(`${validation.errorMessage ?? 'Configuration error.'}\n`);
    return 1;
  }

  const config = validation.config;
  const storageAdapter = options.storageAdapter ?? buildStorageAdapter(config);
  if (!storageAdapter.listObjects || !storageAdapter.getObject) {
    stderr.write(
      'Error: the configured storage adapter does not support listing or getting objects.\n',
    );
    return 1;
  }

  // List objects to download.
  let objects: ListObjectEntry[];
  try {
    if (args.target === 'all') {
      const result = await storageAdapter.listObjects({ projectId: config.projectId });
      objects = result.objects;
    } else {
      const result = await storageAdapter.listObjects({
        projectId: config.projectId,
        sessionId: args.target,
      });
      objects = result.objects;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    stderr.write(`Error listing objects: ${message}\n`);
    return 1;
  }

  if (objects.length === 0) {
    if (args.target === 'all') {
      stdout.write(`No objects found for project "${config.projectId}".\n`);
    } else {
      stdout.write(`No objects found for session "${args.target}".\n`);
    }
    return 0;
  }

  // Ensure output directory exists.
  await fsp.mkdir(args.output, { recursive: true });

  stdout.write(`Downloading ${objects.length} object(s) to ${args.output}...\n\n`);

  let downloaded = 0;
  let failed = 0;
  let totalBytes = 0;
  const errors: string[] = [];

  for (const entry of objects) {
    const result = await downloadObject(storageAdapter, entry, args.output, stdout);
    if (result.ok) {
      downloaded += 1;
      totalBytes += result.bytes;
    } else {
      failed += 1;
      stdout.write(`[fail] ${entry.key} — ${result.error}\n`);
      errors.push(`${entry.key}: ${result.error}`);
    }
  }

  stdout.write('\n');
  stdout.write(
    `Downloaded ${downloaded} file(s), ${formatBytes(totalBytes)} total, ` +
      `${failed} failed to ${args.output}\n`,
  );

  if (errors.length > 0) {
    return 1;
  }
  return 0;
}
