# ADR-0004: Manifests are the authority for artifact classification

**Status:** Accepted

**Date:** 2026-08-24

**Plan reference:** `docs/superpowers/plans/2026-08-24-analytics-data-platform-design.md` §4.6 (Manifests are artifact authority), §7.1 (Descriptor and classification)

## Context

Synced sessions arrive with a manifest that declares artifact ownership, paths,
hashes, scopes, and status. The system must classify each artifact into a
canonical kind (Skill, Agent, Rule, MCP, Settings, transcript, Sub Agent, etc.)
to build configuration snapshots, lifecycle events, and component ecosystems.

If classification relied on content inspection alone, identical bytes could be
misclassified depending on context — the same markdown file could be a Rule in
one path and an Agent definition in another. Content-based classification also
cannot distinguish scope (session vs. workspace vs. global) or determine which
session observed the artifact.

The current manifest v2 does not prove an exhaustive configuration snapshot and
therefore cannot prove removal. A manifest v3 revision is planned to add
finality, deterministic sequence, tombstones, and per-category discovery
completeness.

## Decision

Manifests are the authority for artifact ownership, source identity, hash,
status, and collector coverage. The versioned harness artifact classifier is
the authority for semantic kind. Neither may infer absent configuration from an
incomplete inventory.

Classification derives from:

1. **Manifest harness identity** — takes precedence over schema detection.
2. **Manifest scope** — `session`, `workspace`, `global`, or `runtime`.
3. **Full relative path** — normalized and matched against harness-specific
   path rules (e.g., `.claude/skills/<name>/SKILL.md` → Skill).
4. **Structured content** — when a path matches, structured content may yield
   multiple component definitions with source pointers.

Classification belongs to the manifest artifact reference, not the content blob.
Identical bytes can be a Rule in one path and another artifact kind elsewhere.
CAS object placement is a transport concern resolved through sync-core; it is
not semantic ownership.

For manual imports, explicitly supplied artifacts may be classified, but the
snapshot remains partial. A manual upload does not create a synthetic complete
manifest, infer absent components, or establish offered-component denominators.

Older manifests remain authoritative for the artifacts they list but produce
partial configuration snapshots. Manifest v3 is a prerequisite for
lifecycle-removal and offered-versus-unused metrics.

## Consequences

**Positive:**

- Classification is deterministic from manifest context and path rules, not
  heuristic content inspection.
- Scope is preserved: a global artifact is correctly observed by sessions in
  many projects, while a workspace artifact belongs to its project/workspace
  exposure.
- Manual imports are honestly labeled as partial — no fabricated completeness.
- The classifier is versioned and harness-specific, enabling evolution without
  breaking historical classifications.

**Negative:**

- Manifest v2 limitations mean lifecycle-removal and offered-versus-unused
  metrics are not available until manifest v3 is deployed.
- Classification depends on correct manifest harness identity; an incorrect
  harness declaration would misclassify artifacts.
- Path rules must be maintained per harness as conventions evolve.

**Neutral:**

- The manifest is authoritative for ownership and coverage; the classifier is
  authoritative for semantic kind. This separation allows each to evolve
  independently.

## Alternatives

**Content-based classification.** Rejected because identical bytes can have
different semantic kinds depending on path and scope. Content inspection alone
cannot determine scope or which session observed the artifact.

**File extension-based classification.** Rejected because detection is
schema-based, never extension-based — this is a fundamental principle of the
platform. Extensions are unreliable across harnesses and platforms.

**Inferring absent configuration from incomplete inventory.** Rejected because
it fabricates completeness. A partial snapshot must remain partial; absence
from a listing is unknown, not removal. Only an authoritative tombstone
triggers source deletion.

**Synthetic manifest for manual imports.** Rejected because it would fabricate
configuration completeness, infer absent components, and establish
offered-component denominators that don't exist. Manual sessions store only
supplied evidence.
