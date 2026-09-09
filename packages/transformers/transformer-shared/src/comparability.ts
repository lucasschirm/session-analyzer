export type CapabilityState = 'available' | 'partial' | 'unavailable' | 'incompatible';

export interface ComparabilityGroupSpec {
  readonly metricId: string;
  readonly metricDefinitionVersion: string;
  readonly unit: string;
  readonly currencyPricingVersion?: string;
  readonly grain: string;
  readonly dimensions: Readonly<Record<string, string>>;
  readonly denominator?: string;
  readonly observationUnit: string;
  readonly population: string;
  readonly sessionFinalityRules: string;
  readonly measurementClass: string;
  readonly nativeMappingVersion: string;
  readonly rootOnlyInclusive: 'root_only' | 'inclusive' | 'both';
  readonly statusThresholdCensoringMissingDataRules: string;
  readonly aggregationStatisticalAttributionMethod: string;
}

function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash;
}

function toHex(hash: number): string {
  return hash.toString(16).padStart(8, '0');
}

export function hashString(input: string): string {
  return toHex(fnv1a32(input));
}

function serializeValue(value: unknown): string {
  if (value === undefined || value === null) {
    return '';
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map(serializeValue).join(',');
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
    return entries.map(([k, v]) => `${k}=${serializeValue(v)}`).join(';');
  }
  return String(value);
}

const COMPARABILITY_FIELDS: (keyof ComparabilityGroupSpec)[] = [
  'metricId',
  'metricDefinitionVersion',
  'unit',
  'currencyPricingVersion',
  'grain',
  'dimensions',
  'denominator',
  'observationUnit',
  'population',
  'sessionFinalityRules',
  'measurementClass',
  'nativeMappingVersion',
  'rootOnlyInclusive',
  'statusThresholdCensoringMissingDataRules',
  'aggregationStatisticalAttributionMethod',
];

export function serializeComparabilitySpec(spec: ComparabilityGroupSpec): string {
  return COMPARABILITY_FIELDS.map((field) => `${field}=${serializeValue(spec[field])}`).join('|');
}

export function deriveComparabilityGroupId(spec: ComparabilityGroupSpec): string {
  return `cgrp-${hashString(serializeComparabilitySpec(spec))}`;
}
