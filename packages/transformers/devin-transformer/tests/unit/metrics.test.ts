import type { NormalizedEvidenceRecord } from '@lucasschirm/sal-transformer-shared';
import { describe, expect, it } from 'vitest';
import { DevinTransformer } from '../../src/index.js';
import { comparabilityGroupFor } from '../../src/metrics/comparability.js';
import { deriveDevinMetrics, getDevinMetricDefinitions } from '../../src/metrics/index.js';
import {
  componentsBundle,
  defaultContext,
  linearBundle,
  modelSwitchBundle,
} from '../conformance/fixtures/index.js';

describe('Devin metric definitions', () => {
  it('exports a metric definition for every Phase 1 root and inclusive metric', () => {
    const definitions = getDevinMetricDefinitions();
    expect(definitions.length).toBe(24);
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
    expect(groups.size).toBe(24);
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

describe('devin:invocations:skill:*/agent:* standalone-vs-transform consistency (DS-F11 #288)', () => {
  for (const bundle of [linearBundle, componentsBundle]) {
    it('getCapabilities(bundle) and transform(bundle, ctx).capabilities agree for skill/agent', () => {
      const standalone = DevinTransformer.getCapabilities(bundle);
      const transformed = DevinTransformer.transform(bundle, defaultContext).capabilities;
      const standaloneById = new Map(standalone.map((c) => [c.metricId, c.state]));
      const transformedById = new Map(transformed.map((c) => [c.metricId, c.state]));
      for (const metricId of [
        'devin:invocations:skill:root_only',
        'devin:invocations:skill:inclusive',
        'devin:invocations:agent:root_only',
        'devin:invocations:agent:inclusive',
      ]) {
        expect(standaloneById.get(metricId)).toBe(transformedById.get(metricId));
      }
    });
  }
});

describe('DS-B25 (#285): aggregate token/step metrics cite every model_usage record', () => {
  it('devin:tokens:total:inclusive and devin:steps:count:inclusive evidenceRecordIds include both model-switch step records', () => {
    const result = DevinTransformer.transform(modelSwitchBundle, defaultContext);
    const usageRecordIds = new Set(
      result.evidence.filter((r) => r.recordType === 'model_usage').map((r) => r.recordId),
    );
    expect(usageRecordIds.size).toBe(2);

    for (const metricId of ['devin:tokens:total:inclusive', 'devin:steps:count:inclusive']) {
      const metric = result.metricValues.find((m) => m.metricId === metricId) as
        | { evidenceRecordIds: readonly string[] }
        | undefined;
      expect(metric).toBeDefined();
      if (!metric) continue;
      // Every model_usage record for the session must be cited — not just
      // the first one — since the aggregate value sums across all of them.
      for (const id of usageRecordIds) {
        expect(metric.evidenceRecordIds).toContain(id);
      }
      expect(metric.evidenceRecordIds.length).toBe(2);
    }
  });
});

function modelUsageRecord(
  sessionId: string,
  requestOrder: number,
  normalizedEffort: string | null,
): NormalizedEvidenceRecord {
  return {
    recordId: `mu-${sessionId}-${requestOrder}`,
    recordType: 'model_usage',
    sessionId,
    sourceEventId: `${sessionId}:step:${requestOrder}`,
    sourceField: 'atif_step',
    provenance: { artifactId: 'artifact-1', path: 'artifact-1' },
    payload: { requestOrder, normalizedEffort },
  };
}

const EMPTY_TOKEN_USAGE = {
  prompt: null,
  completion: null,
  cached: null,
  total: null,
  steps: null,
  exact: false,
  recordId: '',
};

// DS-B31 (#290): devin:effort:changes:root_only/:inclusive transition
// counting, mirroring #289's three Claude-side n=0/n=1/n>=2 scenarios
// exactly (same measured-zero-vs-unavailable rules).
describe('devin:effort:changes:root_only/:inclusive transition counting', () => {
  it('is unavailable (never a fabricated 0) when no model_usage record carries a recognized effort', () => {
    const result = deriveDevinMetrics(
      undefined,
      undefined,
      [],
      [],
      EMPTY_TOKEN_USAGE,
      'artifact-1',
      's1',
    );
    const metric = result.metricValues.find((m) => m.metricId === 'devin:effort:changes:root_only');
    expect(metric?.value).toBeNull();
    expect(metric?.unavailableReason).toBe('no recognized effort signal observed for this session');
    // aggregates-expose-sample-size: even unavailable, the metric must cite
    // the evidence it inspected — never an empty evidenceRecordIds array.
    expect(metric?.evidenceRecordIds.length).toBeGreaterThan(0);
  });

  it('reports a measured 0 (n=1, exact) for a single-record session with no transition possible', () => {
    const evidence = [modelUsageRecord('s1', 1, 'high')];
    const result = deriveDevinMetrics(
      undefined,
      undefined,
      [],
      evidence,
      EMPTY_TOKEN_USAGE,
      'artifact-1',
      's1',
    );
    const metric = result.metricValues.find((m) => m.metricId === 'devin:effort:changes:root_only');
    expect(metric?.value).toBe(0);
    expect(metric?.exact).toBe(true);
    expect(metric?.unavailableReason).toBeUndefined();
  });

  it('counts exactly one transition across two model_usage records (glm-5-3-low -> glm-5-3-high)', () => {
    const evidence = [modelUsageRecord('s1', 1, 'low'), modelUsageRecord('s1', 2, 'high')];
    const result = deriveDevinMetrics(
      undefined,
      undefined,
      [],
      evidence,
      EMPTY_TOKEN_USAGE,
      'artifact-1',
      's1',
    );
    for (const scope of ['root_only', 'inclusive'] as const) {
      const metric = result.metricValues.find(
        (m) => m.metricId === `devin:effort:changes:${scope}`,
      );
      expect(metric?.value).toBe(1);
      expect(metric?.evidenceRecordIds).toEqual(['mu-s1-1', 'mu-s1-2']);
    }
  });

  it('carries forward the last known non-null value across a null-effort record without counting it', () => {
    const evidence = [
      modelUsageRecord('s1', 1, 'high'),
      modelUsageRecord('s1', 2, null),
      modelUsageRecord('s1', 3, 'xhigh'),
    ];
    const result = deriveDevinMetrics(
      undefined,
      undefined,
      [],
      evidence,
      EMPTY_TOKEN_USAGE,
      'artifact-1',
      's1',
    );
    const metric = result.metricValues.find((m) => m.metricId === 'devin:effort:changes:root_only');
    expect(metric?.value).toBe(1);
    // The null-effort record is never counted toward the sample.
    expect(metric?.evidenceRecordIds).toEqual(['mu-s1-1', 'mu-s1-3']);
  });
});
