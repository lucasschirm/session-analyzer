# AGENTS.md - Source Directory Overview

This document describes all files in the `src` directory for AI agents and developers.

## Directory Structure

```
src/
├── main.ts                        # Application entry point (mounts <app-root>)
├── router.ts                      # Hash-based router built on @lit-labs/router Routes
├── components/
│   ├── metrics-card.ts            # Clickable dashboard metric card
│   ├── session-list.ts            # Clickable session rows (date-descending)
│   ├── events-table.ts            # Drill-down data table for indicator details
│   ├── project-selector.ts        # Project dropdown (input component)
│   ├── project-modal.ts           # New-project modal (name + description)
│   ├── upload-zone.ts             # Drag & drop + file picker upload zone
│   └── session-transcript.ts      # Chat-like markdown transcript view
├── db/
│   ├── database.ts                # DatabaseManager over sqlite3 oo1 (parameterized SQL)
│   ├── db-protocol.ts             # Typed main-thread <-> worker message protocol
│   ├── db-worker.ts               # Web Worker hosting SQLite (OPFS when available)
│   └── db-client.ts               # Main-thread proxy with promise correlation
├── lib/
│   └── markdown.ts                # marked + DOMPurify rendering helpers
├── pages/
│   ├── app-root.ts                # Root shell: header, HashRouter outlet, DB bootstrap
│   ├── home-page.ts               # Projects CRUD grid + export database
│   ├── project-view.ts            # Upload zone + search + sessions for one project
│   ├── session-dashboard.ts       # Metric cards + transcript toggle
│   └── indicator-details.ts       # Granular events table per indicator
├── types/
│   └── index.ts                   # Centralized TypeScript type definitions
└── workers/
    ├── session-parser.worker.ts   # Format detection + 6 format parsers
    └── parser-client.ts           # Spawns the parser worker per file
```

## Routing

Routes are hash-based (`#/...`) for GitHub Pages compatibility:

- `#/` — Home page (projects list + CRUD)
- `#/projects/:projectId` — Project view (upload + search + sessions)
- `#/sessions/:sessionId` — Session dashboard (metrics + transcript)
- `#/sessions/:sessionId/indicator/:indicator` — Indicator details drill-down

## Notes for Agents

- All TypeScript code should follow the project's coding standards (strict mode, no `any`, ES modules).
- Type definitions in `types/index.ts` should be used instead of inline types when possible.
- Web Workers handle CPU-intensive work: parsing (`session-parser.worker.ts`) and all SQLite transactions (`db-worker.ts`).
- Database access goes through `db/db-client.ts` (main thread) or `db/database.ts` (inside the worker) — never touch SQL elsewhere.
- SQL must stay parameterized; never interpolate values into query strings.
- Lit components follow one-component-per-file with kebab-case filenames matching the tag name.
