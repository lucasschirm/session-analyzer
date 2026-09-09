# src/

Claude Code plugin adapter for the `@lucasschirm/sal-sync` session data sync engine.

**#354 update:** `cli/env.ts`, `cli/config.ts`, `cli/logger.ts`,
`cli/remove-command.ts`, `cli/download-command.ts`, `cli/list-command.ts`,
`cli/migrate-command.ts`, and `cli.ts` are now thin wrappers around
`@lucasschirm/sal-sync`'s shared, harness-parameterized CLI implementation
(hoisted out of this plugin and `devin-session-sync`, which had copy-pasted
~1.5-2k lines of it), bound to this file's new `claude-cli-adapter.ts`. The
behavior documented below is unchanged; see `cli/AGENTS.md` and
`packages/sync/src/cli/AGENTS.md` for where the logic now actually lives.

## Environment Resolution

All entry points in this plugin resolve environment variables through a single
shared function: **`resolveCliEnv`** (`cli/env.ts`). This function implements
the Claude Code settings precedence ladder:

```
~/.claude/settings.json        (user-global, lowest precedence)
.claude/settings.json           (project, committed)
.claude/settings.local.json     (project-local, gitignored)
process.env (ENV)               (highest precedence)
```

Only the `env` key of each settings file is read. Non-string values are
silently skipped. Missing or malformed files are silently ignored. A variable
set in a higher-precedence source always overrides the same key from a lower
one; non-overlapping keys accumulate across all sources.

**Security blocklist:** `SAL_STORAGE_ENDPOINT`, `SAL_STORAGE_ACCESS_KEY_ID`,
and `SAL_STORAGE_SECRET_ACCESS_KEY` are **never** read from the committed
settings files (`settings.json` or `~/.claude/settings.json`). They are only
honored from `process.env` or `.claude/settings.local.json` (gitignored). This
prevents a malicious PR from redirecting uploads to an attacker-controlled
endpoint. See `cli/AGENTS.md` for full details.

**Every entry point** — the `claude-sync` CLI commands (sync, list, download,
remove, migrate) and the Claude Code hooks (session-start, session-end, hook,
transcript-watcher) — calls `resolveCliEnv(cwd, process.env)` in its `main()`
function before passing the resolved env to the sync engine. The `cwd` is
taken from the Claude Code hook input when available, falling back to
`process.cwd()`.

Never bypass `resolveCliEnv` by passing raw `process.env` to the sync engine —
this would skip the settings files and miss user-configured `SAL_*` variables.

See **`cli/AGENTS.md`** for the detailed documentation of the env resolution
behavior, the blocklist, and regression prevention notes.

## Files

- **claude.ts** — Claude Code hook input parsing (`parseClaudeHookInput`), harness session mapping (`toHarnessSession`), and sync trigger mapping (`claudeEventToSyncTrigger`). Defines `ClaudeHookInput` with `session_id`, `transcript_path`, `cwd`, `hook_event_name`, etc. `readStdin` is re-exported here from `@lucasschirm/sal-sync` (hoisted, #354; zero Claude-specific content).
- **claude-cli-adapter.ts** — `ClaudeCliAdapter`: this plugin's `CliHarnessAdapter` (#354), parameterizing the shared CLI with Claude's binary/package naming, `.claude/settings*.json` config paths, help text, and — most importantly — the `migrateManifestHarness` literal `'claude-code'` (deliberately NOT `ClaudeHarnessProfile.harness`; see this file's doc comment).
- **cli.ts** — Standalone `claude-sync` CLI entry point: dispatches to `sync`, `list`, `download`, `remove`, `migrate` subcommands. Thin wrapper (#354) around `@lucasschirm/sal-sync`'s `createCliMain(ClaudeCliAdapter, ...)`.
- **is-main-module.ts** — Re-exports `isMainModule` from `@lucasschirm/sal-sync` (hoisted, #354; zero Claude-specific content).
- **cli/env.ts** — `resolveCliEnv(cwd, processEnv)`: the single shared environment resolver. Reads `~/.claude/settings.json`, `.claude/settings.json`, `.claude/settings.local.json` (in that order), then overlays `processEnv` on top. Used by every entry point in the plugin. See `cli/AGENTS.md` for full documentation.
- **cli/AGENTS.md** — Detailed documentation of the env resolution behavior, precedence ladder, security blocklist, and regression prevention notes.
- **cli/config.ts** — `validateCliConfig` / `validateStorageConfig`: validate the merged environment and produce a `SyncConfig` or a human-readable error with `export` examples for missing variables.
- **cli/logger.ts** — Error log writer for unhandled command aborts. Resolves the log folder from `CLAUDE_SYNC_LOG_PATH_FOLDER` (default: the `logs/` subfolder of the sync data dir from the shared `getDataDir` helper, i.e. `~/.sal-sync/logs`), writes a timestamped `<command>-log-<timestamp>.log` with the full stack trace and chained causes, and produces the user-facing `claude-sync: aborted. Check log in <path>` message. Called from the top-level catch in `cli.ts`.
- **cli/sync-command.ts** — `claude-sync sync` command: full capture + upload.
- **cli/list-command.ts** — `claude-sync list` command: list projects/sessions/files in storage.
- **cli/download-command.ts** — `claude-sync download` command: download sessions from storage.
- **cli/remove-command.ts** — `claude-sync remove` command: remove project/session objects from storage (never touches shared `global/cas/` content).
- **cli/project.ts** — `resolveClaudeProjectDir`, `listLocalSessions`, `encodeProjectFolder`/`decodeProjectFolder` helpers.
- **session-start.ts** — `SessionStart` hook handler: parses hook input, resolves env via `resolveCliEnv`, records session metadata, spawns a detached transcript watcher, and performs the initial bulk upload.
- **session-end.ts** — `SessionEnd` hook handler: parses hook input, resolves env via `resolveCliEnv`, performs the final budgeted delta sync, uploads a session manifest, and surfaces a summary to stderr.
- **hook.ts** — Generic hook handler (PreCompact, PostCompact, Stop, StopFailure, SubagentStop): parses hook input, resolves env via `resolveCliEnv`, and fires a capture.
- **transcript-watcher.ts** — Detached watcher process entry point: resolves env via `resolveCliEnv`, then delegates to `watchTranscripts` from the sync engine.
- **index.ts** — Barrel re-exporting all public APIs.

## Key relationships

- All hooks and CLI commands call `resolveCliEnv` from `cli/env.ts` to merge settings files with `process.env` before passing the result to the sync engine.
- `session-start.ts` spawns `transcript-watcher.ts` as a detached child process; the watcher inherits the resolved env from its parent.
- `cli/config.ts` validates the merged env and delegates to `@lucasschirm/sal-sync`'s `loadConfig` for value validation.
- All sync operations go through `@lucasschirm/sal-sync`'s CLI helpers (`capture`, `sessionStart`, `sessionEnd`, `watch`).
