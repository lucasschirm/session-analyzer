# Pending Items - Agentic Sessions Dashboard

## COMPLETED ✓
1. Project structure with TypeScript
2. Types defined in src/types/index.ts
3. Web Worker session parser (src/workers/session-parser.worker.ts)
   - Format detection for all 6 formats
   - Parsers for Claude, Agentic Pi, Antigravity, OpenCode/Codex, MCP, Local Runners
4. SQLite database manager (src/db/database.ts)
5. Lit components (src/components/dashboard-components.ts)
   - metrics-card, session-list, events-table, project-selector
6. Main app component with routing (src/pages/app-root.ts)
7. Unit tests for parser (tests/unit/parser.test.ts)
8. E2E tests (tests/e2e/app.spec.ts)
9. GitHub Actions workflows (test.yml, deploy.yml)
10. Configuration files (tsconfig.json, vite.config.ts, vitest.config.ts, playwright.config.ts)
11. .gitignore with node_modules
12. Dependencies: dompurify, marked added

## PENDING ITEMS

### 1. Web Worker Integration (CRITICAL)
- [ ] Fix `getParserFunctions()` in app-root.ts - currently throws error
- [ ] Implement proper Web Worker instantiation
- [ ] Move parser logic to run in actual Web Worker thread

### 2. Database Improvements
- [ ] Fix SQL injection vulnerabilities (use parameterized queries)
- [ ] Implement OPFS (Origin Private File System) for persistent storage
- [ ] Add proper database export as .sqlite file (currently exports JSON)

### 3. Missing Features
- [ ] Markdown rendering with DOMPurify sanitization in session transcript view
- [ ] Chat-like timeline view for session messages
- [ ] Drag and drop file upload functionality
- [ ] Search bar for filtering sessions
- [ ] Delete project functionality
- [ ] Proper modal for creating projects (currently uses prompt)

### 4. Test Coverage
- [ ] Add unit tests for database operations
- [ ] Add unit tests for Lit components
- [ ] Add unit tests for routing logic
- [ ] Verify 60% test coverage requirement
- [ ] Add more comprehensive E2E tests

### 5. Build & Runtime Verification
- [ ] Run `pnpm build` to verify no compilation errors
- [ ] Run `pnpm test` to verify all unit tests pass
- [ ] Run `pnpm test:e2e` to verify E2E tests pass
- [ ] Verify Web Worker builds correctly

### 6. Code Quality
- [ ] Remove empty directories (src/routes/, public/)
- [ ] Add proper TypeScript types for SQLite WASM
- [ ] Add error handling throughout
- [ ] Add loading states for async operations

## NEXT STEPS
1. Fix Web Worker integration in app-root.ts
2. Add markdown rendering with DOMPurify
3. Implement chat-like transcript view
4. Add comprehensive unit tests for components and database
5. Run build and tests to verify everything works
