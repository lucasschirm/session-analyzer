import { describe, expect, it } from 'vitest';
import { isKnownDevinRole, mapDevinRole } from './role-map.js';

describe('mapDevinRole', () => {
  it.each(['system', 'user', 'assistant', 'tool'] as const)('maps %s to itself', (role) => {
    expect(mapDevinRole(role)).toBe(role);
  });

  it('falls back to unknown for an unrecognized role value without crashing', () => {
    expect(() => mapDevinRole('narrator')).not.toThrow();
    expect(mapDevinRole('narrator')).toBe('unknown');
  });

  it('falls back to unknown for non-string values', () => {
    expect(mapDevinRole(undefined)).toBe('unknown');
    expect(mapDevinRole(null)).toBe('unknown');
    expect(mapDevinRole(42)).toBe('unknown');
  });
});

describe('isKnownDevinRole', () => {
  it('returns true only for the four known roles', () => {
    expect(isKnownDevinRole('assistant')).toBe(true);
    expect(isKnownDevinRole('narrator')).toBe(false);
    expect(isKnownDevinRole(42)).toBe(false);
  });
});
