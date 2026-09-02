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

  it('registers exactly the claude transformer today', () => {
    const registry = createDefaultRegistry();
    expect(registry.ids()).toEqual(['claude-code']);
  });
});
