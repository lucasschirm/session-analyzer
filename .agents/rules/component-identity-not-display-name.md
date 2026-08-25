---
globs: "packages/db-core/**,packages/db/**,packages/transformer/**"
---

# Component Identity Never Relies on Display Name Alone

**When to use this rule:**

- When defining, storing, classifying, or comparing component identity (Tools, Skills, Agents, MCP servers, settings, plugins) in db-core stores, db rollups, or transformer normalization.

**Invariants (non-negotiable):**

- Component identity is never keyed or matched on display name alone. Display names are labels, not identifiers.
- Stable identity must combine the manifest harness, scope, path, and content hash (see manifest-backed classification rule) plus any native stable ID the harness provides.
- Two components with the same display name in different scopes/harnesses are distinct components.
- Renaming a component must not create a new identity or break lifecycle continuity; identity is preserved across display-name changes.
- Display name is stored as a mutable label on the component record, never as the primary or unique key.
