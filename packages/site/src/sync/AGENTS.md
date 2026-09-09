# sync/

Remote sync orchestration. Downloaded session buffers are retained by the analytics worker via `analyticsClient.retainSyncArtifact`.

## Files

- **credential-crypto.ts** — Encrypts and decrypts S3 credential fields stored in the project record using the user's passkey.
- **sync-manager.ts** — Main-thread sync state machine: project/session discovery, worker queue, manifest diffing, and lifecycle hooks (`onWarning` wired to `toast-container.ts` for real-time toast notifications, and `onRunSummary` for failed-run toasts). Missing project manifests without an `onProjectMissing` handler now push a warning instead of being silently skipped. Snapshots track `isNew` on projects and `isNew`/`wasUpdated` on sessions for the progress bar's final-results summary. Uses a two-phase architecture: (1) discovery/consolidation reads local file hashes and sends them to the worker; (2) the worker downloads all changed files, and the main thread tracks file state in an in-memory `Map<path, SessionFileRecord>` with a `pendingRetention` `Set<string>`. File records are bulk-written to the control DB in a single transaction via `bulkUpsertSessionFiles` only after all downloads and retention work complete, before analytics ingestion starts.
- **sync-protocol.ts** — Typed WebWorker messages exchanged between `SyncManager` and `session-sync.worker.ts`.

## Key relationships

- `sync-manager.ts` uses `db/db-client.ts` methods for project and session sync-state persistence.
- `sync-manager.ts` uses `credential-crypto.ts` to unlock S3 credentials before building a fetch client.

## Session Failure Isolation Invariant

A failed session must NEVER stop the whole sync process.
- **Worker/Main-thread communication:** The worker must never hang awaiting sync decisions from the main thread (watchdogs/timeouts guard requests). The main thread must always respond with sync decisions, even when local processing or DB lookups fail.
- **No fatal escalation for session errors:** Session-scoped errors (`MANIFEST_NOT_FOUND`, `DOWNLOAD_FAILED`, `HASH_MISMATCH`, `INGEST_FAILED`, parsing failures) must never trigger `handleWorkerFatal` or kill the worker.
- **Queue continuity:** When a session fails, its status and details are recorded, `sessionsFailed` and `sessionsDone` are incremented, and the concurrency pool continues executing all remaining sessions until the run finishes cleanly.

