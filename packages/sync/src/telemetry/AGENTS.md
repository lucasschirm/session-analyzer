# telemetry/

Structured, redacted, filesystem-backed telemetry for the sal-sync engine.

## Files

- **index.ts** — Barrel re-exporting the telemetry logger and public types.
- **metrics.ts** — `TelemetryLogger` that writes JSONL records and redacts sensitive fields before persisting.

## Key relationships

- CLI commands in `../cli/` use `TelemetryLogger` via `emitTelemetry()` in `../cli/common.ts`.
- Records are written to `<dataDir>/logs/telemetry.jsonl` by default.
