import { describe, expect, it } from 'vitest';
import {
  ANALYTICS_DTO_VERSION,
  type AnalyticsToken,
  type Coverage,
  type CursorPage,
  DEFAULT_ANALYTICS_LIMIT,
  type EvidenceLink,
  emptyEvidenceLinks,
  isValidComparabilityGroupId,
  type MetricValueDto,
  makeMetricValueDto,
} from '../../src/index.js';

function typeCheck<T>(_value: T) {
  return true;
}

describe('analytics DTOs', () => {
  it('carry required analysis release, generation, and comparability tokens', () => {
    const evidence: EvidenceLink = {
      evidenceId: 'e1',
      entityType: 'turn',
      entityId: 't1',
      label: 'Turn 1',
    };

    const token: AnalyticsToken = {
      analysisReleaseId: 'release-1',
      generationId: 'gen-1',
      comparabilityGroupId: 'cgrp-abc123',
      eligibleN: 100,
      knownN: 95,
      unknownCount: 5,
      coverage: 'complete',
      measurementClass: 'observed',
      confidence: 'high',
      metricVersion: '0.1.0',
      evidenceLinks: [evidence],
    };

    const metric: MetricValueDto = makeMetricValueDto('m1', 42, token);

    expect(metric.metricId).toBe('m1');
    expect(metric.value).toBe(42);
    expect(metric.comparabilityGroupId).toBe('cgrp-abc123');
    expect(metric.eligibleN).toBe(100);
    expect(metric.knownN).toBe(95);
    expect(metric.unknownCount).toBe(5);
    expect(metric.coverage).toBe('complete');
    expect(metric.measurementClass).toBe('observed');
    expect(metric.confidence).toBe('high');
    expect(metric.metricVersion).toBe('0.1.0');
    expect(metric.evidenceLinks).toHaveLength(1);
    expect(typeCheck<MetricValueDto>(metric)).toBe(true);
  });

  it('expose DTO helpers and coverage constants', () => {
    expect(ANALYTICS_DTO_VERSION).toBe('0.1.0');
    expect(DEFAULT_ANALYTICS_LIMIT).toBe(50);
    expect(emptyEvidenceLinks()).toEqual([]);
    expect(isValidComparabilityGroupId('cgrp-abc')).toBe(true);
    expect(isValidComparabilityGroupId('group-abc')).toBe(false);
    expect(isValidComparabilityGroupId('')).toBe(false);
  });

  it('use cursor pages that are snapshot-consistent against generation token', () => {
    const coverage: Coverage = 'partial';

    const page: CursorPage<string> = {
      items: ['a', 'b'],
      nextCursor: 'cursor-2',
      previousCursor: 'cursor-0',
      generationToken: 'gen-1',
      analysisReleaseToken: 'release-1',
    };

    expect(page.generationToken).toBe('gen-1');
    expect(page.analysisReleaseToken).toBe('release-1');
    expect(page.items).toEqual(['a', 'b']);
    expect(coverage).toBe('partial');
  });
});
