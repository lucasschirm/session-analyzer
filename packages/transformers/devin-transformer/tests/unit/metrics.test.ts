import { describe, expect, it } from 'vitest';
import { comparabilityGroupFor } from '../../src/metrics/comparability.js';
import { getDevinMetricDefinitions } from '../../src/metrics/index.js';

describe('Devin metric definitions', () => {
  it('exports a metric definition for every Phase 1 root and inclusive metric', () => {
    const definitions = getDevinMetricDefinitions();
    expect(definitions.length).toBe(22);
    const ids = new Set(definitions.map((d) => d.metricId));
    expect(ids.has('devin:tokens:prompt:root_only')).toBe(true);
    expect(ids.has('devin:tokens:prompt:inclusive')).toBe(true);
    expect(ids.has('devin:invocations:tool:root_only')).toBe(true);
    expect(ids.has('devin:invocations:tool:inclusive')).toBe(true);
    expect(ids.has('devin:cost:total:root_only')).toBe(true);
    expect(ids.has('devin:duration:wall_ms:root_only')).toBe(true);
  });

  it('includes required MetricDefinition fields', () => {
    for (const def of getDevinMetricDefinitions()) {
      expect(def.metricId).toBeDefined();
      expect(def.version).toBeGreaterThan(0);
      expect(def.unit).toBeDefined();
      expect(def.grain).toBe('session');
      expect(def.comparabilityGroupInputs.length).toBeGreaterThan(0);
      expect(def.missingDataBehavior).toBe('unknown');
    }
  });

  it('produces distinct comparability groups for distinct metrics', () => {
    const groups = new Set<string>();
    for (const def of getDevinMetricDefinitions()) {
      const group = comparabilityGroupFor(def, {});
      expect(group).not.toBe('');
      expect(groups.has(group)).toBe(false);
      groups.add(group);
    }
    expect(groups.size).toBe(22);
  });

  it('varies comparability groups when dimensions differ', () => {
    const prompt = getDevinMetricDefinitions().find(
      (d) => d.metricId === 'devin:tokens:prompt:root_only',
    );
    const completion = getDevinMetricDefinitions().find(
      (d) => d.metricId === 'devin:tokens:completion:root_only',
    );
    expect(prompt).toBeDefined();
    expect(completion).toBeDefined();
    if (!prompt || !completion) return;
    expect(comparabilityGroupFor(prompt, { token_class: 'prompt' })).not.toBe(
      comparabilityGroupFor(completion, { token_class: 'completion' }),
    );
  });
});
