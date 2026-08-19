import process from 'node:process';

import {
  buildStorageAdapterFromStorage,
  type ListObjectEntry,
  type ListObjectsResult,
  parseObjectKey,
  type StorageAdapter,
} from '@lucasschirm/sal-sync';

import { validateCliConfig, validateStorageConfig } from './config.js';
import { resolveCliEnv } from './env.js';

export interface ListCommandOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  storageAdapter?: StorageAdapter;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}

export type ListMode =
  | { mode: 'all-projects' }
  | { mode: 'current' }
  | { mode: 'project'; projectId: string }
  | { mode: 'session'; projectId: string; sessionId: string }
  | { mode: 'path'; projectId: string; sessionId: string; path: string };

export type ListArgs = ListMode | { error: string };

interface SessionSummary {
  sessionId: string;
  fileCount: number;
  totalBytes: number;
  lastModified?: Date;
}

interface ProjectSummary {
  projectId: string;
  sessionCount: number;
  fileCount: number;
  totalBytes: number;
  lastModified?: Date;
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\//, '').replace(/\/$/, '');
}

function projectIdFromKey(key: string): string | undefined {
  const parsed = parseObjectKey(key);
  if (parsed) return parsed.projectId;
  const first = key.split('/')[0];
  if (!first) return undefined;
  try {
    return decodeURIComponent(first);
  } catch {
    return first;
  }
}

