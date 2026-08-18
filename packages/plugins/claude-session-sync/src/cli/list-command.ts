import process from 'node:process';

import {
  buildStorageAdapter,
  type ListObjectEntry,
  type ListObjectsResult,
  parseObjectKey,
  type StorageAdapter,
} from '@lucasschirm/sal-sync';

import { validateCliConfig } from './config.js';
import { resolveCliEnv } from './env.js';

export interface ListCommandOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  storageAdapter?: StorageAdapter;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}

interface SessionSummary {
  sessionId: string;
  fileCount: number;
  totalBytes: number;
  lastModified?: Date;
}

function groupBySession(objects: ListObjectEntry[]): Map<string, SessionSummary> {
  const sessions = new Map<string, SessionSummary>();
  for (const obj of objects) {
    const parsed = parseObjectKey(obj.key);
    if (!parsed) continue;
    const existing = sessions.get(parsed.sessionId);
    if (existing) {
      existing.fileCount += 1;
      existing.totalBytes += obj.size ?? 0;
      if (obj.lastModified) {
        if (!existing.lastModified || obj.lastModified > existing.lastModified) {
          existing.lastModified = obj.lastModified;
        }
      }
    } else {
      sessions.set(parsed.sessionId, {
        sessionId: parsed.sessionId,
        fileCount: 1,
        totalBytes: obj.size ?? 0,
        lastModified: obj.lastModified,
      });
    }
  }
  return sessions;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDate(date?: Date): string {
  if (!date) return '-';
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mi = String(date.getUTCMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

function padRight(str: string, width: number): string {
  if (str.length >= width) return str;
  return str + ' '.repeat(width - str.length);
}

/**
 * List all sessions uploaded for the current project in S3 storage.
 *
 * Outputs a human-readable table grouped by session ID.
 */
export async function runListCommand(options: ListCommandOptions = {}): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;

  const env = options.env ?? (await resolveCliEnv(cwd));
  const validation = validateCliConfig(env, cwd);
  if (!validation.ok || !validation.config) {
    stderr.write(`${validation.errorMessage ?? 'Configuration error.'}\n`);
    return 1;
  }

  const config = validation.config;
  const storageAdapter = options.storageAdapter ?? buildStorageAdapter(config);
  if (!storageAdapter.listObjects) {
    stderr.write('Error: the configured storage adapter does not support listing objects.\n');
    return 1;
  }

  let result: ListObjectsResult | undefined;
  try {
    result = await storageAdapter.listObjects({ projectId: config.projectId });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    stderr.write(`Error listing objects: ${message}\n`);
    return 1;
  }

  const sessions = groupBySession(result.objects);
  if (sessions.size === 0) {
    stdout.write(`No sessions found for project "${config.projectId}".\n`);
    return 0;
  }

  const sorted = [...sessions.values()].sort((a, b) => {
    if (b.lastModified && a.lastModified) {
      return b.lastModified.getTime() - a.lastModified.getTime();
    }
    return a.sessionId.localeCompare(b.sessionId);
  });

  const idWidth = Math.max(8, ...sorted.map((s) => s.sessionId.length));
  const filesWidth = 5;
  const sizeWidth = 10;
  const dateWidth = 16;

  const header =
    `${padRight('SESSION ID', idWidth)}  ` +
    `${padRight('FILES', filesWidth)}  ` +
    `${padRight('SIZE', sizeWidth)}  ` +
    `${padRight('LAST MODIFIED', dateWidth)}`;
  stdout.write(`${header}\n`);
  stdout.write(`${'-'.repeat(header.length)}\n`);

  let totalFiles = 0;
  let totalBytes = 0;
  for (const s of sorted) {
    stdout.write(
      `${padRight(s.sessionId, idWidth)}  ` +
        `${padRight(String(s.fileCount), filesWidth)}  ` +
        `${padRight(formatBytes(s.totalBytes), sizeWidth)}  ` +
        `${padRight(formatDate(s.lastModified), dateWidth)}\n`,
    );
    totalFiles += s.fileCount;
    totalBytes += s.totalBytes;
  }

  stdout.write('\n');
  stdout.write(
    `${sessions.size} session(s), ${totalFiles} files, ${formatBytes(totalBytes)} total\n`,
  );

  return 0;
}
