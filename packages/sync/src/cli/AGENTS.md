# cli/

CLI entry points and shared helpers for the sal-sync engine, including
(#354) the harness-parameterized `claude-sync`/`devin-sync`-style plugin CLI
hoisted out of `claude-session-sync`/`devin-session-sync`.

## Files

- **capture.ts** — Fire-and-forget hook handler that discovers, sanitizes, hashes, and uploads a delta for a single event.
- **commands/** — The four harness-parameterized plugin CLI commands (`remove`, `download`, `list`, `migrate`) — see below.
- **common.ts** — Shared CLI helpers: config resolution, hook input parsing, validation, full/delta sync loops, and telemetry emission.
- **config.ts** — `validateCliConfig(adapter, env, cwd?)` / `validateStorageConfig(adapter, env)`: validate the merged environment and produce a `SyncConfig` or a human-readable error with `export` examples, using `adapter.packageName`/`adapter.localConfigDisplayPath` for the example text. Hoisted (#354) from the two plugins' `cli/config.ts`.
- **create-cli.ts** — `createCliMain(adapter, commands, readVersion)`: builds a plugin's `main(argv)` (help/version/dispatch to `sync`/`list`/`download`/`remove`/`migrate`). Hoisted (#354) from the two plugins' near-identical `cli.ts`; each plugin's own `cli.ts` calls this once and keeps its own top-level `isMainModule` guard and `readPackageVersion` (which must stay plugin-local — see its doc comment).
- **env.ts** — `resolveCliEnv(adapter, cwd?, processEnv?, blocklist?)`: the harness-parameterized environment resolver. Hoisted (#354) from the two plugins' `cli/env.ts` — see "Environment Resolution" below; this is the single highest-scrutiny file in the hoist.
- **harness-adapter.ts** — `CliHarnessAdapter`/`CliConfigPaths`: the interface every plugin implements to parameterize this CLI (binary/package naming, config file paths, the `migrate --manifests` harness literal, help text). Composes the isomorphic `HarnessProfile` (`@lucasschirm/sal-sync-core`) rather than duplicating it.
- **index.ts** — Barrel re-exporting all command modules and common helpers.
- **is-main-module.ts** — `isMainModule(moduleUrl)`: true when a module was invoked directly as the entry script. Hoisted (#354) verbatim — zero harness-specific content.
- **logger.ts** — Harness-parameterized error log writer for unhandled command aborts (`resolveLogFolder`/`writeErrorLog`/`formatAbortMessage`, keyed by `adapter.logFolderEnvVar`/`adapter.binName`). Hoisted (#354) from the two plugins' `cli/logger.ts`.
- **read-stdin.ts** — `readStdin(stdin?)`: read and JSON-parse a stream, used by every plugin's hook entry points. Hoisted (#354) verbatim.
- **run.ts** — Default program runner (pure function, `main(argv)`) that dispatches to the appropriate command from argv. No top-level side effect — see `run-entry.ts`.
- **run-entry.ts** — Standalone, un-exported entry script that invokes `run.ts`'s `main()` and calls `process.exit`. Not re-exported through `index.ts`/the package barrel; only ever invoked directly as `node <compiled-path> <command>`.
- **session-end.ts** — Performs the final budgeted delta sync, uploads a session manifest, and tears down the watcher.
- **session-start.ts** — Records session metadata, spawns a detached watcher, and performs the initial bulk upload.
- **status.ts** — Reports durable session/sync state, watcher liveness, and pending upload size.
- **sync.ts** — Manual full capture + upload + manifest command.
- **watch.ts** — Long-running watcher process implementation (pure function, `watch(options)`) that calls a supplied watcher implementation. No top-level side effect — see `watch-entry.ts`.
- **watch-entry.ts** — Standalone, un-exported entry script that invokes `watch.ts`'s `watch()` and calls `process.exit`. Not re-exported through `index.ts`/the package barrel; only ever invoked directly as `node <compiled-path> [...args]` — this is the file `common.ts`'s `getWatchScriptPath()`/`defaultSpawnWatcher()` spawn as a detached child process.

## commands/ (#354 plugin-CLI hoist)

- **remove-command.ts** — `runRemoveCommand(adapter, argv, options)`: dry-run/`--yes` removal of a project's or session's S3 objects. No harness-specific data beyond env/config resolution.
- **download-command.ts** — `runDownloadCommand(adapter, argv, options)`: download session(s) from S3 to a local directory. Contains the path-traversal guard (`buildLocalPath`) that verifies a manifest-derived local path stays inside the requested output directory — SECURITY-SENSITIVE, see that function's doc comment. `adapter.binName` parameterizes the usage message.
- **list-command.ts** — `runListCommand(adapter, argv, options)`: list projects/sessions/files in storage. No harness-specific data at all.
- **migrate-command.ts** — `runMigrateCommand(adapter, argv, options)`: migrate old-format S3 keys and backfill missing manifests. `buildManifestForSession` sources the backfilled manifest's `harness` field from `adapter.migrateManifestHarness` — NEVER `adapter.profile.harness` (see that function's doc comment and `harness-adapter.ts`'s `migrateManifestHarness` field for the Claude-vs-Devin asymmetry this must never "clean up").

Each plugin (`claude-session-sync`, `devin-session-sync`) keeps its own
`src/cli/<command>.ts` as a thin wrapper: it imports the shared function from
`@lucasschirm/sal-sync`, binds its own `CliHarnessAdapter`
(`claude-cli-adapter.ts`/`devin-cli-adapter.ts`), and re-exports under the
exact same names/signatures (minus the leading `adapter` parameter) its own
tests assert on — see each plugin's `src/cli/AGENTS.md` (claude) or this
file (devin has none yet; its `cli/*.ts` files carry the same wrapper
pattern).

## Environment Resolution — Single Source of Truth (all harnesses)

`resolveCliEnv` in `env.ts` is the shared, harness-parameterized environment
resolver every plugin's `cli/env.ts` wraps. Its blocklist has regressed twice
before in `claude-session-sync` specifically (commit `9d71ce6` added it after
a security review; commit `461cc73` accidentally dropped it during a
refactor before a merge re-introduced it — see that plugin's
`src/cli/AGENTS.md` for the full history). Because this file is now the
*single* implementation behind every harness plugin, a regression here would
silently affect all of them at once — treat any change to this file as the
highest-scrutiny step in the whole CLI surface, verified by:

1. Both plugins' own `tests/**/env.test.ts` (unchanged call signatures, run
   directly against each plugin's thin `cli/env.ts` wrapper).
2. `packages/sync/tests/unit/cli/env.test.ts` — a shared parity test with two
   fixture adapters mirroring Claude's and Devin's distinct config-path
   *shapes* (2 vs 3 segments under home), proving the blocklist applies to
   both the project and user-global tiers regardless of adapter shape.

## Key relationships

- `run.ts` dispatches to `capture.ts`, `session-start.ts`, `session-end.ts`, `sync.ts`, `watch.ts`, and `status.ts`. `run-entry.ts` is the only thing that calls `run.ts`'s `main()` as a live process.
- All commands build on helpers in `common.ts` for input parsing, storage adapter construction, and telemetry.
- `session-start.ts` and `session-end.ts` coordinate via `StateStore` and per-session `FileLock` files.
- `watch.ts` and `run.ts` are consumed as a *library* by every downstream plugin via the package barrel (`@lucasschirm/sal-sync`), so neither may carry a top-level self-invoking side effect: once bundled alongside another entry point, every merged module's `import.meta.url` collapses to the bundle's own URL, making an `import.meta.url`/`process.argv[1]` identity guard fire spuriously for the wrong entry point (see #274). `watch-entry.ts`/`run-entry.ts` hold the only process-invoking code for these two commands, and are intentionally excluded from every barrel so importing the library can never accidentally pull them in. `create-cli.ts`'s `createCliMain` is safe to barrel-export despite building a plugin's `main` because it has no process-exit/self-invoking side effect itself — each plugin's own `cli.ts` retains the actual `isMainModule(import.meta.url)` guard and `process.exit` call.
- `sha256Hex` is intentionally imported from `../hashing/index.js` (this package's own synchronous implementation) inside `commands/migrate-command.ts`, never from `@lucasschirm/sal-sync-core` directly — that package also exports an isomorphic *async* `sha256Hex` under the same name (see `packages/sync/src/index.ts`'s doc comment), which would silently produce a `Promise<string>` where a `string` is required.
