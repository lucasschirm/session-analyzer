---
name: Feature
about: A feature — the parent issue that owns a set of task sub-issues
title: "<Feature name>: <one-line outcome>"
labels: feature
---

# <Feature name>

## Summary

<What is being built and why, in 3–6 sentences. Link the approved design
canvas / spec / discussion that this feature implements. Name what changes
for the user, not just what changes in the code.>

- Design / spec reference: <link>
- Approved deviations from the reference: <list each deliberate deviation
  here so the feature-level acceptance check does not fail on it — or
  "none">

## Architecture guardrails (apply to every sub-issue)

<Restate every repo rule from `.agents/rules/` that this feature can
trigger, each as one bullet naming the rule and how it binds this feature.
Do not paraphrase a rule into something weaker. Typical set for this
repo:>

- **No canonical metrics in Lit** — components read precomputed DTOs from
  the `AnalyticsDataSource` contract; new values are added to the db query
  layer + metric registry, never derived in components.
- **Missing is never zero** — absent signals are typed missing and render
  as "—", never 0.
- **Aggregates expose sample size** — every aggregate DTO carries its n
  and coverage; every rendered aggregate displays it.
- **Metric meaning changes require versioning.**
- **SQL only in `packages/db-core`**; schema changes ship the three test
  classes (migration / fresh-schema parity / query-plan).
- **No silent empty states** — empty and error affordances are
  distinguishable everywhere.
- **Domain separation** — Tool, Skill, Agent, Sub Agent are the four
  canonical invocation domains; never invent a fifth.
- **E2E coverage required** — every user-facing PR cites catalog IDs and
  lands the mapped tests in the same PR.
- **Frontend conventions** — `.agents/rules/frontend-coding-style.md`,
  `lit-performance-optimizer` review, `pnpm verify` green.

## Sub-issues / phasing

<Group sub-issues into phases. The FIRST phase is always the bootstrap of
any rule-mandated artifact later PRs must cite (e.g. the E2E catalog +
shared test helpers) — a per-PR obligation can never live only in the
final gate.>

Phase 0 — Bootstrap
0. <catalog / scaffolding PR that unblocks every later PR's citations>

Phase 1 — Foundation
1. <...>

Phase N — Verification & rollout
N. <final completeness gate + rollout checklist, including every
   deferred cleanup as "completed or explicitly deferred with an issue">

**Dependency order:** <explicit, acyclic order, e.g. (0) → (1) → (2, 3) →
(4) → …. Name which items can start in parallel, and which single issue
owns each shared artifact (a renderer, a helper) that multiple issues
touch.>

**Mid-sequence deployability:** every intermediate merge must leave the
deployed app fully usable — name the mechanism (e.g. "the old page/header
persists per route until the PR that replaces its affordances lands", "a
component rendered inside a container being deleted is re-homed first").

## Acceptance (feature-level)

- <Outcome-level criteria, each objectively verifiable.>
- All **<N>** sub-issues closed (list them: #a–#z); catalog updated;
  `pnpm verify` green; no regression in existing E2E suites.
