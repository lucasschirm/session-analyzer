import {
  CAPTURE_ALLOWLIST,
  CLAUDE_SESSION_LAYOUT,
  type HarnessProfile,
  resolveClaudeConfigDir,
} from '@lucasschirm/sal-sync';

export const CLAUDE_HARNESS = 'claude' as const;
export const CLAUDE_HARNESS_VERSION = '0.1.0';

/**
 * `.claude/settings.json` and `~/.claude/settings.json` are typically
 * committed to git, unlike `settings.local.json`. Credentials and the
 * storage endpoint must never be sourced from a file anyone with
 * commit/PR access can edit — a malicious `SAL_STORAGE_ENDPOINT` there
 * could silently redirect session uploads (and the requester's real
 * credentials) to an attacker-controlled server. These keys are only
 * ever honored from `process.env` or `settings.local.json` — see
 * `resolveCliEnv` in `./cli/env.js`, which consumes this list via
 * `ClaudeHarnessProfile.securityBlocklist` instead of a private constant.
 */
const CLAUDE_SECURITY_BLOCKLIST: readonly string[] = [
  'SAL_STORAGE_ENDPOINT',
  'SAL_STORAGE_ACCESS_KEY_ID',
  'SAL_STORAGE_SECRET_ACCESS_KEY',
];

/**
 * Concrete `HarnessProfile` for Claude Code, threaded into the sal-sync
 * engine's discovery/watcher entry points by this plugin's hook/CLI call
 * sites (`claude.ts`, `cli.ts`, `cli/env.ts`, `cli/sync-command.ts`) instead
 * of relying on the engine's ambient Claude-shaped defaults.
 *
 * Location decision (DS-F1 #156): this lives in `claude-session-sync`
 * (Option B from the issue), not in `sync-core`. `sync-core` must stay
 * isomorphic (it is consumed by `packages/site` in the browser and has zero
 * Node runtime dependencies today, enforced by
 * `sync-core/tests/unit/node-import-guard.test.ts`), but `configDir` here
 * needs `node:os`/`node:path` (via `resolveClaudeConfigDir`). Placing the
 * concrete profile in `sync-core` would have required either introducing a
 * Node dependency there or duplicating config-dir resolution. Placing it in
 * `claude-session-sync` is also symmetric with DS-F3 (#158)'s planned
 * `DevinHarnessProfile`, which is planned to live in `devin-session-sync`.
 * `packages/sync`'s own golden-behavior discovery tests do not need this
 * exact object — they build an equivalent profile from `CAPTURE_ALLOWLIST` +
 * `CLAUDE_SESSION_LAYOUT` (both already re-exported by `@lucasschirm/sal-sync`),
 * so `packages/sync` never needs a devDependency on this plugin package
 * (which would otherwise be circular, since this package already depends on
 * `@lucasschirm/sal-sync`).
 */
export const ClaudeHarnessProfile: HarnessProfile = {
  harness: CLAUDE_HARNESS,
  harnessVersion: CLAUDE_HARNESS_VERSION,
  configDir: (env: Record<string, string | undefined>) => resolveClaudeConfigDir(env),
  captureAllowlist: CAPTURE_ALLOWLIST,
  sessionLayout: CLAUDE_SESSION_LAYOUT,
  securityBlocklist: CLAUDE_SECURITY_BLOCKLIST,
};
