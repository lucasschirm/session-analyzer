---
name: filterable-table-pattern
description: Use when building or extending a client-side list/table view over rows already loaded in memory (a session's tool_executions, events, or messages) that needs interactive filtering, row expand-to-detail, or both. Covers filter controls, in-memory .filter() state, expand-on-click, and flagging error rows.
---

# Filterable Table Pattern (client-side filters + row expand)

## When to use

- When building or extending a list/table view that renders an array of
  rows the component already holds in memory (e.g. a session's
  `tool_executions`, `events`, or `messages`), and the view needs
  interactive filtering, a row-level expand-to-detail interaction, or both.
- Typical candidates in this codebase: event/evidence tables on the Session
  Evidence pages (`packages/site/src/pages/session-evidence/`), or a future
  drill-down/list page with more than a handful of rows.

**Closest live precedent:** `packages/site/src/pages/session-evidence/session-evidence-evidence.ts`
(the metadata-cell preview/full split). Read it before building a new
filtered table — reuse its shape rather than inventing a new one.

## Filtering: plain in-memory `.filter()`, not a query

- If the rows are already loaded client-side (the common case for a
  session-scoped drill-down page - the whole session was fetched once),
  filtering is a plain array `.filter()` over `@state()`-held filter values,
  recomputed on every render. Do **not** introduce a DB query, a debounce
  timer, or an async round-trip for this - the data set is already local and
  small enough that recomputing on each render is free.
- Each filter control gets its own `@state()` field (e.g. `toolNameFilter`,
  `toolErrorsOnlyFilter`, `toolTextFilter`). The filter predicate combines
  them with logical AND, short-circuiting on the cheapest checks first
  (exact-match dropdown, then boolean checkbox, then substring search).
- Filters must update the rendered table live as the user types or toggles
  - bind `@input`/`@change` directly to the `@state()` field, no submit
    button, no "Apply" step.
- Free-text search matches case-insensitively across every field a user
  would plausibly search by (e.g. name, stringified structured
  fields, and any free-form result/description text) - normalize both sides
  with `.toLowerCase()`.

## Controls

- **Dropdown** (`<select>`) for filtering to one value out of a small,
  data-derived set - populate its `<option>`s from
  `Array.from(new Set(rows.map(...))).sort()` over the *unfiltered* row
  list, so the option set doesn't shrink as other filters narrow the table.
- **Checkbox** for a boolean narrow-down (e.g. "errors only").
- **Text input** for the free-text substring filter.
- Combine controls in a single flex-wrapped toolbar directly above the
  table; optionally show a `filtered.length of total.length` counter so the
  effect of active filters is visible at a glance.

## Row expand-on-click for detail

- Track expanded row ids in an `@state() private expandedIds = new Set<string>()`
  (or a page-specific name like `expandedToolIds`), toggled by a method that
  clones the set, adds/removes the id, and reassigns it (Lit only re-renders
  on identity change, so mutate a copy, never the set in place).
- Clicking a row (or a dedicated cell, depending on how much of the row
  should be clickable) toggles membership in that set; the expanded detail
  renders as an extra row (`colspan` across all columns) or an inline block
  directly under/in the clicked row, showing whatever full detail doesn't
  fit in the collapsed view (raw inputs, full result text, full JSON, ...).
  The `.metadata-cell` / `.metadata-preview` / `.metadata-full` split
  (truncated one-line preview vs. a scrollable `<pre>` with the full
  pretty-printed content, plus a `title` attribute carrying the full content
  for a native hover tooltip) is the baseline version of this; extend it to
  a whole expandable row when there's more than one field of detail to show
  (inputs *and* result).
- Pretty-print structured detail with `JSON.stringify(value, null, 2)` inside
  a `<pre>` with `white-space: pre-wrap; word-break: break-word` and a
  `max-height` + `overflow-y: auto`, so one huge value can't blow out page
  layout.

## Flagging exceptional rows

- When a row can be in a "bad" state worth spotting without opening it
  (e.g. `success === false`), make that visible on the collapsed row itself
  - a badge/icon in its own column *and* a row-level background tint (a
    `tool-row-error`-style modifier class applied conditionally). Don't rely
    on the expanded detail alone to surface failures; a user scanning the
    table should see them without clicking through every row.

## Non-goals

- This pattern is for **client-side, in-memory** row lists. If a view's
  rows come from a paginated or otherwise server/DB-driven query, filtering
  belongs in that query, not in a `.filter()` over a partial page of results
  - don't apply this pattern there without first checking whether all rows
  are actually loaded.
