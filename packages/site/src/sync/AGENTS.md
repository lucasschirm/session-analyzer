# sync/

Remote sync orchestration. Downloaded session buffers are retained by the analytics worker via `analyticsClient.retainSyncArtifact`.

## Files

- **credential-crypto.ts** — Encrypts and decrypts S3 credential fields stored in the project record using the user's passkey.
- **sync-manager.ts** — Main-thread sync state machine: project/session discovery, worker queue, manifest diffing, and lifecycle hooks (`onWarning` wired to `toast-container.ts` for real-time toast notifications, and `onRunSummary` for failed-run toasts). Missing project manifests without an `onProjectMissing` handler now push a warning instead of being silently skipped.
- **sync-protocol.ts** — Typed WebWorker messages exchanged between `SyncManager` and `session-sync.worker.ts`.

## Key relationships

- `sync-manager.ts` uses `db/db-client.ts` methods for project and session sync-state persistence.
- `sync-manager.ts` uses `credential-crypto.ts` to unlock S3 credentials before building a fetch client.
