import { describe, expect, it } from 'vitest';
import { DevinTransformer } from '../../src/index.js';
import {
  defaultContext,
  linearBundle,
  noRootBundle,
  partialTokensBundle,
  sessionReplayBundle,
  unknownSchemaBundle,
} from '../conformance/fixtures/index.js';

function findMetric(
  result: { metricValues: readonly { metricId: string; value: unknown; exact?: boolean }[] },
  metricId: string,
) {
  return result.metricValues.find((m) => m.metricId === metricId);
}

describe('DevinTransformer.transform', () => {
  it('produces a session summary, evidence, and metric values', () => {
    const result = DevinTransformer.transform(linearBundle, defaultContext);
    expect(result.errors).toEqual([]);
    expect(result.sessionSummaries.length).toBe(1);
    expect(result.evidence.length).toBeGreaterThan(0);
    expect(result.metricValues.length).toBeGreaterThan(0);
    expect(result.capabilities.length).toBe(result.metricValues.length);
  });

  it('derives token counts from ATIF final metrics', () => {
    const result = DevinTransformer.transform(linearBundle, defaultContext);
    expect(findMetric(result, 'devin:tokens:prompt:root_only')?.value).toBe(100);
    expect(findMetric(result, 'devin:tokens:completion:root_only')?.value).toBe(50);
    expect(findMetric(result, 'devin:tokens:cached:root_only')?.value).toBe(10);
    expect(findMetric(result, 'devin:tokens:total:root_only')?.value).toBe(160);
  });

  it('resolves session-level state from the LAST session line, not the first (#320)', () => {
    const result = DevinTransformer.transform(sessionReplayBundle, defaultContext);
    expect(result.errors).toEqual([]);
    const sessionRecords = result.evidence.filter((r) => r.recordType === 'session');
    expect(sessionRecords.length).toBe(1);
    const payload = sessionRecords[0]?.payload as {
      title?: string;
      model?: string;
      endTime?: string;
    };
    expect(payload.title).toBe('Fresh replayed title');
    expect(payload.model).toBe('devin-updated');
    // last_activity_at from the SECOND session line (1722524500s), not the
    // first-pass value (1722520900s).
    expect(payload.endTime).toBe(new Date(1722524500 * 1000).toISOString());
  });

  it('counts turns from the message main chain', () => {
    const result = DevinTransformer.transform(linearBundle, defaultContext);
    expect(findMetric(result, 'devin:turns:count:root_only')?.value).toBe(4);
  });

  it('counts tool invocations from tool_call_state records', () => {
    const result = DevinTransformer.transform(linearBundle, defaultContext);
    expect(findMetric(result, 'devin:invocations:tool:root_only')?.value).toBe(1);
  });

  it('emits invocation records with start/result ids and payload records', () => {
    const result = DevinTransformer.transform(linearBundle, defaultContext);
    const invocations = result.evidence.filter((r) => r.recordType === 'invocation');
    expect(invocations.length).toBe(1);
    const payloads = result.evidence.filter(
      (r) =>
        r.recordType === 'payload' && (r.payload as { toolUseId?: string }).toolUseId === 'tc-1',
    );
    expect(payloads.length).toBe(2);
  });

  it('computes a positive wall duration from session timestamps', () => {
    const result = DevinTransformer.transform(linearBundle, defaultContext);
    const duration = findMetric(result, 'devin:duration:wall_ms:root_only');
    expect(typeof duration?.value).toBe('number');
    expect(duration?.value).toBeGreaterThan(0);
    expect(duration?.exact).toBe(true);
  });

  it('leaves cost unavailable with a reason', () => {
    const result = DevinTransformer.transform(linearBundle, defaultContext);
    const cost = findMetric(result, 'devin:cost:total:root_only');
    expect(cost?.value).toBeNull();
    expect(cost?.exact).toBe(false);
    expect(result.unavailableReasons.some((r) => r.metricId === 'devin:cost:total:root_only')).toBe(
      true,
    );
  });

  it('emits root and inclusive metric pairs with equal values when no subagents are present', () => {
    const result = DevinTransformer.transform(linearBundle, defaultContext);
    for (const metric of result.metricValues) {
      if (!metric.metricId.endsWith(':root_only')) continue;
      const inclusiveId = metric.metricId.replace(':root_only', ':inclusive');
      const inclusive = findMetric(result, inclusiveId);
      expect(inclusive).toBeDefined();
      if (metric.value !== null) {
        expect(inclusive?.value).toBe(metric.value);
      }
    }
  });

  it('produces distinct comparability groups for each metric', () => {
    const result = DevinTransformer.transform(linearBundle, defaultContext);
    const groups = new Set(result.metricValues.map((m) => m.comparabilityGroupId));
    expect(groups.size).toBe(result.metricValues.length);
  });

  it('reports a fatal error when no root transcript is present', () => {
    const result = DevinTransformer.transform(noRootBundle, defaultContext);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.sessionSummaries.length).toBe(0);
    expect(result.metricValues.length).toBe(0);
  });

  it('marks token metrics unavailable when token data is missing', () => {
    const result = DevinTransformer.transform(partialTokensBundle, defaultContext);
    expect(result.errors).toEqual([]);
    expect(findMetric(result, 'devin:tokens:prompt:root_only')?.value).toBeNull();
    expect(findMetric(result, 'devin:tokens:total:root_only')?.value).toBeNull();
    expect(
      result.unavailableReasons.some((r) => r.metricId === 'devin:tokens:prompt:root_only'),
    ).toBe(true);
  });

  it('continues without ATIF when the schema version is unsupported', () => {
    const result = DevinTransformer.transform(unknownSchemaBundle, defaultContext);
    expect(result.errors).toEqual([]);
    expect(findMetric(result, 'devin:tokens:prompt:root_only')?.value).toBeNull();
    expect(findMetric(result, 'devin:turns:count:root_only')?.value).toBeGreaterThan(0);
  });

  it('produces deterministic record ids across two runs of the same bundle', () => {
    const first = DevinTransformer.transform(linearBundle, defaultContext);
    const second = DevinTransformer.transform(linearBundle, defaultContext);
    expect(first.evidence.map((r) => r.recordId)).toEqual(second.evidence.map((r) => r.recordId));
    expect(first.metricValues.map((m) => m.metricId)).toEqual(
      second.metricValues.map((m) => m.metricId),
    );
    expect(first.metricValues.map((m) => m.comparabilityGroupId)).toEqual(
      second.metricValues.map((m) => m.comparabilityGroupId),
    );
  });

  it('keeps record ids stable when artifact order is reversed', () => {
    const reversed = {
      ...linearBundle,
      artifacts: [...linearBundle.artifacts].reverse(),
    };
    const normal = DevinTransformer.transform(linearBundle, defaultContext);
    const rev = DevinTransformer.transform(reversed, defaultContext);
    expect(normal.sessionSummaries.map((s) => s.sessionId)).toEqual(
      rev.sessionSummaries.map((s) => s.sessionId),
    );
    expect(normal.evidence.map((r) => r.recordId)).toEqual(rev.evidence.map((r) => r.recordId));
  });
});
