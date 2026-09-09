---
globs: "packages/plugins/**,packages/transformers/**"
---

# Harness Plugins Pass Conformance

**When to use this rule:**

- When adding or modifying a harness transformer plugin (e.g. `packages/transformers/claude-transformer`) or the transformer conformance suite under `packages/transformers/transformer-shared`.

**Invariants (non-negotiable):**

- Every harness plugin must pass the transformer conformance suite against golden fixtures before it can be registered or released.
- A plugin that fails conformance is not a valid transformer and must not be loaded by `packages/db` ingestion.
- Conformance covers: artifact classification, identity/turns/messages/requests normalization, token usage, invocations, payloads, permissions, modes, hooks, and Phase 1 metric derivation.
- Golden fixtures are versioned; updating a fixture requires a conformance suite update and a recorded reason.
- CI must run the conformance suite for every plugin on every PR; a failing plugin blocks merge.
