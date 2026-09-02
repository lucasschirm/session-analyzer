import { describe, expect, it } from 'vitest';
import {
  type ArtifactClassificationResult,
  type DetectionResult,
  type MetricCapability,
  type SessionTransformer,
  type TransformContext,
  TransformerRegistry,
  type TransformResult,
  type UnknownArtifactBundle,
} from '../../src/index.js';

const DEFAULT_CAPABILITIES: MetricCapability[] = [
  { metricId: 'test:requests', definitionVersion: '0.1.0', state: 'available' },
];

const _DEFAULT_TRANSFORM_CONTEXT: TransformContext = {
  analysisReleaseId: 'r1',
  parserId: 'test-parser',
  parserVersion: '0.1.0',
  sourceFingerprint: 'sha256:abc',
};

function makeTransformer(
  id: string,
  harnesses: readonly string[],
  detectImpl: (bundle: UnknownArtifactBundle) => DetectionResult,
): SessionTransformer<UnknownArtifactBundle> {
  return {
    id,
    harnesses,
    transformerVersion: '0.1.0',
    ontologyVersion: '0.1.0',
    detect: detectImpl,
    classifyArtifacts: (bundle): ArtifactClassificationResult => ({
      artifacts: bundle.artifacts.map((artifact) => ({
        relativePath: artifact.relativePath,
        kind: 'transcript',
        scope: 'session',
        mediaType: artifact.mediaType,
        confidence: 'exact',
      })),
      configurationSnapshot: {
        completeness: {},
        components: [],
      },
      components: [],
    }),
    getCapabilities: (): MetricCapability[] => DEFAULT_CAPABILITIES,
    transform: (_bundle, context): TransformResult => ({
      bundleHash: context.sourceFingerprint,
      parserId: context.parserId,
      parserVersion: context.parserVersion,
      transformerId: id,
      transformerVersion: '0.1.0',
      ontologyVersion: '0.1.0',
      metricDefinitionVersion: '0.1.0',
      evidence: [],
      sessionSummaries: [],
      componentSummaries: [],
      metricValues: [],
      distributions: [],
      configurationSnapshot: {
        completeness: {},
        components: [],
      },
      capabilities: DEFAULT_CAPABILITIES,
      unavailableReasons: [],
      provenance: [],
      warnings: [],
      errors: [],
    }),
  };
}

describe('TransformerRegistry', () => {
  it('registers a plugin and resolves it by harness identity', () => {
    const registry = new TransformerRegistry();
    const transformer = makeTransformer('claude', ['claude-code'], () => ({
      kind: 'matched',
      harness: 'claude-code',
      confidence: 1,
    }));

    registry.register(transformer);

    expect(registry.ids()).toContain('claude');
    expect(registry.harnesses()).toContain('claude-code');
    expect(registry.resolve('claude-code').id).toBe('claude');
  });

  it('resolves by detection for a manual import', () => {
    const registry = new TransformerRegistry();
    const transformer = makeTransformer('claude', ['claude-code'], (bundle) => {
      const hasTranscript = bundle.artifacts.some((a) => a.relativePath.endsWith('.jsonl'));
      return hasTranscript
        ? { kind: 'matched', harness: 'claude-code', confidence: 0.95 }
        : { kind: 'unmatched', reason: 'no transcript artifact' };
    });

    registry.register(transformer);

    const bundle: UnknownArtifactBundle = {
      artifacts: [
        { relativePath: 'transcript.jsonl', mediaType: 'application/jsonl', content: '' },
      ],
    };
    const resolution = registry.resolveByDetection(bundle);

    expect(resolution.kind).toBe('matched');
    if (resolution.kind === 'matched') {
      expect(resolution.plugin.id).toBe('claude');
      expect(resolution.harness).toBe('claude-code');
    }
  });

  it('returns a structured error when detection is ambiguous', () => {
    const registry = new TransformerRegistry();
    const a = makeTransformer('parser-a', ['harness-a'], () => ({
      kind: 'matched',
      harness: 'harness-a',
      confidence: 0.5,
    }));
    const b = makeTransformer('parser-b', ['harness-b'], () => ({
      kind: 'matched',
      harness: 'harness-b',
      confidence: 0.5,
    }));

    registry.register(a);
    registry.register(b);

    const bundle: UnknownArtifactBundle = {
      artifacts: [{ relativePath: 'unknown.log', mediaType: 'text/plain', content: '' }],
    };
    const resolution = registry.resolveByDetection(bundle);

    expect(resolution.kind).toBe('ambiguous');
    if (resolution.kind === 'ambiguous') {
      expect(resolution.candidates.length).toBe(2);
      expect(resolution.candidates).toContain('parser-a:harness-a');
      expect(resolution.candidates).toContain('parser-b:harness-b');
      expect(resolution.reason).toBe('multiple transformers matched the bundle');
    }
  });

  it('returns unmatched when no plugin detects the bundle', () => {
    const registry = new TransformerRegistry();
    const transformer = makeTransformer('claude', ['claude-code'], () => ({
      kind: 'unmatched',
      reason: 'not a claude bundle',
    }));

    registry.register(transformer);

    const bundle: UnknownArtifactBundle = {
      artifacts: [{ relativePath: 'foo.bar', mediaType: 'text/plain', content: '' }],
    };
    const resolution = registry.resolveByDetection(bundle);

    expect(resolution.kind).toBe('unmatched');
  });

  it('throws when resolving an unregistered harness', () => {
    const registry = new TransformerRegistry();
    expect(() => registry.resolve('unknown')).toThrow(
      'no transformer registered for harness: unknown',
    );
  });

  it('throws when registering a duplicate plugin id', () => {
    const registry = new TransformerRegistry();
    const a = makeTransformer('same', ['h1'], () => ({ kind: 'unmatched', reason: '' }));
    const b = makeTransformer('same', ['h2'], () => ({ kind: 'unmatched', reason: '' }));

    registry.register(a);
    expect(() => registry.register(b)).toThrow('plugin already registered: same');
  });

  it('throws when a harness is claimed by more than one plugin', () => {
    const registry = new TransformerRegistry();
    const a = makeTransformer('a', ['shared'], () => ({ kind: 'unmatched', reason: '' }));
    const b = makeTransformer('b', ['shared'], () => ({ kind: 'unmatched', reason: '' }));

    registry.register(a);
    expect(() => registry.register(b)).toThrow('harness already registered: shared');
  });
});
