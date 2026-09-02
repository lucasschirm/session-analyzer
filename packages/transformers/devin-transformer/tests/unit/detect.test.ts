import type { Artifact, UnknownArtifactBundle } from '@lucasschirm/sal-transformer-shared';
import { describe, expect, it } from 'vitest';
import { DevinTransformer } from '../../src/index.js';
import { linearBundle, noRootBundle } from '../conformance/fixtures/index.js';

function bundleWith(artifacts: Artifact<unknown>[], harness?: string): UnknownArtifactBundle {
  const b = {
    artifacts,
    sourceFingerprint: 'fp-detect',
  } as UnknownArtifactBundle & { harness?: string };
  if (harness) b.harness = harness;
  return b;
}

describe('DevinTransformer.detect', () => {
  it('unmatches an empty bundle', () => {
    const result = DevinTransformer.detect({ artifacts: [], sourceFingerprint: 'fp-empty' });
    expect(result.kind).toBe('unmatched');
  });

  it('matches a manifest harness identity', () => {
    const result = DevinTransformer.detect(bundleWith([], 'devin'));
    expect(result.kind).toBe('matched');
    expect((result as { harness?: string }).harness).toBe('devin');
    expect((result as { confidence?: number }).confidence).toBe(1);
  });

  it('unmatches a manifest with a different harness', () => {
    const result = DevinTransformer.detect(bundleWith([], 'claude'));
    expect(result.kind).toBe('unmatched');
  });

  it('matches a bundle with a devin session jsonl transcript', () => {
    const result = DevinTransformer.detect(linearBundle);
    expect(result.kind).toBe('matched');
    expect((result as { harness?: string }).harness).toBe('devin');
  });

  it('unmatches a bundle with only unrecognised files', () => {
    const result = DevinTransformer.detect(
      bundleWith([
        { relativePath: 'unknown.bin', content: 'binary', mediaType: 'application/octet-stream' },
      ]),
    );
    expect(result.kind).toBe('unmatched');
  });

  it('is ambiguous when multiple root transcripts are present', () => {
    const transcript = linearBundle.artifacts.find((a) => a.relativePath === 'transcript.jsonl');
    if (!transcript) throw new Error('linear bundle missing transcript');
    const artifacts = [
      ...linearBundle.artifacts,
      {
        relativePath: 'transcript.jsonl',
        content: transcript.content,
        mediaType: transcript.mediaType,
      },
    ];
    const result = DevinTransformer.detect(bundleWith(artifacts));
    expect(result.kind).toBe('unmatched');
    expect((result as { reason?: string }).reason).toContain('multiple');
  });

  it('unmatches when no root transcript is present', () => {
    const result = DevinTransformer.detect(noRootBundle);
    expect(result.kind).toBe('unmatched');
    expect((result as { reason?: string }).reason).toContain('root transcript');
  });
});
