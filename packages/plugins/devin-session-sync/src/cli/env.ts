import process from 'node:process';

import { resolveCliEnv as sharedResolveCliEnv } from '@lucasschirm/sal-sync';

import { DevinCliAdapter } from '../devin-cli-adapter.js';

/**
 * Precedence ladder for Devin CLI environment resolution (highest → lowest):
 *
 * ```
 *   process.env (ENV)
 *   .devin/config.local.json  "env"  (project-local, expected gitignored)
 *   .devin/config.json         "env"  (project, may be committed, blocklist applies)
 *   ~/.config/devin/config.json "env" (user-global, trusted — no blocklist)
 * ```
 *
 * Mirrors `claude-session-sync`'s `resolveCliEnv` precedence and blocklist
 * pattern (see that module's `cli/AGENTS.md` for the full regression
 * history this guards against — commits `9d71ce6`/`461cc73`). Credentials
 * and the storage endpoint are never read from a project file plausibly
 * committed to git; `process.env`, the gitignored
 * `.devin/config.local.json` override, or the user-global
 * `~/.config/devin/config.json` (a personal machine file — trusted via
 * `DevinCliAdapter.userGlobalEnvBlocklist`) may supply them.
 *
 * This is the single shared function every entry point in this plugin must
 * call — every `devin-sync` CLI command and every Devin hook (session-start,
 * hook, session-end, watcher).
 *
 * Hoisted (#354) to `@lucasschirm/sal-sync`'s harness-parameterized
 * `resolveCliEnv(adapter, cwd, processEnv, blocklist)` — this wrapper binds
 * it to `DevinCliAdapter` and preserves the exact
 * `resolveCliEnv(cwd?, processEnv?, blocklist?)` signature `tests/cli/env.test.ts`
 * asserts on directly.
 */
export async function resolveCliEnv(
  cwd: string = process.cwd(),
  processEnv: Record<string, string | undefined> = process.env,
  blocklist: readonly string[] = DevinCliAdapter.profile.securityBlocklist,
): Promise<Record<string, string | undefined>> {
  return sharedResolveCliEnv(DevinCliAdapter, cwd, processEnv, blocklist);
}
