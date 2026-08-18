# cli/

CLI entry points and shared helpers for the sal-sync engine.

## Files

- **capture.ts** — Fire-and-forget hook handler that discovers, sanitizes, hashes, and uploads a delta for a single event.
- **common.ts** — Shared CLI helpers: config resolution, hook input parsing, validation, full/delta sync loops, and telemetry emission.
- **index.ts** — Barrel re-exporting all command modules and common helpers.
- **run.ts** — Default program runner that dispatches to the appropriate command from `process.argv`.
- **session-end.ts** — Performs the final budgeted delta sync, uploads a session manifest, and tears down the watcher.
- **session-start.ts** — Records session metadata, spawns a detached watcher, and performs the initial bulk upload.
- **status.ts** — Reports durable session/sync state, watcher liveness, and pending upload size.
- **sync.ts** — Manual full capture + upload + manifest command.
- **watch.ts** — Long-running watcher process entry point that calls a supplied watcher implementation.

## Key relationships

- `run.ts` dispatches to `capture.ts`, `session-start.ts`, `session-end.ts`, `sync.ts`, `watch.ts`, and `status.ts`.
- All commands build on helpers in `common.ts` for input parsing, storage adapter construction, and telemetry.
- `session-start.ts` and `session-end.ts` coordinate via `StateStore` and per-session `FileLock` files.
