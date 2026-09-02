import { runTransformerConformanceSuite } from '@lucasschirm/sal-transformer-shared/conformance';
import { describe, expect, it } from 'vitest';
import { DevinTransformer } from '../../src/index.js';
import { devinConformanceFixtures } from '../conformance/fixtures/index.js';

describe('DevinTransformer conformance', () => {
  it('passes the shared transformer conformance suite', () => {
    const report = runTransformerConformanceSuite(DevinTransformer, devinConformanceFixtures);
    for (const inv of report.invariants) {
      if (inv.status !== 'passed') {
        console.log(`[${inv.status}] ${inv.code}: ${inv.details.join('; ')}`);
      }
    }
    expect(report.passed).toBe(true);
  });

  for (const fixture of devinConformanceFixtures.fixtures) {
    it(`fixture ${fixture.name} can be classified and transformed`, () => {
      const classification = DevinTransformer.classifyArtifacts(fixture.bundle);
      expect(classification).toBeDefined();
      expect(Array.isArray(classification.artifacts)).toBe(true);
      expect(classification.configurationSnapshot).toBeDefined();

      const capabilities = DevinTransformer.getCapabilities(fixture.bundle);
      expect(Array.isArray(capabilities)).toBe(true);

      const result = DevinTransformer.transform(fixture.bundle, fixture.context);
      expect(result).toBeDefined();
      expect(Array.isArray(result.metricValues)).toBe(true);
      expect(Array.isArray(result.evidence)).toBe(true);
      expect(
        result.metricValues.length > 0 ||
          result.unavailableReasons.length > 0 ||
          result.errors.length > 0,
      ).toBe(true);
    });
  }
});
