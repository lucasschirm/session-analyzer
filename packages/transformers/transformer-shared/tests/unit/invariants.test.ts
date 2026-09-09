import { describe, expect, it } from 'vitest';
import { CANONICAL_INVARIANTS, listCanonicalInvariants } from '../../src/index.js';

describe('canonical invariants', () => {
  it('lists every canonical invariant with a code and description', () => {
    const invariants = listCanonicalInvariants();

    expect(invariants.length).toBe(Object.keys(CANONICAL_INVARIANTS).length);
    expect(invariants.length).toBeGreaterThanOrEqual(10);

    for (const invariant of invariants) {
      expect(invariant.code).toBeTruthy();
      expect(invariant.description).toBeTruthy();
      expect(Object.keys(CANONICAL_INVARIANTS)).toContain(invariant.code);
    }
  });

  it('retains the tool/skill/agent/subagent distinctness rule', () => {
    const invariants = listCanonicalInvariants();
    const rule = invariants.find((i) => i.code === 'toolSkillAgentSubAgentDistinct');

    expect(rule).toBeDefined();
    expect(rule?.description).toContain('distinct');
  });
});