function sessionRelativeKey(key: string): string | undefined {
  const parsed = parseObjectKey(key);
  if (!parsed) return undefined;
  if (parsed.scope === 'manifest') {
    return 'manifest.json';
  }
  return `${parsed.scope}/${parsed.relativePath}`;
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

export function parseListArgs(argv: string[]): ListArgs {
  let projectId: string | undefined;
  let sessionId: string | undefined;
  let path: string | undefined;
  let current = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg) continue;

    if (arg === '--current') {
      current = true;
      continue;
    }

    if (arg.startsWith('--session=')) {
      sessionId = arg.slice('--session='.length);
      continue;
    }
    if (arg === '--session') {
      const next = argv[i + 1];
      if (!next) {
        return { error: 'Error: --session requires a value.' };
      }
      sessionId = next;
      i++;
      continue;
    }

    if (arg.startsWith('--path=')) {
      path = normalizePath(arg.slice('--path='.length));
      continue;
    }
    if (arg === '--path') {
      const next = argv[i + 1];
      if (!next) {
        return { error: 'Error: --path requires a value.' };
      }
      path = normalizePath(next);
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

  if (current && projectId !== undefined) {
    return { error: 'Error: --current cannot be used with a project id.' };
  }

  if (path !== undefined && sessionId === undefined) {
    return { error: 'Error: --path requires --session.' };
  }

  if (current) {
    return { mode: 'current' };
  }

  if (projectId !== undefined) {
    if (sessionId !== undefined) {
      return path !== undefined
        ? { mode: 'path', projectId, sessionId, path }
        : { mode: 'session', projectId, sessionId };
    }
    return { mode: 'project', projectId };
  }

  if (sessionId !== undefined) {
    return { error: 'Error: --session requires a project id or --current.' };
  }

  return { mode: 'all-projects' };
}

function groupByProject(objects: ListObjectEntry[]): Map<string, ProjectSummary> {
  const projects = new Map<string, ProjectSummary>();
  const sessionsByProject = new Map<string, Map<string, SessionSummary>>();

  for (const obj of objects) {
    const parsed = parseObjectKey(obj.key);
    const projectId = parsed?.projectId ?? projectIdFromKey(obj.key);
    if (!projectId) continue;

    if (!projects.has(projectId)) {
      projects.set(projectId, {
        projectId,
        sessionCount: 0,
        fileCount: 0,
        totalBytes: 0,
        lastModified: undefined,
      });
      sessionsByProject.set(projectId, new Map<string, SessionSummary>());
    }

    const project = projects.get(projectId) as ProjectSummary;
    project.fileCount += 1;
    project.totalBytes += obj.size ?? 0;
    if (obj.lastModified && (!project.lastModified || obj.lastModified > project.lastModified)) {
      project.lastModified = obj.lastModified;
    }

    const sessionId = parsed?.sessionId ?? 'unknown';
    const sessions = sessionsByProject.get(projectId) as Map<string, SessionSummary>;
    if (!sessions.has(sessionId)) {
      sessions.set(sessionId, {
        sessionId,
        fileCount: 0,
        totalBytes: 0,
        lastModified: undefined,
      });
    }
    const session = sessions.get(sessionId) as SessionSummary;
    session.fileCount += 1;
    session.totalBytes += obj.size ?? 0;
    if (obj.lastModified && (!session.lastModified || obj.lastModified > session.lastModified)) {
      session.lastModified = obj.lastModified;
    }
  }

  for (const [projectId, sessions] of sessionsByProject) {
    const project = projects.get(projectId) as ProjectSummary;
    project.sessionCount = sessions.size;
    const sessionsArray = [...sessions.values()];
    for (const s of sessionsArray) {
      if (s.lastModified && (!project.lastModified || s.lastModified > project.lastModified)) {
        project.lastModified = s.lastModified;
      }
    }
  }

  return projects;
}

function groupBySession(objects: ListObjectEntry[]): Map<string, SessionSummary> {
  const sessions = new Map<string, SessionSummary>();
  for (const obj of objects) {
    const parsed = parseObjectKey(obj.key);
    const sessionId = parsed?.sessionId;
    if (!sessionId) continue;
    const existing = sessions.get(sessionId);
    if (existing) {
      existing.fileCount += 1;
      existing.totalBytes += obj.size ?? 0;
      if (obj.lastModified) {
        if (!existing.lastModified || obj.lastModified > existing.lastModified) {
          existing.lastModified = obj.lastModified;
        }
      }
    } else {
      sessions.set(sessionId, {
        sessionId,
        fileCount: 1,
        totalBytes: obj.size ?? 0,
        lastModified: obj.lastModified,
      });
    }
  }
  return sessions;
}

interface ListEntry {
  key: string;
  size?: number;
  lastModified?: Date;
  isPrefix?: boolean;
  fileCount?: number;
}

function listSessionFiles(objects: ListObjectEntry[], filterPath?: string): ListEntry[] {
  const normalizedFilter = filterPath !== undefined ? normalizePath(filterPath) : undefined;
  const direct = new Map<string, ListEntry>();
  const prefixAggregates = new Map<
    string,
    { size: number; fileCount: number; lastModified?: Date }
  >();

  for (const obj of objects) {
    const relative = sessionRelativeKey(obj.key);
    if (!relative) continue;

    // If a filter path is given, only consider keys under it (or equal to it).
    let rest = relative;
    if (normalizedFilter !== undefined) {
      if (relative === normalizedFilter) {
        // Exact file match — show as a direct file.
        direct.set(relative, { key: relative, size: obj.size, lastModified: obj.lastModified });
        continue;
      }
      if (!relative.startsWith(`${normalizedFilter}/`)) continue;
      rest = relative.slice(`${normalizedFilter}/`.length);
    }

    const slashIdx = rest.indexOf('/');
    if (slashIdx === -1) {
      // Direct file child.
      direct.set(rest, { key: rest, size: obj.size, lastModified: obj.lastModified });
    } else {
      // Nested under a subfolder — aggregate under the first segment.
      const prefix = rest.slice(0, slashIdx);
      const agg = prefixAggregates.get(prefix) ?? { size: 0, fileCount: 0 };
      agg.size += obj.size ?? 0;
      agg.fileCount += 1;
      if (obj.lastModified && (!agg.lastModified || obj.lastModified > agg.lastModified)) {
        agg.lastModified = obj.lastModified;
      }
      prefixAggregates.set(prefix, agg);
    }
  }

  const result: ListEntry[] = [];
  for (const [_key, entry] of direct) {
    result.push(entry);
  }
  for (const [prefix, agg] of prefixAggregates) {
    result.push({
      key: `${prefix}/`,
      size: agg.size,
      lastModified: agg.lastModified,
      isPrefix: true,
      fileCount: agg.fileCount,
    });
  }
  return result.sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * List objects in configured storage.
 *
 * Modes:
 *   list                              List all projects in storage.
 *   list --current                    List sessions for the current project (SAL_PROJECT_ID).
 *   list <project-id>                 List sessions for a project.
 *   list <project-id> --session=<id>  List files in a session.
 *   list <project-id> --session=<id> --path=<p>  List files under a session sub-path.
 */
export async function runListCommand(
  argv: string[] = [],
  options: ListCommandOptions = {},
): Promise<number> {
  const args = parseListArgs(argv);
  if ('error' in args) {
    const stderr = options.stderr ?? process.stderr;
    stderr.write(`${args.error}\n`);
    return 1;
  }

  const cwd = options.cwd ?? process.cwd();
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;

  const env = options.env ?? (await resolveCliEnv(cwd));

  let projectId: string | undefined;
  if (args.mode === 'current') {
    projectId = env.SAL_PROJECT_ID?.trim();
    if (!projectId) {
      stderr.write('Error: SAL_PROJECT_ID is required for `list --current`.\n');
      return 1;
    }
  } else if (args.mode !== 'all-projects') {
    projectId = args.projectId;
  }

  const validation =
    args.mode === 'current' ? validateCliConfig(env, cwd) : validateStorageConfig(env);

  if (!validation.ok) {
    stderr.write(`${validation.errorMessage ?? 'Configuration error.'}\n`);
    return 1;
  }

  let storageAdapter: StorageAdapter;
  if (options.storageAdapter) {
    storageAdapter = options.storageAdapter;
  } else if ('storage' in validation && 'retries' in validation) {
    storageAdapter = buildStorageAdapterFromStorage(validation.storage, {
      retries: validation.retries,
    });
  } else if ('config' in validation && validation.config) {
    storageAdapter = buildStorageAdapterFromStorage(validation.config.storage, {
      retries: validation.config.retries,
    });
  } else {
    stderr.write('Error: could not build storage adapter from configuration.\n');
    return 1;
  }

  if (!storageAdapter.listObjects) {
    stderr.write('Error: the configured storage adapter does not support listing objects.\n');
    return 1;
  }

  let result: ListObjectsResult | undefined;
  try {
    if (args.mode === 'all-projects') {
      result = await storageAdapter.listObjects({});
    } else if (args.mode === 'current' || args.mode === 'project') {
      result = await storageAdapter.listObjects({ projectId: projectId as string });
    } else {
      result = await storageAdapter.listObjects({
        projectId: projectId as string,
        sessionId: args.sessionId,
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    stderr.write(`Error listing objects: ${message}\n`);
    return 1;
  }

  switch (args.mode) {
    case 'all-projects': {
      const projects = groupByProject(result.objects);
      if (projects.size === 0) {
        stdout.write('No projects found in storage.\n');
        return 0;
      }

      const sorted = [...projects.values()].sort((a, b) => {
        if (b.lastModified && a.lastModified) {
          return b.lastModified.getTime() - a.lastModified.getTime();
        }
        return a.projectId.localeCompare(b.projectId);
      });

      const idWidth = Math.max(10, ...sorted.map((p) => p.projectId.length));
      const sessionsWidth = 8;
      const filesWidth = 5;
      const sizeWidth = 10;
      const dateWidth = 16;

      const header =
        `${padRight('PROJECT ID', idWidth)}  ` +
        `${padRight('SESSIONS', sessionsWidth)}  ` +
        `${padRight('FILES', filesWidth)}  ` +
        `${padRight('SIZE', sizeWidth)}  ` +
        `${padRight('LAST MODIFIED', dateWidth)}`;
      stdout.write(`${header}\n`);
      stdout.write(`${'-'.repeat(header.length)}\n`);

      let totalFiles = 0;
      let totalBytes = 0;
      for (const p of sorted) {
        stdout.write(
          `${padRight(p.projectId, idWidth)}  ` +
            `${padRight(String(p.sessionCount), sessionsWidth)}  ` +
            `${padRight(String(p.fileCount), filesWidth)}  ` +
            `${padRight(formatBytes(p.totalBytes), sizeWidth)}  ` +
            `${padRight(formatDate(p.lastModified), dateWidth)}\n`,
        );
        totalFiles += p.fileCount;
        totalBytes += p.totalBytes;
      }

      stdout.write('\n');
      stdout.write(
        `${sorted.length} project(s), ${totalFiles} files, ${formatBytes(totalBytes)} total\n`,
      );
      return 0;
    }

    case 'current':
    case 'project': {
      const sessions = groupBySession(result.objects);
      if (sessions.size === 0) {
        stdout.write(`No sessions found for project "${projectId}".\n`);
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

    case 'session':
    case 'path': {
      const filterPath = args.mode === 'path' ? args.path : undefined;
      const entries = listSessionFiles(result.objects, filterPath);
      const sessionId = args.sessionId;
      if (entries.length === 0) {
        if (filterPath !== undefined) {
          stdout.write(
            `No files found for "${filterPath}" in session "${sessionId}" of project "${projectId}".\n`,
          );
        } else {
          stdout.write(`No files found for session "${sessionId}" of project "${projectId}".\n`);
        }
        return 0;
      }

      const keyWidth = Math.max(16, ...entries.map((f) => f.key.length));
      const sizeWidth = 10;
      const filesWidth = 5;
      const dateWidth = 16;

      const header =
        `${padRight('KEY', keyWidth)}  ` +
        `${padRight('SIZE', sizeWidth)}  ` +
        `${padRight('FILES', filesWidth)}  ` +
        `${padRight('LAST MODIFIED', dateWidth)}`;
      stdout.write(`${header}\n`);
      stdout.write(`${'-'.repeat(header.length)}\n`);

      let totalBytes = 0;
      let totalFiles = 0;
      let prefixCount = 0;
      let fileCount = 0;
      for (const f of entries) {
        const filesStr = f.isPrefix ? String(f.fileCount ?? 0) : '-';
        stdout.write(
          `${padRight(f.key, keyWidth)}  ` +
            `${padRight(formatBytes(f.size ?? 0), sizeWidth)}  ` +
            `${padRight(filesStr, filesWidth)}  ` +
            `${padRight(formatDate(f.lastModified), dateWidth)}\n`,
        );
        totalBytes += f.size ?? 0;
        if (f.isPrefix) {
          prefixCount += 1;
          totalFiles += f.fileCount ?? 0;
        } else {
          fileCount += 1;
          totalFiles += 1;
        }
      }

      stdout.write('\n');
      stdout.write(
        `${fileCount} file(s), ${prefixCount} folder(s), ${totalFiles} total file(s), ${formatBytes(totalBytes)} total\n`,
      );
      return 0;
    }
  }
}
