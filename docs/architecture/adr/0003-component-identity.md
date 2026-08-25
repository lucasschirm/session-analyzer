# ADR-0003: Component identity uses kind/owner/integration/native-id, not display name

**Status:** Accepted

**Date:** 2026-08-24

**Plan reference:** `docs/superpowers/plans/2026-08-24-analytics-data-platform-design.md` §4.5 (Portfolio is the top analytical scope), §7.2 (Scope and identity)

## Context

The platform models a portfolio-wide component ecosystem above projects:
Tools, Skills, Agents, Rules, MCP servers, plugins, settings, models, and
versions. Components are shared across projects, sessions, and harnesses.

If component identity relied on display name, the system would conflate
distinct components that happen to share a name (e.g., a "formatter" Skill in
two different projects, or a "filesystem" Tool offered by different MCP
servers). It would also fail to link the same component across harness
migrations or rename events where the display name changed but the underlying
identity did not.

Cross-harness comparison requires a stable identity that survives display-name
changes, path renames, and harness-specific naming conventions. Display-name
equality is insufficient for lifecycle tracking, utilization analysis, and
before/after cohorts.

## Decision

Component identity uses a composite key of:

- **kind** — canonical component kind (tool, skill, agent, rule, mcp_server,
  plugin, setting, model, version)
- **owner/provider** — the component's owner or provider
- **integration/plugin** — the integration or plugin that contributes it
- **native ID** — the source-native identifier when available
- **canonical source identity** — stable source identity (path, hash, or
  structured pointer)

Display-name equality is explicitly insufficient for identity. Cross-harness
equivalence uses an explicit alias edge with source and confidence
(`component_aliases` table). A component rename is a remove/add event unless
native or VCS identity proves continuity. Same-name cross-harness components
maintain separate identities unless an explicit alias exists.

Components are portfolio-level identities first. Projects and sessions
reference scoped installations and versions; they do not own duplicate
component identities. Installation, lifecycle, and exposure remain
environment-scoped.

## Consequences

**Positive:**

- Lifecycle tracking is accurate: a renamed component is correctly identified
  as a remove/add unless continuity is proven.
- Cross-harness comparison is explicit: aliases are declared with source and
  confidence, not inferred from name similarity.
- Utilization analysis correctly attributes usage to the same component across
  projects and sessions.
- Before/after cohorts compare the right component versions.

**Negative:**

- Identity resolution is more complex than a simple name lookup.
- Alias maintenance requires explicit effort when harnesses are migrated or
  components are renamed.
- Users may expect same-name components to be linked; the system requires
  explicit alias declaration.

**Neutral:**

- The `component_aliases` table records source and confidence for each alias,
  enabling audit and future confidence-based merging.

## Alternatives

**Display-name equality.** Rejected because it conflates distinct components
that share a name and fails to link the same component across renames or
harness migrations. It produces false positives in lifecycle tracking and false
negatives in utilization analysis.

**Path-based identity.** Rejected because paths are scope-dependent (a global
artifact vs. a workspace artifact can have the same relative path) and
case-sensitivity varies across filesystems. Path is a component of identity but
not the sole key.

**Hash-based identity.** Rejected as the sole key because content hashes
change on every version update, making lifecycle tracking impossible. Hashes
are used for version identity (`component_versions`), not component identity.

**Auto-inferred aliases from name similarity.** Rejected because it produces
unreliable equivalences. Aliases must be explicit with source and confidence.
