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
 * Resolves `$XDG_DATA_HOME/devin/cli` when set to a non-blank value, else
 * `~/.local/share/devin/cli` (the Devin CLI default data root). This is the
 * single source of truth for the Devin XDG data root — both the extractor's
 * `resolveDevinPaths` and `HarnessProfile.configDir` resolve through it.
 */
export function resolveDevinDataRoot(env: XdgDataRootEnv): string {
  const base =
    env.xdgDataHome && env.xdgDataHome.trim().length > 0
      ? env.xdgDataHome
      : join(env.home, '.local', 'share');
  return join(base, 'devin', 'cli');
}
