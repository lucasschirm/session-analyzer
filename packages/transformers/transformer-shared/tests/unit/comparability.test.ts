import { describe, expect, it } from 'vitest';
import {
  deriveComparabilityGroupId,
  hashString,
  serializeComparabilitySpec,
} from '../../src/index.js';

const BASE_SPEC = {
  metricId: 'token.requests',
  metricDefinitionVersion: '1.0.0',
  unit: 'token',
  grain: 'session',
  dimensions: { provider: 'anthropic', model: 'claude-sonnet' },
  observationUnit: 'request',
  population: 'all_root_sessions',
  sessionFinalityRules: 'final_or_censored',
  measurementClass: 'exact',
  nativeMappingVersion: 'claude-code:1',
  rootOnlyInclusive: 'root_only' as const,
  statusThresholdCensoringMissingDataRules: 'missing_unknown',
  aggregationStatisticalAttributionMethod: 'sum',
};

describe('comparability contract', () => {
  it('derives a deterministic comparability group id', () => {
    const idA = deriveComparabilityGroupId(BASE_SPEC);
    const idB = deriveComparabilityGroupId(BASE_SPEC);

    expect(idA).toMatch(/^cgrp-[0-9a-f]{8}$/);
    expect(idA).toBe(idB);
  });

  it('produces different group ids for differing specs', () => {
    const idA = deriveComparabilityGroupId(BASE_SPEC);
    const idB = deriveComparabilityGroupId({
      ...BASE_SPEC,
      rootOnlyInclusive: 'inclusive',
    });

    expect(idA).not.toBe(idB);
  });

  it('serializes dimensions in a stable order regardless of input order', () => {
    const specA = { ...BASE_SPEC, dimensions: { a: '1', b: '2' } };
    const specB = { ...BASE_SPEC, dimensions: { b: '2', a: '1' } };

    expect(serializeComparabilitySpec(specA)).toBe(serializeComparabilitySpec(specB));
  });

  it('produces the same hash for the same input string', () => {
    const input = 'deterministic input';
    expect(hashString(input)).toBe(hashString(input));
    expect(hashString(input)).not.toBe(hashString('different input'));
  });
});
