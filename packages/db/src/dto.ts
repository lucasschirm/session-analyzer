export type MeasurementClass = 'observed' | 'derived' | 'estimated' | 'heuristic';

export type Confidence = 'high' | 'medium' | 'low' | 'unknown';

export type Coverage = 'complete' | 'partial' | 'unsupported' | 'unknown';

export interface EvidenceLink {
  readonly evidenceId: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly label: string;
}

export interface AnalyticsToken {
  readonly analysisReleaseId: string;
  readonly generationId: string;
  readonly comparabilityGroupId: string;
  readonly eligibleN: number;
  readonly knownN: number;
  readonly unknownCount: number;
  readonly coverage: Coverage;
  readonly measurementClass: MeasurementClass;
  readonly confidence: Confidence;
  readonly metricVersion: string;
  readonly evidenceLinks: readonly EvidenceLink[];
}

export interface MetricValueDto extends AnalyticsToken {
  readonly metricId: string;
  readonly value: number | null;
  readonly unit: string;
  readonly label: string;
  readonly isExact: boolean;
}

export const ANALYTICS_DTO_VERSION = '0.1.0';

export const DEFAULT_ANALYTICS_LIMIT = 50;

export function emptyEvidenceLinks(): readonly EvidenceLink[] {
  return [];
}

export function isValidComparabilityGroupId(id: string): boolean {
  return typeof id === 'string' && id.length > 0 && id.startsWith('cgrp-');
}

export function makeMetricValueDto(
  metricId: string,
  value: number | null,
  token: AnalyticsToken,
  evidenceLinks?: readonly EvidenceLink[],
): MetricValueDto {
  return {
    ...token,
    evidenceLinks: evidenceLinks ?? token.evidenceLinks,
    metricId,
    value,
    unit: 'count',
    label: metricId,
    isExact: token.measurementClass === 'observed',
  };
}
