---
globs: "packages/transformer/**,packages/plugins/**"
---

# Transformers Never Write SQLite

**When to use this rule:**

- When implementing or extending a transformer plugin or its conformance fixtures under `packages/transformer` or `packages/plugins`.

**Invariants (non-negotiable):**

- Transformers are pure functions from native artifacts to canonical normalized records. They never open, write to, or import a SQLite runtime.
- A transformer must not depend on `db-core`, `db`, or any SQLite adapter.
- Persistence is the responsibility of `packages/db` ingestion, which receives transformer output and writes via `db-core` stores.
- Transformer tests use in-memory fixtures and assertions on canonical record shapes — never a database.
- A plugin that writes SQLite fails conformance and must not be registered.
