# Pending Items - Agentic Sessions Dashboard

## COMPLETED ✓

### Core application
1. Project structure with TypeScript (strict mode)
2. Types defined in `src/types/index.ts` (sessions, projects, transcript, indicators)
3. Web Worker session parser with schema-based detection for all 6 formats
   (Claude, Agentic Pi, Antigravity, OpenCode/Codex, MCP, Local Runners)
4. SQLite WASM database manager with parameterized queries (`src/db/database.ts`)
5. Database Web Worker with OPFS persistence + in-memory fallback (`src/db/db-worker.ts`)
6. Main-thread DB client proxy with promise correlation (`src/db/db-client.ts`)
7. Hash-based routing built on `@lit-labs/router` Routes (`src/router.ts`)
8. Lit components, one per file (metrics-card, session-list, events-table,
   project-selector, project-modal, upload-zone, session-transcript)
9. Pages: app-root shell, home-page (project CRUD + export), project-view
   (upload + search), session-dashboard (metric cards + transcript),
   indicator-details (drill-down tables)
10. Dark-mode-first UI theme
11. Markdown transcript rendering with DOMPurify sanitization
12. SQLite database export as a real `.sqlite` file

### Features from the original plan
- [x] Web Worker integration (parsing + all DB transactions off-thread)
- [x] Parameterized SQL (no injection vulnerabilities)
- [x] OPFS persistent storage (COOP/COEP headers via Vite + coi-sw.js on Pages)
- [x] `.sqlite` file export (was JSON before)
- [x] Markdown rendering in transcript view
- [x] Chat-like timeline view with per-role styling
- [x] Drag-and-drop file upload (+ picker accepting .json/.jsonl/.log)
- [x] Search bar filtering sessions by title or message content
- [x] Delete project with cascade
- [x] New-project modal with name + description
- [x] Metric cards routing to Indicator Details pages
- [x] Full metric set: tokens, compactions, turns, tools (+most used),
      files read/written, agents/skills

### Tests & CI
- [x] Unit tests for parsers (all formats + detection + helpers)
- [x] Unit tests for the database manager (real SQLite WASM, in-memory)
- [x] Unit tests for db-client / parser-client (worker doubles)
- [x] Unit tests for all components and pages
- [x] Unit tests for the hash router (URLPattern shim in setup)
- [x] Coverage threshold enforced at 60% (statements/branches/functions/lines)
- [x] E2E tests for the full user journey incl. OPFS persistence + export
- [x] GitHub Actions: test.yml (ubuntu-latest, actions/cache, coverage) and
      deploy.yml (GitHub Pages on push to main)

## NEXT STEPS (future enhancements, not required by the current plan)
- Session import (restore an exported `.sqlite` file)
- Project edit/rename
- Charts for token usage over time
- Session deletion from the UI (DB layer already supports it)
