import process from 'node:process';

import { resolveCliEnv as sharedResolveCliEnv } from '@lucasschirm/sal-sync';

import { ClaudeCliAdapter } from '../claude-cli-adapter.js';

/**
 * Precedence ladder for Claude Code environment resolution (highest → lowest):
 *
 * ```
 *   process.env (ENV)
 *   .claude/settings.local.json   (project-local, gitignored)
 *   .claude/settings.json          (project, committed)
 *   ~/.claude/settings.json         (user-global, committed)
 * ```
 *
 * Process environment variables take precedence. For any variable still
 * missing, the CLI looks for `${cwd}/.claude/settings.local.json` and merges
 * in its `env` key; any variable still missing after that is filled in from
 * `${cwd}/.claude/settings.json` (project-wide settings shared by the team),
 * and finally from `~/.claude/settings.json` (user-global settings).
 *
 * Credentials and the storage endpoint are never read from either committed
 * settings file (`settings.json` or `~/.claude/settings.json`), since those
 * files are typically committed to git — see `ClaudeHarnessProfile.securityBlocklist`.
 * Only `settings.local.json` (gitignored) and `process.env` may supply them.
 *
 * Only the `env` key of each settings file is read. Non-string values are
 * silently skipped (Claude Code itself ignores them). Missing or malformed
 * files are silently ignored — the run proceeds with whatever sources are
 * available.
 *
 * This is the single shared function used by every entry point in the plugin
 * — the `claude-sync` CLI commands (sync, list, download, remove) and the
 * Claude Code hooks (session-start, session-end, hook, transcript-watcher).
 *
 * Hoisted (#354) to `@lucasschirm/sal-sync`'s harness-parameterized
 * `resolveCliEnv(adapter, cwd, processEnv, blocklist)` — this wrapper binds
 * it to `ClaudeCliAdapter` and preserves the exact
 * `resolveCliEnv(cwd?, processEnv?, blocklist?)` signature `tests/unit/env.test.ts`
 * asserts on directly. See `./AGENTS.md` for the full regression history
 * (`9d71ce6`/`461cc73`) this preserves.
 *
 * @param cwd - the project working directory (defaults to `process.cwd()`)
 * @param processEnv - the raw process environment (defaults to `process.env`)
 * @param blocklist - env var names never honored from a committed settings
 *   file; defaults to `ClaudeHarnessProfile.securityBlocklist`.
 * @returns the merged environment record
 */
export async function resolveCliEnv(
  cwd: string = process.cwd(),
  processEnv: Record<string, string | undefined> = process.env,
  blocklist: readonly string[] = ClaudeCliAdapter.profile.securityBlocklist,
): Promise<Record<string, string | undefined>> {
  return sharedResolveCliEnv(ClaudeCliAdapter, cwd, processEnv, blocklist);
}
