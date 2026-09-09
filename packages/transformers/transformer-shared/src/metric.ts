import type { CapabilityState } from './comparability.js';

export interface MetricCapability {
  readonly metricId: string;
  readonly definitionVersion: string;
  readonly state: CapabilityState;
  readonly reason?: string;
  readonly evidence?: readonly string[];
  readonly comparabilityGroupId?: string;
}

export interface MetricUnavailableReason {
  readonly metricId: string;
  readonly definitionVersion: string;
  readonly reason: string;
}

export interface ScalarMetricValue {
  readonly metricId: string;
  readonly definitionVersion: string;
  readonly value: number | null;
  readonly exact: boolean;
  readonly unit: string;
  readonly comparabilityGroupId: string;
  readonly provenanceArtifactId?: string;
}

// ---------------------------------------------------------------------------
// Shared metric definition contract (§9)
//
// Harness-agnostic descriptor for a metric's formula, population, and
// comparability inputs. Harness-specific transformer packages (e.g.
// claude-transformer, devin-transformer) implement metric getters that
// return arrays of this shape (or an extension of it), so that shared
// tooling (metric-label lookup, the conformance suite) can consume metric
// metadata without importing a harness-specific package.
// ---------------------------------------------------------------------------

export interface MetricDefinition {
  readonly metricId: string;
  readonly version: number;
  readonly label: string;
  readonly description: string;
  readonly family: string;
  readonly measurementClass: 'observed' | 'derived' | 'estimated' | 'heuristic';
  readonly unit: string;
  readonly valueType: 'integer' | 'real' | 'currency' | 'ratio' | 'text';
  readonly grain: string;
  readonly dimensions: readonly string[];
  readonly denominator?: string;
  readonly populationRule: string;
  readonly statusRule: string;
  readonly aggregation: string;
  readonly allocationMethod?: string;
  readonly statisticalPolicyId: string;
  readonly comparabilityGroupInputs: readonly string[];
  readonly missingDataBehavior: 'unknown' | 'not_applicable';
  readonly rootInclusion: 'root_only' | 'inclusive' | 'both' | 'not_applicable';
  readonly distributionPolicy?: string;
  readonly provenanceRequirement: string;
}

export interface DistributionBin {
  readonly lower: number;
  readonly upper: number;
  readonly count: number;
}

export interface Distribution {
  readonly metricId: string;
  readonly definitionVersion: string;
  readonly unit: string;
  readonly comparabilityGroupId: string;
  readonly population: number;
  readonly bins: readonly DistributionBin[];
}
