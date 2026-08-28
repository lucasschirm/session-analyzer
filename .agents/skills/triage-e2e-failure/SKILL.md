---
name: triage-e2e-failure
description: Use when a browser E2E or pipeline integration test fails (locally or in CI). Classify as product bug, test bug, or flake; use Playwright trace/screenshot artifacts and pipeline receipts to isolate; apply the quarantine-last-resort procedure; and route fixes to the implementer, product owner, or maintainer.
---

# Triage E2E Failure

## Overview

E2E failures are classified before they are fixed. The loop protects UX
signal: never mute a product regression as a "flake", never chase ghost
failures with arbitrary sleeps, and never let quarantines expire silently.

**Core invariants:**

- Every failing test is classified into exactly one of: **product bug**,
  **test bug**, or **flake**, before any fix.
- Retries (`CI` retries=2) are for flakes only; do not rely on retries as
  triage.
- Quarantine is a last resort, time-boxed (30 days), and requires a linked
  product-bug entry when the root cause is a product bug.
- Product bugs get a minimal reproduction in the bug entry; test bugs get
  a selector/stabilization correction.

## Plan references

- §10 Maintenance model
- `docs/superpowers/plans/2026-08-27-e2e-coverage-enhancement.md` catalog

## Procedure

### Step 1 — Capture evidence first

- Browser (Playwright): open `playwright-report/` (reporter: html),
  inspect the failure screenshot (`only-on-failure`) and, on CI retry, the
  trace (`on-first-retry`). Save the trace zip path in the triage note.
- Pipeline (Vitest): keep the raw error + receipt/issue objects; run with
  `-g "PIPE-###"` locally to isolate.

### Step 2 — Classify

1. **Product bug** — the guarded behavior genuinely broke:
   - Empty chart rendered (geometry assertion fails at shadow DOM).
   - Import error affordance missing/generic when the feature has one.
   - Sync stall (heartbeat timeout on distinct observations).
   - Pipeline: receipt succeeds yet rollup/query drift, stale tokens,
     duplicated contributions, missing-as-zero aggregation.
   - Action: file product bug with minimal repro. Do not weaken the test.
2. **Test bug** — behavior is correct; the assertion or selector drifted:
   - Selector broke due to DOM change; the data verifies manually.
   - Assertion asserted the wrong affordance (error vs empty inverted).
   - Fixture or route interception no longer matches reality.
   - Action: correct with `add-e2e-test` / `add-pipeline-e2e-test` skills.
3. **Flake** — intermittent without assertion-side cause:
   - Race between worker completion and assertion; no explicit wait.
   - Shared browser state leaking between fully-parallel runs.
   - Action: stabilize with explicit waits/state isolation (never
     arbitrary `sleep`).

### Step 3 — Reproduce before fixing

- Browser: `pnpm --filter site test:e2e -g "<ID>"` until consistent.
- Pipeline: `pnpm --filter @lucasschirm/sal-db test -- -g "<ID>"`.

### Step 4 — Route the fix

| Classification | Owner | Artifact |
|---|---|---|
| Product bug | Product owner (via PR/issue) | Bug entry with minimal repro + link to failing test |
| Test bug | `e2e-test-maintainer` | Updated helper/selector/assertion |
| Flake | `e2e-test-maintainer` | State isolation / explicit wait |

When a product bug is open, update the plan's tracker: mark the catalog
entry status as `FAILING-PRODUCT-BUG` with the issue link.

### Step 5 — Quarantine (last resort)

If a product bug cannot be fixed promptly, mark the test with
`test.fixme()` (Playwright) or a `describe.skip` (Vitest) *with a comment
linking the bug and expiry*:

```ts
// QUARANTINE until 2026-09-27 — product bug #<link>
test.fixme('UX-001: chart geometry', ...);
```

Track expiry in the plan tracker; the maintainer re-enables or deletes at
expiry. Never quarantine flakes — fix the isolation instead.

### Step 6 — Post-triage record

Append to `docs/superpowers/discoveries/2026-08-27-e2e-coverage-enhancement.md`:

```markdown
## <date> — <UX/PIPE/SYNC ID>
- Classification: product-bug | test-bug | flake
- Evidence: <trace path / receipt / error>
- Action: <link or fix>
- Rule/skill/tool proposal: <if a repeated pattern emerges>
```

## Completion checklist

- [ ] Evidence captured (trace/screenshot or receipt).
- [ ] Classification recorded.
- [ ] Product bug entries include minimal reproduction.
- [ ] Test fix follows the authoring skills (no arbitrary sleeps).
- [ ] Quarantine is time-boxed, linked, and tracked in the plan.
- [ ] Discovery entry appended for repeat patterns.
