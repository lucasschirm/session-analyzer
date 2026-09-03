import { describe, expect, it } from 'vitest';
import { deepEqual, equal, fail, ok } from '../../src/conformance/assert-lite.js';

// assert-lite.ts is a minimal, dependency-free stand-in for `node:assert`,
// used only by the conformance suite (src/conformance/suite.ts) so this
// package never imports a `node:` module from src/ (see
// tests/forbidden-imports.test.ts and .agents/rules/transformers-never-write-sqlite.md).

describe('assert-lite', () => {
  describe('ok', () => {
    it('does not throw for a truthy condition', () => {
      expect(() => ok(true, 'should not throw')).not.toThrow();
    });

    it('throws with the given message for a falsy condition', () => {
      expect(() => ok(false, 'expected true')).toThrow('expected true');
    });
  });

  describe('equal', () => {
    it('does not throw when values are Object.is-equal', () => {
      expect(() => equal(1, 1, 'should be equal')).not.toThrow();
    });

    it('throws with expected/actual detail when values differ', () => {
      expect(() => equal(1, 2, 'mismatch')).toThrow(/mismatch/);
    });

    it('uses a default message when none is given', () => {
      expect(() => equal(1, 2)).toThrow('Values are not equal');
    });

    it('falls back to String() for a value JSON.stringify cannot serialize', () => {
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      expect(() => equal(circular, 'other', 'circular mismatch')).toThrow(/circular mismatch/);
    });
  });

  describe('deepEqual', () => {
    it('does not throw for structurally equal objects', () => {
      expect(() => deepEqual({ a: 1, b: [1, 2] }, { a: 1, b: [1, 2] })).not.toThrow();
    });

    it('throws with expected/actual detail for structurally different objects', () => {
      expect(() => deepEqual({ a: 1 }, { a: 2 }, 'objects differ')).toThrow(/objects differ/);
    });

    it('uses a default message when none is given', () => {
      expect(() => deepEqual({ a: 1 }, { a: 2 })).toThrow('Values are not deeply equal');
    });
  });

  describe('fail', () => {
    it('always throws with the given message', () => {
      expect(() => fail('always fails')).toThrow('always fails');
    });
  });
});
