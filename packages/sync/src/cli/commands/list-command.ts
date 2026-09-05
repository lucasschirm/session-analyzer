import process from 'node:process';

import {
  CAS_NAMESPACE_ROOT,
  type ListObjectEntry,
  type ListObjectsResult,
  parseObjectKey,
  type StorageAdapter,
} from '@lucasschirm/sal-sync-core';

import { buildStorageAdapterFromStorage } from '../common.js';
import { validateCliConfig, validateStorageConfig } from '../config.js';
import { resolveCliEnv } from '../env.js';
import type { CliHarnessAdapter } from '../harness-adapter.js';

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

function sessionRelativeKey(key: string): string | undefined {
  const parsed = parseObjectKey(key);
  if (!parsed) return undefined;
  if (parsed.projectId === undefined || parsed.sessionId === undefined) {
    return undefined;
  }
  if (parsed.scope === 'manifest') {
    return 'manifest.json';
  }
  // Session-scoped keys omit the `session/` segment in the actual S3 key
  // (buildObjectKey skips the scope segment for 'session' and 'manifest').
  // The display must match the on-disk layout so `list` doesn't show a
  // phantom `session/` prefix that doesn't exist in storage.
  if (parsed.scope === 'session') {
    return parsed.relativePath;
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

/**
 * Parse `list [options]` arguments.
 *
 * Modes:
 *   list                              List all projects in storage.
 *   list --current                    List sessions for the current project (SAL_PROJECT_ID).
 *   list <project-id>                 List sessions for a project.
 *   list <project-id> --session=<id>  List files in a session.
 *   list <project-id> --session=<id> --path=<p>  List files under a session sub-path.
 *
 * Harness-agnostic — no `CliHarnessAdapter` needed.
 */
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

    if (parsed?.scope === 'cas') {
      const casProjectId = CAS_NAMESPACE_ROOT;
      if (!projects.has(casProjectId)) {
        projects.set(casProjectId, {
          projectId: casProjectId,
          sessionCount: 0,
          fileCount: 0,
          totalBytes: 0,
          lastModified: undefined,
        });
      }
      const casProject = projects.get(casProjectId) as ProjectSummary;
      casProject.fileCount += 1;
      casProject.totalBytes += obj.size ?? 0;
      if (
        obj.lastModified &&
        (!casProject.lastModified || obj.lastModified > casProject.lastModified)
      ) {
        casProject.lastModified = obj.lastModified;
      }
      continue;
    }

    const projectId = parsed?.projectId;
    const sessionId = parsed?.sessionId;
    if (!projectId || !sessionId) continue;

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

function renderAllProjects(result: ListObjectsResult, stdout: NodeJS.WritableStream): number {
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
  const header =
    `${padRight('PROJECT ID', idWidth)}  ${padRight('SESSIONS', 8)}  ` +
    `${padRight('FILES', 5)}  ${padRight('SIZE', 10)}  ${padRight('LAST MODIFIED', 16)}`;
  stdout.write(`${header}\n${'-'.repeat(header.length)}\n`);

  let totalFiles = 0;
  let totalBytes = 0;
  for (const p of sorted) {
    const sessionsStr = p.projectId === CAS_NAMESPACE_ROOT ? '-' : String(p.sessionCount);
    stdout.write(
      `${padRight(p.projectId, idWidth)}  ${padRight(sessionsStr, 8)}  ` +
        `${padRight(String(p.fileCount), 5)}  ${padRight(formatBytes(p.totalBytes), 10)}  ` +
        `${padRight(formatDate(p.lastModified), 16)}\n`,
    );
    totalFiles += p.fileCount;
    totalBytes += p.totalBytes;
  }

  stdout.write(
    `\n${sorted.length} project(s), ${totalFiles} files, ${formatBytes(totalBytes)} total\n`,
  );
  return 0;
}

function renderProjectSessions(
  result: ListObjectsResult,
  projectId: string | undefined,
  stdout: NodeJS.WritableStream,
): number {
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
  const header =
    `${padRight('SESSION ID', idWidth)}  ${padRight('FILES', 5)}  ` +
    `${padRight('SIZE', 10)}  ${padRight('LAST MODIFIED', 16)}`;
  stdout.write(`${header}\n${'-'.repeat(header.length)}\n`);

  let totalFiles = 0;
  let totalBytes = 0;
  for (const s of sorted) {
    stdout.write(
      `${padRight(s.sessionId, idWidth)}  ${padRight(String(s.fileCount), 5)}  ` +
        `${padRight(formatBytes(s.totalBytes), 10)}  ${padRight(formatDate(s.lastModified), 16)}\n`,
    );
    totalFiles += s.fileCount;
    totalBytes += s.totalBytes;
  }

  stdout.write(
    `\n${sessions.size} session(s), ${totalFiles} files, ${formatBytes(totalBytes)} total\n`,
  );
  return 0;
}

function renderSessionFiles(
  result: ListObjectsResult,
  args: { projectId: string; sessionId: string; path?: string },
  stdout: NodeJS.WritableStream,
): number {
  const entries = listSessionFiles(result.objects, args.path);
  if (entries.length === 0) {
    const scope =
      args.path !== undefined
        ? `"${args.path}" in session "${args.sessionId}"`
        : `session "${args.sessionId}"`;
    stdout.write(`No files found for ${scope} of project "${args.projectId}".\n`);
    return 0;
  }

  const keyWidth = Math.max(16, ...entries.map((f) => f.key.length));
  const header =
    `${padRight('KEY', keyWidth)}  ${padRight('SIZE', 10)}  ` +
    `${padRight('FILES', 5)}  ${padRight('LAST MODIFIED', 16)}`;
  stdout.write(`${header}\n${'-'.repeat(header.length)}\n`);

  let totalBytes = 0;
  let totalFiles = 0;
  let prefixCount = 0;
  let fileCount = 0;
  for (const f of entries) {
    const filesStr = f.isPrefix ? String(f.fileCount ?? 0) : '-';
    stdout.write(
      `${padRight(f.key, keyWidth)}  ${padRight(formatBytes(f.size ?? 0), 10)}  ` +
        `${padRight(filesStr, 5)}  ${padRight(formatDate(f.lastModified), 16)}\n`,
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

  stdout.write(
    `\n${fileCount} file(s), ${prefixCount} folder(s), ${totalFiles} total file(s), ${formatBytes(totalBytes)} total\n`,
  );
  return 0;
}

async function resolveListStorageAdapter(
  adapter: CliHarnessAdapter,
  args: ListMode,
  env: Record<string, string | undefined>,
  cwd: string,
  options: ListCommandOptions,
  stderr: NodeJS.WritableStream,
): Promise<StorageAdapter | undefined> {
  if (options.storageAdapter) return options.storageAdapter;
  const validation =
    args.mode === 'current'
      ? validateCliConfig(adapter, env, cwd)
      : validateStorageConfig(adapter, env);
  if (!validation.ok) {
    stderr.write(`${validation.errorMessage ?? 'Configuration error.'}\n`);
    return undefined;
  }
  const storage = 'storage' in validation ? validation.storage : validation.config?.storage;
  const retries = 'retries' in validation ? validation.retries : validation.config?.retries;
  if (!storage) {
    stderr.write('Error: could not build storage adapter from configuration.\n');
    return undefined;
  }
  return buildStorageAdapterFromStorage(storage, { retries });
}

function resolveProjectId(
  args: ListMode,
  env: Record<string, string | undefined>,
): string | undefined {
  if (args.mode === 'current') return env.SAL_PROJECT_ID?.trim();
  if (args.mode !== 'all-projects') return args.projectId;
  return undefined;
}

/**
 * Fetch the raw `listObjects` result for the resolved mode/project/session:
 * reports an unsupported adapter or a thrown storage error as a written
 * stderr line (never a thrown exception) and returns `undefined` for both.
 * Split out of `runListCommand` to keep both functions under
 * `.agents/rules/workspace-rules.md`'s 20/30-line function cap.
 *
 * Takes the whole `storageAdapter` (never a `storageAdapter.listObjects`
 * reference held in a bare variable) and always calls it as
 * `storageAdapter.listObjects(...)` — extracting the method into a
 * standalone reference detaches it from its `this`, which broke a real
 * `StorageAdapter` implementation that reads instance state internally
 * (caught by `SYNC-008`'s pipeline test, not by any unit test using a
 * `this`-free vi.fn() double).
 */
async function fetchListObjects(
  storageAdapter: StorageAdapter,
  args: ListMode,
  projectId: string | undefined,
  stderr: NodeJS.WritableStream,
): Promise<ListObjectsResult | undefined> {
  if (!storageAdapter.listObjects) {
    stderr.write('Error: the configured storage adapter does not support listing objects.\n');
    return undefined;
  }
  try {
    if (args.mode === 'all-projects') return await storageAdapter.listObjects({});
    if (args.mode === 'session' || args.mode === 'path') {
      return await storageAdapter.listObjects({
        projectId: projectId as string,
        sessionId: args.sessionId,
      });
    }
    return await storageAdapter.listObjects({ projectId: projectId as string });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    stderr.write(`Error listing objects: ${message}\n`);
    return undefined;
  }
}

/** Dispatch a fetched `ListObjectsResult` to the mode-appropriate renderer. */
function renderListResult(
  args: ListMode,
  result: ListObjectsResult,
  projectId: string | undefined,
  stdout: NodeJS.WritableStream,
): number {
  if (args.mode === 'all-projects') return renderAllProjects(result, stdout);
  if (args.mode === 'current' || args.mode === 'project') {
    return renderProjectSessions(result, projectId, stdout);
  }
  return renderSessionFiles(
    result,
    {
      projectId: args.projectId,
      sessionId: args.sessionId,
      path: args.mode === 'path' ? args.path : undefined,
    },
    stdout,
  );
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
 *
 * Hoisted (#354) from `claude-session-sync`/`devin-session-sync`. Carries no
 * harness-specific rendering — restructured onto devin's already-decomposed
 * shape (`renderAllProjects`/`renderProjectSessions`/`renderSessionFiles`/
 * `resolveListStorageAdapter`/`resolveProjectId`, plus `fetchListObjects`/
 * `renderListResult` splitting the fetch-then-render tail out of this
 * function) rather than claude's pre-hoist single ~157-line inline `switch`, per
 * `.agents/rules/workspace-rules.md`'s 20/30-line function cap.
 */
export async function runListCommand(
  adapter: CliHarnessAdapter,
  argv: string[] = [],
  options: ListCommandOptions = {},
): Promise<number> {
  const args = parseListArgs(argv);
  if ('error' in args) {
    (options.stderr ?? process.stderr).write(`${args.error}\n`);
    return 1;
  }

  const cwd = options.cwd ?? process.cwd();
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const env = options.env ?? (await resolveCliEnv(adapter, cwd));

  const projectId = resolveProjectId(args, env);
  if (args.mode === 'current' && !projectId) {
    stderr.write('Error: SAL_PROJECT_ID is required for `list --current`.\n');
    return 1;
  }

  const storageAdapter = await resolveListStorageAdapter(adapter, args, env, cwd, options, stderr);
  if (!storageAdapter) return 1;

  const result = await fetchListObjects(storageAdapter, args, projectId, stderr);
  if (!result) return 1;

  return renderListResult(args, result, projectId, stdout);
}
