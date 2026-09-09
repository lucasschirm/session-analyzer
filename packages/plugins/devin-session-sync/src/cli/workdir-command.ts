import os from 'node:os';
import process from 'node:process';

import {
  runWorkdirCommand as sharedRunWorkdirCommand,
  type WorkdirCommandOptions,
} from '@lucasschirm/sal-sync';

import { DevinCliAdapter } from '../devin-cli-adapter.js';
import { resolveDevinPaths } from '../extractor/paths.js';
import { listWorkingDirectories, openDevinDatabase, resolveSchema } from '../extractor/reader.js';

export type { WorkdirCommandOptions, WorkdirConfig } from '@lucasschirm/sal-sync';
export {
  isGlobPattern,
  readWorkdirConfig,
  resolveWorkdirPath,
  workdirConfigPath,
  workdirMatches,
  writeWorkdirConfig,
} from '@lucasschirm/sal-sync';

/**
 * Reads all distinct `working_directory` values from Devin's `sessions.db`.
 * Used by the shared `workdir list` / `workdir add` commands via
 * `DevinCliAdapter.listAvailableWorkdirs`.
 */
export async function listDevinWorkingDirectories(options: {
  env?: Record<string, string | undefined>;
  cwd?: string;
  homeDir?: string;
  sessionsDbPath?: string;
}): Promise<string[]> {
  const env = options.env ?? process.env;
  const home = options.homeDir ?? os.homedir();
  const cwd = options.cwd ?? process.cwd();
  const dbPath =
    options.sessionsDbPath ??
    resolveDevinPaths({ xdgDataHome: env.XDG_DATA_HOME, home, cwd }).sessionsDbPath;

  const { db, close } = await openDevinDatabase(dbPath);
  try {
    const resolution = resolveSchema(db);
    return listWorkingDirectories(db, resolution);
  } finally {
    close();
  }
}

/**
 * Manage working directories mapped to the current `SAL_PROJECT_ID`.
 *
 * Subcommands:
 *   workdir list                          List working directories from sessions.db + config
 *   workdir add                           Interactive checkbox selection
 *   workdir add <path>                    Add a path (resolves `.`, `~`, relative)
 *   workdir add /path/to/worktrees/*      Add a glob/wildcard pattern
 *   workdir remove <path>                 Remove a working directory from config
 *
 * Thin wrapper around `@lucasschirm/sal-sync`'s harness-parameterized
 * `runWorkdirCommand(adapter, argv, options)`, bound to `DevinCliAdapter`.
 */
export async function runWorkdirCommand(
  argv: string[] = [],
  options: WorkdirCommandOptions = {},
): Promise<number> {
  return sharedRunWorkdirCommand(DevinCliAdapter, argv, options);
}
