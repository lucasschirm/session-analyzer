# cli/

CLI entry points and shared helpers for the sal-sync engine.

## Files

- **capture.ts** — Fire-and-forget hook handler that discovers, sanitizes, hashes, and uploads a delta for a single event.
- **common.ts** — Shared CLI helpers: config resolution, hook input parsing, validation, full/delta sync loops, and telemetry emission.
- **index.ts** — Barrel re-exporting all command modules and common helpers.
- **run.ts** — Default program runner (pure function, `main(argv)`) that dispatches to the appropriate command from argv. No top-level side effect — see `run-entry.ts`.
- **run-entry.ts** — Standalone, un-exported entry script that invokes `run.ts`'s `main()` and calls `process.exit`. Not re-exported through `index.ts`/the package barrel; only ever invoked directly as `node <compiled-path> <command>`.
- **session-end.ts** — Performs the final budgeted delta sync, uploads a session manifest, and tears down the watcher.
- **session-start.ts** — Records session metadata, spawns a detached watcher, and performs the initial bulk upload.
- **status.ts** — Reports durable session/sync state, watcher liveness, and pending upload size.
- **sync.ts** — Manual full capture + upload + manifest command.
- **watch.ts** — Long-running watcher process implementation (pure function, `watch(options)`) that calls a supplied watcher implementation. No top-level side effect — see `watch-entry.ts`.
- **watch-entry.ts** — Standalone, un-exported entry script that invokes `watch.ts`'s `watch()` and calls `process.exit`. Not re-exported through `index.ts`/the package barrel; only ever invoked directly as `node <compiled-path> [...args]` — this is the file `common.ts`'s `getWatchScriptPath()`/`defaultSpawnWatcher()` spawn as a detached child process.

## Key relationships

- `run.ts` dispatches to `capture.ts`, `session-start.ts`, `session-end.ts`, `sync.ts`, `watch.ts`, and `status.ts`. `run-entry.ts` is the only thing that calls `run.ts`'s `main()` as a live process.
- All commands build on helpers in `common.ts` for input parsing, storage adapter construction, and telemetry.
- `session-start.ts` and `session-end.ts` coordinate via `StateStore` and per-session `FileLock` files.
- `watch.ts` and `run.ts` are consumed as a *library* by every downstream plugin via the package barrel (`@lucasschirm/sal-sync`), so neither may carry a top-level self-invoking side effect: once bundled alongside another entry point, every merged module's `import.meta.url` collapses to the bundle's own URL, making an `import.meta.url`/`process.argv[1]` identity guard fire spuriously for the wrong entry point (see #274). `watch-entry.ts`/`run-entry.ts` hold the only process-invoking code for these two commands, and are intentionally excluded from every barrel so importing the library can never accidentally pull them in.
