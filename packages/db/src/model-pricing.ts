import type {
  AttributionPolicy,
  AttributionType,
  InsertAttributionPolicyInput,
  InsertInvocationPayloadInput,
  InsertModelCapabilityInput,
  InsertPricingVersionInput,
  InvocationPayload,
  ModelCapability,
  ModelTokenClass,
  PricingVersion,
  SqliteExecutor,
  SqliteTransaction,
} from '@lucasschirm/sal-db-core';
import {
  AttributionPolicyStore,
  InvocationPayloadStore,
  ModelCapabilityStore,
  PricingVersionStore,
  RollupPolicyStore,
  StatisticalPolicyStore,
} from '@lucasschirm/sal-db-core';
import {
  isAttributionPolicyComplete,
  isRollupPolicyComplete,
  isStatisticalPolicyComplete,
  type MetricRegistryValidationResult,
  validateMetricRegistry,
} from './metric-registry.js';

type Queryable = SqliteExecutor | SqliteTransaction;

/**
 * Supported overlap handling strategies for Phase 3 attribution policies.
 */
export const ATTRIBUTION_OVERLAP_HANDLINGS = [
  'prorate',
  'exclusive',
  'partitioned',
  'first-wins',
] as const;
export type AttributionOverlapHandling = (typeof ATTRIBUTION_OVERLAP_HANDLINGS)[number];

/**
 * Supported allocation methods for distributing attribution among payloads.
 */
export const ATTRIBUTION_ALLOCATIONS = [
  'direct',
  'proportional',
  'equal',
  'context-weighted',
] as const;
export type AttributionAllocationMethod = (typeof ATTRIBUTION_ALLOCATIONS)[number];

/**
 * Result of a cost computation. Exact and estimated costs are kept separate.
 */
export interface CostBreakdown {
  readonly currency: string;
  readonly exactCost: number;
  readonly estimatedCost: number;
  readonly totalCost: number;
  readonly byTokenClass: readonly TokenClassCost[];
}

/**
 * Cost for a single token class. Exact and estimated values are never merged.
 */
export interface TokenClassCost {
  readonly tokenClass: ModelTokenClass;
  readonly exactTokens: number;
  readonly estimatedTokens: number;
  readonly exactCost: number;
  readonly estimatedCost: number;
  readonly unitCost: number | null;
  readonly isAvailable: boolean;
  readonly unavailableReason: string | null;
}

/**
 * A single usage entry for cost computation.
 */
export interface ModelUsageCostInput {
  readonly tokenClass: ModelTokenClass;
  readonly exactTokens: number;
  readonly estimatedTokens: number;
}

/**
 * A concurrent invocation window for attribution.
 */
export interface InvocationWindow {
  readonly invocationId: string;
  readonly sessionId: string;
  readonly generationId: string;
  readonly startTime: number;
  readonly endTime: number;
  readonly payloads: readonly InvocationPayloadCandidate[];
}

/**
 * A payload candidate inside an invocation window.
 */
export interface InvocationPayloadCandidate {
  readonly payloadId: string;
  readonly isInput: boolean;
  readonly isResult: boolean;
  readonly isContext: boolean;
  readonly exactTokens: number;
  readonly estimatedTokens: number;
}

/**
 * Attribution allocation result for one invocation-payload pair.
 */
export interface AttributionAllocation {
  readonly invocationId: string;
  readonly payloadId: string;
  readonly sessionId: string;
  readonly generationId: string;
  readonly attributionType: AttributionType;
  readonly attributionShare: number;
  readonly isInput: boolean;
  readonly isResult: boolean;
  readonly isContext: boolean;
}

/**
 * A validation issue returned by the model/pricing/attribution CI gate.
 */
export interface ModelPricingIssue {
  readonly code: string;
  readonly severity: 'error' | 'warning';
  readonly message: string;
  readonly entityId?: string;
}

/**
 * Result of the model/pricing/attribution CI gate.
 */
