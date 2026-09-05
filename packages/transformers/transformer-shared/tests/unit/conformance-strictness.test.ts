import { describe, expect, it } from 'vitest';
import { runTransformerConformanceSuite } from '../../src/conformance/suite.js';
import type {
  ArtifactClassificationResult,
  DetectionResult,
  MetricCapability,
  NormalizedEvidenceRecord,
  SessionTransformer,
  TransformContext,
  TransformResult,
  UnknownArtifactBundle,
} from '../../src/index.js';

// #308 acceptance criteria: (a) a deliberately-broken fixture — a Skill
// invocation conflated into the generic tool pool — must FAIL the
// toolSkillAgentSubAgentDistinct invariant, proving the check is live for a
// 'complete'-tagged fixture; (b) strict mode must turn silently-skipped
// (`unverified`) invariants into failures, so a missing fixture can never
// disable an invariant again.

const context: TransformContext = {
  analysisReleaseId: 'strictness-r1',
  parserId: 'strictness-fixture-parser',
  parserVersion: '0.1.0',
  sourceFingerprint: 'fp-strictness',
};

const bundle: UnknownArtifactBundle = {
  artifacts: [{ relativePath: 'transcript.txt', mediaType: 'text/plain', content: 'hello' }],
  sourceFingerprint: 'fp-strictness',
};

function invocation(kind: string, id: string): NormalizedEvidenceRecord[] {
  return [
    {
      recordId: `invocation-${id}`,
      recordType: 'invocation',
      sessionId: 'sess-1',
      sourceEventId: id,
      provenance: { artifactId: 'transcript.txt', sourceEventId: id },
      payload: { kind, startId: id, resultId: id },
    },
    {
      recordId: `payload-${id}-input`,
      recordType: 'payload',
      sessionId: 'sess-1',
      sourceEventId: id,
      provenance: { artifactId: 'transcript.txt', sourceEventId: id },
      payload: { payloadType: 'input', toolUseId: id, sourceEventId: id },
    },
    {
      recordId: `payload-${id}-result`,
      recordType: 'payload',
      sessionId: 'sess-1',
      sourceEventId: id,
      provenance: { artifactId: 'transcript.txt', sourceEventId: id },
      payload: { payloadType: 'result', toolUseId: id, sourceEventId: id },
    },
  ];
}

/**
 * A transformer that CONFLATES its skill call into the generic tool pool:
 * the session really ran a skill, but every invocation record says
 * `kind: 'tool'` (plus one agent) — the exact regression class
 * `analytics-domain-distinctions.md` forbids and DS-B28/DS-F11 fixed.
 */
function conflatedResult(): TransformResult {
  return {
    bundleHash: 'hash-conflated',
    parserId: 'strictness-fixture-parser',
    parserVersion: '0.1.0',
    transformerId: 'strictness-conflated-transformer',
    transformerVersion: '0.1.0',
    ontologyVersion: '1',
    metricDefinitionVersion: '1',
    evidence: [
      ...invocation('tool', 'call-1'),
      ...invocation('tool', 'call-2-was-a-skill'),
      ...invocation('agent', 'call-3'),
    ],
    sessionSummaries: [
      { sessionId: 'sess-1', rootSessionId: 'sess-1', harness: 'strictness', finality: 'final' },
    ],
    componentSummaries: [],
    metricValues: [
      {
        metricId: 'strictness:example:count',
        definitionVersion: '1',
        value: 3,
        exact: true,
        unit: 'count',
        comparabilityGroupId: 'strictness:example:count:v1',
        provenanceArtifactId: 'transcript.txt',
      },
      {
        metricId: 'strictness:example:estimate',
        definitionVersion: '1',
        value: 7,
        exact: false,
        unit: 'count',
        comparabilityGroupId: 'strictness:example:estimate:v1',
        provenanceArtifactId: 'transcript.txt',
      },
    ],
    distributions: [],
    configurationSnapshot: { completeness: {}, components: [] },
    capabilities: [],
    unavailableReasons: [],
    provenance: [{ artifactId: 'transcript.txt' }],
    warnings: [],
    errors: [],
  };
}

const conflatedTransformer: SessionTransformer<UnknownArtifactBundle> = {
  id: 'strictness-conflated-transformer',
  harnesses: ['strictness'],
  transformerVersion: '0.1.0',
  ontologyVersion: '1',
  detect: (): DetectionResult => ({ kind: 'matched', harness: 'strictness', confidence: 1 }),
  classifyArtifacts: (): ArtifactClassificationResult => ({
    artifacts: [],
    configurationSnapshot: { completeness: {}, components: [] },
    components: [],
  }),
  getCapabilities: (): MetricCapability[] => [],
  transform: (): TransformResult => conflatedResult(),
};

function fixtures(tags: string[]) {
  return {
    fixtures: [
      {
        name: 'strictness-fixture',
        description: 'Strictness/conflation probe fixture.',
        bundle,
        context,
        tags,
      },
    ],
  };
}

describe('conformance suite strictness (#308)', () => {
  it('FAILS a complete fixture whose skill invocation was conflated into the tool pool', () => {
    expect(() =>
      runTransformerConformanceSuite(conflatedTransformer, fixtures(['root', 'complete'])),
    ).toThrow(/toolSkillAgentSubAgentDistinct/);
  });

  it('passes non-strict with unverified invariants, but strict mode fails them', () => {
    const lenient = runTransformerConformanceSuite(conflatedTransformer, fixtures(['root']));
    expect(lenient.passed).toBe(true);
    expect(lenient.invariants.some((i) => i.status === 'unverified')).toBe(true);

    expect(() =>
      runTransformerConformanceSuite(conflatedTransformer, fixtures(['root']), { strict: true }),
    ).toThrow(/unverified under strict mode/);
  });
});
