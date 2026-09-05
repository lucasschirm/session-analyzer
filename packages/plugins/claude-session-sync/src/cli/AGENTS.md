# cli/

CLI subcommands and shared helpers for the `claude-sync` plugin.

**#354 update:** the actual command/env/config/logger/dispatch
*implementations* now live in `@lucasschirm/sal-sync`'s
`packages/sync/src/cli/` (shared with `devin-session-sync`, and any future
harness plugin). Every file in this directory is now a **thin wrapper**: it
imports the shared, harness-parameterized function and binds it to
`../claude-cli-adapter.js`'s `ClaudeCliAdapter`, re-exporting under the exact
same name/signature (minus the leading `adapter` parameter) this plugin's own
tests assert on directly. This directory's own doc content below describes
*this plugin's specific behavior* (Claude's config paths, its
`migrateManifestHarness` literal, its blocklist) — see
`packages/sync/src/cli/AGENTS.md` for the shared implementation and the
regression-prevention testing strategy that now spans both plugins.

## Environment Resolution — Single Source of Truth

**`resolveCliEnv`** in `env.ts` is the **only** function that reads Claude Code
settings files and merges them with `process.env`. Every entry point in the
plugin — every CLI command and every Claude Code hook — MUST call it before
passing configuration to the sync engine. Never bypass it by passing raw
`process.env` to `@lucasschirm/sal-sync` helpers; that would silently skip
user-configured `SAL_*` variables from settings files.

