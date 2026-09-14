import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Inputs needed to resolve Devin CLI's XDG data root. Deliberately minimal
 * (no dependency beyond `node:path`) so both `extractor/paths.ts` and
 * `devin-profile.ts` can import this module without pulling in the rest of
 * either's unrelated concerns.
 */
export interface XdgDataRootEnv {
  /** `$XDG_DATA_HOME`, if set. */
  xdgDataHome?: string;
  /** The current user's home directory. */
  home: string;
}

/**
 * Candidate base directories that may hold the Devin CLI data root
 * (`<base>/devin/cli/sessions.db`). The first candidate whose
 * `devin/cli/sessions.db` actually exists on disk wins.
 *
 * 1. `$XDG_DATA_HOME` — the XDG spec default, when explicitly set.
 * 2. `~/.local/share` — the XDG spec default when `$XDG_DATA_HOME` is unset.
 * 3. `~/.devin-xdg-data` — the Orca-installed Devin CLI wrapper's data root.
 *    The wrapper (`/home/lucas/.local/bin/devin`) exports
 *    `XDG_DATA_HOME="$HOME/.devin-xdg-data"` before exec'ing the real
 *    binary, so Devin stores its database there even though the variable
 *    is not set in the user's shell profile. Without this fallback,
 *    `devin-sync` (run from a regular terminal where `XDG_DATA_HOME` is
 *    unset) would look in `~/.local/share/devin/cli/` and fail.
 */
export function candidateDataRoots(env: XdgDataRootEnv): string[] {
  const roots: string[] = [];
  if (env.xdgDataHome && env.xdgDataHome.trim().length > 0) {
    roots.push(env.xdgDataHome);
  }
  roots.push(join(env.home, '.local', 'share'));
  roots.push(join(env.home, '.devin-xdg-data'));
  return roots;
}

/**
 * Resolves the Devin CLI data root (`<base>/devin/cli`), probing candidate
 * base directories in precedence order and returning the first whose
 * `devin/cli/sessions.db` actually exists on disk. If none exists, returns
 * the XDG default (`~/.local/share/devin/cli`) so the caller's error
 * message points at the spec-compliant path.
 *
 * This is the single source of truth for the Devin XDG data root — both
 * the extractor's `resolveDevinPaths` and `HarnessProfile.configDir`
 * resolve through it.
 *
 * @param env - the environment to resolve from
 * @param existsFn - injectable filesystem check (defaults to `existsSync`)
 */
export function resolveDevinDataRoot(
  env: XdgDataRootEnv,
  existsFn: (path: string) => boolean = existsSync,
): string {
  for (const base of candidateDataRoots(env)) {
    const root = join(base, 'devin', 'cli');
    if (existsFn(join(root, 'sessions.db'))) {
      return root;
    }
  }
  // None of the candidates exist — fall back to the XDG default so the
  // caller's error message points at the spec-compliant path.
  const hasXdg = env.xdgDataHome && env.xdgDataHome.trim().length > 0;
  const fallbackBase = hasXdg ? env.xdgDataHome! : join(env.home, '.local', 'share');
  return join(fallbackBase, 'devin', 'cli');
}
