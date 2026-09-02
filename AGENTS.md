# Agentic Sessions Dashboard - Stack Definition

## Overview
This project is a fully offline, privacy-first web application designed to help developers visualize and manage their agentic coding sessions. It runs entirely in the browser and processes session files from various AI coding assistants to generate statistical dashboards.

## Domain Terminology
A session's activity breaks down into four distinct concepts. Keep this distinction clear in code, UI copy, and metrics - each has its own indicator page and is never conflated with another:

*   **Skill** - A project skill being used: describes how something works and how to execute a set of tasks. Surfaced via the `skills` indicator (`isSkillTool` in `src/workers/session-parser.worker.ts`, exact Claude Code tool name `Skill`).
*   **Agent** - A project agent being used: describes how to execute a specific task, step by step. Surfaced via the `agents` indicator (`isAgentTool`, exact Claude Code tool name `Agent`).
*   **Tools** - Tools available in the project. Tool availability can depend on session mode - e.g. planning mode will not allow `Write` or other content-editing tools, while auto mode allows all tools. Surfaced via the `tools` indicator.
*   **Sub Agents** - Sub-sessions that execute their own tools, agents, and skills to complete one specific goal. These are the uploaded `subagents/agent-<id>.jsonl` transcripts (`session.subagents` / `SubagentUsage`), shown in the Session Dashboard's Subagents panel and the Session Transcript page - distinct from the `agents` indicator above.

Skill and Agent are usually invoked by calling a tool (`tool_use` blocks named `Skill`/`Agent`), but they are deliberately **excluded** from the generic "tool call" pool (`Tools Used` metric, `tools` indicator) since they have their own dedicated metrics and pages.

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
This repo is a pnpm workspace monorepo. It currently contains three package
areas: the dashboard app, publishable parsers, the session sync engine, and a
Claude Code plugin that bundles the sync engine.

```
/workspace
├── packages/
│   ├── site/                 # The dashboard app (package name: "site")
│   │   ├── src/
│   │   │   ├── components/       # Lit web components (one per file)
│   │   │   ├── db/               # SQLite WASM database manager, db-worker, db-client
│   │   │   ├── lib/              # Markdown rendering + sanitization
│   │   │   ├── pages/            # Route-level components (home, project, session, indicator)
│   │   │   ├── types/            # TypeScript type definitions
│   │   │   └── workers/          # Web Worker for session parsing + client helper
│   │   ├── tests/
│   │   │   ├── unit/             # Vitest unit tests
│   │   │   ├── perf/             # Vitest performance and read-budget tests
│   │   │   └── e2e/              # Playwright E2E tests + fixture session files
│   │   ├── public/               # coi-sw.js (COOP/COEP for GitHub Pages), .nojekyll
│   │   ├── index.html            # Entry HTML file (dark theme variables)
│   │   ├── package.json          # App dependencies and scripts
│   │   ├── tsconfig.json         # Extends root tsconfig.base.json, adds path aliases
│   │   ├── vite.config.ts        # Vite build configuration (COOP/COEP headers, ES workers)
│   │   ├── vitest.config.ts      # Vitest test configuration (coverage thresholds)
│   │   └── playwright.config.ts  # Playwright E2E configuration (chromium)
│   ├── parsers/
│   │   ├── claude-session-parser/  # @lucasschirm/sal-claude-session-parser
│   │   │   ├── src/                # Pure, dependency-free Claude Code parser
│   │   │   └── tests/              # Parser unit tests
│   │   └── devin-session-parser/   # @lucasschirm/sal-devin-session-parser
│   │       └── src/                # Pure, dependency-free Devin CLI parser (jsonl/atif/models/schema-descriptor), tests colocated
│   ├── sync/                       # @lucasschirm/sal-sync
│   │   ├── src/                    # Session data sync engine (harness-agnostic)
│   │   └── tests/                  # Sync engine unit tests
│   └── plugins/
│       ├── claude-session-sync/    # @lucasschirm/claude-session-sync
│       │   ├── .claude-plugin/     # Claude Code plugin manifest
│       │   ├── bin/                # Single-file esbuild bundles (generated)
│       │   ├── hooks/              # Claude Code hooks/hooks.json
│       │   ├── src/                # Plugin entry points and Claude-specific mapping
│       │   ├── build.mjs           # esbuild bundling script
│       │   └── tests/              # Plugin unit tests (including packaging)
│       └── devin-session-sync/     # @lucasschirm/devin-session-sync
│           ├── src/extractor/      # sessions.db (node:sqlite) -> devin-session-jsonl/v1 extractor
│           ├── build.mjs           # placeholder build (esbuild bin wiring lands with the plugin manifest/CLI)
│           └── tests/extractor/    # Extractor unit + fixture-DB pipeline tests
├── .github/workflows/    # GitHub Actions CI/CD
├── package.json          # Root workspace package (private, passthrough scripts, husky)
├── pnpm-workspace.yaml    # Workspace package globs
└── tsconfig.base.json     # Shared TypeScript compiler options
```

