import type { HarnessProfile } from '@lucasschirm/sal-sync-core';

/**
 * Resolved on-disk paths for a harness's three-tier CLI config precedence
 * ladder (highest to lowest, excluding `process.env`, which always wins
 * regardless of these paths):
 *
 * ```
 *   local      (project-local override, gitignored, no blocklist)
 *   project    (project-wide, may be committed, blocklist applies)
 *   userGlobal (user-global, may be committed, blocklist applies)
 * ```
 */
export interface CliConfigPaths {
  /** Project-local override, gitignored, never blocklisted (e.g. `<cwd>/.claude/settings.local.json`). */
  local: string;
  /** Project-wide, may be committed to git, blocklist applies (e.g. `<cwd>/.claude/settings.json`). */
  project: string;
  /** User-global, may be committed to git, blocklist applies (e.g. `~/.claude/settings.json`). */
  userGlobal: string;
}

/**
 * Parameterizes the shared `@lucasschirm/sal-sync` CLI (env resolution,
 * config validation, error logging, and the remove/download/list/migrate
 * commands) for one harness plugin (`claude-session-sync`,
 * `devin-session-sync`, ...). Composes the isomorphic `HarnessProfile`
 * (discovery/watcher/blocklist data, shared with the sync engine itself)
 * with CLI-only concerns that have no meaning outside a command-line
 * entry point: binary naming, npm package naming, config file paths, and
 * the manifest `harness` literal `migrate --manifests` backfills.
 *
 * See `packages/plugins/claude-session-sync/src/claude-cli-adapter.ts` and
 * `packages/plugins/devin-session-sync/src/devin-cli-adapter.ts` for the two
 * concrete instances.
 */
export interface CliHarnessAdapter {
  /** The isomorphic harness profile consumed by discovery/the watcher/the blocklist default. */
  profile: HarnessProfile;
  /** CLI binary name used in usage/log/abort messages, e.g. `'claude-sync'`. */
  binName: string;
  /**
   * Published npm package name used in config-error `npx` examples, e.g.
   * `'@lucasschirm/claude-session-sync'`. Distinct from `binName` — the
   * package publishes two bin aliases, but only one canonical package name.
   */
  packageName: string;
  /** Env var name that overrides the error-log folder, e.g. `'CLAUDE_SYNC_LOG_PATH_FOLDER'`. */
  logFolderEnvVar: string;
  /**
   * Resolve this harness's three-tier CLI config file paths. A FUNCTION
   * rather than a string template: path *shape*, not just naming, differs
   * per harness — e.g. Claude's user-global config is `~/.claude/settings.json`
   * (one directory segment under home) while Devin's is
   * `~/.config/devin/config.json` (two directory segments under home). A
   * template interpolating a single "harness name" segment cannot express
   * that difference.
   */
  resolveConfigPaths(cwd: string, homedir: string): CliConfigPaths;
  /** Human-readable local-override path shown in config-error messages, e.g. `'.claude/settings.local.json'`. */
  localConfigDisplayPath: string;
  /**
   * The `harness` literal written into manifests backfilled by
   * `migrate --manifests`.
   *
   * NEVER derive this from `profile.harness` — the two are deliberately
   * independent for reasons specific to each harness:
   *
   * - Claude: `'claude-code'`, NOT `profile.harness` (`'claude'`). Required
   *   because `packages/db`'s `classifyManifestArtifact` does an *exact
   *   string match* on the literal `'claude-code'` to run Claude-specific
   *   artifact classification. Changing this to `profile.harness` would
   *   silently degrade every migrated Claude session's artifacts to
   *   `unclassified` — see `ClaudeCliAdapter`'s doc comment.
   * - Devin: correctly `profile.harness` (`'devin'`) — Devin has no
   *   equivalent legacy string mismatch, so it sources this field from the
   *   profile directly (the DS-B5 pattern also used by Devin's `sync`
   *   command). See `DevinCliAdapter`'s doc comment.
   *
   * A hoist must preserve each harness's own sourcing pattern rather than
   * unifying them — they encode different, harness-specific facts.
   */
  migrateManifestHarness: string;
  /** Full help text for `<bin> --help` / `<bin> -h` / no-args. */
  helpText: string;
}
