# Qwen Coder Harness Best Practices

## Core Principles

1. **Incremental Implementation**: Build features in small, testable increments. Always verify each step before proceeding.
2. **Type Safety First**: Use TypeScript strict mode. Define interfaces for all data structures before implementation.
3. **Test-Driven Development**: Write tests (Vitest for units, Playwright for E2E) before or alongside feature code.
4. **Web Worker Offloading**: Move heavy parsing/computation logic to Web Workers to keep the UI thread responsive.
5. **Standardized Data Models**: Normalize all external data formats into internal `DashboardSession` schema immediately upon ingestion.

## Project Structure Rules

- **Components**: Lit-based web components in `src/components/`. Keep them small, single-responsibility.
- **State Management**: Use lightweight state management; avoid heavy frameworks. Prefer signals or simple stores.
- **Routing**: Use hash-based routing for GitHub Pages compatibility.
- **Workers**: Place all Web Worker logic in `src/workers/`. Use a router pattern for multi-format parsing.
- **Tests**: 
  - Unit tests in `*.test.ts` alongside source files.
  - E2E tests in `tests/e2e/` using Playwright.
- **CI/CD**: GitHub Actions only. No self-hosted runners. Use `actions/cache` for dependencies. Deploy to GitHub Pages on `main` merge.

## Coding Standards

- **No `any` types**: Always define explicit types.
- **Immutable Data**: Treat parsed session data as immutable after normalization.
- **Error Handling**: Gracefully handle malformed inputs in parsers; log errors but never crash the worker.
- **Async/Await**: Use async/await for all asynchronous operations; avoid raw Promises.
- **Module Format**: Use ES Modules exclusively.

## Parser Implementation Rules

When adding new session format parsers:

1. **Detection First**: Implement a lightweight detection function that identifies the format by schema inspection (not file extension).
2. **Normalization**: Map all format-specific fields to the standard `DashboardSession` interface immediately.
3. **Token Accounting**: Accurately sum input/output tokens from all relevant events (e.g., `message_start`, `message_delta`, `usage_snapshot`).
4. **Tool Tracking**: Extract and normalize tool executions into a unified `{ name, target, timestamp? }` structure.
5. **Cost Calculation**: If cost is not provided, leave as `undefined`; do not estimate unless explicitly configured.
6. **Event Granularity**: Preserve individual events for drill-down views; do not aggregate prematurely.

## CI/CD Enforcement

- All PRs must pass Vitest and Playwright tests on `ubuntu-latest`.
- No workflow may reference `self-hosted` runners.
- No workflow may use service containers like MinIO; use `actions/cache` instead.
- Deploy workflow must only trigger on `push` to `main`.

## Testing Requirements

- **Unit Tests**: Cover all parser branches, detection logic, and normalization functions.
- **E2E Tests**: Cover full user journey: file upload → parsing → dashboard display → drill-down view.
- **Browser Target**: Playwright tests must target Chrome on Linux (GitHub Actions environment).

## Documentation

- Each parser must have a comment block describing:
  - Identification criteria
  - Key fields mapped
  - Known limitations
- Update this file when adding new formats or changing core architecture.

## Tests

- Always create unit tests for any code changes.
- Unit tests must cover all parser branches, detection logic, and normalization functions.
- E2E tests must cover full user journey: file upload → parsing → dashboard display → drill-down view.
- Browser target: Chrome on Linux (GitHub Actions environment).

