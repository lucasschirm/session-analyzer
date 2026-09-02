---
name: feature-planning
description: Use when turning an approved design, spec, or sizable request into a GitHub feature - a parent Feature issue with linked task sub-issues - written by the issue-writer agent, reviewed by the feature-reviewer agent until clean. Covers issue creation mechanics (gh, issue types vs labels, sub-issue linking), label policy, phasing/dependency ordering, and the review loop.
---

# Feature Planning

## Overview

This skill codifies the repeatable procedure for planning a feature as GitHub
issues: one parent **Feature** issue plus one **task** sub-issue per PR-sized
unit of work, grounded in the real codebase, and iterated against an
adversarial review until the plan needs no further change.

**The three roles:**

| Role | Who | Does |
|---|---|---|
| Orchestrator | you (main session) | runs this procedure, owns `gh` mechanics, labels, linking, the review loop |
| Writer | `issue-writer` agent | writes/rewrites every issue body from the templates, verifying claims against the code |
| Reviewer | `feature-reviewer` agent | audits the full issue set, returns severity-ranked findings + a VERDICT line |

**Templates** (bodies must follow them):
- `.github/ISSUE_TEMPLATE/feature_template.md` — the parent feature outline
- `.github/ISSUE_TEMPLATE/task_template.md` — each task sub-issue outline

## Procedure

### 1. Ground the plan

Before any issue text exists, establish from the code (not memory): the routes
and pages touched, the data contracts involved (`AnalyticsDataSource` views,
DTOs, schema), existing components being replaced, existing tests/catalog IDs,
and every `.agents/rules/*.md` the feature triggers. The plan's phasing comes
out of this: bootstrap first (any artifact later PRs must cite, e.g. the E2E
catalog), then foundation, building blocks, screens, and a final
verification/rollout gate. Dependency order must be explicit and acyclic, and
every intermediate `main` merge must leave the deployed app fully usable.

### 2. Write the bodies

Dispatch the **`issue-writer`** agent with the feature context (design
reference, plan outline, grounding notes) to produce the parent body and every
sub-issue body as local markdown files (one file per issue, e.g. under a
scratch directory). Large features: batch related issues per dispatch rather
than one agent per issue. Review what comes back for scope-level sanity (the
reviewer will do the deep audit).

### 3. Create the issues

```bash
# Parent - try the typed Feature issue first:
gh api repos/{owner}/{repo}/issues \
  -f title="<Feature title>" -F body=@parent.md -f type=Feature \
  --jq '{number: .number, id: .id, type: .type}'
```

- **Issue types (`type: Feature`) exist only on organization-owned repos.**
  On a user-owned repo the API *silently ignores* the field — check `.type`
  in the response; when it comes back `null`, fall back to the label:
  `gh label create feature --color 1c2b4a --description "Feature (issue type)" --force`
  then `gh issue edit <n> --add-label feature`.
- **Label policy: ONLY the parent issue carries `feature`.** Sub-issues carry
  `task` (create the label the same way if missing) — never `feature`.

```bash
# Each sub-issue, then link it under the parent:
out=$(gh api repos/{owner}/{repo}/issues \
  -f title="<Feature short-name> <k>/<N>: <task>" -F body=@task-k.md \
  --jq '"\(.number) \(.id)"')
num=${out%% *}; id=${out##* }
gh api -X POST repos/{owner}/{repo}/issues/<parent_number>/sub_issues \
  -F sub_issue_id="$id"
gh issue edit "$num" --add-label task
```

- Sub-issue linking uses the issue's **`id`** (the numeric database id), NOT
  its `number`. Verify the links after creating:
  `gh api repos/{owner}/{repo}/issues/<parent>/sub_issues --jq '.[].number'`.
- Title numbering is `k/N` over the REAL final count — when the review adds a
  sub-issue, retitle the set so numbering and the parent's count stay true.

### 4. The review loop

Dispatch the **`feature-reviewer`** agent with the repo, parent number, and
all sub-issue numbers. Then:

1. If the verdict is `CHANGES REQUIRED`: apply **every** finding — blockers,
   should-fixes, AND nice-to-haves (applying nice-to-haves is what lets the
   next round terminate instead of re-listing them). Edit the local body
   files, push with `gh issue edit <n> --body-file <file>` (and
   `--title` where numbering changed); create any newly-scoped sub-issue via
   step 3. For substantial rewrites, send the finding back through the
   `issue-writer` agent rather than patching prose yourself.
2. Re-dispatch the reviewer on the updated set. Each round's prompt states it
   is round k and that the text must be judged from scratch; carry forward
   the standing decisions (documented deviations and interim states are
   approved, not findings) so settled questions don't oscillate.
3. **Stop when a round returns `VERDICT: CLEAN` on the final text.** If the
   clean round still listed nice-to-haves and you apply them, run one short
   confirmation round on the exact final text. Two consecutive clean
   verdicts is always a valid stopping point — do not loop on cosmetics
   after that; apply trivial notes (a one-line clause, a retitle) directly
   and finish.

Expect convergence, not perfection per round: a well-grounded plan typically
goes findings → fewer findings → clean within 2–4 rounds. If a round's
finding count is not shrinking, the plan (not the prose) is wrong — go back
to step 1.

### 5. Report

Summarize for the user: parent + sub-issue numbers with the phase table, the
label situation (typed issue vs `feature` label fallback), what the review
loop caught, and the verdict history.

## Delegation map

- Issue bodies (new or rewritten) → `issue-writer`
- Plan audit / verdict → `feature-reviewer`
- Design canvas or UI mockups referenced by the feature → the design tooling
  that produced them (out of scope here; link, don't recreate)
- Implementation of the planned issues → the execution agents
  (`task-orchestrator` picks tasks up; specialized reviewers like
  `db-migration-reviewer`, `metric-schema-reviewer`, `ui-chart-reviewer`,
  `harness-integration-reviewer` run at implementation time, not planning
  time)

## Core invariants

- Bodies come from the templates; guidance comments in the templates are
  binding on the writer.
- Only the parent wears `feature`; sub-issues wear `task`.
- Sub-issues are linked via the sub-issues API (by `id`), so the parent
  renders its live checklist.
- The loop ends only on a clean verdict over the final text; every finding
  applied is pushed to GitHub, never left only in local files.
