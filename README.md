# Session Analyzer — Agentic Coding Sessions Dashboard

A fully offline, privacy-first web dashboard for visualizing and managing
coding sessions from AI assistants. Everything — parsing, analytics, and
storage — runs locally in the browser. No backend, no network calls.

## Features

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

## Tech stack

- [pnpm](https://pnpm.io/) — package manager
- [Lit](https://lit.dev/) — web components
- [@lit-labs/router](https://lit.dev/docs/libraries/router/) — routing
  (wrapped in a hash-based router for GitHub Pages compatibility)
- [@sqlite.org/sqlite-wasm](https://sqlite.org/wasm/) — SQLite via WASM + OPFS
- [marked](https://marked.js.org/) + [dompurify](https://github.com/cure53/DOMPurify) — safe markdown rendering
- [Vite](https://vitejs.dev/) — dev server and bundler
- [Vitest](https://vitest.dev/) — unit tests (≥60% coverage enforced)
- [Playwright](https://playwright.dev/) — E2E tests (Chromium on Linux CI)
- GitHub Actions — PR test pipeline and GitHub Pages deploy

## Getting started

```bash
pnpm install
pnpm dev        # development server on http://localhost:3000
```

### Scripts

| Command | Purpose |
|---|---|
| `pnpm dev` | Start the development server |
| `pnpm build` | Type-check (`tsc`) and build to `packages/site/dist/` |
| `pnpm preview` | Serve the production build locally |
| `pnpm test` | Run Vitest unit tests |
| `pnpm test:coverage` | Unit tests with coverage (60% threshold) |
| `pnpm test:e2e` | Run Playwright E2E tests against `pnpm preview` |

## Architecture notes

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

## Project structure

This is a pnpm workspace; the app lives in `packages/site/` (a future,
separately-designed effort will add `packages/parsers/*`).

```
packages/site/
├── src/
│   ├── components/   # One Lit component per file (metrics-card, upload-zone, …)
│   ├── db/           # DatabaseManager (sqlite oo1), db-worker, db-client proxy
│   ├── lib/          # Markdown + sanitization helpers
│   ├── pages/        # Route-level components (home, project, session, indicator)
│   ├── types/        # Shared TypeScript types
│   └── workers/      # Session parser worker + client helper
└── tests/
    ├── unit/         # Vitest suites (parser, database, components, pages, router)
    └── e2e/          # Playwright journeys + session fixture files
```

## Husky pre-commit hook

`pnpm build` runs before every commit; the commit is blocked if the
type-check or Vite build fails.