export interface ModelPricingValidationResult {
  readonly valid: boolean;
  readonly issues: readonly ModelPricingIssue[];
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isPositiveInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function priceForTokenClass(
  pricingVersion: PricingVersion,
  tokenClass: ModelTokenClass,
): number | null {
  switch (tokenClass) {
    case 'input':
      return pricingVersion.inputPricePerToken;
    case 'output':
      return pricingVersion.outputPricePerToken;
    case 'cache_creation':
      return pricingVersion.cacheCreationPricePerToken;
    case 'cache_read':
      return pricingVersion.cacheReadPricePerToken;
    default:
      return null;
  }
}

function attributionTypeFor(
  exactTokens: number,
  estimatedTokens: number,
): AttributionAllocation['attributionType'] {
  if (exactTokens > 0 && estimatedTokens > 0) return 'allocated';
  if (exactTokens > 0) return 'exact';
  if (estimatedTokens > 0) return 'estimated';
  return 'unavailable';
}

/**
 * Adds a model capability with versioned context limits and provider metadata.
 * Throws if the model/provider/version is already registered.
 */
export async function addModelCapability(
  queryable: Queryable,
  input: InsertModelCapabilityInput,
): Promise<ModelCapability> {
  if (!isNonEmptyString(input.model)) {
    throw new Error('Model capability model is required');
  }
  if (!isNonEmptyString(input.provider)) {
    throw new Error('Model capability provider is required');
  }
  if (!isNonEmptyString(input.version)) {
    throw new Error('Model capability version is required');
  }

  const existing = await ModelCapabilityStore.listByProvider(queryable, input.provider);
  const match = existing.find(
    (c) => c.model === input.model && c.provider === input.provider && c.version === input.version,
  );
  if (match) {
    throw new Error(
      `Model capability ${input.model} / ${input.provider} / ${input.version} already exists`,
    );
  }

  const id = await ModelCapabilityStore.insert(queryable, input);
  const capability = await ModelCapabilityStore.getById(queryable, id);
  if (!capability) {
    throw new Error(`Model capability was not stored`);
  }
  return capability;
}

/**
 * Adds a pricing version for provider/model/currency/effective-date token prices.
 * Throws if the same provider/model/currency/effective-date is already registered.
 */
export async function addPricingVersion(
  queryable: Queryable,
  input: InsertPricingVersionInput,
): Promise<PricingVersion> {
  if (!isNonEmptyString(input.provider)) {
    throw new Error('Pricing version provider is required');
  }
  if (!isNonEmptyString(input.model)) {
    throw new Error('Pricing version model is required');
  }
  if (!isNonEmptyString(input.currency)) {
    throw new Error('Pricing version currency is required');
  }
  if (!isNonEmptyString(input.effectiveDate)) {
    throw new Error('Pricing version effectiveDate is required');
  }

  const existing = await PricingVersionStore.listByProviderModel(
    queryable,
    input.provider,
    input.model,
  );
  const match = existing.find(
    (p) =>
      p.provider === input.provider &&
      p.model === input.model &&
      p.currency === input.currency &&
      p.effectiveDate === input.effectiveDate,
  );
  if (match) {
    throw new Error(
      `Pricing version ${input.provider} / ${input.model} / ${input.currency} / ${input.effectiveDate} already exists`,
    );
  }

  const id = await PricingVersionStore.insert(queryable, input);
  const version = await PricingVersionStore.getById(queryable, id);
  if (!version) {
    throw new Error(`Pricing version was not stored`);
  }
  return version;
}

/**
 * Finds the pricing version effective at a given ISO date. Returns the latest
 * version whose effectiveDate is on or before the request date.
 */
export async function findPricingVersionEffectiveAt(
  queryable: Queryable,
  provider: string,
  model: string,
  currency: string,
  atDate: string,
): Promise<PricingVersion | undefined> {
  const versions = await PricingVersionStore.listByProviderModel(queryable, provider, model);
  const matching = versions.filter((v) => v.currency === currency && v.effectiveDate <= atDate);
  if (matching.length === 0) return undefined;
  matching.sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));
  return matching[matching.length - 1];
}

