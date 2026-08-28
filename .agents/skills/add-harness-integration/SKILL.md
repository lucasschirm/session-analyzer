---
name: add-harness-integration
description: Use when adding or updating a harness parser/transformer integration (detection, artifact classification, capability mapping, fixtures, registration, and conformance) for the analytics data platform. Covers the full path from native artifacts through canonical write batches.
---

# Add Harness Integration

## Overview

This skill codifies the repeatable procedure for adding a new harness
integration to the analytics platform. A harness integration has two layers:
a **native parser** (produces a typed native model) and a **canonical
transformer** (produces a canonical write batch). The transformer is a plugin
registered in `@lucasschirm/sal-transformer`; the parser is a separate
package the transformer depends on.

**Core invariant:** transformers are pure and deterministic. They never open
SQLite, query project history, access remote storage, or emit project
lifecycle events. All generated identifiers must be deterministic from stable
source identity, not call order or wall-clock time.

## Plan references

- §6 Transformer plugin and comparability contract (§6.1 plugin contract, §6.2
  cross-harness comparability, §6.3 canonical invariants)
- §7 Manifest-driven artifacts (§7.1 descriptor and classification, §7.2 scope
  and identity, §7.3 completeness, time, ordering, and lifecycle)
- §15.2 Transformer acceptance criteria
- §16.3 Rules — harness plugins pass conformance

## Package paths

| Concern | Path |
|---|---|
| Transformer plugin interface | `packages/transformer/src/plugin/` |
| Plugin registry | `packages/transformer/src/registry.ts` |
| Default registry | `packages/transformer/src/default-registry.ts` |
| Artifact classification | `packages/transformer/src/classification.ts` |
| Comparability groups | `packages/transformer/src/comparability.ts` |
| Canonical invariants | `packages/transformer/src/invariants.ts` |
| Metric computation primitives | `packages/transformer/src/metric.ts` |
| Bundle contracts | `packages/transformer/src/bundle.ts` |
| Evidence normalization | `packages/transformer/src/evidence.ts` |
| Provenance | `packages/transformer/src/provenance.ts` |
| Issue contracts | `packages/transformer/src/issue.ts` |
| Claude Code transformer (reference) | `packages/transformer/src/plugin/` |
| Claude Code parser (reference) | `packages/parsers/claude-session-parser/` |
| Conformance suite | `packages/transformer/tests/` |
| Golden fixtures | `packages/transformer/tests/fixtures/` |

## Procedure

### Step 1 — Scaffold the parser package

If a native parser does not yet exist for the target harness, create a new
package under `packages/parsers/<harness>-session-parser/`.

```bash
mkdir -p packages/parsers/<harness>-session-parser/{src,tests}
```

**`packages/parsers/<harness>-session-parser/package.json` template:**

```json
{
  "name": "@lucasschirm/sal-<harness>-session-parser",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "scripts": {
    "test": "vitest run",
    "test:coverage": "vitest run --coverage",
    "verify": "pnpm test:coverage && pnpm build"
  },
  "devDependencies": {
    "vitest": "^3.0.0"
  }
}
```

The parser must be pure, dependency-free, and schema-based in its detection
(never file-extension-based). It produces a typed native model from native
artifacts.

### Step 2 — Scaffold the transformer plugin

Create the transformer plugin under
`packages/transformer/src/plugin/<harness>/`.

```bash
mkdir -p packages/transformer/src/plugin/<harness>
```

**Plugin file template (`packages/transformer/src/plugin/<harness>/index.ts`):**

```ts
import type { SessionTransformer, UnknownArtifactBundle } from '../../bundle';
import type { DetectionResult, ArtifactClassificationResult } from '../../classification';
import type { MetricCapability } from '../../metric';
import type { TransformContext, TransformResult } from '../../session';

export const <harness>Transformer: SessionTransformer<UnknownArtifactBundle> = {
  id: '<harness>',
  harnesses: ['<harness>'],
  transformerVersion: '0.1.0',
  ontologyVersion: '0.1.0',

  detect(bundle: UnknownArtifactBundle): DetectionResult {
    // Schema-based detection. Ambiguous detection is a structured error,
    // never first-match behavior. Manifest harness identity takes precedence.
  },

  classifyArtifacts(bundle): ArtifactClassificationResult {
    // Use harness + scope + full relative path. Identical bytes can be
    // different kinds in different paths.
  },

  getCapabilities(bundle?): MetricCapability[] {
    // Declare available, partial, unavailable, or incompatible for each
    // canonical metric. Unavailable metrics must include a reason.
  },

  transform(bundle, context): TransformResult {
    // Produce normalized evidence, typed summaries, scalar metrics,
    // distributions, configuration snapshot, capabilities, provenance,
    // version stamps, warnings, and fatal errors.
    // All IDs must be deterministic from stable source identity.
  },
};
```

### Step 3 — Implement detection

Detection is schema-based, not file-extension-based. Manifest harness
identity takes precedence over schema detection. Schema detection is used for
manual imports or validation.

```ts
detect(bundle: UnknownArtifactBundle): DetectionResult {
  // 1. If manifest harness identity is present and matches this plugin,
  //    return { harness: '<harness>', confidence: 'manifest', ... }.
  // 2. Otherwise probe schema signatures (structured content, not extension).
  // 3. Ambiguous detection returns a structured error, never first-match.
}
```

**Detection result template:**

```ts
interface DetectionResult {
  harness: string;
  harnessVersion?: string;
  confidence: 'manifest' | 'schema' | 'ambiguous';
  ambiguousWith?: readonly string[];
  issues?: readonly Issue[];
}
```

### Step 4 — Implement artifact classification

