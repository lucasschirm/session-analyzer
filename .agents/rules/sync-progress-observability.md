---
globs: "packages/site/src/**,packages/sync/**,packages/plugins/**"
---

# Sync Progress Observability

**When to use this rule:**

- When implementing or changing any long-running operation surfaced to
  the user (sync, import, export, watcher, ingestion/reprocess flows at
  the UI boundary).

**Invariants (non-negotiable):**

- Every long-running operation surfaces: advancing progress, terminal
  success, and terminal failure affordances. A stall at any point must
  be observable.
- Progress events are monotonic and timestamped so that heartbeat
  assertions (distinct values in a bounded window) are meaningful.
- Hooks and remote operations must never return a success exit code on
  failure without a user-visible channel; silent-telemetry-only
  signaling is insufficient.
- On verification of a stall, E2E heartbeat assertions are part of the
  Definition of Done.
- Library seams that accept completion hooks (e.g. `onFileDownloaded`,
  `onSyncComplete`) must not silently no-op in the production wiring;
  absence of a registered handler is a product-level defect.