/**
 * Computes cost for a set of token usage entries using the given pricing version.
 * Exact and estimated token values are never silently combined.
 */
export function computeCostForUsage(
  pricingVersion: PricingVersion,
  usage: readonly ModelUsageCostInput[],
): CostBreakdown {
  const hasComponents = usage.some((u) => u.tokenClass !== 'total' && u.tokenClass !== 'reasoning');

  const byTokenClass: TokenClassCost[] = [];
  let exactCost = 0;
  let estimatedCost = 0;

  for (const entry of usage) {
    const unitCost = priceForTokenClass(pricingVersion, entry.tokenClass);
    const isAvailable = unitCost !== null && (entry.tokenClass !== 'total' || !hasComponents);
    let reason: string | null = null;

    if (unitCost === null) {
      reason = `no price for token class ${entry.tokenClass}`;
    } else if (entry.tokenClass === 'total' && hasComponents) {
      reason = 'total redundant when component token classes are present';
    }

    if (entry.tokenClass === 'total' && !hasComponents) {
      // A standalone total cannot be costed exactly without a breakdown.
      byTokenClass.push({
        tokenClass: entry.tokenClass,
        exactTokens: entry.exactTokens,
        estimatedTokens: entry.estimatedTokens,
        exactCost: 0,
        estimatedCost: 0,
        unitCost: null,
        isAvailable: false,
        unavailableReason: 'total requires component token classes to compute cost',
      });
      continue;
    }

    const exactClassCost = isAvailable ? entry.exactTokens * unitCost : 0;
    const estimatedClassCost = isAvailable ? entry.estimatedTokens * unitCost : 0;

    if (isAvailable) {
      exactCost += exactClassCost;
      estimatedCost += estimatedClassCost;
    }

    byTokenClass.push({
      tokenClass: entry.tokenClass,
      exactTokens: entry.exactTokens,
      estimatedTokens: entry.estimatedTokens,
      exactCost: exactClassCost,
      estimatedCost: estimatedClassCost,
      unitCost,
      isAvailable,
      unavailableReason: reason,
    });
  }

  return {
    currency: pricingVersion.currency,
    exactCost,
    estimatedCost,
    totalCost: exactCost + estimatedCost,
    byTokenClass,
  };
}

/**
 * Validates and registers an attribution policy. The policy is versioned by
 * `policyId` and `version`. Window boundaries, overlap handling, allocation,
 * confidence, and additive status are all required.
 */
export async function registerAttributionPolicy(
  queryable: Queryable,
  input: InsertAttributionPolicyInput,
): Promise<AttributionPolicy> {
  if (!isNonEmptyString(input.policyId)) {
    throw new Error('Attribution policy policyId is required');
  }
  if (!isPositiveInteger(input.version)) {
    throw new Error('Attribution policy version must be a positive integer');
  }
  if (!isNonEmptyString(input.name)) {
    throw new Error('Attribution policy name is required');
  }
  if (!isNonEmptyString(input.windowBoundaries)) {
    throw new Error('Attribution policy windowBoundaries is required');
  }
  if (!isNonEmptyString(input.overlapHandling)) {
    throw new Error('Attribution policy overlapHandling is required');
  }
  if (
    !ATTRIBUTION_OVERLAP_HANDLINGS.includes(input.overlapHandling as AttributionOverlapHandling)
  ) {
    throw new Error(
      `Attribution policy overlapHandling must be one of ${ATTRIBUTION_OVERLAP_HANDLINGS.join(', ')}`,
    );
  }
  if (!isNonEmptyString(input.allocation)) {
    throw new Error('Attribution policy allocation is required');
  }
  if (!ATTRIBUTION_ALLOCATIONS.includes(input.allocation as AttributionAllocationMethod)) {
    throw new Error(
      `Attribution policy allocation must be one of ${ATTRIBUTION_ALLOCATIONS.join(', ')}`,
    );
  }

  const existing = await AttributionPolicyStore.getByPolicyIdAndVersion(
    queryable,
    input.policyId,
    input.version,
  );
  if (existing) {
    throw new Error(`Attribution policy ${input.policyId} version ${input.version} already exists`);
  }

  const id = await AttributionPolicyStore.insert(queryable, input);
  const policy = await AttributionPolicyStore.getById(queryable, id);
  if (!policy) {
    throw new Error(`Attribution policy was not stored`);
  }
  return policy;
}

