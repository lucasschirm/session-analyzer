import * as fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { checkbox } from '@inquirer/prompts';
import { minimatch } from 'minimatch';

import { getDataDir } from '../common.js';
import { resolveCliEnv } from '../env.js';
import type { CliHarnessAdapter } from '../harness-adapter.js';

// ---------------------------------------------------------------------------
// Config file
// ---------------------------------------------------------------------------

/** Per-project workdir config stored at `<dataDir>/projects/<projectId>/config.json`. */
export interface WorkdirConfig {
  /** Working directory patterns (exact paths or globs like `/path/to/worktrees/*`). */
  workdirs: string[];
}

/** Resolves the per-project workdir config file path. */
export function workdirConfigPath(dataDir: string, projectId: string): string {
  return path.join(dataDir, 'projects', projectId, 'config.json');
}

/** Reads the per-project workdir config, returning an empty config if missing. */
export async function readWorkdirConfig(
  dataDir: string,
  projectId: string,
): Promise<WorkdirConfig> {
  const configPath = workdirConfigPath(dataDir, projectId);
  try {
    const raw = await fsp.readFile(configPath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { workdirs: [] };
    }
    const workdirs = (parsed as { workdirs?: unknown }).workdirs;
    if (!Array.isArray(workdirs)) return { workdirs: [] };
    return { workdirs: workdirs.filter((w): w is string => typeof w === 'string') };
  } catch {
    return { workdirs: [] };
  }
}

