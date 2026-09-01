# cli/

CLI subcommands and shared helpers for the `claude-sync` plugin.

## Environment Resolution — Single Source of Truth

**`resolveCliEnv`** in `env.ts` is the **only** function that reads Claude Code
settings files and merges them with `process.env`. Every entry point in the
plugin — every CLI command and every Claude Code hook — MUST call it before
passing configuration to the sync engine. Never bypass it by passing raw
`process.env` to `@lucasschirm/sal-sync` helpers; that would silently skip
user-configured `SAL_*` variables from settings files.

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

- **env.ts** — `resolveCliEnv(cwd, processEnv)`: the single shared environment
  resolver. Reads settings files in precedence order (local → project → global),
  applies the security blocklist to committed files, then overlays `processEnv`.
  This is the ONLY place settings files are read.
- **config.ts** — `validateCliConfig` / `validateStorageConfig`: validate the
  merged environment and produce a `SyncConfig` or a human-readable error with
  `export` examples for missing variables.
- **sync-command.ts** — `claude-sync sync` command: full capture + upload.
- **list-command.ts** — `claude-sync list` command: list projects/sessions/files.
- **download-command.ts** — `claude-sync download` command: download sessions.
- **remove-command.ts** — `claude-sync remove` command: remove project/session objects.
- **migrate-command.ts** — `claude-sync migrate` command: migrate old-format S3 keys.
- **project.ts** — `resolveClaudeProjectDir`, `listLocalSessions`, project folder helpers.

## Regression Prevention

This is the second time the env resolution has regressed. To prevent a third:

1. **All settings reading goes through `resolveCliEnv`** — no exceptions.
2. **The blocklist is tested** in `tests/unit/env.test.ts` — if the blocklist
   is removed, tests fail.
3. **This AGENTS.md documents the full behavior** — refactors must preserve
   both the precedence ladder and the blocklist.
4. **The HELP_TEXT in `cli.ts` documents the precedence** — users can see
   where variables are read from.
