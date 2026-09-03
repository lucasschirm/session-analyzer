import { describe, expect, it } from 'vitest';
import {
  CANONICAL_INVARIANTS,
  deriveComparabilityGroupId,
  type SessionTransformer,
  type TransformContext,
  type UnknownArtifactBundle,
} from '../../src/index.js';

describe('SessionTransformer contract', () => {
  it('can be implemented and invoked', () => {
    const transformer: SessionTransformer<UnknownArtifactBundle> = {
      id: 'dummy',
      harnesses: ['dummy-harness'],
      transformerVersion: '0.1.0',
      ontologyVersion: '0.1.0',
      detect: () => ({ kind: 'matched', harness: 'dummy-harness', confidence: 1 }),
      classifyArtifacts: (bundle) => ({
        artifacts: bundle.artifacts.map((a) => ({
          relativePath: a.relativePath,
          kind: 'transcript',
          scope: 'session',
          mediaType: a.mediaType,
          confidence: 'exact',
        })),
        configurationSnapshot: { completeness: {}, components: [] },
        components: [],
      }),
      getCapabilities: () => [
        {
          metricId: 'm',
          definitionVersion: '0.1.0',
          state: 'available',
          comparabilityGroupId: deriveComparabilityGroupId({
            metricId: 'm',
            metricDefinitionVersion: '0.1.0',
            unit: 'count',
            grain: 'session',
            dimensions: {},
            observationUnit: 'session',
            population: 'all',
            sessionFinalityRules: 'final',
            measurementClass: 'exact',
            nativeMappingVersion: 'none',
            rootOnlyInclusive: 'root_only',
            statusThresholdCensoringMissingDataRules: 'unknown',
            aggregationStatisticalAttributionMethod: 'sum',
          }),
        },
      ],
      transform: (bundle, context) => ({
        bundleHash: context.sourceFingerprint,
        parserId: context.parserId,
        parserVersion: context.parserVersion,
        transformerId: 'dummy',
        transformerVersion: '0.1.0',
        ontologyVersion: '0.1.0',
        metricDefinitionVersion: '0.1.0',
        evidence: [],
        sessionSummaries: [],
        componentSummaries: [],
        metricValues: [],
        distributions: [],
        configurationSnapshot: { completeness: {}, components: [] },
        capabilities: [],
        unavailableReasons: [],
        provenance: bundle.artifacts.map((a) => ({ artifactId: a.sha256 ?? a.relativePath })),
        warnings: [],
        errors: [],
      }),
    };

    const bundle: UnknownArtifactBundle = {
      artifacts: [{ relativePath: 't.jsonl', mediaType: 'application/jsonl', content: '' }],
    };

    const context: TransformContext = {
      analysisReleaseId: 'r1',
      parserId: 'p',
      parserVersion: '1',
      sourceFingerprint: 'fp',
    };

    const detection = transformer.detect(bundle);
    expect(detection.kind).toBe('matched');

    const classification = transformer.classifyArtifacts(bundle);
    expect(classification.artifacts.length).toBe(1);

    const capabilities = transformer.getCapabilities();
    expect(capabilities.length).toBe(1);
    expect(capabilities[0].state).toBe('available');

    const result = transformer.transform(bundle, context);
    expect(result.transformerId).toBe('dummy');
    expect(result.bundleHash).toBe('fp');
    expect(result.provenance.length).toBe(1);
    expect(result.warnings).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('exposes the canonical invariants contract', () => {
    expect(Object.keys(CANONICAL_INVARIANTS)).toContain('unavailableMetricsIncludeReason');
    expect(Object.keys(CANONICAL_INVARIANTS)).toContain('outputIsDeterministic');
  });
});