function overlaps(a: InvocationWindow, b: InvocationWindow): boolean {
  return a.startTime < b.endTime && b.startTime < a.endTime;
}

function computeTotalTokens(payloads: readonly InvocationPayloadCandidate[]): number {
  return payloads.reduce((sum, p) => sum + p.exactTokens + p.estimatedTokens, 0);
}

function allocationWeight(
  payload: InvocationPayloadCandidate,
  payloads: readonly InvocationPayloadCandidate[],
  allocation: AttributionAllocationMethod,
  totalTokens: number,
  inputResultTokens: number,
): number {
  if (totalTokens === 0) {
    return payloads.length === 0 ? 0 : 1 / payloads.length;
  }
  switch (allocation) {
    case 'proportional':
      return (payload.exactTokens + payload.estimatedTokens) / totalTokens;
    case 'equal':
      return 1 / payloads.length;
    case 'context-weighted':
      if (payload.isContext) return 0;
      if (inputResultTokens === 0) return 1 / payloads.length;
      return (payload.exactTokens + payload.estimatedTokens) / inputResultTokens;
    default:
      if (payload.isInput || payload.isResult)
        return 1 / (payloads.filter((p) => p.isInput || p.isResult).length || 1);
      return 0;
  }
}

function findOverlapGroups(windows: readonly InvocationWindow[]): InvocationWindow[][] {
  const groups: InvocationWindow[][] = [];
  const remaining = [...windows];
  while (remaining.length > 0) {
    const group: InvocationWindow[] = [remaining[0]];
    remaining.splice(0, 1);
    let changed = true;
    while (changed) {
      changed = false;
      for (let i = remaining.length - 1; i >= 0; i--) {
        const candidate = remaining[i];
        if (group.some((g) => overlaps(g, candidate))) {
          group.push(candidate);
          remaining.splice(i, 1);
          changed = true;
        }
      }
    }
    groups.push(group);
  }
  return groups;
}

function windowDuration(window: InvocationWindow): number {
  return Math.max(0, window.endTime - window.startTime);
}

/**
 * Applies an attribution policy to a set of concurrent invocation windows.
 * Overlapping allocation remains non-additive unless the policy is additive or
 * overlap handling is 'partitioned'. Each result carries a non-additive
 * attribution share.
 */
export function applyAttributionPolicy(
  policy: AttributionPolicy,
  windows: readonly InvocationWindow[],
): readonly AttributionAllocation[] {
  const results: AttributionAllocation[] = [];
  const groups = findOverlapGroups(windows);

  for (const group of groups) {
    const additive = policy.additive || policy.overlapHandling === 'partitioned';
    const sorted = [...group].sort((a, b) => a.startTime - b.startTime);
    const unionStart = Math.min(...sorted.map((w) => w.startTime));
    const unionEnd = Math.max(...sorted.map((w) => w.endTime));
    const unionDuration = Math.max(0, unionEnd - unionStart);

    const shares: Record<string, number> = {};
    if (additive) {
      for (const window of sorted) {
        shares[window.invocationId] = 1;
      }
    } else {
      switch (policy.overlapHandling) {
        case 'first-wins':
        case 'exclusive':
          for (let i = 0; i < sorted.length; i++) {
            shares[sorted[i].invocationId] = i === 0 ? 1 : 0;
          }
          break;
        default: {
          const totalDuration = sorted.reduce((sum, w) => sum + windowDuration(w), 0);
          if (totalDuration === 0 || unionDuration === 0) {
            const perWindow = sorted.length === 0 ? 0 : 1 / sorted.length;
            for (const window of sorted) {
              shares[window.invocationId] = perWindow;
            }
          } else {
            for (const window of sorted) {
              shares[window.invocationId] = windowDuration(window) / totalDuration;
            }
          }
          break;
        }
      }
    }

    for (const window of sorted) {
      const invocationShare = shares[window.invocationId] ?? 0;
      const totalTokens = computeTotalTokens(window.payloads);
      const inputResultPayloads = window.payloads.filter((p) => p.isInput || p.isResult);
      const inputResultTokens = inputResultPayloads.reduce(
        (sum, p) => sum + p.exactTokens + p.estimatedTokens,
        0,
      );
      const allocation = policy.allocation as AttributionAllocationMethod;

      for (const payload of window.payloads) {
        const weight = allocationWeight(
          payload,
          window.payloads,
          allocation,
          totalTokens,
          inputResultTokens,
        );
        const payloadShare = invocationShare * weight;
        const attributionType = attributionTypeFor(payload.exactTokens, payload.estimatedTokens);

        results.push({
          invocationId: window.invocationId,
          payloadId: payload.payloadId,
          sessionId: window.sessionId,
          generationId: window.generationId,
          attributionType,
          attributionShare: payloadShare,
          isInput: payload.isInput,
          isResult: payload.isResult,
          isContext: payload.isContext,
        });
      }
    }
  }

  return results;
}

