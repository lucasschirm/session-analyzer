import { describe, expect, it } from 'vitest';
import { parseDevinModelsJson } from './parse.js';

function record(overrides: Record<string, unknown> = {}) {
  return {
    modelUid: 'model-a',
    label: 'Model A',
    familyUid: 'family-a',
    costTier: 'Standard',
    maxContextTokens: 128000,
    maxOutputTokens: 8000,
    ...overrides,
  };
}

describe('parseDevinModelsJson — pricing: absent', () => {
  it('passes through pricing as undefined for a free-tier model, never a zero-valued object', () => {
    const result = parseDevinModelsJson([record({ costTier: 'Free' })]);
    expect(result.models).toHaveLength(1);
    expect(result.models[0].pricing).toBeUndefined();
    expect(result.models[0].pricingUnavailableReason).toBeUndefined();
    expect('pricing' in result.models[0]).toBe(false);
  });
});

describe('parseDevinModelsJson — pricing: parsed', () => {
  it('passes through a well-formed pricing object unchanged', () => {
    const pricing = { inputPerMTok: 0.7, cachedInputPerMTok: 0.13, outputPerMTok: 2.2 };
    const result = parseDevinModelsJson([record({ pricing })]);
    expect(result.models[0].pricing).toEqual(pricing);
    expect(result.models[0].pricingUnavailableReason).toBeUndefined();
  });
});

describe('parseDevinModelsJson — pricing: malformed/unavailable-with-reason', () => {
  it('passes through pricingUnavailableReason and the preserved raw string, distinct from absent', () => {
    const result = parseDevinModelsJson([
      record({
        pricingUnavailableReason: 'unparsed-format',
        costSummaryRaw: '$0.7 / 1M Input',
      }),
    ]);
    const model = result.models[0];
    expect(model.pricing).toBeUndefined();
    expect(model.pricingUnavailableReason).toBe('unparsed-format');
    expect(model.costSummaryRaw).toBe('$0.7 / 1M Input');
  });

  it('is distinguishable from the plain-absent case', () => {
    const absent = parseDevinModelsJson([record({ costTier: 'Free' })]).models[0];
    const malformed = parseDevinModelsJson([
      record({ pricingUnavailableReason: 'unparsed-format', costSummaryRaw: 'garbled' }),
    ]).models[0];
    expect('pricingUnavailableReason' in absent).toBe(false);
    expect('pricingUnavailableReason' in malformed).toBe(true);
  });
});

describe('parseDevinModelsJson — identity and passthrough', () => {
  it('preserves modelUid as the identity field, not just label', () => {
    const result = parseDevinModelsJson([record({ modelUid: 'model-x', label: 'Pretty Name' })]);
    expect(result.models[0].modelUid).toBe('model-x');
    expect(result.models[0].label).toBe('Pretty Name');
  });

  it('passes through maxContextTokens/maxOutputTokens', () => {
    const result = parseDevinModelsJson([
      record({ maxContextTokens: 200000, maxOutputTokens: 4096 }),
    ]);
    expect(result.models[0]).toMatchObject({ maxContextTokens: 200000, maxOutputTokens: 4096 });
  });

  it('nulls maxContextTokens/maxOutputTokens when absent, never 0', () => {
    const {
      maxContextTokens: _maxContextTokens,
      maxOutputTokens: _maxOutputTokens,
      ...rest
    } = record();
    const result = parseDevinModelsJson([rest]);
    expect(result.models[0].maxContextTokens).toBeNull();
    expect(result.models[0].maxOutputTokens).toBeNull();
  });
});

describe('parseDevinModelsJson — malformed input', () => {
  it('returns an empty result with a warning when the root is not an array', () => {
    const result = parseDevinModelsJson({ not: 'an array' });
    expect(result.models).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('skips an entry missing a required string field without throwing', () => {
    expect(() => parseDevinModelsJson([{ modelUid: 'model-a' }])).not.toThrow();
    const result = parseDevinModelsJson([{ modelUid: 'model-a' }, record()]);
    expect(result.models).toHaveLength(1);
    expect(result.warnings).toHaveLength(1);
  });

  it('skips a non-object entry without throwing', () => {
    const result = parseDevinModelsJson(['not an object', record()]);
    expect(result.models).toHaveLength(1);
    expect(result.warnings).toHaveLength(1);
  });
});
