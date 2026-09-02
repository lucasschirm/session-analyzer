---
name: pr-review
description: Use when asked to review a GitHub pull request for merge/deploy risk. Reads diffs alongside the surrounding code and consumers they feed, checks changes against the rules in .agents/rules, hunts for UX regressions in load-bearing files, verifies claimed fixes and test coverage against actual behavior, and posts findings as a real GitHub PR review with inline comments via the gh CLI.
---

# PR Review

## Overview

A PR review is judged on what it catches, not what it covers. Reading the
diff alone is not enough — most real risk in a PR shows up in how the
changed lines interact with code that isn't in the diff: callers of a
changed function, a base class other components inherit from, a router or
singleton whose invariants a small change can quietly break. This skill
reviews for merge/deploy risk with a bias toward UX regressions, and ends
by posting findings as an actual GitHub PR review — not a chat summary.

**Core invariants:**

- Every finding is pinned to a concrete file + line + failure scenario.
  "Could be cleaner" is not a finding; "clicking X while Y leaves the UI
  in state Z" is.
- The diff is a starting point, not the review surface. For every changed
  function, component, or exported symbol, its callers/consumers are
  checked too — a correct-looking change at the definition can still
  break a caller built on the old contract.
- Load-bearing files (shared base classes, singletons, routers,
  sync/ingestion orchestrators, anything widely imported) are read in
  full when touched, even for a one-line change — their surrounding state
  machine determines whether that line is actually safe.
- UX-facing changes get the deepest scrutiny: modals, routing, loading/
  error/empty states, focus and keyboard paths, and any long-running
  operation's progress/failure affordances. This is where silent
  regressions hide.
- Claims in the PR description, commit messages, and test-plan checkboxes
  are verified against the actual code and actual tests, never taken on
  faith. A claimed fix with no test that drives its exact prior failure
  path is itself a finding.
- Findings are minimal, non-repetitive problem statements: no praise, no
  "looks good", no fix code or "consider" hedging. State the risk and
  stop; drop anything that doesn't clear the bar of a real, concrete
  risk rather than padding the review.
- The output is a posted GitHub PR review with inline comments, not a
  chat-only summary — unless the user specifically asks for the latter.

## Rule references

This repo encodes its non-negotiable invariants under `.agents/rules/*.md`,
one concern per file, each opening with a **When to use this rule**
header. Don't rely on memory of what's in there — run `ls .agents/rules/`
and open whichever files' headers match the paths or concepts the PR
touches before finishing the review. A frontend/Lit PR and a db-core
migration PR pull in almost entirely different rules from that directory.

## Reference commands

| Need | Command |
|---|---|
| Repo owner/name | `git remote get-url origin` |
| PR metadata, files, commits | `gh pr view <n> --json number,title,body,headRefName,baseRefName,url,files,additions,deletions,commits` |
| Full diff (no checkout needed) | `gh pr diff <n>` |
| Per-file diff when the PR branch is checked out | `git fetch origin <base> --quiet && git diff origin/<base>...HEAD -- <path>` |
| Diff hunk ranges (for comment placement) | `git diff origin/<base>...HEAD -- <path> \| grep '^@@'` |
| Head commit SHA (for the review payload) | `gh pr view <n> --json headRefOid` |
| Post the review | `gh api repos/<owner>/<repo>/pulls/<n>/reviews --input <file>` |

## Procedure

### Step 1 — Resolve the PR and gather its own claims

Get `owner`/`repo` from the origin remote and fetch PR metadata with
`gh pr view`. Read the PR body's bullet list of "what changed" and every
commit message — treat these as hypotheses the review will verify, not as
established fact. Note `baseRefName` and use it (not an assumed `main`)
in every diff command that follows.

If the PR's branch is already checked out locally (common when reviewing
your own just-finished work), work directly against it. Otherwise, prefer
read-only inspection (`gh pr diff <n>`, `git show <headRefOid>:<path>`)
over switching branches; if a checkout is genuinely more convenient, run
`git status` first per the repo's git safety rules before touching the
working tree.

### Step 2 — Read full diffs per file, not just the stat

`git diff --stat` (or the `files` array from `gh pr view`) gives the
shape of the change; read every changed file's full diff
(`git diff origin/<base>...HEAD -- <path>`), not only the stat line.
Prioritize by blast radius, not by line count: a 5-line change to a
router or singleton outweighs a 300-line addition to a single leaf
component.

### Step 3 — Read load-bearing touched files whole

A file is load-bearing when it's widely imported (grep its exported
symbols or tag name across the repo), when it's a singleton or
orchestrator (sync manager, app shell, a router), or when it sits on a
boot/ingestion/rebuild critical path. For each one touched, read the
*whole* file, not just its diff hunk — a small change only reads
correctly in light of the rest of its state machine or render method.
Specifically check:

- Module-level or singleton mutable state — can a second concurrent
  caller stomp on it, or a resolver/callback leak if never consumed?
- Lifecycle hooks (`connectedCallback`/`disconnectedCallback`/
  `firstUpdated`/`willUpdate`) for missed cleanup or a reaction that
  fires (or fails to fire) under conditions the author didn't consider.
- Shared base classes — confirm subclasses *compose* the parent's
  contribution (e.g. `static styles = [baseStyles, css\`...\`]`) rather
  than silently overriding and dropping it.

### Step 4 — Trace consumers, not just producers

For every changed function, exported symbol, or component tag, grep the
rest of the repo for its call sites and open each one. For a data-shape
change, follow it through the whole pipeline it feeds (e.g. transformer →
ingestion → rollup → query → UI), not just the first consumer. For a
routing change, read the router implementation itself rather than
assuming standard browser-history semantics — hash routers and
`replaceState`-based updates frequently behave differently from what the
calling code assumes (e.g. a route controller that only re-derives
params on a real navigation event, never on a same-page `replaceState`).