/**
 * Persists invocation payload attribution with non-additive metadata.
 * Exact and estimated token values are kept on the payload and never combined
 * silently.
 */
export async function addInvocationPayloadAttribution(
  queryable: Queryable,
  input: InsertInvocationPayloadInput,
): Promise<InvocationPayload> {
  if (!isNonEmptyString(input.invocationId)) {
    throw new Error('invocationId is required');
  }
  if (!isNonEmptyString(input.payloadId)) {
    throw new Error('payloadId is required');
  }
  if (!isNonEmptyString(input.sessionId)) {
    throw new Error('sessionId is required');
  }
  if (!isNonEmptyString(input.generationId)) {
    throw new Error('generationId is required');
  }
  if (!isNonEmptyString(input.attributionType)) {
    throw new Error('attributionType is required');
  }

  const existing = await InvocationPayloadStore.listByParent(queryable, input.invocationId);
  const duplicate = existing.find(
    (e) =>
      e.payloadId === input.payloadId &&
      e.attributionType === input.attributionType &&
      e.generationId === input.generationId,
  );
  if (duplicate) {
    throw new Error(
      `Invocation payload attribution for ${input.invocationId} / ${input.payloadId} / ${input.attributionType} already exists`,
    );
  }

  const id = await InvocationPayloadStore.insert(queryable, input);
  const record = await InvocationPayloadStore.getById(queryable, input.invocationId, id);
  if (!record) {
    throw new Error('Invocation payload attribution was not stored');
  }
  return record;
}

/**
 * CI gate: verifies that statistical, attribution, and rollup policies are
 * versioned and complete, and that model/pricing registries are valid.
 */
