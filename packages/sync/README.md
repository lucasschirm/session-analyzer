# `@lucasschirm/sal-sync`

Shared, harness-agnostic session data sync engine for the Session Analyzer project.

This package captures, sanitizes, hashes, and uploads agentic coding session artifacts to an S3-compatible storage backend. It is designed to be embedded by harness-specific plugins (such as `claude-session-sync`) and can also be invoked directly through its CLI for testing or manual sync operations.

## What it does

- Discovers session artifacts in workspace and global configuration paths.
- Watches transcript JSONL files for live, byte-offset-tracked deltas.
- Sanitizes configuration files by redacting secrets, tokens, keys, and credentials.
- Computes SHA-256 hashes and uploads only changed content.
- Builds a versioned `manifest.json` that records session metadata, artifacts, and sync telemetry.
- Stores durable state locally so the engine survives process restarts and crashes.

## Install

```bash
pnpm add @lucasschirm/sal-sync
```

This package is published from `packages/sync` in the `session-analyzer` monorepo and is also used by the `claude-session-sync` plugin.

## API overview

The package exports contracts, helpers, and CLI adapters from `src/index.ts`:

| Module | Purpose |
|--------|---------|
| `manifest` | `SyncManifest` contract and `ManifestGenerator` for building and uploading manifests. |
| `artifact` | `ArtifactIdentity`, `ManifestArtifact`, and `ArtifactScope`/`ArtifactStatus` types. |
| `session` | `SessionData` telemetry contract. |
| `sync-run` | `SyncRun` and `SyncTrigger` telemetry contracts. |
| `state` | Durable `StateStore` for tracking artifact upload status and hashing progress. |
| `storage` | Storage adapter contract plus an S3-compatible adapter. |
| `discovery` | File discovery for transcripts, workspace, and global configuration. |
| `sanitization` | JSON/JSONL sanitizers and secret redaction rules. |
| `watcher` | `TranscriptWatcher` with PID files and byte-offset tracking. |
| `hashing` | SHA-256 helpers and content-aware hashing. |
| `config` | Configuration parsing and contract types. |
| `telemetry` | Metrics collection helpers. |
| `errors` | Typed `SyncErrorCode` catalog and `SyncError`/`StorageError` classes. |
| `cli` | Runnable CLI commands (`session-start`, `session-end`, `sync`, `watch`, `status`, `capture`). |

## Manifest structure

The sync engine produces a `SyncManifest` (see `src/manifest/contract.ts`):

```ts
interface SyncManifest {
  schemaVersion: number;
  projectId: string;
  sessionId: string;
  harness: string;
  harnessVersion: string;
  model?: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  endReason?: string;
  syncVersion: string;
  pluginVersion: string;
  transcriptsCaptured: boolean;
  artifacts: ManifestArtifact[];
  syncRuns: SyncRun[];
}
```

Artifacts carry an `ArtifactScope` (`session`, `workspace`, `global`, `runtime`) and an `ArtifactStatus` (`uploaded`, `failed`, `skipped`, `pending`). The manifest is regenerated from durable `StateStore` data so it always reflects the current upload state, even across process restarts.

## CLI

The package exposes a runnable CLI through `src/cli/index.ts` for local testing and plugin wiring:

```bash
node dist/cli/index.js <command> [options]
```

Commands include:

- `session-start` - Initialize a session, record telemetry, and start the transcript watcher.
- `session-end` - Stop the watcher, flush the final transcript delta, and upload the manifest.
- `sync` - Run a one-off sync for a trigger.
- `watch` - Start a persistent transcript watcher.
- `status` - Inspect local state and uploaded artifact status.
- `capture` - Manual capture utility.

CLI commands are stateless wrappers around the core library; durable state is stored in the configured `SAL_DATA_DIR`.

## Privacy and data handling

See [POLICY.md](./POLICY.md) for the complete capture, sanitization, and retention policy.

Key points:

- Only files in the versioned capture allowlist are discovered.
- Configuration files are sanitized to remove secrets, credentials, and tokens.
- Transcript files are captured raw by default and can be disabled with `SAL_CAPTURE_TRANSCRIPTS=false`.
- Synchronization can be fully disabled with `SAL_SYNC_DISABLED=true`.

## Development

From the repository root:

```bash
# Type-check
pnpm --filter @lucasschirm/sal-sync typecheck

# Lint
pnpm --filter @lucasschirm/sal-sync lint

# Run tests
pnpm --filter @lucasschirm/sal-sync test

# Run tests with coverage
pnpm --filter @lucasschirm/sal-sync test:coverage

# Build
pnpm --filter @lucasschirm/sal-sync build

# Verify (typecheck + lint + test)
pnpm --filter @lucasschirm/sal-sync verify
```

## Testing

Tests are located in `tests/` and run with Vitest:

- `tests/unit/` - Unit tests for each module.
- `tests/e2e/` - End-to-end lifecycle and failure tests.
- `tests/integration/s3.test.ts` - S3 integration tests (skipped by default).

Coverage thresholds are configured at 60% for statements, branches, functions, and lines.

## License

ISC