### Step 5 — Hunt UX risk specifically

Apply this checklist to every changed interactive/user-facing surface:

- **Modals/dialogs**: does opening move focus in? Does Escape or an
  overlay click actually reach the handler regardless of where focus was
  before opening, or only if the user already clicked inside?
- **Loading/error/empty states**: can the loading gate hang forever if a
  promise rejects? Is a failure ever rendered identically to a
  legitimate empty/idle state (`no-silent-empty-states.md`)?
- **Long-running operations** (sync, rebuild, reprocess, import): is
  there a *tested* terminal-failure affordance, or only a happy path
  (`sync-progress-observability.md`)?
- **Reactive prop/state sync**: when a value is driven by both a
  route/prop and a local action (e.g. `replaceState`, a toggle), can a
  "suppress the next reaction" guard go stale and swallow a later
  legitimate external change?
- **Back-button/bookmark/refresh**: does an action that visibly changes
  the URL push a history entry, or only `replaceState`? Is URL behavior
  consistent across sibling actions of the same feature (e.g. Edit and
  Cancel update the URL but New doesn't)?
- **Design consistency**: a hardcoded color/spacing value inside an
  otherwise theme-token-driven file signals the change bypassed the
  usual token pass.
- Whatever the PR description explicitly claims it fixed is the single
  highest-value thing to independently reproduce/verify — authors most
  often under-test exactly the failure mode they just "fixed".

### Step 6 — Verify test coverage against the actual fix

For each behavior the PR claims to fix or add, find the specific test
that should cover it and read it — confirm it drives the *actual trigger
path*, not a related-but-different path that happens to touch the same
component. A test "in the area" is not coverage. Also check:

- New test code doesn't itself violate workspace rules to get there
  (e.g. `@ts-expect-error`/`@ts-ignore` to reach a private field — banned
  by `workspace-rules.md`; needing one is a sign the code under test
  wants a real seam instead). If the same escape hatch is already used
  elsewhere in the same file, say so — it's pre-existing debt, not a new
  violation, and the finding should be scoped accordingly.
- Per `e2e-coverage-required.md`, user-facing changes should cite catalog
  IDs (UX-/PIPE-/SYNC-) registered in the plan file the rule names —
  check that file actually exists and actually contains them. Report a
  gap either way: missing catalog entries, or a rule pointing at a file
  that was never created.

### Step 7 — Compile findings

One finding per concrete, verified risk. Each is 1–3 sentences: enough
context to locate the problem, then the failure statement — no fix code,
no "consider" hedging, no praise. Cite the specific rule file when a
finding is a rule violation. Drop anything that can't be pinned to a
file, a line, and a concrete scenario rather than padding the review; a
short list of verified risks is worth more than a long list diluted with
nits.

### Step 8 — Post as a real GitHub PR review

1. Get the head commit: `gh pr view <n> --json headRefOid`.
2. For each finding's anchor line, confirm it actually falls inside a
   diff hunk (`git diff ... -- <path> | grep '^@@'`, check the line
   against the `+start,len` range) — the API rejects a comment on a line
   that isn't part of the diff.
3. Write one JSON payload to a scratch file (don't inline-escape a
   multi-comment body in shell):
   ```json
   {
     "commit_id": "<headRefOid>",
     "event": "COMMENT",
     "body": "<short summary + any process-level note that doesn't anchor to one line>",
     "comments": [
       { "path": "<file>", "line": <n>, "side": "RIGHT", "body": "<finding>" }
     ]
   }
   ```
4. Validate the JSON (e.g. `python3 -m json.tool file.json`) before
   sending.
5. Submit: `gh api repos/<owner>/<repo>/pulls/<n>/reviews --input <file>`.
6. Use `event: "COMMENT"`. Never `APPROVE` — the goal is to surface risk,
   not to gate the merge decision, unless the user explicitly asked for a
   blocking review. If genuinely nothing survives Step 7's bar, submit
   `COMMENT` with an empty comment list and a short body rather than
   inventing filler or praise.
7. Reply in chat with a short pointer to the posted review (link + one
   line on what it covers) — the findings themselves live in the review,
   not restated in the conversation, unless the user asks to see them.

## Relationship to the `pr-review` agent

`.agents/agents/pr-review.md` defines a separate dispatchable subagent
built around GitHub MCP tool calls (`mcp__github__*`). This skill instead
guides the *current* agent's own actions using the `gh` CLI, which needs
no MCP server configured. Use whichever is actually available; the
underlying goal — concrete, minimal, non-approving findings posted as a
real review — is the same either way.

## Completion checklist

- [ ] PR metadata, file list, and commit messages read via `gh pr view`
- [ ] Full diff read per changed file, not just the stat
- [ ] Load-bearing touched files read in full, beyond their diff hunks
- [ ] Call sites/consumers of every changed exported symbol checked
- [ ] Relevant `.agents/rules/*.md` files identified and read
- [ ] UX-risk checklist (Step 5) applied to every interactive change
- [ ] Every PR-claimed fix independently verified against the code
- [ ] Test coverage confirmed to exercise the actual trigger path
- [ ] Findings are concrete, minimal, non-repetitive, no praise/fix-code
- [ ] Comment anchor lines confirmed inside diff hunks before posting
- [ ] Review posted via `gh api .../reviews` with `COMMENT` (never `APPROVE`)
- [ ] Chat reply stays a short pointer to the review, not a re-summary