/** Writes the per-project workdir config, creating parent dirs as needed. */
export async function writeWorkdirConfig(
  dataDir: string,
  projectId: string,
  config: WorkdirConfig,
): Promise<void> {
  const configPath = workdirConfigPath(dataDir, projectId);
  await fsp.mkdir(path.dirname(configPath), { recursive: true });
  await fsp.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

// ---------------------------------------------------------------------------
// Path resolution & matching
// ---------------------------------------------------------------------------

/**
 * Resolves a user-supplied path to an absolute, normalized form.
 *
 * - `.` and `./` resolve to `process.cwd()` (or the supplied `cwd`).
 * - `~` and `~/...` resolve to the home directory.
 * - Relative paths resolve against `cwd`.
 * - Paths containing glob characters (`*`, `?`, `[`) are kept as-is after
 *   `~`/relative resolution — the glob metacharacters are part of the
 *   pattern, not a filesystem path to stat.
 * - Trailing slashes are stripped (except for root `/`).
 */
export function resolveWorkdirPath(input: string, cwd: string = process.cwd()): string {
  let resolved = input;
  // Expand ~ to home
  if (resolved === '~') {
    resolved = os.homedir();
  } else if (resolved.startsWith('~/')) {
    resolved = path.join(os.homedir(), resolved.slice(2));
  }
  // Resolve relative paths (but not glob patterns — those stay relative to cwd)
  if (!path.isAbsolute(resolved)) {
    resolved = path.resolve(cwd, resolved);
  }
  // Normalize and strip trailing slash (except root)
  resolved = path.normalize(resolved);
  if (resolved.length > 1 && resolved.endsWith('/')) {
    resolved = resolved.slice(0, -1);
  }
  return resolved;
}

/** True if a path contains glob metacharacters (`*`, `?`, `[`). */
export function isGlobPattern(input: string): boolean {
  return /[*?[]/.test(input);
}

/**
 * Tests whether a session's `working_directory` matches any of the
 * configured workdir patterns. Exact paths match after normalization;
 * glob patterns (containing `*`, `?`, `[`) match via `minimatch`.
 */
export function workdirMatches(workdir: string, patterns: readonly string[]): boolean {
  const normalized = path.normalize(workdir).replace(/\/+$/, '');
  for (const pattern of patterns) {
    if (isGlobPattern(pattern)) {
      if (minimatch(normalized, pattern, { dot: false })) return true;
    } else {
      const normalizedPattern = path.normalize(pattern).replace(/\/+$/, '');
      if (normalized === normalizedPattern) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Command options
// ---------------------------------------------------------------------------

export interface WorkdirCommandOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  homeDir?: string;
  sessionsDbPath?: string;
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

async function runWorkdirList(
  adapter: CliHarnessAdapter,
  options: WorkdirCommandOptions,
): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? (await resolveCliEnv(adapter, cwd));
  const dataDir = getDataDir(env);
  const projectId = env.SAL_PROJECT_ID;
  const configured = projectId ? await readWorkdirConfig(dataDir, projectId) : { workdirs: [] };
  const configuredSet = new Set(configured.workdirs);

  stdout.write('Working directories:\n\n');

  if (adapter.listAvailableWorkdirs) {
    try {
      const available = await adapter.listAvailableWorkdirs({
        env,
        cwd,
        homeDir: options.homeDir,
        sessionsDbPath: options.sessionsDbPath,
      });
      if (available.length === 0) {
        stdout.write('  (no sessions found in session store)\n');
      } else {
        for (const dir of available) {
          const mark = configuredSet.has(dir) ? ' [configured]' : '';
          stdout.write(`  ${dir}${mark}\n`);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      stdout.write(`  (could not read session store: ${message})\n`);
    }
  }

  // Show configured patterns that don't appear in the session store (e.g. globs)
  if (adapter.listAvailableWorkdirs) {
    const available = await adapter
      .listAvailableWorkdirs({
        env,
        cwd,
        homeDir: options.homeDir,
        sessionsDbPath: options.sessionsDbPath,
      })
      .catch(() => [] as string[]);
    const availableSet = new Set(available);
    const extra = configured.workdirs.filter((w) => !availableSet.has(w));
    if (extra.length > 0) {
      stdout.write('\nConfigured patterns not in session store:\n\n');
      for (const dir of extra) {
        stdout.write(`  ${dir} [configured]\n`);
      }
    }
  } else if (configured.workdirs.length > 0) {
    stdout.write('\nConfigured working directories:\n\n');
    for (const dir of configured.workdirs) {
      stdout.write(`  ${dir} [configured]\n`);
    }
  }

  if (configured.workdirs.length === 0 && !adapter.listAvailableWorkdirs) {
    stdout.write('  (no working directories configured)\n');
  }

  stdout.write(
    `\nUse \`${adapter.binName} workdir add\` to configure working directories for this project.\n`,
  );
  return 0;
}

async function runWorkdirAdd(
  adapter: CliHarnessAdapter,
  args: string[],
  options: WorkdirCommandOptions,
): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? (await resolveCliEnv(adapter, cwd));
  const dataDir = getDataDir(env);
  const projectId = env.SAL_PROJECT_ID;

  if (!projectId) {
    stderr.write('Error: SAL_PROJECT_ID is required to configure working directories.\n');
    stderr.write('Set it via environment variable or config file before running this command.\n');
    return 1;
  }

  const config = await readWorkdirConfig(dataDir, projectId);

  if (args.length > 0) {
    // Manual add: resolve each path and add to config
    for (const arg of args) {
      const resolved = resolveWorkdirPath(arg, cwd);
      if (!config.workdirs.includes(resolved)) {
        config.workdirs.push(resolved);
        stdout.write(`Added: ${resolved}\n`);
      } else {
        stdout.write(`Already configured: ${resolved}\n`);
      }
    }
    await writeWorkdirConfig(dataDir, projectId, config);
    stdout.write(
      `\nProject "${projectId}" now has ${config.workdirs.length} working directory pattern(s).\n`,
    );
    return 0;
  }

  // Interactive: show checkbox with available workdirs from session store
  if (!adapter.listAvailableWorkdirs) {
    stderr.write(
      'Error: interactive workdir selection requires a session store. Provide a path argument instead:\n' +
        `  ${adapter.binName} workdir add <path>\n` +
        `  ${adapter.binName} workdir add /path/to/worktrees/*\n`,
    );
    return 1;
  }

  let available: string[];
  try {
    available = await adapter.listAvailableWorkdirs({
      env,
      cwd,
      homeDir: options.homeDir,
      sessionsDbPath: options.sessionsDbPath,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    stderr.write(`Error: could not read session store: ${message}\n`);
    return 1;
  }

  if (available.length === 0) {
    stdout.write('No working directories found in the session store.\n');
    stdout.write(`Add one manually: ${adapter.binName} workdir add <path>\n`);
    return 0;
  }

  const configuredSet = new Set(config.workdirs);
  const choices = available.map((dir) => ({
    name: dir,
    value: dir,
    checked: configuredSet.has(dir),
  }));

  const selected = await checkbox({
    message: 'Select working directories to map to this project:',
    choices,
  });

  // Merge: keep configured patterns that weren't in the available list (e.g. globs),
  // then add the newly selected ones.
  const availableSet = new Set(available);
  const kept = config.workdirs.filter((w) => !availableSet.has(w));
  const newWorkdirs = [...kept, ...selected];

  await writeWorkdirConfig(dataDir, projectId, { workdirs: newWorkdirs });
  stdout.write(
    `\nProject "${projectId}" now has ${newWorkdirs.length} working directory pattern(s).\n`,
  );
  return 0;
}

async function runWorkdirRemove(
  adapter: CliHarnessAdapter,
  args: string[],
  options: WorkdirCommandOptions,
): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? (await resolveCliEnv(adapter, cwd));
  const dataDir = getDataDir(env);
  const projectId = env.SAL_PROJECT_ID;

  if (!projectId) {
    stderr.write('Error: SAL_PROJECT_ID is required to manage working directories.\n');
    return 1;
  }

  if (args.length === 0) {
    stderr.write(`Usage: ${adapter.binName} workdir remove <path>\n`);
    return 1;
  }

  const config = await readWorkdirConfig(dataDir, projectId);
  const toRemove = new Set(args.map((a) => resolveWorkdirPath(a, cwd)));
  const before = config.workdirs.length;
  config.workdirs = config.workdirs.filter((w) => !toRemove.has(w));
  const removed = before - config.workdirs.length;

  if (removed === 0) {
    stdout.write('No matching working directories found in config.\n');
    return 0;
  }

  await writeWorkdirConfig(dataDir, projectId, config);
  stdout.write(`Removed ${removed} working directory pattern(s).\n`);
  stdout.write(
    `Project "${projectId}" now has ${config.workdirs.length} working directory pattern(s).\n`,
  );
  return 0;
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/**
 * Harness-parameterized `workdir` command: manage which working directories
 * are mapped to the current `SAL_PROJECT_ID`.
 *
 * Subcommands:
 *   workdir list                          List all working directories from the
 *                                         session store + configured patterns.
 *   workdir add                           Interactive checkbox selection (requires
 *                                         adapter.listAvailableWorkdirs).
 *   workdir add <path>                    Add a path (resolves `.`, `~`, relative).
 *   workdir add /path/to/worktrees/*      Add a glob pattern (wildcard match).
 *   workdir remove <path>                 Remove a working directory from config.
 *
 * Config is stored at `<dataDir>/projects/<SAL_PROJECT_ID>/config.json`.
 */
export async function runWorkdirCommand(
  adapter: CliHarnessAdapter,
  argv: string[],
  options: WorkdirCommandOptions = {},
): Promise<number> {
  const [subcommand, ...rest] = argv;

  if (!subcommand || subcommand === '-h' || subcommand === '--help') {
    const stdout = options.stdout ?? process.stdout;
    stdout.write(
      `Usage: ${adapter.binName} workdir <subcommand> [options]\n\n` +
        'Subcommands:\n' +
        '  list                          List working directories from session store + config\n' +
        '  add [path]                    Add a working directory (interactive if no path)\n' +
        '  add /path/to/worktrees/*      Add a glob/wildcard pattern\n' +
        '  remove <path>                 Remove a working directory from config\n',
    );
    return 0;
  }

  switch (subcommand) {
    case 'list':
      return runWorkdirList(adapter, options);
    case 'add':
      return runWorkdirAdd(adapter, rest, options);
    case 'remove':
      return runWorkdirRemove(adapter, rest, options);
    default: {
      const stderr = options.stderr ?? process.stderr;
      stderr.write(`Unknown workdir subcommand: ${subcommand}\n`);
      stderr.write(`Run \`${adapter.binName} workdir --help\` for usage.\n`);
      return 1;
    }
  }
}
