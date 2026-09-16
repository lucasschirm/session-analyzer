import { describe, expect, it } from 'vitest';
import { runTransformerConformanceSuite } from '../../src/conformance/suite.js';
import type {
  ArtifactClassificationResult,
  DetectionResult,
  MetricCapability,
  NormalizedEvidenceRecord,
  ScalarMetricValue,
  SessionTransformer,
  TransformContext,
  TransformResult,
  UnknownArtifactBundle,
} from '../../src/index.js';

/**
 * Regression guards for the three context-ordering invariants added to the
 * conformance suite after the `brassy-humor` context-growth defect: the
 * session-level aggregate was parented to the first turn, dumping ~50.2M
 * cumulative tokens onto message #1. These tests drive a minimal
 * base-contract transformer whose `transform()` returns an explicitly
 * chosen evidence shape, so each invariant's failure mode is exercised
 * end-to-end (not just its happy path).
 */

const context: TransformContext = {
  analysisReleaseId: 'r1',
  parserId: 'fixture-parser',
  parserVersion: '0.1.0',
  sourceFingerprint: 'fp-order',
};

const bundle: UnknownArtifactBundle = {
  artifacts: [{ relativePath: 'transcript.jsonl', mediaType: 'application/jsonl', content: '{}' }],
  sourceFingerprint: 'fp-order',
};

function turn(recordId: string, sessionId: string, ordinal: number): NormalizedEvidenceRecord {
  return {
    recordId,
    recordType: 'turn',
    sessionId,
    sourceEventId: recordId,
    provenance: { artifactId: 'transcript.jsonl' },
    payload: { ordinal },
  };
}

function message(recordId: string, sessionId: string, parentId: string): NormalizedEvidenceRecord {
  return {
    recordId,
    recordType: 'message',
    sessionId,
    parentId,
    sourceEventId: recordId,
    provenance: { artifactId: 'transcript.jsonl' },
    payload: { role: 'assistant' },
  };
}

function usage(
  recordId: string,
  sessionId: string,
  parentId: string | undefined,
  payload: Record<string, unknown>,
): NormalizedEvidenceRecord {
  return {
    recordId,
    recordType: 'model_usage',
    sessionId,
    parentId,
    sourceEventId: recordId,
    sourceField: typeof payload.sourceField === 'string' ? payload.sourceField : 'usage',
    provenance: { artifactId: 'transcript.jsonl' },
    payload,
  };
}

const sessionTotal: ScalarMetricValue = {
  metricId: 'claude:tokens:total:root_only',
  definitionVersion: '1',
  value: 50,
  exact: true,
  unit: 'tokens',
  comparabilityGroupId: 'claude:tokens:total:root_only:v1',
  provenanceArtifactId: 'transcript.jsonl',
};

function transformerFor(
  evidence: NormalizedEvidenceRecord[],
): SessionTransformer<UnknownArtifactBundle> {
  const result: TransformResult = {
    bundleHash: 'hash-order',
    parserId: 'fixture-parser',
    parserVersion: '0.1.0',
    transformerId: 'fixture-transformer',
    transformerVersion: '0.1.0',
    ontologyVersion: '1',
    metricDefinitionVersion: '1',
    evidence,
    sessionSummaries: [
      { sessionId: 's1', rootSessionId: 's1', harness: 'fixture', finality: 'final' },
    ],
    componentSummaries: [],
    metricValues: [sessionTotal],
    distributions: [],
    configurationSnapshot: { completeness: {}, components: [] },
    capabilities: [],
    unavailableReasons: [],
    provenance: [{ artifactId: 'transcript.jsonl' }],
    warnings: [],
    errors: [],
  };
  return {
    id: 'fixture-transformer',
    harnesses: ['fixture'],
    transformerVersion: '0.1.0',
    ontologyVersion: '1',
    detect: (): DetectionResult => ({ kind: 'matched', harness: 'fixture', confidence: 1 }),
    classifyArtifacts: (): ArtifactClassificationResult => ({
      artifacts: [],
      configurationSnapshot: { completeness: {}, components: [] },
      components: [],
    }),
    getCapabilities: (): MetricCapability[] => [],
    transform: (): TransformResult => result,
  };
}

function run(evidence: NormalizedEvidenceRecord[]) {
  return runTransformerConformanceSuite(transformerFor(evidence), {
    fixtures: [
      {
        name: 'order-fixture',
        description: 'Synthetic ordering fixture.',
        bundle,
        context,
        tags: ['root'],
      },
    ],
  });
}

