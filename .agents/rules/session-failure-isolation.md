---
globs: "packages/site/src/**,packages/sync/**,packages/plugins/**,packages/db/**"
---

# Session Failure Isolation

**When to use this rule:**

- When implementing, refactoring, or reviewing any session import, sync, ingestion, or parsing pipelines.

**Invariants (non-negotiable):**

- **Zero Interruption on Session Failure:** A failed session must NEVER stop the whole sync or import process.
- **Strict Isolation:** Errors occurring during manifest discovery, downloading, parsing, file downloading, artifact retention, or analytics ingestion for a specific session must always be trapped and isolated to that session.
- **Worker & Main-Thread Liveness:** Session errors must never terminate Web Workers, cause unhandled rejections that escalate to fatal worker errors, or deadlock worker concurrency pools. Watchdogs or timeouts must guard asynchronous handshakes (such as continue and sync decisions).
- **Failure Observability & Continuity:** When a session fails, its terminal failure state and error details must be persisted to the database and reflected in UI indicators. `sessionsDone` (total completed) and `sessionsFailed` must be accurately incremented, and the queue must proceed with all remaining sessions until the batch or project run completes.
