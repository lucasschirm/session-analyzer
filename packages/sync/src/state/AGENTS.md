# state/

Durable, filesystem-backed queue and concurrency control for the sync engine.

## Files

- **lock.ts** — File-based advisory locks with O_EXCL create, stale-lock recovery via `process.kill(pid, 0)`, and an in-process promise queue to serialize same-process callers.
- **state.ts** — `StateStore` and pure artifact-state helpers: read/write `state/state.json`, read/write `sessions/<id>/session.json`, atomic temp+fsync+rename writes, and corruption recovery.
- **index.ts** — Module barrel re-exporting the public lock and state APIs.
- **AGENTS.md** — This file.

## Key relationships

- `state.ts` uses `FileLock` from `lock.ts` to guard `state.json` and per-session `session.json`.
- `writeFileAtomic` in `state.ts` writes to a `.tmp` file, fsyncs it, and renames it into place.
- `recordArtifact*` helpers in `state.ts` mutate an in-memory `SyncState`; callers use `StateStore.withState` for persistence under the global lock.
