# cli/

CLI subcommands and shared helpers for the `devin-sync` plugin.

As of #354, `env.ts`/`config.ts`/`logger.ts`/`remove-command.ts`/
`download-command.ts`/`list-command.ts`/`migrate-command.ts` are thin
wrappers around `@lucasschirm/sal-sync`'s shared, harness-parameterized CLI
implementation (`packages/sync/src/cli/`), bound to `../devin-cli-adapter.js`'s
`DevinCliAdapter`. Each wrapper imports the shared function and re-exports it
under the exact same name/signature (minus the leading `adapter` parameter)
this plugin's own tests assert on directly. `../cli.ts` (the `devin-sync` bin
entry point) is likewise a thin wrapper around the shared `createCliMain`.
`sync-command.ts` and `project.ts` are genuinely Devin-specific business
logic and are NOT part of the #354 hoist. See
`packages/sync/src/cli/AGENTS.md` for what each shared function actually
does, and `claude-session-sync/src/cli/AGENTS.md` for the full history of
the env-resolution security blocklist this shared implementation now carries
for both harnesses (regressed twice before in that plugin: commits
`9d71ce6`/`461cc73`).

## Files

- **env.ts** — `resolveCliEnv(cwd, processEnv, blocklist?)`: wraps the shared
  `resolveCliEnv(adapter, ...)`, bound to `DevinCliAdapter`, whose
  `resolveConfigPaths` returns `.devin/config.local.json` /
  `.devin/config.json` (project) / `~/.config/devin/config.json`
  (user-global — note the 3-segment shape, one more than Claude's
  `~/.claude/settings.json`, which is exactly why `resolveConfigPaths` is a
  function and not a shared string template).
- **config.ts** — `validateCliConfig` / `validateStorageConfig`: wraps the
  shared functions, using `DevinCliAdapter.packageName`
  (`@lucasschirm/devin-session-sync`) and `DevinCliAdapter.localConfigDisplayPath`
  (`.devin/config.local.json`) in the generated error text.
- **logger.ts** — Error log writer for unhandled command aborts. Wraps the
  shared logger, bound to `DevinCliAdapter.logFolderEnvVar`
  (`DEVIN_SYNC_LOG_PATH_FOLDER`) and `DevinCliAdapter.binName` (`devin-sync`).
- **sync-command.ts** — `devin-sync sync` command: full capture + upload.
  Genuinely Devin-specific business logic — NOT part of the #354 hoist.
- **list-command.ts** — `devin-sync list` command: list projects/sessions/files.
- **download-command.ts** — `devin-sync download` command: download
  sessions, including the path-traversal guard (`buildLocalPath` in the
  shared implementation) — `tests/cli/download-command.test.ts`'s
  `refuses to write outside the output directory...` test closed a real
  coverage gap in this plugin's pre-#354 suite (the equivalent assertion
  already existed in `claude-session-sync`).
- **remove-command.ts** — `devin-sync remove` command: remove project/session objects.
- **migrate-command.ts** — `devin-sync migrate` command: migrate old-format
  S3 keys and backfill missing manifests with `harness:
  DevinHarnessProfile.harness` (`'devin'`) — the `DevinCliAdapter.migrateManifestHarness`
  field, correctly profile-derived (the DS-B5 #143 pattern). This is the
  opposite sourcing from `ClaudeCliAdapter.migrateManifestHarness`
  (a literal, `'claude-code'`) — see `../devin-cli-adapter.ts`'s doc comment
  for why the two are deliberately asymmetric and must never be unified.
- **project.ts** — `filterSessionsForCwd`, `listDevinSessions`. Devin-specific
  — NOT part of the #354 hoist.