As of #354, this plugin's `env.ts` is a thin wrapper around
`@lucasschirm/sal-sync`'s shared `resolveCliEnv(adapter, cwd, processEnv,
blocklist)`, bound to `ClaudeCliAdapter` (whose `resolveConfigPaths` returns
this plugin's `.claude/settings*.json` paths and whose `profile` is
`ClaudeHarnessProfile`, supplying the default blocklist below). The
precedence ladder and blocklist behavior described in this file are
unchanged — only the implementation's location moved.

### Precedence Ladder (highest → lowest)

```
1. process.env                         (real environment variables — always win)
2. .claude/settings.local.json  "env"  (project-local, gitignored)
3. .claude/settings.json        "env"  (project, committed to git)
4. ~/.claude/settings.json      "env"  (user-global, committed to git)
```

A variable set in a higher-precedence source is never overwritten by a lower
one. Non-overlapping keys accumulate across all sources. Only the `env` key
of each settings file is read; non-string values are silently skipped; missing
or malformed files are silently ignored.

This matches Claude Code's own resolution order and the spread semantics
`{ ...global, ...project, ...local, ...ENV }`.

### Security Blocklist (credential keys)

Three keys are **blocked** from the committed settings files
(`settings.json` and `~/.claude/settings.json`):

| Blocked Key | Reason |
|-------------|--------|
| `SAL_STORAGE_ENDPOINT` | A malicious endpoint in a committed file could redirect uploads (and the requester's real credentials) to an attacker-controlled server. |
| `SAL_STORAGE_ACCESS_KEY_ID` | Credentials must never be committed to git. |
| `SAL_STORAGE_SECRET_ACCESS_KEY` | Credentials must never be committed to git. |

These keys are only honored from `process.env` or
`.claude/settings.local.json` (which is gitignored). All other `SAL_*`
variables (project id, storage type, bucket, region, timeouts, limits, etc.)
follow the full precedence ladder without restriction.

**This blocklist is intentional and must not be removed.** It was introduced
in commit `9d71ce6` after a security review. It was accidentally lost during
the `461cc73` refactor and re-introduced via a merge — that regression must
not happen again. If you refactor `env.ts`, the blocklist tests in
`tests/unit/env.test.ts` will catch its removal.

### Call Sites

Every entry point calls `resolveCliEnv(cwd, process.env)` in its `main()`
function:

| Entry point | File | How it gets `cwd` |
|-------------|------|-------------------|
| `claude-sync sync` | `sync-command.ts` | `process.cwd()` |
| `claude-sync list` | `list-command.ts` | `process.cwd()` |
| `claude-sync download` | `download-command.ts` | `process.cwd()` |
| `claude-sync remove` | `remove-command.ts` | `process.cwd()` |
| `claude-sync migrate` | `migrate-command.ts` | `process.cwd()` |
| `SessionStart` hook | `session-start.ts` | `parsed.input.cwd` from hook stdin |
| `SessionEnd` hook | `session-end.ts` | `parsed.input.cwd` from hook stdin |
| Generic hook | `hook.ts` | `parsed.input.cwd` from hook stdin |
| Transcript watcher | `transcript-watcher.ts` | `process.cwd()` |

## Files

All of the following (except `project.ts`, which is Claude-specific local
session discovery, and `sync-command.ts`, which has genuinely different
business logic from Devin's) are now thin wrappers around
`@lucasschirm/sal-sync`'s shared implementation, bound to `../claude-cli-adapter.js`'s
`ClaudeCliAdapter`. See `packages/sync/src/cli/AGENTS.md` for what each
shared function actually does.

- **env.ts** — `resolveCliEnv(cwd, processEnv, blocklist?)`: wraps the shared
  `resolveCliEnv(adapter, ...)`. This is still the ONLY place this plugin
  reads settings files.
- **config.ts** — `validateCliConfig` / `validateStorageConfig`: wraps the
  shared `validateCliConfig`/`validateStorageConfig(adapter, ...)`, which use
  `ClaudeCliAdapter.packageName` (`@lucasschirm/claude-session-sync`) and
  `ClaudeCliAdapter.localConfigDisplayPath` (`.claude/settings.local.json`)
  in the generated error text.
- **logger.ts** — Error log writer for unhandled command aborts. Wraps the
  shared logger, bound to `ClaudeCliAdapter.logFolderEnvVar`
  (`CLAUDE_SYNC_LOG_PATH_FOLDER`) and `ClaudeCliAdapter.binName`
  (`claude-sync`, used in the `<command>-log-<timestamp>.log` filename and
  the `claude-sync: aborted...` abort message). Used by the top-level catch
  handler in `cli.ts`. Not a sensitive variable — the log-folder env var is
  read from `process.env` directly (not via `resolveCliEnv`) so logging still
  works when settings-file resolution itself is what aborted.
- **sync-command.ts** — `claude-sync sync` command: full capture + upload.
  Genuinely Claude-specific business logic — NOT part of the #354 hoist.
- **list-command.ts** — `claude-sync list` command: list projects/sessions/files.
- **download-command.ts** — `claude-sync download` command: download
  sessions, including the path-traversal guard (`buildLocalPath` in the
  shared implementation).
- **remove-command.ts** — `claude-sync remove` command: remove project/session objects.
- **migrate-command.ts** — `claude-sync migrate` command: migrate old-format
  S3 keys and backfill missing manifests with `harness: 'claude-code'` (the
  `ClaudeCliAdapter.migrateManifestHarness` literal — see
  `../claude-cli-adapter.ts`'s doc comment for why this is deliberately NOT
  `ClaudeHarnessProfile.harness`).
- **project.ts** — `resolveClaudeProjectDir`, `listLocalSessions`, project
  folder helpers. Claude-specific — NOT part of the #354 hoist.

`../cli.ts` (the `claude-sync` bin entry point) is likewise now a thin
wrapper around `@lucasschirm/sal-sync`'s `createCliMain`, supplying
`ClaudeCliAdapter` (for `HELP_TEXT`), this directory's command wrappers, and
its own `readPackageVersion()` (which must stay here — it resolves this
plugin's own `package.json`).

## Regression Prevention

This is the second time the env resolution has regressed. To prevent a
third — now made structurally harder by #354, since the actual
precedence/blocklist logic has a single implementation shared with every
harness plugin (`packages/sync/src/cli/env.ts`) rather than one copy per
plugin that could each drift independently:

1. **All settings reading goes through `resolveCliEnv`** — no exceptions.
2. **The blocklist is tested** in `tests/unit/env.test.ts` (this plugin,
   unchanged call signature) and in
   `packages/sync/tests/unit/cli/env.test.ts` (shared, parameterized across
   both harnesses' config-path shapes) — if the blocklist is removed from the
   shared implementation, both fail.
3. **This AGENTS.md and `packages/sync/src/cli/AGENTS.md` document the full
   behavior** — refactors must preserve both the precedence ladder and the
   blocklist.
4. **The HELP_TEXT in `../claude-cli-adapter.ts` documents the precedence** —
   users can see where variables are read from.
