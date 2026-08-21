import { describe, expect, it } from 'vitest';

import {
  buildProjectManifest,
  type ProjectManifest,
  parseProjectManifest,
} from '../../src/index.js';

const FIXED_TIME = '2026-08-20T00:00:00.000Z';

function makeInput(
  overrides: Partial<ProjectManifest> = {},
): ConstructorParameters<typeof buildProjectManifest>[0] {
  return {
    projectId: 'proj-1',
    name: 'Project One',
    writtenBy: 'test-suite',
    ...overrides,
  };
}

function makeManifest(overrides: Partial<ProjectManifest> = {}): ProjectManifest {
  return {
    schemaVersion: 1,
    projectId: 'proj-1',
    name: 'Project One',
    createdAt: FIXED_TIME,
    writtenBy: 'test-suite',
    ...overrides,
  };
}

describe('parseProjectManifest', () => {
  it('accepts a valid project manifest', () => {
    const parsed = parseProjectManifest(makeManifest());
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.projectId).toBe('proj-1');
    expect(parsed.name).toBe('Project One');
  });

  it('tolerates a description and unknown extra fields', () => {
    const parsed = parseProjectManifest({
      ...makeManifest({ description: 'A test project' }),
      extraField: 'ignored',
      nested: { value: 42 },
    });
    expect(parsed.description).toBe('A test project');
    expect(parsed.projectId).toBe('proj-1');
    expect((parsed as Record<string, unknown>).extraField).toBe('ignored');
  });

  it('rejects a missing schemaVersion', () => {
    expect(() => parseProjectManifest({ ...makeManifest(), schemaVersion: undefined })).toThrow();
  });

  it('rejects a non-1 schemaVersion', () => {
    expect(() => parseProjectManifest({ ...makeManifest(), schemaVersion: 2 })).toThrow();
  });

  it('rejects a missing projectId', () => {
    expect(() => parseProjectManifest({ ...makeManifest(), projectId: '' })).toThrow();
  });

  it('rejects a non-object input', () => {
    expect(() => parseProjectManifest('not an object')).toThrow();
  });
});

describe('buildProjectManifest', () => {
  it('fills schemaVersion, createdAt and preserves known fields', () => {
    const manifest = buildProjectManifest(makeInput());
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.projectId).toBe('proj-1');
    expect(manifest.name).toBe('Project One');
    expect(manifest.writtenBy).toBe('test-suite');
    expect(manifest.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('accepts an injected clock for deterministic tests', () => {
    const manifest = buildProjectManifest(makeInput(), () => FIXED_TIME);
    expect(manifest.createdAt).toBe(FIXED_TIME);
  });

  it('round-trips through parseProjectManifest', () => {
    const built = buildProjectManifest(makeInput({ description: 'desc' }), () => FIXED_TIME);
    const parsed = parseProjectManifest(built);
    expect(parsed).toEqual(built);
  });
});
