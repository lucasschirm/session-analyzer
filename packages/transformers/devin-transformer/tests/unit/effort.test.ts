import type { DevinModelRecord } from '@lucasschirm/sal-devin-session-parser';
import { describe, expect, it } from 'vitest';
import { parseDevinEffortFromLabel, resolveDevinEffortForModel } from '../../src/effort.js';

// Real label shapes from DS-B31 (#290) finding 3, verified against a live
// Devin CLI's `devin models list --format json` catalog output.
describe('parseDevinEffortFromLabel', () => {
  it.each([
    ['SWE-1.7 Max', { raw: 'Max', normalized: 'max' }],
    ['SWE-1.7 Medium', { raw: 'Medium', normalized: 'medium' }],
    ['GLM-5.2 High', { raw: 'High', normalized: 'high' }],
    ['GLM-5.3 Low', { raw: 'Low', normalized: 'low' }],
    ['Claude Opus 5 Low Fast', { raw: 'Low', normalized: 'low' }],
    ['GLM-5.2 No Thinking', { raw: 'No Thinking', normalized: 'none' }],
    ['GLM-5.2 No Thinking 1M', { raw: 'No Thinking', normalized: 'none' }],
    ['GLM-5.2 High 1M', { raw: 'High', normalized: 'high' }],
    ['SWE-1.6', { raw: null, normalized: null }],
    ['Claude Opus 4.6 Thinking', { raw: null, normalized: null }],
  ] as const)('parses %s -> %o', (label, expected) => {
    expect(parseDevinEffortFromLabel(label)).toEqual(expected);
  });

  it('is case-insensitive on the tier word and modifier tokens', () => {
    expect(parseDevinEffortFromLabel('GLM-5.3 low')).toEqual({ raw: 'low', normalized: 'low' });
    expect(parseDevinEffortFromLabel('Claude Opus 5 High fast')).toEqual({
      raw: 'High',
      normalized: 'high',
    });
  });

  it('returns no match for an empty or whitespace-only label', () => {
    expect(parseDevinEffortFromLabel('')).toEqual({ raw: null, normalized: null });
    expect(parseDevinEffortFromLabel('   ')).toEqual({ raw: null, normalized: null });
  });
});

function model(modelUid: string, label: string): DevinModelRecord {
  return {
    modelUid,
    label,
    familyUid: modelUid,
    costTier: 'Standard cost',
    maxContextTokens: null,
    maxOutputTokens: null,
  };
}

const CATALOG: DevinModelRecord[] = [
  model('glm-5-3-low', 'GLM-5.3 Low'),
  model('swe-1-7', 'SWE-1.7 Max'),
  model('glm-5-2', 'GLM-5.2 High'),
  model('swe-1-6', 'SWE-1.6'),
  model('compactor', 'Compactor'),
];

describe('resolveDevinEffortForModel', () => {
  it('resolves a suffixed model_uid via its label', () => {
    expect(resolveDevinEffortForModel('glm-5-3-low', CATALOG)).toEqual({
      raw: 'Low',
      normalized: 'low',
    });
  });

  it('resolves the unsuffixed-uid, label-only tier case (finding 3b)', () => {
    expect(resolveDevinEffortForModel('swe-1-7', CATALOG)).toEqual({
      raw: 'Max',
      normalized: 'max',
    });
    expect(resolveDevinEffortForModel('glm-5-2', CATALOG)).toEqual({
      raw: 'High',
      normalized: 'high',
    });
  });

  it('returns no match for the compactor pseudo-model and an unknown uid', () => {
    expect(resolveDevinEffortForModel('compactor', CATALOG)).toEqual({
      raw: null,
      normalized: null,
    });
    expect(resolveDevinEffortForModel('some-unknown-uid', CATALOG)).toEqual({
      raw: null,
      normalized: null,
    });
  });

  it('returns no match for a real, recognized model whose label has no tier phrase', () => {
    expect(resolveDevinEffortForModel('swe-1-6', CATALOG)).toEqual({
      raw: null,
      normalized: null,
    });
  });

  it('returns no match for a null modelUid (e.g. a step with no generation_model)', () => {
    expect(resolveDevinEffortForModel(null, CATALOG)).toEqual({ raw: null, normalized: null });
  });

  it('returns no match when the catalog is empty (capture failed/unavailable)', () => {
    expect(resolveDevinEffortForModel('glm-5-3-low', [])).toEqual({ raw: null, normalized: null });
  });
});
