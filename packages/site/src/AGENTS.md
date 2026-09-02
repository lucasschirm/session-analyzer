# AGENTS.md - Source Directory Overview

This document describes all files in the `src` directory for AI agents and developers.

## Directory Structure

```
src/
├── main.ts                        # Application entry point (mounts <app-root>)
├── router.ts                      # Hash-based router built on @lit-labs/router Routes
├── components/
│   ├── charts/                    # Reusable chart web components built on ECharts, with textual summaries, tables, and accessibility fallbacks
│   │   ├── analytics-chart.ts     # Chart wrapper that picks ECharts renderers by chart type and exposes loading/empty/error states
│   │   ├── chart-types.ts         # Chart DTO types, state union, and compact value formatting helpers
│   │   ├── chart-helpers.ts       # Domain-agnostic ECharts option builders (time-series, stacked-bar, doughnut) and text summaries
│   │   └── echarts-base.ts        # Tree-shaken ECharts core registration, SVG renderer, and a11y table fallback
│   ├── connect-modal.ts           # S3 connection management modal (list, add, edit, test, sync)
│   ├── manual-import/             # Manual import flow components
│   │   ├── manual-import-harness-selector.ts
│   │   ├── manual-import-project-workspace.ts
│   │   ├── manual-import-state.ts
│   │   └── manual-import-upload.ts
│   ├── metrics-card.ts            # Clickable dashboard metric card; optional valueTitle prop for full-number hover tooltip
│   ├── passkey-modal.ts           # Passkey create/unlock modal for the credential vault
│   ├── project-modal.ts           # New-project modal (name + description)
│   ├── project-selector.ts        # Project dropdown (input component)
│   ├── project-sync-indicator.ts  # Small spinner that opens the project sync status modal when clicked
│   ├── project-sync-status-modal.ts # Per-project and full-run sync status modal with project/session progress and file counts
│   ├── sync-progress-bar.ts       # Global sync progress bar with live P/S/F counts, queued-run suffix, cancel button, final-results summary with unicode icons (files/new projects/new sessions/sessions updated) shown for 6s after completion, and full sync-status modal
│   ├── sync-status-bar.ts         # Bottom-fixed sync discovery indicator ("Found: X Projects / Y Sessions / Z sessions pending") shown while a run is active or queued
│   ├── toast-container.ts         # ToastManager singleton + fixed-position toast stack (error/warning/info/success); error toasts are sticky, others auto-dismiss; sync warnings and run failures are wired to toasts via the manager
│   └── upload-zone.ts             # Drag & drop + file picker upload zone
├── db/                            # SQLite WASM control database (worker) and analytics worker client
│   ├── analytics-client.ts        # Main-thread client for the analytics Web Worker
│   ├── analytics-protocol.ts      # Typed main-thread <-> analytics worker message protocol
│   ├── analytics-worker.ts        # Analytics Web Worker hosting sal-db over WasmSqliteExecutor
│   ├── artifact-adapters.ts       # Browser artifact blob store, resolver, and sync-cache adapters
│   ├── database.ts                # DatabaseManager: control DB with projects, sessions, session_files, connections, credentials, passkey, checkpoints, and UI preferences
│   ├── db-client.ts               # Main-thread proxy for db-worker with promise correlation
│   ├── db-protocol.ts             # Typed main-thread <-> db-worker message protocol
│   ├── db-worker.ts               # Web Worker hosting SQLite (OPFS when available); enforces strict message ordering via promise queue
│   └── wasm-sqlite-executor.ts    # db-core SqliteExecutor adapter over @sqlite.org/sqlite-wasm; OPFS when available, in-memory fallback, exposes backend/durability/fallback metadata
├── lib/
│   ├── format.ts                  # Compact number formatting (K/M/B) with full-number tooltips
│   ├── id.ts                      # generateId helper for local ids
│   ├── markdown.ts                # marked + DOMPurify rendering helpers
│   ├── s3-errors.ts               # Shared S3 error utilities: hintForS3Error (human hint + docs link per error code), formatS3Error (HTTP status + code + message), describeS3Error (structured message + hint for toast notifications)
│   └── uploaded-file.ts           # Uploaded file metadata helpers
├── pages/
│   ├── app-root.ts                # Root shell: header, HashRouter outlet, DB bootstrap, sync-manager initialization, Connect entry point, bottom-fixed sync-status-bar, and toast-container
│   ├── artifact-diff/             # Artifact diff analytics view
│   │   ├── artifact-diff-chart-helpers.ts
│   │   ├── artifact-diff-params.ts
│   │   └── artifact-diff-view.ts
│   ├── component-ecosystem/       # Component ecosystem analytics view
│   │   ├── component-ecosystem-chart-helpers.ts
│   │   ├── component-ecosystem-params.ts
│   │   └── component-ecosystem-view.ts
│   ├── home-page.ts               # Projects list with CRUD and export database
│   ├── manual-import/             # Manual import page
│   │   └── manual-import-page.ts
│   ├── portfolio/                 # Portfolio analytics view and chart helpers
│   │   ├── portfolio-view.ts
│   │   ├── portfolio-chart-helpers.ts
│   │   └── portfolio-params.ts
│   ├── project-behavior/          # Project Behavior analytics view
│   │   ├── project-behavior-view.ts
│   │   ├── project-behavior-chart-helpers.ts
│   │   └── project-behavior-params.ts
│   ├── session-evidence/          # Session Evidence analytics view
│   │   ├── session-evidence-chart-helpers.ts
│   │   ├── session-evidence-evidence.ts
│   │   ├── session-evidence-params.ts
│   │   ├── session-evidence-transcript.ts
│   │   ├── session-evidence-tree.ts
│   │   └── session-evidence-view.ts
├── sync/                          # Remote sync orchestration
│   ├── credential-crypto.ts       # Vault key management: passkey hashing, encrypt/decrypt helpers, and unlock state for S3 credentials
│   ├── sync-manager.ts            # Singleton EventTarget that coordinates sync runs, workers, queue, and snapshots; exposes retrySession and publishes change events
│   └── sync-protocol.ts           # Typed main-thread <-> session-sync worker message protocol
├── types/
│   └── index.ts                   # Centralized TypeScript type definitions
└── workers/
    └── session-sync.worker.ts     # Web Worker for remote session sync
```

