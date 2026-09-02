---
name: issue-orchestrator
description: Use when implementing GitHub issues - "work on issue #N", "work on the next issue", "continue the feature", or resuming an in-flight feature. Orchestrates the backlog of a Feature issue's task sub-issues (or standalone issues) - pick the next ready issue, mark it in progress, link a branch, delegate to the right specialized agent, verify, open the PR against the right base, and record discoveries.
---

# Implement GitHub Issues

## Overview

This skill is the GitHub-issues counterpart of the `task-orchestrator` agent:
the same orchestration loop - track, pick, delegate, verify, record - with the
backlog living in GitHub issues instead of `docs/superpowers/tasks/` files.
You do **not** implement every issue yourself: delegate to specialized agents
when one fits, implement directly only when the change is small, and always
record what you learn.

**Backlog shape** (as produced by the `feature-planning` skill): a parent
**Feature** issue (label `feature`) with linked **task** sub-issues (label
`task`), each sized to land as one PR, each carrying Scope / Rules /
Acceptance criteria / Test plan / Dependencies sections. Standalone issues
follow the same loop with `main` as the PR base.

## Status model (GitHub state instead of YAML frontmatter)

| task-orchestrator status | GitHub equivalent |
|---|---|
| NOT_STARTED | issue open, no `In Progress` label |
| IN_PROGRESS | issue open + `In Progress` label, branch linked |
| IN_REVIEW | PR open for the issue's branch |
| COMPLETED | PR merged; issue closed by its `Closes #<n>` |

- **Review can move work backwards**: when the PR review (or a failing gate)
  finds defects, the issue is back IN_PROGRESS on the same branch — record
  the findings as an issue comment, fix, and re-verify. Never skip back to
  IN_REVIEW without the gates re-run.
- Only the orchestrator moves status (labels, branch links). Implementing
  agents report results; the orchestrator advances state after verification.
- Ticking an issue's Acceptance-criteria checkboxes is the ONE body edit the
  orchestrator makes without approval — marks only, never the criteria text.
- Never skip review: work always lands through a PR, never a direct push.
- Never rewrite an issue's Scope / Acceptance / Dependencies to fit the
  implementation - a needed contract change is proposed to the user first
  (the issue text is the contract, like `Task ID`/`Dependency` in task files).

## Procedure

### 1. Assess the backlog

For a Feature issue `<F>`:

```bash
gh api repos/{owner}/{repo}/issues/<F>/sub_issues \
  --jq '.[] | {number, title, state, labels: [.labels[].name]}'
```

Identify: issues already `In Progress` (finish these first), ready issues,
and blocked issues with their blocker chain. An issue is **ready** when every
issue named in its body's `Dependencies:` line is CLOSED (read the body with
`gh issue view <n> --json body`; the `k/N` title order is a hint, the
Dependencies line is the contract). Older features (e.g. #182's sub-issues)
express the same contract as `Blocked by:` / `Blocks:` lines inside a
`## Dependencies` section — parse those the same way; `Blocked by` is what
gates readiness.

### 2. Select the next issue

1. Any issue already `In Progress` (resume it).
2. The lowest-`k/N` ready open issue (older features without `k/N` titles:
   the lowest-numbered ready issue).
3. Nothing ready → report the blocker chain and stop; never start an issue
   whose dependencies are open.

### 3. Mark in progress and link a branch (per `.agents/rules/workspace-rules.md` § Working on Issues)

```bash
gh issue edit <n> --add-label "In Progress"
gh issue develop <n> --name <branch-name> --base <base>   # creates the linked branch
```

(For a branch that already exists, link it via the `createLinkedBranch`
GraphQL mutation instead — per workspace-rules.)

- One issue per branch; never mix issues on a branch.
- **Base selection**: if the issue's parent is a Feature issue (parent
  sub-issue relationship, parent labeled `feature`), the branch and its PR
  target the **Feature issue's linked branch**, not `main` - create and link
  the feature branch first (`gh issue develop <F> --name <feature-branch>
  --base main`) if it doesn't exist. Only the Feature branch's own PR targets
  `main`. Standalone issues base on `main`.

### 4. Read the issue in full, then the references it cites

The issue body is the contract: Scope, disposition tables, Rules, Acceptance
criteria, Test plan, Dependencies. Also read every artifact it references -
the parent Feature's guardrails section, the design canvas/spec link, the
`.agents/rules/*.md` files it names, and the E2E catalog rows it cites.
Implement against the issue text, not a summary of it.

### 5. Delegate or implement

The `task-orchestrator` delegation table, extended for issue work (E2E
coverage, TS review):

