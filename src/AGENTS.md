# AGENTS.md - Source Directory Overview

This document describes all files in the `src` directory for AI agents and developers.

## Directory Structure

```
src/
├── main.ts                        # Application entry point (mounts <app-root>)
├── router.ts                      # Hash-based router built on @lit-labs/router Routes
├── components/
│   ├── metrics-card.ts            # Clickable dashboard metric card; optional valueTitle prop for full-number hover tooltip
│   ├── session-list.ts            # Clickable session rows (date-descending); token count rendered compactly with full-number tooltip
│   ├── events-table.ts            # Drill-down data table for indicator details; metadata column supports hover tooltip and click-to-expand full JSON
│   ├── project-selector.ts        # Project dropdown (input component)
│   ├── project-modal.ts           # New-project modal (name + description)
│   ├── upload-zone.ts             # Drag & drop + file picker upload zone
│   └── session-transcript.ts      # Chat-like markdown transcript view
├── db/
│   ├── database.ts                # DatabaseManager over sqlite3 oo1; extended schema with cache_creation/cache_read tokens, model_usage, tool parameters, and message uuid/parent_uuid; includes migrate() for backward compatibility
│   ├── db-protocol.ts             # Typed main-thread <-> worker message protocol
│   ├── db-worker.ts               # Web Worker hosting SQLite (OPFS when available); enforces strict message ordering via promise queue
│   └── db-client.ts               # Main-thread proxy with promise correlation
├── lib/
│   ├── markdown.ts                # marked + DOMPurify rendering helpers
│   └── format.ts                  # Compact number formatting (K/M/B) with full-number tooltips; estimateTokenCount/formatEstimatedTokens for the ~4-chars/token tool-result estimate (no exact tokenizer available client-side)
├── pages/
│   ├── app-root.ts                # Root shell: header, HashRouter outlet, DB bootstrap
│   ├── home-page.ts               # Projects CRUD grid + export database
│   ├── project-view.ts            # Upload zone + search + sessions for one project; Total Tokens card uses compact number formatting with tooltip
│   ├── session-dashboard.ts       # Metric cards + link to the Session Transcript page; "Total Tokens" card = input+output only (cache tokens excluded - see SessionBuilder.finalize); enriched with token breakdown panel (input/output/cache write/cache read), an estimated Tool Result Tokens panel (~4-chars/token heuristic over tool_result content, % of total input volume), models-used table, top-tools ranked list, skills-used list with parameters, and cache-diagnostics panel
│   ├── indicator-details.ts       # Granular events table per indicator; 'turns' indicator now renders messages as collapsible parent/child tree nested by uuid/parent_uuid; new 'diagnostics' indicator for cache miss tracking
│   └── session-transcript-page.ts # Dedicated transcript page: main session's transcript as the first column, plus a row of subagent cards (when session.subagents.length > 0) that each toggle open/closed an additional side-by-side column showing that subagent's own messages (SubagentUsage.messages)
├── types/
│   └── index.ts                   # Centralized TypeScript type definitions; new types: ModelTokenUsage, updated DashboardSession (added cache_creation_tokens/cache_read_tokens/models), ToolExecution (added parameters), TranscriptMessage (added uuid/parent_uuid), SessionMetrics (added cache/total token fields), IndicatorKey (added 'diagnostics'), SubagentUsage (added optional messages: TranscriptMessage[] for the subagent's own transcript)
└── workers/
    ├── session-parser.worker.ts   # Format detection + 6 format parsers; rewritten Claude Code parser now handles real ~/.claude/projects/*.jsonl CLI format (not synthetic API events); added per-model token tracking, cache token accounting, tool parameter capture, message uuid/parent_uuid propagation, cache-miss-reason diagnostics, and ai-title CLI event for session title
    └── parser-client.ts           # Spawns the parser worker per file
```

## Routing

Routes are hash-based (`#/...`) for GitHub Pages compatibility:

- `#/` — Home page (projects list + CRUD)
- `#/projects/:projectId` — Project view (upload + search + sessions)
- `#/sessions/:sessionId` — Session dashboard (metrics; links out to the transcript page)
- `#/sessions/:sessionId/indicator/:indicator` — Indicator details drill-down
- `#/sessions/:sessionId/transcript` — Session transcript page (main transcript + side-by-side subagent transcript columns)

## Notes for Agents

- All TypeScript code should follow the project's coding standards (strict mode, no `any`, ES modules).
- Type definitions in `types/index.ts` should be used instead of inline types when possible.
- Web Workers handle CPU-intensive work: parsing (`session-parser.worker.ts`) and all SQLite transactions (`db-worker.ts`).
- Database access goes through `db/db-client.ts` (main thread) or `db/database.ts` (inside the worker) — never touch SQL elsewhere.
- SQL must stay parameterized; never interpolate values into query strings.
- Lit components follow one-component-per-file with kebab-case filenames matching the tag name.
