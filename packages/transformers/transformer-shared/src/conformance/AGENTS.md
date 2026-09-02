# src/conformance/

Shared conformance harness used to verify that any `SessionTransformer`
obeys the 10 canonical invariants. Published as the public subpath
`@lucasschirm/sal-transformer-shared/conformance` (see `package.json`
`exports`) so transformer plugin packages (`claude-transformer`, and a
future `devin-transformer`, DS-F7 / #149) can import it directly instead of
reaching into this package's internals.

This lives under `src/`, not `tests/`, specifically so it is reachable
through the package's normal build/`exports` map by other packages — a
`tests/`-relative reach-through (`../../../transformer/tests/...`) does not
generalize past a sibling-directory relationship.

## Files

- **index.ts** — Barrel re-exporting `suite.ts` and `fixtures/index.ts`; this is what `/conformance` resolves to.
- **suite.ts** — `runTransformerConformanceSuite` entry point; executes all 10 invariants against a transformer and fixture set and returns a pass/partial/fail report.
- **fixtures/index.ts** — The generic `ConformanceFixture<TBundle>` / `TransformerFixtures<TBundle>` contract types. No fixture *data* lives here — each transformer plugin package supplies its own golden fixtures (e.g. `packages/transformers/claude-transformer/tests/conformance/fixtures/`).

## Key relationships

- `suite.ts` imports the base contract types from `../index.js` (this package's own barrel) and the fixture contract from `./fixtures/index.js`.
- `packages/transformers/transformer-shared/tests/unit/base-contract-conformance.test.ts` drives the suite against a minimal fixture transformer to prove it works for a spec-conformant plugin that does not extend `ScalarMetricValue`.
- Each transformer plugin package drives the suite against its own fixtures from its own `tests/unit/conformance.test.ts` (e.g. `packages/transformers/claude-transformer/tests/unit/conformance.test.ts`), importing `runTransformerConformanceSuite` from the `/conformance` subpath.
