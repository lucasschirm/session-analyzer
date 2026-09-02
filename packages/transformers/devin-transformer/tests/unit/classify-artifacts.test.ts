import { describe, expect, it } from 'vitest';
import { DevinTransformer } from '../../src/index.js';
import { branchyBundle, linearBundle } from '../conformance/fixtures/index.js';

function artifact(relativePath: string, content: string, mediaType = 'text/plain') {
  return { relativePath, content, mediaType };
}

describe('DevinTransformer.classifyArtifacts', () => {
  it('classifies all B3 artifacts in the happy path', () => {
    const result = DevinTransformer.classifyArtifacts(linearBundle);
    const byPath = new Map(result.artifacts.map((a) => [a.relativePath, a]));

    expect(byPath.get('transcript.jsonl')?.kind).toBe('transcript');
    expect(byPath.get('transcript.jsonl')?.scope).toBe('session');

    expect(byPath.get('native/atif-transcript.json')?.kind).toBe('transcript');
    expect(byPath.get('native/atif-transcript.json')?.scope).toBe('session');
    expect(byPath.get('native/atif-transcript.json')?.role).toBe('native');

    expect(byPath.get('native/models.json')?.kind).toBe('settings');
    expect(byPath.get('native/models.json')?.scope).toBe('runtime');
    expect(byPath.get('native/models.json')?.role).toBe('models');

    expect(byPath.get('native/schema-descriptor.json')?.kind).toBe('settings');
    expect(byPath.get('native/schema-descriptor.json')?.scope).toBe('runtime');
    expect(byPath.get('native/schema-descriptor.json')?.role).toBe('schema');
  });

  it('classifies plan markdown as a session transcript with plan role', () => {
    const planBundle = {
      artifacts: [
        ...linearBundle.artifacts,
        artifact('plans/plan-deadbeef.md', '# Plan\n1. Edit\n'),
      ],
      sourceFingerprint: 'fp-plan',
    };
    const result = DevinTransformer.classifyArtifacts(planBundle);
    const plan = result.artifacts.find((a) => a.relativePath === 'plans/plan-deadbeef.md');
    expect(plan).toBeDefined();
    expect(plan?.kind).toBe('transcript');
    expect(plan?.scope).toBe('session');
    expect(plan?.role).toBe('plan');
  });

  it('classifies workspace and global config as settings', () => {
    const b = {
      artifacts: [
        artifact('.devin/config.json', JSON.stringify({ project: 'test' }), 'application/json'),
        artifact('config.json', JSON.stringify({ global: true }), 'application/json'),
      ],
      sourceFingerprint: 'fp-config',
    };
    const result = DevinTransformer.classifyArtifacts(b);
    expect(result.artifacts[0]?.kind).toBe('settings');
    expect(result.artifacts[0]?.scope).toBe('workspace');
    expect(result.artifacts[1]?.kind).toBe('settings');
    expect(result.artifacts[1]?.scope).toBe('global');
  });

  it('flags an unrecognised path as unclassified', () => {
    const b = {
      artifacts: [
        ...linearBundle.artifacts,
        artifact('unknown.bin', 'data', 'application/octet-stream'),
      ],
      sourceFingerprint: 'fp-unknown',
    };
    const result = DevinTransformer.classifyArtifacts(b);
    const unknown = result.artifacts.find((a) => a.relativePath === 'unknown.bin');
    expect(unknown?.kind).toBe('unclassified');
    expect(unknown?.confidence).toBe('unclassified');
    expect(result.warnings?.length ?? 0).toBeGreaterThan(0);
  });

  it('produces a configuration snapshot', () => {
    const result = DevinTransformer.classifyArtifacts(linearBundle);
    expect(result.configurationSnapshot).toBeDefined();
    expect(result.configurationSnapshot.components).toEqual([]);
    expect(result.configurationSnapshot.completeness).toBeDefined();
  });

  it('does not raise warnings for fully classified bundles', () => {
    const result = DevinTransformer.classifyArtifacts(branchyBundle);
    expect(result.warnings).toEqual([]);
  });

  it('downgrades confidence when content fails schema validation', () => {
    const b = {
      artifacts: [artifact('native/models.json', 'not-json', 'application/json')],
      sourceFingerprint: 'fp-bad-models',
    };
    const result = DevinTransformer.classifyArtifacts(b);
    expect(result.artifacts[0]?.confidence).toBe('inferred');
    expect(result.artifacts[0]?.kind).toBe('settings');
  });
});