export async function validatePolicyRegistries(
  queryable: Queryable,
): Promise<ModelPricingValidationResult> {
  const issues: ModelPricingIssue[] = [];

  const metricValidation: MetricRegistryValidationResult = await validateMetricRegistry(queryable);
  for (const issue of metricValidation.issues) {
    issues.push({
      code: issue.code,
      severity: issue.severity,
      message: issue.message,
      entityId: issue.metricId ?? issue.policyId,
    });
  }

  const statisticalPolicies = await StatisticalPolicyStore.listAll(queryable);
  for (const policy of statisticalPolicies) {
    if (!isStatisticalPolicyComplete(policy)) {
      issues.push({
        code: 'incomplete_statistical_policy',
        severity: 'error',
        message: `Statistical policy ${policy.policyId} v${policy.version} is incomplete`,
        entityId: policy.policyId,
      });
    }
    if (policy.version <= 0) {
      issues.push({
        code: 'unversioned_statistical_policy',
        severity: 'error',
        message: `Statistical policy ${policy.policyId} has invalid version ${policy.version}`,
        entityId: policy.policyId,
      });
    }
  }

  const attributionPolicies = await AttributionPolicyStore.listAll(queryable);
  for (const policy of attributionPolicies) {
    if (!isAttributionPolicyComplete(policy)) {
      issues.push({
        code: 'incomplete_attribution_policy',
        severity: 'error',
        message: `Attribution policy ${policy.policyId} v${policy.version} is incomplete`,
        entityId: policy.policyId,
      });
    }
    if (policy.version <= 0) {
      issues.push({
        code: 'unversioned_attribution_policy',
        severity: 'error',
        message: `Attribution policy ${policy.policyId} has invalid version ${policy.version}`,
        entityId: policy.policyId,
      });
    }
    if (
      !ATTRIBUTION_OVERLAP_HANDLINGS.includes(policy.overlapHandling as AttributionOverlapHandling)
    ) {
      issues.push({
        code: 'unknown_overlap_handling',
        severity: 'error',
        message: `Attribution policy ${policy.policyId} has unknown overlapHandling ${policy.overlapHandling}`,
        entityId: policy.policyId,
      });
    }
    if (!ATTRIBUTION_ALLOCATIONS.includes(policy.allocation as AttributionAllocationMethod)) {
      issues.push({
        code: 'unknown_allocation_method',
        severity: 'error',
        message: `Attribution policy ${policy.policyId} has unknown allocation ${policy.allocation}`,
        entityId: policy.policyId,
      });
    }
  }

  const rollupPolicies = await RollupPolicyStore.listAll(queryable);
  for (const policy of rollupPolicies) {
    if (!isRollupPolicyComplete(policy)) {
      issues.push({
        code: 'incomplete_rollup_policy',
        severity: 'error',
        message: `Rollup policy ${policy.policyId} v${policy.version} is incomplete`,
        entityId: policy.policyId,
      });
    }
    if (policy.version <= 0) {
      issues.push({
        code: 'unversioned_rollup_policy',
        severity: 'error',
        message: `Rollup policy ${policy.policyId} has invalid version ${policy.version}`,
        entityId: policy.policyId,
      });
    }
  }

  const capabilities = await ModelCapabilityStore.listAll(queryable);
  for (const capability of capabilities) {
    if (!isNonEmptyString(capability.model)) {
      issues.push({
        code: 'incomplete_model_capability',
        severity: 'error',
        message: `Model capability ${capability.id} is missing a model`,
        entityId: capability.id,
      });
    }
    if (!isNonEmptyString(capability.provider)) {
      issues.push({
        code: 'incomplete_model_capability',
        severity: 'error',
        message: `Model capability ${capability.id} is missing a provider`,
        entityId: capability.id,
      });
    }
    if (!isNonEmptyString(capability.version)) {
      issues.push({
        code: 'incomplete_model_capability',
        severity: 'error',
        message: `Model capability ${capability.id} is missing a version`,
        entityId: capability.id,
      });
    }
  }

  const pricingVersions = await PricingVersionStore.listAll(queryable);
  for (const version of pricingVersions) {
    if (!isNonEmptyString(version.provider)) {
      issues.push({
        code: 'incomplete_pricing_version',
        severity: 'error',
        message: `Pricing version ${version.id} is missing a provider`,
        entityId: version.id,
      });
    }
    if (!isNonEmptyString(version.model)) {
      issues.push({
        code: 'incomplete_pricing_version',
        severity: 'error',
        message: `Pricing version ${version.id} is missing a model`,
        entityId: version.id,
      });
    }
    if (!isNonEmptyString(version.currency)) {
      issues.push({
        code: 'incomplete_pricing_version',
        severity: 'error',
        message: `Pricing version ${version.id} is missing a currency`,
        entityId: version.id,
      });
    }
    if (!isNonEmptyString(version.effectiveDate)) {
      issues.push({
        code: 'incomplete_pricing_version',
        severity: 'error',
        message: `Pricing version ${version.id} is missing an effectiveDate`,
        entityId: version.id,
      });
    }
  }

  return { valid: issues.length === 0, issues };
}
