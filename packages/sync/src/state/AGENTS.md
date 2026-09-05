# state/

Durable, filesystem-backed queue and concurrency control for the sync engine.

## Files

- **lock.ts** — File-based advisory locks with O_EXCL create, stale-lock recovery via `process.kill(pid, 0)`, and an in-process promise queue to serialize same-process callers. Stale-lock reclaim is atomic (#327): the stale file is renamed aside to a unique name (single winner among any number of concurrent contenders — `rename` fails for everyone else once the source path is gone), its content is re-verified against what was originally judged stale, and a mismatch (a different, newer holder's lock) is restored via `link` — never `rename` — so a restore can never silently overwrite a legitimate new holder's lock. `release()` similarly re-verifies the on-disk content matches what this instance itself wrote before unlinking, so a takeover elsewhere can never cause a `release()` to destroy an unrelated holder's lock.
- **unique-id.ts** — `uniqueSuffix()`: the process-unique, collision-resistant suffix shared by `state.ts`'s atomic-write temp files and `lock.ts`'s stale-lock reclaim claim files.
- **state.ts** — `StateStore` and pure artifact-state helpers: read/write `state/state.json`, read/write `sessions/<id>/session.json`, atomic temp+fsync+rename writes, and corruption recovery.
- **index.ts** — Module barrel re-exporting the public lock and state APIs.
- **AGENTS.md** — This file.

## Key relationships

- `state.ts` uses `FileLock` from `lock.ts` to guard `state.json` and per-session `session.json`.
- `writeFileAtomic` in `state.ts` writes to a `.tmp` file, fsyncs it, and renames it into place, naming that temp file via `unique-id.ts`'s `uniqueSuffix()` — the same helper `lock.ts`'s stale-lock reclaim uses for its own claim-file names.
- `recordArtifact*` helpers in `state.ts` mutate an in-memory `SyncState`; callers use `StateStore.withState` for persistence under the global lock.
