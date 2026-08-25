# Architecture Decision Records

Architecture Decision Records (ADRs) capture the rationale behind significant
architectural decisions in the Session Analyzer analytics platform.

## Index

| ADR | Title | Status |
|-----|-------|--------|
| [0001](0001-package-boundaries.md) | Package boundaries: db-core, transformer, db as separate packages | Accepted |
| [0002](0002-typed-facts-rollups.md) | Precomputed rollups over read-time aggregation | Accepted |
| [0003](0003-component-identity.md) | Component identity uses kind/owner/integration/native-id, not display name | Accepted |
| [0004](0004-manifest-authority.md) | Manifests are the authority for artifact classification | Accepted |
| [0005](0005-source-retention.md) | Deleting source blobs doesn't delete normalized evidence | Accepted |
| [0006](0006-metric-versioning.md) | Metric meaning changes require versioning | Accepted |
| [0007](0007-fresh-database-rollout.md) | Fresh activation with rollback window | Accepted |

## Template

See [`template.md`](template.md) for the ADR template.

## Relationships

- Plans cite ADRs/specs; tasks cite plan sections; discoveries feed changes
  back into rules and skills.
- Each ADR references the plan section(s) that motivated it.
- When a decision is superseded, update the ADR's status to `Superseded` and
  link to the superseding ADR.
