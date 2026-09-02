import { describe, expect, it } from 'vitest';
import { DevinTransformer } from '../../src/index.js';
import { getDevinMetricDefinitions } from '../../src/metrics/index.js';
import { linearBundle, noRootBundle, partialTokensBundle } from '../conformance/fixtures/index.js';

describe('DevinTransformer.getCapabilities', () => {
  it('returns a capability for every canonical metric id', () => {
    const caps = DevinTransformer.getCapabilities(linearBundle);
    const definitionIds = getDevinMetricDefinitions().map((d) => d.metricId);
    const capIds = new Set(caps.map((c) => c.metricId));
    for (const id of definitionIds) {
      expect(capIds.has(id)).toBe(true);
    }
    expect(caps.length).toBe(definitionIds.length);
  });

  it('returns partial capabilities when no bundle is supplied', () => {
    const caps = DevinTransformer.getCapabilities();
    for (const cap of caps) {
      expect(cap.state).toBe('partial');
      expect(cap.reason).toContain('no bundle');
    }
  });

  it('returns unavailable capabilities when there is no root transcript', () => {
    const caps = DevinTransformer.getCapabilities(noRootBundle);
    for (const cap of caps) {
      expect(cap.state).toBe('unavailable');
      expect(cap.reason).toContain('root transcript');
    }
  });

  it('marks token metrics available when ATIF final metrics are present', () => {
    const caps = DevinTransformer.getCapabilities(linearBundle);
    const byId = new Map(caps.map((c) => [c.metricId, c]));
    expect(byId.get('devin:tokens:prompt:root_only')?.state).toBe('available');
    expect(byId.get('devin:tokens:completion:root_only')?.state).toBe('available');
    expect(byId.get('devin:tokens:cached:root_only')?.state).toBe('available');
    expect(byId.get('devin:tokens:total:root_only')?.state).toBe('available');
  });

  it('marks token metrics unavailable when no token source is present', () => {
    const caps = DevinTransformer.getCapabilities(partialTokensBundle);
    const byId = new Map(caps.map((c) => [c.metricId, c]));
    expect(byId.get('devin:tokens:prompt:root_only')?.state).toBe('unavailable');
    expect(byId.get('devin:tokens:total:root_only')?.state).toBe('unavailable');
  });

  it('marks skill and agent invocations unavailable', () => {
    const caps = DevinTransformer.getCapabilities(linearBundle);
    const byId = new Map(caps.map((c) => [c.metricId, c]));
    expect(byId.get('devin:invocations:skill:root_only')?.state).toBe('unavailable');
    expect(byId.get('devin:invocations:agent:root_only')?.state).toBe('unavailable');
    expect(byId.get('devin:invocations:skill:root_only')?.reason).toContain(
      'plugins/discovered.json',
    );
  });

  it('marks cost unavailable', () => {
    const caps = DevinTransformer.getCapabilities(linearBundle);
    const byId = new Map(caps.map((c) => [c.metricId, c]));
    expect(byId.get('devin:cost:total:root_only')?.state).toBe('unavailable');
    expect(byId.get('devin:cost:total:root_only')?.reason).toContain('model_uid');
  });

  it('marks duration partial because per-message timestamps are unreliable', () => {
    const caps = DevinTransformer.getCapabilities(linearBundle);
    const byId = new Map(caps.map((c) => [c.metricId, c]));
    expect(byId.get('devin:duration:wall_ms:root_only')?.state).toBe('partial');
    expect(byId.get('devin:duration:wall_ms:root_only')?.reason).toContain(
      'per-message timestamps',
    );
  });

  it('includes a comparability group id on every capability', () => {
    const caps = DevinTransformer.getCapabilities(linearBundle);
    for (const cap of caps) {
      expect(cap.comparabilityGroupId).toBeDefined();
      expect(cap.comparabilityGroupId?.length ?? 0).toBeGreaterThan(0);
    }
  });
});
