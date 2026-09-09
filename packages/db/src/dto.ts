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

export type ComponentDomain = 'tool' | 'skill' | 'agent';

export interface ComponentUtilizationTiersDto {
  readonly totalAvailable: number;
  readonly totalUsed: number;
  readonly totalUnused: number;
  readonly usedLt10Pct: number;
  readonly usedLt25Pct: number;
  readonly usedLt50Pct: number;
  readonly usedGte50Pct: number;
  readonly insufficientSample: number;
}

export interface ComponentUtilizationItemDto {
  readonly componentId: string;
  readonly kind: ComponentDomain;
  readonly displayName: string;
  readonly nativeId?: string;
  readonly offeredSessions: number;
  readonly usedSessions: number;
  readonly usageRate: number;
  readonly tier: 'unused' | 'lt10' | 'lt25' | 'lt50' | 'gte50' | 'insufficient_sample';
}

export interface DomainUtilizationSummaryDto {
  readonly domain: ComponentDomain;
  readonly tiers: ComponentUtilizationTiersDto;
  readonly sampleSessions: number;
  readonly eligibleSessions: number;
  readonly minSampleSizeConfig: number;
  readonly components: readonly ComponentUtilizationItemDto[];
}

export interface SessionDomainUtilizationDto {
  readonly domain: ComponentDomain;
  readonly availableCount: number;
  readonly usedCount: number;
  readonly unusedCount: number;
  readonly availableComponents: readonly string[];
  readonly usedComponents: readonly string[];
  readonly unusedComponents: readonly string[];
}

export interface ScopeUtilizationReportDto {
  readonly scopeType: 'session' | 'harness' | 'project' | 'portfolio';
  readonly scopeId: string;
  readonly token: AnalyticsToken;
  readonly domains: Record<ComponentDomain, DomainUtilizationSummaryDto>;
  readonly sessionDomains?: Record<ComponentDomain, SessionDomainUtilizationDto>;
}
