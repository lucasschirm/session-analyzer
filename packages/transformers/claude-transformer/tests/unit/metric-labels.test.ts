import { describe, expect, it } from 'vitest';
import { getClaudeCodeAttributionMetricDefinitions } from '../../src/plugin/claude-code-attribution-metrics.js';
import {
  createMetricLabelLookup,
  metricIdToLabel,
  tryMetricIdToLabel,
} from '../../src/plugin/metric-labels.js';

describe('createMetricLabelLookup', () => {
  it('builds a label lookup from an injected definitions array', () => {
    const lookup = createMetricLabelLookup([
      {
        metricId: 'test:example',
        version: 1,
        label: 'Example Metric',
        description: 'An example metric for the label lookup test.',
        family: 'test',
        measurementClass: 'observed',
        unit: 'count',
        valueType: 'integer',
        grain: 'session',
        dimensions: [],
        populationRule: 'always',
        statusRule: 'always',
        aggregation: 'sum',
        statisticalPolicyId: 'test-default',
        comparabilityGroupInputs: ['metricId'],
        missingDataBehavior: 'unknown',
        rootInclusion: 'not_applicable',
        provenanceRequirement: 'none',
      },
    ]);

    expect(lookup.tryMetricIdToLabel('test:example')).toBe('Example Metric');
    expect(lookup.metricIdToLabel('test:example')).toBe('Example Metric');
  });

  it('returns undefined/the raw id for an unknown metric id', () => {
    const lookup = createMetricLabelLookup([]);

    expect(lookup.tryMetricIdToLabel('unknown:metric')).toBeUndefined();
    expect(lookup.metricIdToLabel('unknown:metric')).toBe('unknown:metric');
  });
});

describe("this package's combined Claude metric label lookup", () => {
  it('resolves labels for attribution metrics (DS-B3 / #141 regression)', () => {
    const [firstAttributionDefinition] = getClaudeCodeAttributionMetricDefinitions();
    expect(firstAttributionDefinition).toBeDefined();

    const label = tryMetricIdToLabel(firstAttributionDefinition.metricId);
    expect(label).toBe(firstAttributionDefinition.label);
    expect(label).not.toBe(firstAttributionDefinition.metricId);
  });

  it('falls back to the raw metric id for an unknown metric', () => {
    expect(tryMetricIdToLabel('does-not-exist')).toBeUndefined();
    expect(metricIdToLabel('does-not-exist')).toBe('does-not-exist');
  });
});
