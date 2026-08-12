# Agentic Sessions Dashboard - Stack Definition

## Overview
This project is a fully offline, privacy-first web application designed to help developers visualize and manage their agentic coding sessions. It runs entirely in the browser and processes session files from various AI coding assistants to generate statistical dashboards.

## Technology Stack

### Core Frontend
*   **Framework/Components:** [Lit (LitJS)](https://lit.dev/) - A simple, fast, and lightweight library for building native Web Components. One component per file, kebab-case filenames matching the element tag.
*   **Routing:** [`@lit-labs/router`](https://lit.dev/docs/libraries/router/) - The `Routes` controller is wrapped by a hash-based router (`src/router.ts`) so deep links survive GitHub Pages static hosting (`#/projects/...` style URLs).
*   **Package Manager:** [pnpm](https://pnpm.io/) - Fast, disk-space-efficient package manager used for dependency management.
*   **Build Tool:** [Vite](https://vitejs.dev/) - Next generation frontend tooling for fast development and optimized builds.

### Storage & Data Management
*   **Database:** SQLite via WebAssembly (WASM) using `@sqlite.org/sqlite-wasm`. Persistence uses the OPFS (Origin Private File System) VFS inside a Web Worker; falls back to an in-memory database when OPFS/SharedArrayBuffer is unavailable. All SQL uses parameterized queries.
*   **Cross-origin isolation:** OPFS requires `SharedArrayBuffer`, which needs COOP/COEP headers. `vite dev`/`vite preview` send them; GitHub Pages gets them via `public/coi-sw.js` (a header-injecting service worker).
*   **Data Export:** Built-in capability to export the local SQLite database as a `.sqlite` file, giving users full control and portability over their data.

### Testing
*   **Unit Tests:** [Vitest](https://vitest.dev/) - Unit tests for parsers, the database manager (real SQLite WASM in Node), components, pages, and routing logic. Coverage threshold: 60% (statements, branches, functions, lines) via `@vitest/coverage-v8`.
*   **E2E Tests:** [Playwright](https://playwright.dev/) - End-to-end tests covering complete user journeys, targeting Chrome/Chromium on Linux (the GitHub Actions environment).

### CI/CD
*   **GitHub Actions:**
    - `test.yml`: Runs on PRs against `main`/`develop` on `ubuntu-latest`. Installs via pnpm, builds, runs Vitest with coverage (threshold-enforced) and Playwright, and uses `actions/cache` for the pnpm store.
    - `deploy.yml`: Runs on pushes to `main` only. Deploys the static `dist/` output to GitHub Pages.

### Supported Agentic Session Integrations
The application ingests, parses, and generates statistics for session files from the following AI coding assistants. Detection is schema-based (never file-extension-based) and runs in a Web Worker:

| Format | Identification | Key Features Parsed |
|--------|---------------|---------------------|
| **Claude Code** | Real CLI format from `~/.claude/projects/*.jsonl` with `message_start`, `ai-title`, cache/token events | Per-model token usage, cache_creation/cache_read tokens, tool executions with parameters, nested transcript messages (uuid/parent_uuid), cache-miss diagnostics, session title from ai-title event |
| **Agentic Pi** | JSONL with `{"type":"session","version":3}` | Exact tokens, cost from `usage_snapshot`, tool executions, transcript messages |
| **Antigravity** | JSON array with sandbox events | `context_compaction`, `tool_exec`, `file_write`, `request-review` overrides |
| **OpenCode/Codex** | JSON logs with `action` fields | CLI formatters (prettier), `/undo` tracking, user commands |
| **MCP** | JSON-RPC trace logs (array or JSONL) | `CallToolRequest`, `CallToolResult`, error correlation by request id |
| **Local Runner** | Server request logs (Ollama/vLLM) | Model names, prompt eval counts, generation speeds, VRAM warnings |

## Architecture Notes
*   **Offline-First & Privacy-Focused:** No backend server is required for data processing. All parsing, analytics, and storage run locally in the user's browser.
*   **Web Worker Offloading:** Session file parsing and all SQLite transactions run in dedicated Web Workers to avoid blocking the main thread during large file processing.
*   **Project Organization:** Users can create distinct projects (name + description) and upload sessions into them; deletion cascades to sessions.
*   **Reactive UI:** The dashboard utilizes Lit's reactive properties to efficiently update statistics as new sessions are parsed and added to the SQLite-WASM database.
*   **Drill-Down Views:** Every metric card on the Session Dashboard routes to an Indicator Details page showing the granular events behind the metric.
*   **Transcripts:** Chat-like message view rendered via `marked` + sanitized with `dompurify`.

## Project Structure
```
/workspace
├── src/
│   ├── components/       # Lit web components (one per file)
│   ├── db/               # SQLite WASM database manager, db-worker, db-client
│   ├── lib/              # Markdown rendering + sanitization
│   ├── pages/            # Route-level components (home, project, session, indicator)
│   ├── types/            # TypeScript type definitions
│   └── workers/          # Web Worker for session parsing + client helper
├── tests/
│   ├── unit/             # Vitest unit tests
│   └── e2e/              # Playwright E2E tests + fixture session files
├── public/               # coi-sw.js (COOP/COEP for GitHub Pages), .nojekyll
├── .github/workflows/    # GitHub Actions CI/CD
├── index.html            # Entry HTML file (dark theme variables)
├── package.json          # Dependencies and scripts
├── tsconfig.json         # TypeScript configuration
├── vite.config.ts        # Vite build configuration (COOP/COEP headers, ES workers)
├── vitest.config.ts      # Vitest test configuration (coverage thresholds)
└── playwright.config.ts  # Playwright E2E configuration (chromium)
```

## Scripts
```bash
pnpm dev            # Start development server
pnpm build          # Type-check and build for production
pnpm preview        # Preview production build
pnpm test           # Run unit tests
pnpm test:coverage  # Run unit tests with coverage thresholds
pnpm test:e2e       # Run E2E tests
```