Classification belongs to the manifest artifact reference, not the content
blob. Use normalized full paths and structured content. A structured artifact
can yield multiple component definitions; each extracted component retains a
source pointer (safe JSON Pointer or text range).

**Classification table template** (adapt from §7.1 for your harness):

```ts
const CLASSIFICATION_RULES: ReadonlyArray<{
  scope: ArtifactScope;
  pathPattern: RegExp;
  kind: ComponentKind;
  extractComponents?: (content: unknown) => ComponentDefinition[];
}> = [
  // e.g. { scope: 'session', pathPattern: /^transcript\.jsonl$/, kind: 'root_transcript' },
  // e.g. { scope: 'workspace', pathPattern: /^\.claude\/skills\/[^/]+\/SKILL\.md$/, kind: 'skill' },
];
```

Unmatched supported-scope paths are classified as `unclassified` with a
reason, never silently dropped.

### Step 5 — Implement capability mapping

For each canonical metric, declare whether this harness can produce it:

```ts
getCapabilities(bundle?): MetricCapability[] {
  return [
    { metricId: 'session.total_tokens', status: 'available' },
    { metricId: 'session.cache_read_tokens', status: 'available' },
    { metricId: 'session.task_completion', status: 'unavailable', reason: 'no native task signal' },
    { metricId: 'session.sub_agent_critical_path', status: 'partial', reason: 'overlap not captured' },
  ];
}
```

Capability statuses: `available`, `partial`, `unavailable`, `incompatible`.
Unvailable metrics **must** include a reason. Capabilities are keyed by
transformer/harness/version in `transformer_metric_capabilities`.

### Step 6 — Implement the transform

`TransformResult` must include:

- normalized evidence records;
- typed session and component summaries;
- scalar metric values and distributions;
- a configuration snapshot with per-component-type completeness;
- metric capabilities and unavailable reasons;
- artifact, source-event, and source-field provenance;
- parser, transformer, ontology, metric-definition, and estimation-method
  versions;
- recoverable warnings and fatal errors.

**Command to verify determinism:**

```bash
# Run the transformer twice on the same bundle and diff the output.
cd packages/transformer && pnpm vitest run -- -t "deterministic"
```

### Step 7 — Create golden fixtures

Create fixtures under `packages/transformer/tests/fixtures/<harness>/`:

```bash
mkdir -p packages/transformer/tests/fixtures/<harness>/{complete,malformed,partial,redacted,compacted,replayed}
```

Required fixture categories (§15.2):

- root and Sub Agent sessions;
- complete, malformed, partial, redacted, compacted, and replayed artifacts;
- manifest path classification and structured multi-component artifacts;
- capability matrices and unavailable reasons;
- provenance to artifact/event/field;
- root/inclusive anti-double-counting.

**Fixture manifest template
(`packages/transformer/tests/fixtures/<harness>/manifest.json`):**

```json
{
  "harness": "<harness>",
  "fixtures": [
    {
      "name": "complete-root-session",
      "category": "complete",
      "input": "complete/root-session.jsonl",
      "expected": "complete/root-session.expected.json",
      "description": "A complete root session with all artifact types"
    },
    {
      "name": "partial-transcript",
      "category": "partial",
      "input": "partial/truncated.jsonl",
      "expected": "partial/truncated.expected.json",
      "description": "A truncated transcript that must declare partial capabilities"
    }
  ]
}
```

### Step 8 — Register the plugin

Add the plugin to the default registry:

```ts
// packages/transformer/src/default-registry.ts
import { <harness>Transformer } from './plugin/<harness>';
import type { SessionTransformerRegistry } from './registry';

export function createDefaultRegistry(): SessionTransformerRegistry {
  const registry = new SessionTransformerRegistry();
  registry.register(claudeCodeTransformer);
  registry.register(<harness>Transformer); // <-- add this line
  return registry;
}
```

**Command to verify registration:**

```bash
cd packages/transformer && pnpm vitest run -- -t "registry"
```

### Step 9 — Run the conformance suite

Every plugin must pass the shared conformance suite (§6.3). The suite proves:

- Tool, Skill, Agent, and Sub Agent remain distinct;
- unknown is not zero;
- exact and estimated values remain separable;
- root-only and inclusive values cannot double-count descendants;
- starts and results correlate by source ID;
- replayed source events deduplicate deterministically;
- partial snapshots do not imply removals;
- unavailable metrics include a reason;
- output is deterministic for the same bundle and versions;
- every aggregate retains evidence/provenance links.

**Command:**

```bash
cd packages/transformer && pnpm vitest run -- -t "conformance"
```

### Step 10 — Add harness documentation

Create `docs/architecture/harnesses/<harness>.md` documenting:

- native-to-canonical metric mappings;
- unsupported metrics and their reasons;
- classification rules and edge cases;
- comparability limitations across harnesses;
- manifest schema version supported.

## Completion checklist

- [ ] Parser package created under `packages/parsers/<harness>-session-parser/`.
- [ ] Transformer plugin created under `packages/transformer/src/plugin/<harness>/`.
- [ ] Detection is schema-based; ambiguous detection returns structured error.
- [ ] Artifact classification uses harness + scope + full path, not blob content.
- [ ] Capability mapping covers all canonical metrics with reasons for unavailable.
- [ ] Golden fixtures cover complete, malformed, partial, redacted, compacted, replayed.
- [ ] Plugin registered in `default-registry.ts`.
- [ ] Conformance suite passes for the new plugin.
- [ ] Determinism test passes (same bundle + versions → same output).
- [ ] Harness documentation created under `docs/architecture/harnesses/`.
- [ ] `pnpm --filter @lucasschirm/sal-transformer verify` passes.
