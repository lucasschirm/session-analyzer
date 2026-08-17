# Session Analyzer

Tools for working with AI coding agent session data — parsing raw transcripts
and configuration into typed data, and visualizing them offline in the
browser. This is a pnpm workspace with two packages:

| Package | What it is |
|---|---|
| [`packages/site`](packages/site) | A fully offline, privacy-first web dashboard for visualizing and managing coding sessions from AI assistants. Everything — parsing, analytics, and storage — runs locally in the browser. No backend, no network calls. |
| [`packages/parsers/claude-session-parser`](packages/parsers/claude-session-parser) | [`@lucasschirm/sal-claude-session-parser`](https://www.npmjs.com/package/@lucasschirm/sal-claude-session-parser) — a pure, dependency-free parser for Claude Code's on-disk formats (session transcripts, subagent files, and the full `.claude` configuration surface). Used by the dashboard, but publishable and usable standalone. |

**[Live demo →](https://lucasschirm.github.io/session-analyzer/)**

## Getting started

```bash
pnpm install
pnpm dev        # dashboard dev server on http://localhost:3000
```

| Command | Purpose |
|---|---|
| `pnpm dev` | Start the dashboard's development server |
| `pnpm build` | Build every package (`pnpm -r build`) |
| `pnpm preview` | Serve the dashboard's production build locally |
| `pnpm test` | Run the dashboard's Vitest unit tests |
| `pnpm test:coverage` | Dashboard unit tests with coverage (60% threshold) |
| `pnpm test:e2e` | Run Playwright E2E tests against `pnpm preview` |

`pnpm build` runs before every commit via a husky pre-commit hook; the
commit is blocked if any package's type-check or build fails.

## Repository structure

```
packages/
├── site/                       # The dashboard app (see below)
│   ├── src/
│   │   ├── components/         # One Lit component per file (metrics-card, upload-zone, …)
│   │   ├── db/                 # DatabaseManager (sqlite oo1), db-worker, db-client proxy
│   │   ├── lib/                # Markdown + sanitization helpers
│   │   ├── pages/               # Route-level components (home, project, session, indicator)
│   │   ├── types/               # Shared TypeScript types
│   │   └── workers/             # Session parser worker + client helper
│   └── tests/
│       ├── unit/                # Vitest suites (parser, database, components, pages, router)
│       └── e2e/                 # Playwright journeys + session fixture files
└── parsers/
    └── claude-session-parser/  # @lucasschirm/sal-claude-session-parser (see below)
        ├── src/
        └── tests/
```

## `packages/site` — the dashboard

### Features

- **Project CRUD** — create (with name + description), list, and delete
  projects; deleting cascades to all of a project's sessions.
- **Session upload** — drag & drop or file picker for `.json`, `.jsonl`, and
  `.log` files, parsed off the main thread in a Web Worker.
- **Six supported formats** (detected by schema, not file extension):
  | Format | Highlights |
  |---|---|
  | Claude Code | token usage from `message_start`/`message_delta`, tool_use blocks |
  | Agentic Pi | exact tokens + cost from `usage_snapshot`, transcript messages |
  | Antigravity | `context_compaction`, `tool_exec`, `file_write`, policy overrides |
  | OpenCode / Codex | CLI formatter usage, `/undo` tracking |
  | MCP (JSON-RPC) | `CallToolRequest` / `CallToolResult` correlation |
  | Local runners (Ollama / vLLM) | models, prompt eval counts, VRAM warnings |
- **Session dashboard** — metric cards for total tokens, context compactions,
  interactions, tools used (+ most used), files read/written, and agents &
  skills. Every card drills down into an Indicator Details table.
- **Session transcript** — chat-like markdown view (rendered with `marked`,
  sanitized with `dompurify`) with distinct styling per role.
- **Search** — filter sessions by title or transcript message content.
- **SQLite in the browser** — `@sqlite.org/sqlite-wasm` persisted via OPFS
  (Origin Private File System) inside a Web Worker, with an in-memory
  fallback when OPFS/SharedArrayBuffer is unavailable.
- **Database export** — download the entire SQLite database as a `.sqlite`
  file at any time.

### Tech stack

- [Lit](https://lit.dev/) — web components
- [@lit-labs/router](https://lit.dev/docs/libraries/router/) — routing
  (wrapped in a hash-based router for GitHub Pages compatibility)
- [@sqlite.org/sqlite-wasm](https://sqlite.org/wasm/) — SQLite via WASM + OPFS
- [marked](https://marked.js.org/) + [dompurify](https://github.com/cure53/DOMPurify) — safe markdown rendering
- [Vite](https://vitejs.dev/) — dev server and bundler
- [Vitest](https://vitest.dev/) — unit tests (≥60% coverage enforced)
- [Playwright](https://playwright.dev/) — E2E tests (Chromium on Linux CI)

### Architecture notes

- **Workers do the heavy lifting.** Session parsing and every SQLite
  transaction run in dedicated Web Workers so the UI thread never blocks.
- **OPFS requires cross-origin isolation.** The SQLite OPFS VFS depends on
  `SharedArrayBuffer`, which needs COOP/COEP response headers. `vite dev`
  and `vite preview` send them; on GitHub Pages a small service worker
  (`public/coi-sw.js`) injects them. Without isolation the app degrades to
  an in-memory database (still fully functional, not persisted).
- **Hash-based routing** (`#/projects/…`) keeps deep links working on
  GitHub Pages, where server-side path rewrites are unavailable.
- **Parameterized SQL only** — no user input is ever interpolated into SQL.

## `packages/parsers/claude-session-parser`

A pure, dependency-free parser for Claude Code's on-disk formats: session
transcripts, subagent transcripts and meta files, and the `.claude`
configuration surface (`settings.json`, `.mcp.json`, agent/skill/rule
definitions, plugin marketplaces). It parses text the caller supplies — it
never touches a filesystem — so it runs anywhere JavaScript does, including
inside the dashboard's browser Web Worker.

Published standalone as
[`@lucasschirm/sal-claude-session-parser`](https://www.npmjs.com/package/@lucasschirm/sal-claude-session-parser).
See [its README](packages/parsers/claude-session-parser/README.md) for usage
and design constraints.

## Deploy

Pushes to `main` build the dashboard and deploy it to GitHub Pages via
`.github/workflows/deploy.yml`: **https://lucasschirm.github.io/session-analyzer/**
