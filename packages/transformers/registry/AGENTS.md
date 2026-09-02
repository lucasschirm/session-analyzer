# packages/transformers/registry/

Default `TransformerRegistry` composition root for the Session Analyzer
analytics platform.

Package name: `@lucasschirm/sal-transformer-registry`

This package exists so that adding a new transformer plugin package (e.g. a
future `devin-transformer`, DS-F7 / #149) means registering it in one place —
`src/default-registry.ts` — rather than touching every consumer
(`packages/site/src/db/analytics-worker.ts`, and the ~15 `packages/db` test
files that previously imported `createDefaultRegistry` from the pre-split
`packages/transformer`).

## Source layout

```
src/
├── index.ts                # Public barrel export
└── default-registry.ts     # createDefaultRegistry() — composes every transformer plugin package
```

## Test layout

```
tests/unit/
└── default-registry.test.ts   # Asserts the default registry resolves the claude-code and claude harness aliases
```

## Key relationships

- Depends on `@lucasschirm/sal-transformer-shared` for `TransformerRegistry`.
- Depends on `@lucasschirm/sal-claude-transformer` for `ClaudeCodeTransformer`
  (and, in future, every other transformer plugin package it composes).
- Imported by `packages/site/src/db/analytics-worker.ts` (the production
  composition root) and by `packages/db` tests that need a fully-composed
  registry.
- Does not import `db-core`, `db`, `site`, or any SQLite/runtime module.
