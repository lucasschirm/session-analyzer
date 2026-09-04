import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolveDevinDataRoot } from '../xdg-data-root.js';

export { resolveDevinDataRoot } from '../xdg-data-root.js';

/** Inputs needed to resolve Devin CLI's data root — injectable for tests. */
export interface DevinPathEnv {
  /** `$XDG_DATA_HOME`, if set. */
  xdgDataHome?: string;
  /** The current user's home directory. */
  home: string;
  /** The current working directory (for project-scoped probes). */
  cwd: string;
}

/** One optional, probed-but-not-required location. */
export interface ProbedPath {
  label: string;
  path: string;
  exists: boolean;
}

export interface ResolvedDevinPaths {
  /** `<xdg-or-default>/devin/cli` — the directory holding `sessions.db`. */
  dataRoot: string;
  /** `<dataRoot>/sessions.db`. */
  sessionsDbPath: string;
  /** Optional locations probed for existence only; never required. */
  probes: ProbedPath[];
}

/**
 * Optional Devin/Windsurf/Codeium locations to probe for existence.
 * None of these are required for extraction to proceed.
 */
function optionalProbeCandidates(env: DevinPathEnv): Array<{ label: string; path: string }> {
  return [
    { label: 'home-devin', path: join(env.home, '.devin') },
    { label: 'home-devin-shared', path: join(env.home, '.devin-shared') },
    { label: 'home-codeium', path: join(env.home, '.codeium') },
    { label: 'home-windsurf', path: join(env.home, '.windsurf') },
    { label: 'project-devin', path: join(env.cwd, '.devin') },
    { label: 'project-windsurf', path: join(env.cwd, '.windsurf') },
  ];
}

/**
 * Resolves the Devin CLI data root and `sessions.db` path, and probes (but
 * never requires) the optional companion locations Devin/Codeium/Windsurf
 * may use. `existsFn` is injectable so tests don't touch the real filesystem.
 */
export function resolveDevinPaths(
  env: DevinPathEnv,
  existsFn: (path: string) => boolean = existsSync,
): ResolvedDevinPaths {
  const dataRoot = resolveDevinDataRoot(env);
  const probes = optionalProbeCandidates(env).map(({ label, path }) => ({
    label,
    path,
    exists: existsFn(path),
  }));
  return { dataRoot, sessionsDbPath: join(dataRoot, 'sessions.db'), probes };
}
