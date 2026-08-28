---
globs: "packages/db/**,packages/transformer/**,packages/plugins/**"
---

# Manifest-Backed Classification Uses Harness, Scope, Path, and Hash

**When to use this rule:**

- When classifying, deduplicating, or ownership-tagging synced artifacts (sessions, subagents, transcripts, config snapshots) in db ingestion, transformer normalization, or plugin sync.

**Invariants (non-negotiable):**

- Manifest-backed artifact classification is keyed on all four of: manifest **harness**, **scope**, **path**, and content **hash**. None of the four may be dropped.
- Classification that uses fewer than these four fields is ambiguous and must not be accepted by ingestion.
- The manifest is the authority for synced artifact ownership, paths, hashes, scopes, and observing sessions; classification must not override manifest authority with heuristics.
- Tombstones and partial manifests are honored: a missing manifest field means partial/unavailable, never a default value that mimics a real classification.
- Reclassification requires a new manifest-backed record with all four fields; re-stating only some fields is not a reclassification.
