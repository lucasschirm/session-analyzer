---
name: Task
about: A task — one sub-issue under a feature, sized to land as a single PR
title: "<Feature short-name> <k>/<N>: <task name>"
labels: task
---

# <Task name>

Part of <parent feature issue link>. Design / spec reference: <link to the
exact artboard / section this task implements>.

## Scope

<What this PR builds, concretely. Every codebase claim in this section
must be VERIFIED against the code before filing — file paths, symbol
names, constants, limits. Never write "verify X exists" as a scope item:
check now, and if X is missing, scope its creation as new work here or
name the issue that owns it.>

<When this task deletes or replaces a shared component (a nav, a header,
a container), include a **disposition table**: every affordance/route the
component carries today → where it goes (this PR, a named later PR, or an
explicitly accepted interim state with the restoring PR named).>

<When this task ships a reusable artifact (a renderer, a helper), state
that this issue OWNS it and which issues consume it — one owner per
artifact.>

<State the mount point: which page/route this lands on in ITS OWN PR, so
acceptance is verifiable at merge time — never against UI a later PR
builds.>

## Out of scope

<What neighboring work is deliberately excluded, and which issue owns it.
No dead controls: a UI element whose behavior is deferred is not rendered;
the deferral gets a follow-up issue.>

## Rules

<The `.agents/rules/` invariants this task triggers, restated as they
bind THIS task — including the edge semantics: missing values typed and
rendered "—" never 0; unbounded/"All" windows make deltas not-applicable;
sample size (n=) on every aggregate; canonical enum vocabularies (e.g.
`INVOCATION_KINDS`) copied exactly, never extended in UI copy.>

## Acceptance criteria

- <Each criterion objectively verifiable when THIS PR merges.>
- <Quantitative bounds must be CI-deterministic (sizes, counts — not
  wall-clock timings; timing bounds are local guidance or belong to the
  rollout perf smoke).>
- `pnpm verify` green.

## Test plan

- Unit: <branches, edge cases (empty / single / N), typed-missing paths,
  ordering guards>.
- E2E (catalog-mapped): <the catalog IDs this PR cites — and this PR
  lands those tests itself; both empty AND error affordances for any
  data-rendering surface>.

Dependencies: <issues that must land first, including the bootstrap PR;
"none" is a claim to verify, not a default>.
