# sync/

Remote sync orchestration and the file-processing bridge that turns downloaded session buffers into parsed, persisted `DashboardSession` rows.

## Files

- **credential-crypto.ts** — Encrypts and decrypts S3 credential fields stored in the project record using the user's passkey.
- **file-processing-bridge.ts** — `SyncManager` seam that dispatches main transcripts and subagent `.jsonl`/`meta.json` files to parser workers, merges completed subagent groups into the parent session, and re-applies sync mirror columns after every DB replace.
- **sync-manager.ts** — Main-thread sync state machine: project/session discovery, worker queue, manifest diffing, and lifecycle hooks (including the default `onFileDownloaded` wired to `file-processing-bridge.ts`, `onWarning` wired to `toast-container.ts` for real-time toast notifications, and `onRunSummary` for failed-run toasts). Missing project manifests without an `onProjectMissing` handler now push a warning instead of being silently skipped.
- **sync-protocol.ts** — Typed WebWorker messages exchanged between `SyncManager` and `session-sync.worker.ts`.

## Key relationships

- `sync-manager.ts` hands downloaded `ArrayBuffer`s to `file-processing-bridge.ts` via its `onFileDownloaded` seam.
- `file-processing-bridge.ts` calls `db/db-client.ts` methods for persistence and `workers/parser-client.ts` for transcript parsing.
- `sync-manager.ts` uses `credential-crypto.ts` to unlock S3 credentials before building a fetch client.