## Scripts
Run from the repo root - they delegate to the `site` package via `pnpm --filter`:
```bash
pnpm dev            # Start development server
pnpm build          # Type-check and build for production
pnpm preview        # Preview production build
pnpm test           # Run unit tests
pnpm test:coverage  # Run unit tests with coverage thresholds
pnpm test:e2e       # Run E2E tests
```
Equivalent commands scoped to the site package directly:
`cd packages/site && pnpm dev` (etc.), or `pnpm --filter site <script>` from
anywhere in the workspace.

## Analytics packages
The monorepo also contains the analytics data platform packages:

- `packages/db-core/` (`@lucasschirm/sal-db-core`) — Runtime-independent SQLite schema, migrations, stores, and generation control.
- `packages/db/` (`@lucasschirm/sal-db`) — Application-facing ingestion, aggregation, reprocessing, and analytics data-source facade.
- `packages/transformers/transformer-shared/` (`@lucasschirm/sal-transformer-shared`) — Harness-agnostic transformer contract layer, registry, and conformance suite (public `/conformance` subpath).
- `packages/transformers/claude-transformer/` (`@lucasschirm/sal-claude-transformer`) — Claude Code transformer plugin: artifact classification and metric derivation.
- `packages/transformers/registry/` (`@lucasschirm/sal-transformer-registry`) — Default `TransformerRegistry` composition root wiring every transformer plugin package together.
- `packages/sync-core/` (`@lucasschirm/sal-sync-core`) — Shared manifest and sync contract types.
- `packages/parsers/claude-session-parser/` (`@lucasschirm/sal-claude-session-parser`) — Pure Claude Code session parser.
- `packages/parsers/devin-session-parser/` (`@lucasschirm/sal-devin-session-parser`) — Pure, dependency-free Devin CLI parser: `devin-session-jsonl/v1` lines, ATIF v1.7 native transcripts, `models.json` (DS-F4-forward-compatible three-state pricing), and `schema-descriptor.json`. No SQLite/SQL; never depends on `db-core`/`db`/`packages/plugins/*`.
- `packages/plugins/claude-session-sync/` (`@lucasschirm/claude-session-sync`) — Claude Code plugin bundles for the sync engine.
- `packages/plugins/devin-session-sync/` (`@lucasschirm/devin-session-sync`) — Devin CLI plugin adapter; currently hosts the `sessions.db` -> `devin-session-jsonl/v1` extractor (`src/extractor/`), read-only via `node:sqlite` (see the `sql-only-in-db-core` carve-out). Plugin manifest/hooks/CLI land separately.

See the per-package `AGENTS.md` files for source maps and invariants.

## CI maintenance gates

- `scripts/analytics-gates/` — Standalone CI maintenance gate scripts; see `scripts/analytics-gates/AGENTS.md`.
- `.github/workflows/analytics-gates.yml` — GitHub Actions workflow that runs the maintenance gates on pull requests.
- `package.json` `analytics-gates` script — Entry point for the full gate suite.

## Agent rules and skills

- `.agents/rules/` — Project-specific behavioral rules:
  aggregates-expose-sample-size, analytics-domain-distinctions,
  component-identity-not-display-name, e2e-coverage-required,
  frontend-coding-style, harness-plugins-conformance, lifecycle-removal-snapshots,
  manifest-backed-classification, metric-meaning-versioning, missing-is-never-zero,
  never-display-raw-ids, no-canonical-metrics-in-lit, no-silent-empty-states,
  schema-change-tests,
  sql-only-in-db-core, sync-progress-observability,
  transformers-never-write-sqlite, workspace-rules.
- `.agents/skills/` — Project-specific reusable skills:
  add-analytics-view, add-db-migration, add-e2e-test, add-harness-integration,
  add-pipeline-e2e-test, add-session-metric, feature-planning,
  filterable-table-pattern, issue-orchestrator, pr-review,
  reprocess-analytics, triage-e2e-failure.
- `.agents/agents/` — Project-specific agent definitions:
  db-migration-reviewer, e2e-failure-fixer, e2e-test-implementer,
  e2e-test-maintainer, e2e-test-planner, feature-reviewer,
  harness-integration-reviewer, issue-writer, lit-performance-optmizer,
  metric-schema-reviewer, pr-review, task-orchestrator, ts-best-practices,
  ui-chart-reviewer.