describe('turnOrdinalsAreSequential invariant', () => {
  it('fails when turn ordinals are not 1..N in delivery order', () => {
    const evidence = [
      turn('turn:{"nodeId":1}', 's1', 1),
      turn('turn:{"nodeId":3}', 's1', 3),
      turn('turn:{"nodeId":2}', 's1', 2),
    ];
    expect(() => run(evidence)).toThrow(/turnOrdinalsAreSequential/);
  });

  it('fails when message evidence is out of turn order', () => {
    const evidence = [
      turn('turn:{"nodeId":1}', 's1', 1),
      turn('turn:{"nodeId":2}', 's1', 2),
      message('msg:b', 's1', 'turn:{"nodeId":2}'),
      message('msg:a', 's1', 'turn:{"nodeId":1}'),
    ];
    expect(() => run(evidence)).toThrow(/turnOrdinalsAreSequential/);
  });

  it('passes for sequential turns and in-order messages', () => {
    const evidence = [
      turn('turn:{"nodeId":1}', 's1', 1),
      turn('turn:{"nodeId":2}', 's1', 2),
      message('msg:a', 's1', 'turn:{"nodeId":1}'),
      message('msg:b', 's1', 'turn:{"nodeId":2}'),
    ];
    const report = run(evidence);
    const inv = report.invariants.find((i) => i.code === 'turnOrdinalsAreSequential');
    expect(inv?.status).toBe('passed');
  });
});

describe('sessionAggregateUsageIsNotTurnScoped invariant', () => {
  it('fails for a final_metrics aggregate parented to a turn', () => {
    const evidence = [
      turn('turn:{"nodeId":1}', 's1', 1),
      usage('usage:agg', 's1', 'turn:{"nodeId":1}', {
        sourceField: 'final_metrics',
        requestId: 's1',
        inputTokens: 10,
      }),
    ];
    expect(() => run(evidence)).toThrow(/sessionAggregateUsageIsNotTurnScoped/);
  });

  it('fails when a turn-scoped record carries the session id as its requestId', () => {
    const evidence = [
      turn('turn:{"nodeId":1}', 's1', 1),
      usage('usage:agg', 's1', 'turn:{"nodeId":1}', { requestId: 's1', inputTokens: 10 }),
    ];
    expect(() => run(evidence)).toThrow(/sessionAggregateUsageIsNotTurnScoped/);
  });

  it('fails when a session-scoped aggregate carries a per-message requestOrder without a turn parent', () => {
    // The `byOrder` variant: no parentId, but requestOrder=1 binds the
    // session total to message #1 in the context-timing computation.
    const evidence = [
      turn('turn:{"nodeId":1}', 's1', 1),
      usage('usage:agg', 's1', undefined, { requestId: 's1', requestOrder: 1, inputTokens: 10 }),
    ];
    expect(() => run(evidence)).toThrow(/sessionAggregateUsageIsNotTurnScoped/);
  });

  it('passes for a genuinely per-request turn-scoped record', () => {
    const evidence = [
      turn('turn:{"nodeId":1}', 's1', 1),
      usage('usage:req', 's1', 'turn:{"nodeId":1}', { requestId: 'uuid-1', inputTokens: 10 }),
    ];
    const report = run(evidence);
    const inv = report.invariants.find((i) => i.code === 'sessionAggregateUsageIsNotTurnScoped');
    expect(inv?.status).toBe('passed');
  });
});

describe('turnContextDoesNotExceedSessionTotal invariant', () => {
  it('fails when a turn-scoped context exceeds the session total', () => {
    const evidence = [
      turn('turn:{"nodeId":1}', 's1', 1),
      usage('usage:huge', 's1', 'turn:{"nodeId":1}', {
        requestId: 'uuid-1',
        inputTokens: 25_736_894,
        cacheReadTokens: 24_456_832,
        outputTokens: 106_335,
      }),
    ];
    expect(() => run(evidence)).toThrow(/turnContextDoesNotExceedSessionTotal/);
  });

  it('passes when every turn-scoped context is bounded by the session total', () => {
    const evidence = [
      turn('turn:{"nodeId":1}', 's1', 1),
      usage('usage:req', 's1', 'turn:{"nodeId":1}', {
        requestId: 'uuid-1',
        inputTokens: 20,
        cacheReadTokens: 10,
        outputTokens: 5,
      }),
    ];
    const report = run(evidence);
    const inv = report.invariants.find((i) => i.code === 'turnContextDoesNotExceedSessionTotal');
    expect(inv?.status).toBe('passed');
  });
});