| Work profile | Agent | When |
|---|---|---|
| Lit component / frontend perf | `lit-performance-optimizer` | `packages/site` components, render cycles (mandatory review per `frontend-coding-style.md`) |
| Harness integration review | `harness-integration-reviewer` | transformer plugins / parsers |
| Metric / schema / comparability review | `metric-schema-reviewer` | metric definitions, schema changes, comparability |
| DB migration / query / rollup review | `db-migration-reviewer` | `db-core`/`db` migrations, queries, indexes, rollups |
| UI / chart / accessibility review | `ui-chart-reviewer` | chart components, dashboard views, DTO consumption |
| GitHub PR review | `pr-review` | the opened PR, before requesting merge |
| TypeScript quality review | `ts-best-practices` | reviewing a completed issue's TS before the PR opens |
| E2E planning / implementation / triage | `e2e-test-planner` / `e2e-test-implementer` / `e2e-failure-fixer` | issues whose acceptance criteria include catalog-mapped E2E coverage; red suites |
| Read-only exploration | Explore subagent | context gathering before implementation |
| General implementation | general subagent | default for file edits when no specialist fits |
| Orchestratorial / small edits | (yourself) | labels, comments, small config edits |

Delegate prompts include: the issue number and full body (or `gh` command to
read it), the branch name, the specific files to create/modify when known,
the verification gates to run, and "report back: what you changed, what you
verified, what blocked you". Never run two delegates that write the same
files in parallel.

### 6. Verify

Before opening the PR, on the issue's branch:

```bash
pnpm verify                                # workspace root - mandatory
node scripts/analytics-gates/run-all-gates.mjs
```

Plus whatever the issue's own Test plan demands (package-scoped gates,
Playwright E2E for user-facing surfaces). Confirm every Acceptance criterion
in the issue body - each one is written to be verifiable at this PR's merge.
Self-critique the diff for edge cases before opening the PR.

### 7. Open the PR (review gate)

- Target the base from step 3. The PR body cites the E2E catalog IDs the
  issue names and MUST contain `Closes #<n>` so the merge closes the issue
  even if the branch link is missing.
- User-facing changes: the mapped catalog tests land **in this same PR**
  (per `e2e-coverage-required.md`) - never deferred.
- Dispatch the `pr-review` agent on the opened PR; address its findings
  before asking the user to merge. Merging is the user's call unless they
  have granted merge autonomy.

### 8. Complete and record

After the PR merges (issue auto-closes):

- Remove the `In Progress` label if the close didn't.
- Comment on the issue with the implementation summary: what was built,
  verification results, and any deviation from the issue text and why
  (the `## Notes` equivalent).
- If work stops without a merge (blocked/abandoned): remove `In Progress`,
  comment the reason and the blocker chain, and report to the user - per
  workspace-rules.

### 9. Document failures and discoveries (the improvement loop)

First-class responsibility, exactly as in the task-orchestrator:

- Repeated failure pattern → propose a **rule** under `.agents/rules/`.
- Reusable procedure several issues need → propose a **skill** under
  `.agents/skills/`.
- Missing tool/script → record a candidate **tool**.

Record each discovery before calling the issue done: a dated entry in
`docs/superpowers/discoveries/<feature-slug>.md` (create if absent) using the
same entry format as the task-orchestrator (`Discovery / Proposed artifact /
Location / Status`), and a pointer comment on the issue. When a discovery
warrants its own tracked work, open a new issue for it (label `enhancement`
or `bug`) instead of widening the current one.

### 10. Loop or report

Issue closed and more ready sub-issues remain → loop to step 1 (or report and
await the user, per the autonomy granted). When the LAST sub-issue merges
into the feature branch, open the Feature branch's PR to `main`; its merge
closes the Feature issue.

## Pre-delegation checklist

- [ ] Issue selected is ready (all dependency issues CLOSED).
- [ ] Issue body, its comments, and the parent Feature's guardrails read in
      full (comments carry review feedback and prior progress).
- [ ] `In Progress` label applied and branch linked before work starts.
- [ ] Delegate prompt includes: issue number + body, feature number, branch
      name, target files, verification gates, report-back instructions.
- [ ] No parallel delegate writes to the same files or branch as another
      running delegate.

## Pre-completion checklist

- [ ] Every Acceptance criterion verified (boxes ticked — marks only).
- [ ] `pnpm verify` + `node scripts/analytics-gates/run-all-gates.mjs` green,
      plus the issue's own Test-plan gates.
- [ ] Self-critique performed on the diff.
- [ ] PR opened with `Closes #<n>` against the correct base; catalog IDs
      cited; `pr-review` findings addressed.
- [ ] Implementation-summary comment posted (built / verified / deviations).
- [ ] Discoveries recorded in `docs/superpowers/discoveries/<feature-slug>.md`.

## Error handling

- **Delegate reports an unresolvable blocker**: comment it on the issue, keep
  `In Progress` (or remove the label with a reason comment if no work was
  done), surface the exact failure and candidate next actions to the user.
- **Verification fails**: never open/merge the PR. Comment the failure on the
  issue, fix or delegate the fix, re-run the gates.
- **Dependencies discovered wrong** (missing or spurious): never silently
  edit the issue body — propose the change to the user with rationale, edit
  only after approval.

## Decision policy

- Never open a PR without `pnpm verify` and the gates passing.
- Never start an issue whose dependencies are open; never work two issues on
  one branch.
- Never edit an issue's Scope / Acceptance / Dependencies without explicit
  user approval - propose the change with rationale instead.
- Prefer finishing `In Progress` work over starting new work.
- Prefer specialists over implementing everything yourself.
- When in doubt about scope, ask; never expand an issue's scope silently.
