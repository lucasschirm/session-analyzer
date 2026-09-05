import { describe, expect, it } from 'vitest';
import { runTransformerConformanceSuite } from '../../src/conformance/suite.js';
import type {
  ArtifactClassificationResult,
  DetectionResult,
  MetricCapability,
  ScalarMetricValue,
  SessionTransformer,
  TransformContext,
  TransformResult,
  UnknownArtifactBundle,
} from '../../src/index.js';

// This transformer implements only the documented base `ScalarMetricValue`
// shape from src/metric.ts — no Claude-only `provenance`/`evidenceRecordIds`/
// `unavailableReason` fields (see ClaudeMetricValue). It stands in for a
// spec-conformant second-harness plugin (e.g. a devin-transformer) and
// exercises the regression from issue #139: running the shared conformance
// suite against it must not throw a raw TypeError.

const baseContext: TransformContext = {
  analysisReleaseId: 'base-contract-r1',
  parserId: 'base-contract-fixture-parser',
  parserVersion: '0.1.0',
  sourceFingerprint: 'fp-base-contract',
};

const baseBundle: UnknownArtifactBundle = {
  artifacts: [{ relativePath: 'transcript.txt', mediaType: 'text/plain', content: 'hello' }],
  sourceFingerprint: 'fp-base-contract',
};

function baseScalarMetric(overrides: Partial<ScalarMetricValue>): ScalarMetricValue {
  return {
    metricId: 'base:example:count',
    definitionVersion: '1',
    value: 1,
    exact: true,
    unit: 'count',
    comparabilityGroupId: 'base:example:count:v1',
    provenanceArtifactId: 'transcript.txt',
    ...overrides,
  };
}

function baseTransformResult(): TransformResult {
  return {
    bundleHash: 'hash-1',
    parserId: 'base-contract-fixture-parser',
    parserVersion: '0.1.0',
    transformerId: 'base-contract-fixture-transformer',
    transformerVersion: '0.1.0',
    ontologyVersion: '1',
    metricDefinitionVersion: '1',
    evidence: [
      {
        recordId: 'rec-1',
        recordType: 'normalized_event',
        sessionId: 'sess-1',
        sourceEventId: 'evt-1',
        provenance: { artifactId: 'transcript.txt' },
        payload: {},
      },
    ],
    sessionSummaries: [
      { sessionId: 'sess-1', rootSessionId: 'sess-1', harness: 'base-fixture', finality: 'final' },
    ],
    componentSummaries: [],
    metricValues: [
      baseScalarMetric({}),
      baseScalarMetric({
        metricId: 'base:example:unavailable',
        comparabilityGroupId: 'base:example:unavailable:v1',
        value: null,
        exact: false,
      }),
    ],
    distributions: [],
    configurationSnapshot: { completeness: {}, components: [] },
    capabilities: [],
    unavailableReasons: [
      {
        metricId: 'base:example:unavailable',
        definitionVersion: '1',
        reason: 'not observed by base harness',
      },
    ],
    provenance: [{ artifactId: 'transcript.txt' }],
    warnings: [],
    errors: [],
  };
}

const baseContractTransformer: SessionTransformer<UnknownArtifactBundle> = {
  id: 'base-contract-fixture-transformer',
  harnesses: ['base-fixture'],
  transformerVersion: '0.1.0',
  ontologyVersion: '1',
  detect: (): DetectionResult => ({ kind: 'matched', harness: 'base-fixture', confidence: 1 }),
  classifyArtifacts: (): ArtifactClassificationResult => ({
    artifacts: [],
    configurationSnapshot: { completeness: {}, components: [] },
    components: [],
  }),
  getCapabilities: (): MetricCapability[] => [],
  transform: (): TransformResult => baseTransformResult(),
};

describe('runTransformerConformanceSuite against a base-contract-only transformer', () => {
  it('does not throw a TypeError for a fixture with only ScalarMetricValue fields', () => {
    const run = () =>
      runTransformerConformanceSuite(baseContractTransformer, {
        fixtures: [
          {
            name: 'base-only',
            description:
              'Minimal fixture implementing only ScalarMetricValue, no Claude-only fields.',
            bundle: baseBundle,
            context: baseContext,
            tags: ['root', 'partial', 'unavailable'],
          },
        ],
      });

    expect(run).not.toThrow(TypeError);
  });

  it('passes (or fails with a clear conformance diagnostic) without extended metric fields', () => {
    const report = runTransformerConformanceSuite(baseContractTransformer, {
      fixtures: [
        {
          name: 'base-only',
          description: 'Minimal fixture implementing only ScalarMetricValue.',
          bundle: baseBundle,
          context: baseContext,
          tags: ['root', 'partial', 'unavailable'],
        },
      ],
    });

    expect(report.invariants.every((inv) => inv.status !== 'failed')).toBe(true);
  });
});
