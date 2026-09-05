import { runTransformerConformanceSuite } from '@lucasschirm/sal-transformer-shared/conformance';
import { describe, expect, it } from 'vitest';
import { ClaudeCodeTransformer } from '../../src/index.js';
import { claudeConformanceFixtures } from '../conformance/fixtures/index.js';

describe('ClaudeCodeTransformer conformance', () => {
  it('passes the shared transformer conformance suite (strict: unverified fails)', () => {
    // Default profile is the claude one; strict mode (#308) turns any
    // silently-skipped (`unverified`) invariant into a failure.
    const report = runTransformerConformanceSuite(
      ClaudeCodeTransformer,
      claudeConformanceFixtures,
      { strict: true },
    );
    for (const inv of report.invariants) {
      if (inv.status !== 'passed') {
        console.log(`[${inv.status}] ${inv.code}: ${inv.details.join('; ')}`);
      }
    }
    expect(report.passed).toBe(true);
    expect(report.invariants.filter((i) => i.status === 'unverified')).toEqual([]);
  });

  it.each(claudeConformanceFixtures.fixtures)(
    'fixture $name can be classified and transformed',
    (fixture) => {
      const classification = ClaudeCodeTransformer.classifyArtifacts(fixture.bundle);
      expect(classification).toBeDefined();
      expect(Array.isArray(classification.artifacts)).toBe(true);
      expect(Array.isArray(classification.components)).toBe(true);
      expect(classification.configurationSnapshot).toBeDefined();

      const capabilities = ClaudeCodeTransformer.getCapabilities(fixture.bundle);
      expect(Array.isArray(capabilities)).toBe(true);

      const result = ClaudeCodeTransformer.transform(fixture.bundle, fixture.context);
      expect(result).toBeDefined();
      expect(Array.isArray(result.metricValues)).toBe(true);
      expect(Array.isArray(result.evidence)).toBe(true);
      expect(
        result.metricValues.length > 0 ||
          result.unavailableReasons.length > 0 ||
          result.errors.length > 0,
      ).toBe(true);
    },
  );
});
