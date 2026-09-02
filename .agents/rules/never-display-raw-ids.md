---
globs: "packages/site/src/**,packages/site/tests/**,packages/db/src/**,packages/db/tests/**"
---

# Never Display Raw Internal IDs to End Users

**When to use this rule:**

- When implementing or changing any UI surface (Lit component, page, chart,
  table, metric card, tooltip, toast, evidence link label) that renders an
  entity reference to the user, or any DTO field that feeds such a surface.
- When building or modifying an analytics view (`packages/db/src/analytics*.ts`)
  that returns entity references destined for display.

**Invariants (non-negotiable):**

- Internal identifiers (component ids like `comp-7b749f662cc27c79`, session
  ids, project ids, generation ids, store primary keys, hash-derived
  deterministic ids) must never be shown to end users as the primary label for
  the thing they refer to.
- Always resolve the best available human-friendly label before rendering:
  - For components: use `componentDisplayName(kind, nativeId, displayName, id)`
    — prefer `kind/nativeId` (e.g. `skill/multi-issue-agent`), then
    `kind/displayName`, then `kind/id` only as a last-resort data-quality
    signal.
  - For sessions: use the session title / ai-title when available, falling
    back to a short timestamped summary, never the raw session uuid.
  - For projects: use the project `name`, never the project id.
  - For other entities: prefer the dedicated `name`/`label`/`title` field,
    falling back to a derived summary, never the primary key.
- DTO fields named `*Id` are for routing, correlation, and evidence links —
  not for direct display. If a field is rendered to the user, it must be a
  resolved label field (`name`, `label`, `displayName`, or a composed label).
- A raw id may appear in a tooltip, copy-to-clipboard affordance, or developer
  diagnostics surface only when the primary visible label is already shown
  alongside it — never as the sole representation.
- Tests that assert on rendered entity references must assert on the resolved
  label, not the raw id, so a regression to id-as-label is caught.

**Why:**

- Internal ids are opaque, unstable across re-ingestion, and meaningless to the
  user. Showing them is both a UX defect and a signal that the label
  resolution step was skipped somewhere in the data path.