## Routing

Routes are hash-based (`#/...`) for GitHub Pages compatibility:

- `#/` — Home page (projects list + CRUD)
- `#/portfolio` — Portfolio analytics view
- `#/projects/:projectId/behavior` — Project Behavior analytics view
- `#/sessions/:sessionId` — Session Evidence analytics view
- `#/manual-import` — Manual Import (transcript/partial upload)
- `#/components` — Component Ecosystem
- `#/components/:componentId` — Component Ecosystem with a selected component
- `#/artifact-diff` — Artifact Diff

## Notes for Agents

- All TypeScript code should follow the project's coding standards (strict mode, no `any`, ES modules).
- Type definitions in `types/index.ts` should be used instead of inline types when possible.
- Web Workers handle CPU-intensive work: remote sync (`workers/session-sync.worker.ts`) and analytics queries (`db/analytics-worker.ts`).
- Database access goes through `db/db-client.ts` (main thread) or `db/database.ts` (inside the worker) — never touch SQL elsewhere.
- SQL must stay parameterized; never interpolate values into query strings.
- Lit components follow one-component-per-file with kebab-case filenames matching the tag name.

## Display labeling policy (non-negotiable)

Internal ids (component ids like `comp-7b749f662cc27c79`, session uuids,
project ids, generation ids, store primary keys, hash-derived deterministic
ids) must **never** be shown to end users as the primary label for the thing
they refer to. This is enforced by the `never-display-raw-ids` rule in
`.agents/rules/`.

- Always resolve the best available human-friendly label before rendering:
  - **Components**: use the `componentDisplayName(kind, nativeId, displayName, id)`
    helper from `packages/db/src/analytics-portfolio.ts` (prefer `kind/nativeId`
    e.g. `skill/multi-issue-agent`, then `kind/displayName`, then `kind/id`
    only as a last-resort data-quality signal). DTO fields that surface
    component references to the UI must carry resolved labels, not raw ids —
    e.g. `PortfolioOverview.unusedOfferedComponents` returns labels, not ids.
  - **Sessions**: render the session title / ai-title when available, falling
    back to a short timestamped summary — never the raw session uuid.
  - **Projects**: render the project `name`, never the project id.
  - **Other entities**: prefer the dedicated `name`/`label`/`title` field,
    falling back to a derived summary, never the primary key.
- DTO fields named `*Id` are for routing, correlation, and evidence links —
  not for direct display. If a field is rendered to the user, it must be a
  resolved label field (`name`, `label`, `displayName`, or a composed label).
- A raw id may appear in a tooltip, copy-to-clipboard affordance, or developer
  diagnostics surface only when the primary visible label is already shown
  alongside it — never as the sole representation.
- Tests that assert on rendered entity references must assert on the resolved
  label, not the raw id, so a regression to id-as-label is caught.
