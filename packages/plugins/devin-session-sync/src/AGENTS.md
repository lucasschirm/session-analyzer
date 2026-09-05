# src/

Devin CLI plugin adapter for the `@lucasschirm/sal-sync` session data sync
engine. This doc predates the plugin manifest/hooks/`devin-sync` CLI/esbuild
bin wiring landing (DS-F3, issue #158) and still only documents the
`extractor/` module below; see `cli/AGENTS.md` for the CLI surface.

**#354 update:** `devin-cli-adapter.ts` (new) is this plugin's
`CliHarnessAdapter`, parameterizing `@lucasschirm/sal-sync`'s shared CLI
implementation (hoisted out of this plugin and `claude-session-sync`, which
had copy-pasted ~1.5-2k lines of this plugin's CLI) with Devin's binary/
package naming, `.devin`/`~/.config/devin` config paths, help text, and the
`migrateManifestHarness` field (correctly `DevinHarnessProfile.harness` —
see that file's doc comment). `cli/env.ts`, `cli/config.ts`, `cli/logger.ts`,
`cli/remove-command.ts`, `cli/download-command.ts`, `cli/list-command.ts`,
`cli/migrate-command.ts`, `cli.ts`, and `is-main-module.ts` are now thin
wrappers around that shared implementation — see `cli/AGENTS.md`.

## extractor/

Reads Devin CLI's `~/.local/share/devin/cli/sessions.db` (or
`$XDG_DATA_HOME/devin/cli/sessions.db`) and produces deterministic, ordered
`devin-session-jsonl/v1` lines. Read-only SQL against this third-party
database is permitted here under the carve-out in
`.agents/rules/sql-only-in-db-core.md` — never writes, and never this
product's own SQLite.

- `paths.ts` — resolves the Devin CLI data root and probes (never requires)
  optional companion locations (`~/.devin`, `~/.codeium`, `~/.windsurf`,
  project-scoped `.devin`/`.windsurf`).
- `schema-registry.ts` — maps the `refinery_schema_history` ledger's max
  version to a known table/column shape. Only refinery version 16 is
  verified (devin 3000.6.7); any other observed version degrades to a
  reduced table set (drops `tool_call_state` first) with warnings, and
  never throws.
- `reader.ts` — `node:sqlite` `DatabaseSync` access only, no native
  dependency. `assertSqliteAvailable` guards against Node versions where
  `DatabaseSync` isn't unflagged-available (<22.13/23.4) and fails with a
  clear, user-visible `DevinSqliteUnavailableError` rather than a silent
  no-op. `openDevinDatabase` opens read-only against the live path first
  (verified WAL-safe against a concurrent writer); falls back to a
  snapshot copy of `sessions.db`+`-wal`+`-shm` if that fails.
  `computeSchemaDescriptor` builds the `native/schema-descriptor.json`
  content (caller-supplied Devin CLI version + refinery migration ledger +
  per-table DDL checksums) that DS-F3 writes into the plugin's artifact set.
- `jsonl-writer.ts` — pure transformation from raw table rows to ordered
  JSONL lines; no DB access. `orderMessageNodes` is the key algorithm: a
  deterministic topological sort of the `node_id`/`parent_node_id` tree
  (Kahn's algorithm, ready-set tie-broken by ascending `node_id`) —
  **never `created_at`**, which is empirically not per-message (shared
  across every row of a session, equal to `sessions.last_activity_at`,
  because the node forest is rewritten on each persist). Tool-call rows
  are interleaved by scanning each message node's `chat_message` text for
  the `tool_call_id`; unresolved rows (including ones whose referencing
  node was read in an earlier incremental batch — resolution is scoped to
  rows read together in the same pass) are appended last, in `row_id`
  order.

## Watermarks

`DevinWatermarks` (`types.ts`) covers `message_nodes.row_id`,
`tool_call_state`'s implicit `rowid`, and `prompt_history.id`. This package
only accepts/merges/emits these values (`mergeWatermark` in
`jsonl-writer.ts` never regresses a prior watermark) — persistence is owned
by the sync engine's `StateStore` (`packages/sync/src/state/`), consumed by
DS-F3. `sessions` has no watermark: it is current-state (upserted), not
append-only, and is read in full and re-emitted every extraction pass.

## Fixtures

No binary `.db` files are checked in. `tests/extractor/fixtures/build-fixture-db.ts`
builds a real on-disk `node:sqlite` database matching the verified v16 schema
for every test.
