import { describe, expect, it } from 'vitest';
import { createDefaultRegistry } from '../../src/index.js';

describe('createDefaultRegistry', () => {
  it('resolves the claude transformer for the claude-code harness', () => {
    const registry = createDefaultRegistry();
    const resolution = registry.resolve('claude-code');
    expect(resolution.id).toBe('claude-code');
  });

  it('resolves the claude transformer for the claude harness alias', () => {
    const registry = createDefaultRegistry();
    const resolution = registry.resolve('claude');
    expect(resolution.id).toBe('claude-code');
  });

  it('resolves the devin transformer for the devin harness', () => {
    const registry = createDefaultRegistry();
    const resolution = registry.resolve('devin');
    expect(resolution.id).toBe('devin');
  });

  it('registers the claude and devin transformers', () => {
    const registry = createDefaultRegistry();
    expect([...registry.ids()].sort()).toEqual(['claude-code', 'devin']);
  });
});
