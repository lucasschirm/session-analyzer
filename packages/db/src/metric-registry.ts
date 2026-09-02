import type {
  AttributionPolicy,
  InsertMetricDefinitionInput,
  InsertRollupPolicyInput,
  InsertStatisticalPolicyInput,
  MeasurementClass,
  MetricComparabilityInput,
  RollupPolicy,
  RootInclusion,
  SqliteExecutor,
  SqliteTransaction,
  StatisticalPolicy,
  StoredMetricDefinition,
  ValueType,
} from '@lucasschirm/sal-db-core';
import {
  AttributionPolicyStore,
  deriveMetricComparabilityGroupId,
  deterministicId,
  MetricDefinitionStore,
  RollupPolicyStore,
  StatisticalPolicyStore,
} from '@lucasschirm/sal-db-core';
import type { MetricValueDto } from './dto.js';

type Queryable = SqliteExecutor | SqliteTransaction;

const ADDITIVE_AGGREGATIONS = new Set(['sum', 'count', 'count_distinct']);

const PHASE1_FAMILIES = new Set([
  'tokens',
  'cost',
  'time',
  'session_shape',
  'invocations',
  'file_activity',
  'command_activity',
  'validation',
  'session_outcome',
]);

const PHASE2_FAMILIES = new Set([
  'context',
  'payload',
  'latency',
  'utilization',
  'lifecycle',
  'optimization',
  'active_time',
  'rule',
  'cohort',
]);

const PHASE3_FAMILIES = new Set([
  'attribution',
  'overlap',
  'critical_path',
  'pricing_registry',
  'model_registry',
]);

const FAMILY_EVIDENCE: Readonly<Record<string, readonly string[]>> = {
  tokens: ['model_usage event', 'token class field'],
  cost: ['model_usage event', 'pricing version'],
  time: ['event timestamps'],
  session_shape: ['turn events'],
  invocations: ['invocation records'],
  file_activity: ['file operation events'],
  command_activity: ['command execution events'],
  validation: ['validation events'],
  session_outcome: ['final native event(s) per harness', 'sessions.finality'],
};

interface PlannedMetricRecipe {
  readonly metricId: string;
  readonly version: number;
  readonly label: string;
  readonly description: string;
  readonly family: string;
  readonly measurementClass: MeasurementClass;
  readonly valueType: ValueType;
  readonly unit: string;
  readonly grain: string;
  readonly dimensions: readonly string[];
  readonly aggregation: string;
  readonly rootInclusion: RootInclusion;
  readonly phase: 'phase2' | 'phase3';
  readonly requiredEvidence: readonly string[];
  readonly releaseReadiness: 'blocked' | 'unavailable';
}

const PLANNED_INSIGHT_RECIPE_CATALOG: readonly PlannedMetricRecipe[] = [
  {
    metricId: 'insight:context_growth_rate',
    version: 1,
    label: 'Context growth rate',
    description: 'Tokens added per turn.',
    family: 'context',
    measurementClass: 'derived',
    valueType: 'real',
    unit: 'tokens_per_turn',
    grain: 'turn',
    dimensions: ['model'],
    aggregation: 'mean',
    rootInclusion: 'both',
    phase: 'phase2',
    requiredEvidence: ['context payload events', 'turn sequence'],
    releaseReadiness: 'blocked',
  },
  {
    metricId: 'insight:cache_efficiency',
    version: 1,
    label: 'Cache efficiency',
    description: 'Ratio of cache read tokens to total input tokens.',
    family: 'optimization',
    measurementClass: 'derived',
    valueType: 'ratio',
    unit: 'ratio',
    grain: 'session',
    dimensions: ['token_class'],
    aggregation: 'mean',
    rootInclusion: 'both',
    phase: 'phase2',
    requiredEvidence: ['cache read tokens', 'cache creation tokens', 'input tokens'],
    releaseReadiness: 'blocked',
  },
  {
    metricId: 'insight:tool_result_latency',
    version: 1,
    label: 'Tool result latency',
    description: 'Latency from tool start to result.',
    family: 'latency',
    measurementClass: 'derived',
    valueType: 'real',
    unit: 'ms',
    grain: 'invocation',
    dimensions: ['tool'],
    aggregation: 'percentile',
    rootInclusion: 'root_only',
    phase: 'phase2',
    requiredEvidence: ['invocation start/result timestamps'],
    releaseReadiness: 'blocked',
  },
  {
    metricId: 'insight:validation_rework_rate',
    version: 1,
    label: 'Validation rework rate',
    description: 'Rate of repeated validation cycles.',
    family: 'validation',
    measurementClass: 'derived',
    valueType: 'ratio',
    unit: 'percent',
    grain: 'session',
    dimensions: ['validation_type'],
    aggregation: 'mean',
    rootInclusion: 'both',
    phase: 'phase2',
    requiredEvidence: ['validation events', 'file operation events'],
    releaseReadiness: 'blocked',
  },
  {
    metricId: 'insight:subagent_critical_path',
    version: 1,
    label: 'Sub Agent critical path',
    description: 'Longest dependency-aware Sub Agent path.',
    family: 'attribution',
    measurementClass: 'derived',
    valueType: 'real',
    unit: 'ms',
    grain: 'session',
    dimensions: ['agent_id'],
    aggregation: 'max',
    rootInclusion: 'inclusive',
    phase: 'phase3',
    requiredEvidence: ['subagent launch/complete events', 'invocation timestamps'],
    releaseReadiness: 'blocked',
  },
  {
    metricId: 'insight:subagent_overlap',
    version: 1,
    label: 'Sub Agent overlap',
    description: 'Concurrent Sub Agent execution time.',
    family: 'overlap',
    measurementClass: 'derived',
    valueType: 'real',
    unit: 'ms',
    grain: 'session',
    dimensions: ['agent_id'],
    aggregation: 'sum',
    rootInclusion: 'inclusive',
    phase: 'phase3',
    requiredEvidence: ['subagent launch/complete events'],
    releaseReadiness: 'blocked',
  },
  {
    metricId: 'insight:event_attribution_window',
    version: 1,
    label: 'Event attribution window',
    description: 'Attributed context contribution per event.',
    family: 'attribution',
    measurementClass: 'estimated',
    valueType: 'real',
    unit: 'tokens',
    grain: 'invocation',
    dimensions: ['tool'],
    aggregation: 'sum',
    rootInclusion: 'both',
    phase: 'phase3',
    requiredEvidence: ['invocation_payload records', 'context retention policy'],
    releaseReadiness: 'blocked',
  },
];

export const SESSION_OUTCOME_METRIC_ID = 'session:outcome';
export const SESSION_OUTCOME_METRIC_VERSION = 1;

/**
 * Session outcome metric (issue #178) — id `session:outcome`, version 1.
 *
 * - **Population**: sessions with `finality = 'final'` only. Open and
 *   censored sessions are excluded from the population entirely (they are
 *   not "missing outcome", they are not yet in scope — a session cannot
 *   have ended cleanly, on error, or by interruption while still open).
 *   `populationRule` records this exactly so a comparability check can
 *   detect a mismatched population without re-deriving it.
 * - **Missingness policy**: within the final-session population,
 *   `sessions.outcome IS NULL` (unreadable tail / not classifiable) is
 *   `missingDataBehavior: 'unknown'` — counted in the sample size, never
 *   folded into any of the three real outcome buckets or dropped
 *   (`.agents/rules/missing-is-never-zero.md`). Consumers read
 *   `SessionOutcomeStore.rollupByProject` (db-core) and report
 *   `eligibleN` = sum of all rows' counts, `knownN` = sum of rows whose
 *   `outcome` is not `null`, `unknownCount` = the `null` row's count —
 *   the exact `AnalyticsToken` shape (`packages/db/src/dto.ts`) so the
 *   coverage breakdown (n classified / n missing) required by sub-issue
 *   #169's DTO consumers is available without re-deriving it there.
 * - **Reprocessing / backfill policy**: sessions ingested before this
 *   column existed have `outcome = NULL` until they are reprocessed
 *   through the standard replacement-generation path
 *   (`packages/db/src/reprocessing.ts`), which re-runs the transformer and
 *   overwrites `sessions.outcome` with a freshly classified value (or
 *   leaves it `NULL` if still not classifiable). No separate backfill job
 *   exists or is required: outcome is derived fresh on every generation,
 *   so the standard reprocessing sweep is sufficient. Until a given
 *   session is reprocessed, its outcome is honestly reported missing, not
 *   guessed or defaulted.
 * - **Storage, deliberately not `metric_values`**: unlike the transformer's
 *   other metrics (`TransformResult.metricValues[]`, auto-registered by
 *   `DefaultIngestionOrchestrator.upsertMetricDefinitions`), `outcome` is a
 *   categorical session fact stored directly on the `sessions.outcome`
 *   column (`packages/db-core` migration v81) and read through
 *   `SessionOutcomeStore.rollupByProject` / `getSessionOutcomeDistribution`
 *   — not through `MetricDefinitionStore`/`metric_values`. This constant is
 *   therefore registry *documentation* of that column's meaning, version,
 *   and policy (what this issue asked for), not a row that
 *   `upsertMetricDefinitions` inserts automatically. `statisticalPolicyId:
 *   'claude-default'` is the same **symbolic policy id** convention
 *   `TransformResult.metricValues[].definition.statisticalPolicyId` and
 *   `DefaultIngestionOrchestrator.ensureStatisticalPolicyFor` use — not a
 *   resolved `StatisticalPolicyStore` row id. To register this definition
 *   through the strict `addMetricDefinition` registry path (as opposed to
 *   `upsertMetricDefinitions`'s auto-create-on-first-value path), resolve
 *   the symbolic id to a real policy id first, exactly as
 *   `packages/db/tests/unit/metric-registry-session-outcome.test.ts` does.
 */
export const SESSION_OUTCOME_METRIC_DEFINITION: InsertMetricDefinitionInput = {
  metricId: SESSION_OUTCOME_METRIC_ID,
  version: SESSION_OUTCOME_METRIC_VERSION,
  label: 'Session outcome',
  description:
    'Per-session classification of the final native event(s) into clean, ' +
    'interrupted-by-user, or ended-on-error, scoped to finalized sessions.',
  family: 'session_outcome',
  measurementClass: 'observed',
  unit: 'count',
  valueType: 'text',
  grain: 'session',
  dimensions: ['outcome'],
  populationRule: "finality = 'final'",
  statusRule: 'committed',
  aggregation: 'distribution',
  statisticalPolicyId: 'claude-default',
  comparabilityGroupInputs: [],
  missingDataBehavior: 'unknown',
  rootInclusion: 'root_only',
  provenanceRequirement: 'final native event(s) per harness',
};

export const PORTFOLIO_SESSIONS_DELTA_METRIC_ID = 'portfolio:sessions_delta';
export const PORTFOLIO_SESSIONS_DELTA_METRIC_VERSION = 1;

/**
 * Portfolio KPI-band sessions period-over-period delta (issue #169) — id
 * `portfolio:sessions_delta`, version 1. Implemented:
 * `PortfolioView.getKpiBand` / `getKpiBand` in `analytics-portfolio.ts`.
 *
 * - **Population**: sessions with a non-null `start_time` inside the query
 *   window (`AnalyticsQuery.timeRange`). Sessions with no `start_time` are
 *   excluded from both windows' counts, never coerced into either bucket.
 * - **Missingness policy**: the "All" time preset has no `start` bound, so
 *   there is no equal-length previous window to compare against —
 *   `resolvePreviousWindow` returns `undefined` and the delta fields
 *   (`PeriodDelta.previous`/`previousN`) are omitted entirely, never a
 *   fabricated `0`/`0%` (`.agents/rules/missing-is-never-zero.md`). Covered
 *   by `packages/db/tests/unit/analytics-datasource-169.test.ts`.
 * - **Comparability**: both windows are equal-length (millisecond-epoch
 *   arithmetic, DST/short-month safe) and read the same metric version.
 */
export const PORTFOLIO_SESSIONS_DELTA_METRIC_DEFINITION: InsertMetricDefinitionInput = {
  metricId: PORTFOLIO_SESSIONS_DELTA_METRIC_ID,
  version: PORTFOLIO_SESSIONS_DELTA_METRIC_VERSION,
  label: 'Portfolio sessions period-over-period delta',
  description: 'Session count in the query window compared to the equal-length prior window.',
  family: 'session_shape',
  measurementClass: 'derived',
  unit: 'count',
  valueType: 'integer',
  grain: 'portfolio',
  dimensions: [],
  populationRule: 'start_time IS NOT NULL AND start_time IN [window.start, window.end)',
  statusRule: 'committed',
  aggregation: 'count',
  statisticalPolicyId: 'claude-default',
  comparabilityGroupInputs: [],
  missingDataBehavior: 'unknown',
  rootInclusion: 'both',
  provenanceRequirement: 'sessions.start_time',
};

export const INVOCATIONS_BY_DOMAIN_METRIC_ID = 'portfolio:invocations_by_domain';
export const INVOCATIONS_BY_DOMAIN_METRIC_VERSION = 1;

/**
 * Portfolio invocations-by-domain metric (issue #169) — id
 * `portfolio:invocations_by_domain`, version 1. **Registry documentation
 * only as of this issue**: the query surface
 * (`PortfolioView`/`ComponentEcosystemView`) is not wired up yet — see the
 * issue #169 implementation report's deviations section. Recorded now so
 * the domain rule and dimensions are fixed before any query is built.
 *
 * - **Population**: every row in `invocations` (`INVOCATION_KINDS` =
 *   `tool | skill | agent | sub_agent` in
 *   `packages/db-core/src/session-evidence.ts`) — exactly four canonical
 *   domains, never five.
 * - **MCP sub-classification rule** (`.agents/rules/analytics-domain-
 *   distinctions.md`): an MCP-server invocation is stored as `kind =
 *   'tool'` with a `component_identities.kind = 'mcp_server'` component. It
 *   is counted once, inside the `tool` bucket. A consumer that wants the
 *   MCP subset filters `tool` invocations by component kind — it must
 *   never be added as a fifth chart series, and doing so would double-count
 *   against the `tool` total.
 *
 * Query surface: `PortfolioView.getInvocationsByDomain` /
 * `getInvocationsByDomain` in `analytics-portfolio.ts`, backed by
 * `PortfolioKpiStore.getInvocationsByDomainInWindow` (db-core). Covered by
 * `packages/db/tests/unit/analytics-portfolio-169-round2.test.ts` including
 * an explicit `sum(byKind) === totalInvocations` assertion with a
 * `mcp_server`-classified `tool` invocation in the fixture.
 */
export const INVOCATIONS_BY_DOMAIN_METRIC_DEFINITION: InsertMetricDefinitionInput = {
  metricId: INVOCATIONS_BY_DOMAIN_METRIC_ID,
  version: INVOCATIONS_BY_DOMAIN_METRIC_VERSION,
  label: 'Invocations by component domain',
  description:
    'Count of invocations grouped by the four canonical kinds (tool, skill, agent, ' +
    'sub_agent); MCP-server calls are a sub-classification within tool, not a fifth domain.',
  family: 'invocations',
  measurementClass: 'observed',
  unit: 'count',
  valueType: 'integer',
  grain: 'invocation',
  dimensions: ['kind'],
  populationRule: 'true',
  statusRule: 'committed',
  aggregation: 'count',
  statisticalPolicyId: 'claude-default',
  comparabilityGroupInputs: [],
  missingDataBehavior: 'unknown',
  rootInclusion: 'both',
  provenanceRequirement: 'invocations.kind',
};

export const PORTFOLIO_CLEAN_COMPLETION_RATE_METRIC_ID = 'portfolio:clean_completion_rate';
export const PORTFOLIO_CLEAN_COMPLETION_RATE_METRIC_VERSION = 1;

/**
 * Portfolio clean-completion rate (issue #169) — id
 * `portfolio:clean_completion_rate`, version 1. Implemented:
 * `PortfolioView.getKpiBand` (`cleanCompletionRate` field) in
 * `analytics-portfolio.ts`, backed by
 * `PortfolioKpiStore.getCleanCompletionInWindow` (db-core).
 *
 * - **Formula**: `cleanN / knownN`, where `cleanN` is sessions with
 *   `outcome = 'clean'` and `knownN` is sessions with any non-null
 *   `outcome` (reusing the `session:outcome` classification from
 *   `classifyClaudeCodeOutcome` / `SESSION_OUTCOME_METRIC_DEFINITION` —
 *   this metric does not reclassify outcomes, it only aggregates the
 *   existing per-session signal).
 * - **Population**: sessions with `finality = 'final'` and a non-null
 *   `start_time` inside the query window (`eligibleN`).
 * - **Denominator**: `knownN` (the classified subset of `eligibleN`), not
 *   `eligibleN` — the unclassified "unreadable tail" bucket is excluded
 *   from the rate rather than counted as a failure or a success.
 * - **Missingness policy**: `value` is `null`, never `0`, when `knownN` is
 *   0 (no classified outcome observed in the window) —
 *   `.agents/rules/missing-is-never-zero.md`.
 */
export const PORTFOLIO_CLEAN_COMPLETION_RATE_METRIC_DEFINITION: InsertMetricDefinitionInput = {
  metricId: PORTFOLIO_CLEAN_COMPLETION_RATE_METRIC_ID,
  version: PORTFOLIO_CLEAN_COMPLETION_RATE_METRIC_VERSION,
  label: 'Portfolio clean-completion rate',
  description:
    'Share of finalized sessions in the query window classified with a clean outcome, ' +
    'among sessions with a known (classified) outcome.',
  family: 'session_outcome',
  measurementClass: 'derived',
  unit: 'ratio',
  valueType: 'real',
  grain: 'portfolio',
  dimensions: [],
  populationRule:
    "finality = 'final' AND start_time IS NOT NULL AND start_time IN [window.start, window.end)",
  statusRule: 'committed',
  aggregation: 'distribution',
  statisticalPolicyId: 'claude-default',
  comparabilityGroupInputs: [],
  missingDataBehavior: 'unknown',
  rootInclusion: 'root_only',
  provenanceRequirement: 'sessions.outcome',
};

/**
 * Low-sample-size flag threshold for model×harness cohort rows (issue
 * #169): a cohort with fewer than this many sessions is flagged low-n by
 * consumers rather than treated as a statistically reliable comparison
 * point. Centralized here (not in the UI) per
 * `.agents/rules/aggregates-expose-sample-size.md`.
 */
export const MODEL_HARNESS_COHORT_LOW_N_THRESHOLD = 5;

/**
 * Session-duration histogram bin edges, in milliseconds (issue #169).
 * Defined in the registry, not the UI, so the binning policy is versioned
 * alongside the metric it backs. `SESSION_DURATION_HISTOGRAM_BIN_EDGES_MS`
 * has `n` edges producing `n - 1` bins; the last bin is open-ended (">= last
 * edge"). Query implementation is tracked as a follow-up — see the issue
 * #169 report.
 */
export const SESSION_DURATION_HISTOGRAM_BIN_EDGES_MS = [
  0,
  60_000,
  5 * 60_000,
  15 * 60_000,
  30 * 60_000,
  60 * 60_000,
  2 * 60 * 60_000,
] as const;

function buildPlannedMetricDefinitionInput(
  recipe: PlannedMetricRecipe,
): InsertMetricDefinitionInput {
  return {
    metricId: recipe.metricId,
    version: recipe.version,
    label: recipe.label,
    description: recipe.description,
    family: recipe.family,
    measurementClass: recipe.measurementClass,
    unit: recipe.unit,
    valueType: recipe.valueType,
    grain: recipe.grain,
    dimensions: recipe.dimensions,
    populationRule: 'planned',
    statusRule: 'planned',
    aggregation: recipe.aggregation,
    statisticalPolicyId: 'planned',
    attributionPolicyId: null,
    comparabilityGroupInputs: [],
    missingDataBehavior: 'unknown',
    rootInclusion: recipe.rootInclusion,
    provenanceRequirement: recipe.requiredEvidence[0] ?? 'source_artifact_event_field',
  };
}

export type MetricRegistryIssueSeverity = 'error' | 'warning';

export interface MetricRegistryIssue {
  readonly code: string;
  readonly severity: MetricRegistryIssueSeverity;
  readonly message: string;
  readonly metricId?: string;
  readonly version?: number;
  readonly policyId?: string;
}

export interface MetricRegistryValidationResult {
  readonly valid: boolean;
  readonly issues: readonly MetricRegistryIssue[];
}

export type MetricReleaseReadiness = 'ready' | 'partial' | 'blocked' | 'unavailable';

export type MetricPhase = 'phase1' | 'phase2' | 'phase3' | 'insight';

export interface MetricReleaseMatrixRow {
  readonly metricId: string;
  readonly version: number;
  readonly label: string;
  readonly family: string;
  readonly phase: MetricPhase;
  readonly requiredEvidence: readonly string[];
  readonly measurementClass: string;
  readonly valueType: string;
  readonly unit: string;
  readonly grain: string;
  readonly aggregation: string;
  readonly additive: boolean;
  readonly capabilityGate: string;
  readonly statisticalPolicyId: string;
  readonly attributionPolicyId: string | null;
  readonly rollupPolicyId: string | null;
  readonly releaseReadiness: MetricReleaseReadiness;
  readonly comparabilityGroupId: string;
}

export interface MetricDefinitionReference extends InsertMetricDefinitionInput {}

export interface MetricRegistryReference {
  readonly checksum: string;
  readonly definitionChecksums: Readonly<Record<string, string>>;
  readonly definitions: readonly MetricDefinitionReference[];
}

export interface HeadlineStratum {
  readonly stratumKey: string;
  readonly comparabilityGroupId: string;
  readonly metricId: string;
  readonly version: number;
  readonly label: string;
  readonly value: number | null;
  readonly unit: string;
  readonly sourceDescription: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function sortedKeys<T extends Record<string, unknown>>(value: T): string[] {
  return Object.keys(value).sort();
}

function stableSerialize(value: unknown): string {
  if (value === null || value === undefined) {
    return 'null';
  }
  const type = typeof value;
  if (type === 'string' || type === 'number' || type === 'boolean' || type === 'bigint') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = sortedKeys(record);
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
      .join(',')}}`;
  }
  return String(value);
}

function meaningFieldsFor(definition: MetricDefinitionShape): Record<string, unknown> {
  return {
    metricId: definition.metricId,
    version: definition.version,
    family: definition.family,
    measurementClass: definition.measurementClass,
    unit: definition.unit,
    valueType: definition.valueType,
    grain: definition.grain,
    dimensions: definition.dimensions,
    denominator: definition.denominator ?? null,
    populationRule: definition.populationRule,
    statusRule: definition.statusRule,
    aggregation: definition.aggregation,
    allocationMethod: definition.allocationMethod ?? null,
    statisticalPolicyId: definition.statisticalPolicyId,
    attributionPolicyId: definition.attributionPolicyId ?? null,
    missingDataBehavior: definition.missingDataBehavior,
    rootInclusion: definition.rootInclusion,
    distributionPolicy: definition.distributionPolicy ?? null,
    provenanceRequirement: definition.provenanceRequirement,
  };
}

type MetricDefinitionShape = InsertMetricDefinitionInput | StoredMetricDefinition;

function coreMeaningFieldsFor(definition: MetricDefinitionShape): Record<string, unknown> {
  const { version: _version, ...core } = meaningFieldsFor(definition);
  return core;
}

function metricDefinitionMeaningKey(definition: MetricDefinitionShape): string {
  return stableSerialize(coreMeaningFieldsFor(definition));
}

export function computeMetricDefinitionChecksum(definition: MetricDefinitionShape): string {
  const meaning = meaningFieldsFor(definition);
  const documentation = {
    label: definition.label,
    description: definition.description,
  };
  const canonical = stableSerialize({ ...documentation, ...meaning });
  return deterministicId('metric-definition-checksum', canonical);
}

export function generateMetricRegistryReference(
  definitions: readonly MetricDefinitionReference[],
): MetricRegistryReference {
  const definitionChecksums: Record<string, string> = {};
  for (const definition of definitions) {
    const key = `${definition.metricId}@v${definition.version}`;
    definitionChecksums[key] = computeMetricDefinitionChecksum(definition);
  }
  const orderedKeys = sortedKeys(definitionChecksums);
  const overall = deterministicId(
    'metric-registry-reference',
    ...orderedKeys.map((key) => `${key}=${definitionChecksums[key]}`),
  );
  return {
    checksum: overall,
    definitionChecksums,
    definitions: [...definitions].sort((a, b) => {
      if (a.metricId !== b.metricId) return a.metricId.localeCompare(b.metricId);
      return a.version - b.version;
    }),
  };
}

function isAdditiveAggregation(aggregation: string): boolean {
  return ADDITIVE_AGGREGATIONS.has(aggregation);
}

function classifyMetricPhase(family: string): MetricPhase {
  if (PHASE1_FAMILIES.has(family)) return 'phase1';
  if (PHASE2_FAMILIES.has(family)) return 'phase2';
  if (PHASE3_FAMILIES.has(family)) return 'phase3';
  return 'insight';
}

function requiredEvidenceFor(definition: MetricDefinitionShape): readonly string[] {
  const base = [definition.provenanceRequirement];
  const extra = FAMILY_EVIDENCE[definition.family] ?? [];
  return [...base, ...extra];
}

function parseJsonList(value: string): readonly string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed as string[];
  } catch {
    // fall through
  }
  return [];
}

export function isStatisticalPolicyComplete(policy: StatisticalPolicy): boolean {
  return (
    isNonEmptyString(policy.policyId) &&
    policy.version > 0 &&
    isNonEmptyString(policy.name) &&
    isNonEmptyString(policy.observationUnit) &&
    isNonEmptyString(policy.eligibility) &&
    isNonEmptyString(policy.microWeighting) &&
    isNonEmptyString(policy.macroWeighting) &&
    isNonEmptyString(policy.percentileAlgorithm) &&
    policy.percentileMinimumN !== null &&
    policy.percentileMinimumN >= 0 &&
    isNonEmptyString(policy.ratioPolicy) &&
    isNonEmptyString(policy.censoring) &&
    isNonEmptyString(policy.outlierPolicy) &&
    isNonEmptyString(policy.uncertainty) &&
    isNonEmptyString(policy.timezone) &&
    isNonEmptyString(policy.dayBoundary) &&
    isNonEmptyString(policy.matching) &&
    isNonEmptyString(policy.coverage) &&
    isNonEmptyString(policy.insightSuppression)
  );
}

export function isAttributionPolicyComplete(policy: AttributionPolicy | undefined | null): boolean {
  if (!policy) return false;
  return (
    isNonEmptyString(policy.policyId) &&
    policy.version > 0 &&
    isNonEmptyString(policy.name) &&
    isNonEmptyString(policy.windowBoundaries) &&
    isNonEmptyString(policy.overlapHandling) &&
    isNonEmptyString(policy.allocation)
  );
}

export function isRollupPolicyComplete(policy: RollupPolicy): boolean {
  if (!policy) return false;
  const supported = parseJsonList(policy.supportedDimensions);
  return (
    isNonEmptyString(policy.policyId) &&
    policy.version > 0 &&
    isNonEmptyString(policy.name) &&
    supported.length > 0 &&
    isNonEmptyString(policy.topNBehavior) &&
    isNonEmptyString(policy.otherBucketLabel) &&
    isNonEmptyString(policy.unknownBucketLabel) &&
    isNonEmptyString(policy.bucketTimezone) &&
    isNonEmptyString(policy.analysisReleaseId)
  );
}

export function deriveComparabilityGroupIdForDefinition(definition: MetricDefinitionShape): string {
  const input: MetricComparabilityInput = {
    metricId: definition.metricId,
    version: definition.version,
    unit: definition.unit,
    valueType: definition.valueType,
    grain: definition.grain,
    dimensions: definition.dimensions,
    denominator: definition.denominator ?? null,
    populationRule: definition.populationRule,
    statusRule: definition.statusRule,
    aggregation: definition.aggregation,
    allocationMethod: definition.allocationMethod ?? null,
    statisticalPolicyId: definition.statisticalPolicyId,
    attributionPolicyId: definition.attributionPolicyId ?? null,
    missingDataBehavior: definition.missingDataBehavior,
    rootInclusion: definition.rootInclusion,
    distributionPolicy: definition.distributionPolicy ?? null,
    valueClass: null,
  };
  return deriveMetricComparabilityGroupId(input);
}

function releaseReadinessFor(
  definition: MetricDefinitionShape,
  statisticalPolicy: StatisticalPolicy | undefined,
  attributionPolicy: AttributionPolicy | undefined | null,
  rollupPolicy: RollupPolicy | undefined,
): MetricReleaseReadiness {
  if (definition.missingDataBehavior === 'not_applicable') {
    return 'unavailable';
  }
  if (definition.measurementClass === 'heuristic') {
    return 'blocked';
  }
  if (!statisticalPolicy || !isStatisticalPolicyComplete(statisticalPolicy)) {
    return 'blocked';
  }
  if (definition.attributionPolicyId && !isAttributionPolicyComplete(attributionPolicy)) {
    return 'blocked';
  }
  if (definition.allocationMethod && !isAttributionPolicyComplete(attributionPolicy)) {
    return 'blocked';
  }
  if (['percentile', 'distribution', 'non-additive'].includes(definition.aggregation)) {
    if (!rollupPolicy || !isRollupPolicyComplete(rollupPolicy)) {
      return 'blocked';
    }
  }
  if (definition.measurementClass === 'observed' && isAdditiveAggregation(definition.aggregation)) {
    return 'ready';
  }
  if (definition.measurementClass === 'derived' || definition.measurementClass === 'estimated') {
    return 'partial';
  }
  return 'ready';
}

function capabilityGateFor(definition: MetricDefinitionShape): string {
  const parts = [definition.measurementClass, definition.aggregation];
  if (definition.rootInclusion !== 'not_applicable') {
    parts.push(definition.rootInclusion);
  }
  if (definition.allocationMethod) {
    parts.push(definition.allocationMethod);
  }
  return parts.join(':');
}

async function resolveRollupPolicy(
  queryable: Queryable,
  rollupPolicyId: string | undefined,
): Promise<RollupPolicy | undefined> {
  if (rollupPolicyId) {
    return RollupPolicyStore.getById(queryable, rollupPolicyId);
  }
  const all = await RollupPolicyStore.listAll(queryable);
  return all[0];
}

function validateDefinitionInput(
  input: InsertMetricDefinitionInput,
): readonly MetricRegistryIssue[] {
  const issues: MetricRegistryIssue[] = [];
  const requiredFields: (keyof InsertMetricDefinitionInput)[] = [
    'metricId',
    'version',
    'label',
    'description',
    'family',
    'measurementClass',
    'unit',
    'valueType',
    'grain',
    'dimensions',
    'populationRule',
    'statusRule',
    'aggregation',
    'statisticalPolicyId',
    'comparabilityGroupInputs',
    'missingDataBehavior',
    'rootInclusion',
    'provenanceRequirement',
  ];
  for (const field of requiredFields) {
    const value = input[field];
    if (value === undefined || value === null || (typeof value === 'string' && value === '')) {
      issues.push({
        code: 'missing_required_metadata',
        severity: 'error',
        message: `Definition is missing required field ${field}`,
        metricId: input.metricId,
        version: input.version,
      });
    }
  }
  if (input.version <= 0) {
    issues.push({
      code: 'invalid_version',
      severity: 'error',
      message: 'Definition version must be greater than 0',
      metricId: input.metricId,
      version: input.version,
    });
  }
  if (!Array.isArray(input.dimensions)) {
    issues.push({
      code: 'invalid_dimensions',
      severity: 'error',
      message: 'Dimensions must be an array',
      metricId: input.metricId,
      version: input.version,
    });
  }
  if (!Array.isArray(input.comparabilityGroupInputs)) {
    issues.push({
      code: 'invalid_comparability_group_inputs',
      severity: 'error',
      message: 'comparabilityGroupInputs must be an array',
      metricId: input.metricId,
      version: input.version,
    });
  }
  return issues;
}

export async function addStatisticalPolicy(
  queryable: Queryable,
  input: InsertStatisticalPolicyInput,
): Promise<string> {
  const policy: StatisticalPolicy = {
    id: input.id ?? '',
    policyId: input.policyId,
    version: input.version,
    name: input.name,
    description: input.description ?? null,
    observationUnit: input.observationUnit,
    eligibility: input.eligibility,
    microWeighting: input.microWeighting ?? null,
    macroWeighting: input.macroWeighting ?? null,
    percentileAlgorithm: input.percentileAlgorithm ?? null,
    percentileMinimumN: input.percentileMinimumN ?? null,
    ratioPolicy: input.ratioPolicy ?? null,
    censoring: input.censoring ?? null,
    outlierPolicy: input.outlierPolicy ?? null,
    uncertainty: input.uncertainty ?? null,
    timezone: input.timezone ?? null,
    dayBoundary: input.dayBoundary ?? null,
    matching: input.matching ?? null,
    coverage: input.coverage ?? null,
    insightSuppression: input.insightSuppression ?? null,
    createdAt: input.createdAt ?? 0,
    updatedAt: input.updatedAt ?? 0,
  };
  if (!isStatisticalPolicyComplete(policy)) {
    throw new Error(`Statistical policy ${input.policyId} v${input.version} is incomplete`);
  }
  const existing = await StatisticalPolicyStore.getByPolicyIdAndVersion(
    queryable,
    input.policyId,
    input.version,
  );
  if (existing) {
    throw new Error(`Statistical policy ${input.policyId} version ${input.version} already exists`);
  }
  return StatisticalPolicyStore.insert(queryable, input);
}

export async function addAttributionPolicy(
  queryable: Queryable,
  input: Parameters<typeof AttributionPolicyStore.insert>[1],
): Promise<string> {
  const existing = await AttributionPolicyStore.getByPolicyIdAndVersion(
    queryable,
    input.policyId,
    input.version,
  );
  if (existing) {
    throw new Error(`Attribution policy ${input.policyId} version ${input.version} already exists`);
  }
  return AttributionPolicyStore.insert(queryable, input);
}

export async function addRollupPolicy(
  queryable: Queryable,
  input: InsertRollupPolicyInput,
): Promise<string> {
  const existing = await RollupPolicyStore.getByPolicyIdAndVersion(
    queryable,
    input.policyId,
    input.version,
  );
  if (existing) {
    throw new Error(`Rollup policy ${input.policyId} version ${input.version} already exists`);
  }
  const policy: RollupPolicy = {
    id: input.id ?? '',
    policyId: input.policyId,
    version: input.version,
    name: input.name,
    description: input.description ?? null,
    supportedDimensions: input.supportedDimensions,
    cardinalityCaps: input.cardinalityCaps,
    topNBehavior: input.topNBehavior,
    otherBucketLabel: input.otherBucketLabel ?? 'Other',
    unknownBucketLabel: input.unknownBucketLabel ?? 'Unknown',
    bucketTimezone: input.bucketTimezone ?? 'UTC',
    analysisReleaseId: input.analysisReleaseId,
    createdAt: input.createdAt ?? 0,
    updatedAt: input.updatedAt ?? 0,
  };
  if (!isRollupPolicyComplete(policy)) {
    throw new Error(`Rollup policy ${input.policyId} v${input.version} is incomplete`);
  }
  return RollupPolicyStore.insert(queryable, input);
}

export interface AddMetricDefinitionResult {
  readonly definition: StoredMetricDefinition;
  readonly comparabilityGroupId: string;
}

export async function addMetricDefinition(
  queryable: Queryable,
  input: InsertMetricDefinitionInput,
): Promise<AddMetricDefinitionResult> {
  const validationIssues = validateDefinitionInput(input);
  if (validationIssues.length > 0) {
    throw new Error(`Metric definition validation failed: ${validationIssues[0].message}`);
  }
  const existing = await MetricDefinitionStore.getByMetricIdAndVersion(
    queryable,
    input.metricId,
    input.version,
  );
  if (existing) {
    throw new Error(`Metric ${input.metricId} version ${input.version} already exists`);
  }
  const statisticalPolicy = await StatisticalPolicyStore.getById(
    queryable,
    input.statisticalPolicyId,
  );
  if (!statisticalPolicy) {
    throw new Error(`Statistical policy ${input.statisticalPolicyId} not found`);
  }
  if (input.attributionPolicyId) {
    const attributionPolicy = await AttributionPolicyStore.getById(
      queryable,
      input.attributionPolicyId,
    );
    if (!attributionPolicy) {
      throw new Error(`Attribution policy ${input.attributionPolicyId} not found`);
    }
  }
  const sameVersionDefinitions: StoredMetricDefinition[] = [];
  const allDefinitions = await queryDefinitions(queryable);
  for (const def of allDefinitions) {
    if (def.metricId === input.metricId) {
      sameVersionDefinitions.push(def);
    }
  }
  for (const def of sameVersionDefinitions) {
    if (def.version >= input.version) {
      throw new Error(
        `Metric ${input.metricId} version ${input.version} must be greater than existing versions`,
      );
    }
  }
  if (sameVersionDefinitions.length > 0) {
    const latest = sameVersionDefinitions.reduce((a, b) => (a.version > b.version ? a : b));
    if (metricDefinitionMeaningKey(input) === metricDefinitionMeaningKey(latest)) {
      throw new Error(
        `Metric ${input.metricId} meaning is unchanged; use updateMetricDocumentation for label-only edits`,
      );
    }
  }
  const id = await MetricDefinitionStore.insert(queryable, input);
  const definition = await MetricDefinitionStore.getById(queryable, id);
  if (!definition) {
    throw new Error(`Metric definition was not stored`);
  }
  return { definition, comparabilityGroupId: definition.comparabilityGroupId };
}

export async function updateMetricDocumentation(
  queryable: Queryable,
  definitionId: string,
  label: string,
  description: string,
): Promise<StoredMetricDefinition> {
  const existing = await MetricDefinitionStore.getById(queryable, definitionId);
  if (!existing) {
    throw new Error(`Metric definition ${definitionId} not found`);
  }
  await MetricDefinitionStore.update(queryable, definitionId, { label, description });
  const updated = await MetricDefinitionStore.getById(queryable, definitionId);
  if (!updated) {
    throw new Error(`Metric definition ${definitionId} not found after update`);
  }
  return updated;
}

async function queryDefinitions(queryable: Queryable): Promise<readonly StoredMetricDefinition[]> {
  const { rows } = await queryable.exec(
    'SELECT DISTINCT family FROM metric_definitions ORDER BY family',
  );
  const definitions: StoredMetricDefinition[] = [];
  for (const row of rows) {
    const family = String(row.family);
    const familyDefs = await MetricDefinitionStore.listByFamily(queryable, family);
    definitions.push(...familyDefs);
  }
  return definitions;
}

async function findMixedGroups(
  queryable: Queryable,
): Promise<readonly { groupId: string; metrics: { metricId: string; version: number }[] }[]> {
  const { rows } = await queryable.exec(
    'SELECT comparability_group_id, metric_id, version FROM metric_definitions ORDER BY comparability_group_id',
  );
  const groups = new Map<string, { metricId: string; version: number }[]>();
  for (const row of rows) {
    const groupId = String(row.comparability_group_id);
    if (!groups.has(groupId)) {
      groups.set(groupId, []);
    }
    groups.get(groupId)?.push({ metricId: String(row.metric_id), version: Number(row.version) });
  }
  const mixed: { groupId: string; metrics: { metricId: string; version: number }[] }[] = [];
  for (const [groupId, metrics] of groups) {
    const distinct = new Map<string, number>();
    for (const m of metrics) {
      distinct.set(`${m.metricId}@v${m.version}`, m.version);
    }
    if (distinct.size > 1) {
      mixed.push({ groupId, metrics });
    }
  }
  return mixed;
}

export async function validateMetricRegistry(
  queryable: Queryable,
  options?: { reference?: readonly MetricDefinitionReference[] },
): Promise<MetricRegistryValidationResult> {
  const issues: MetricRegistryIssue[] = [];
  const definitions = await queryDefinitions(queryable);
  const seenKeys = new Set<string>();
  for (const def of definitions) {
    const key = `${def.metricId}@v${def.version}`;
    if (seenKeys.has(key)) {
      issues.push({
        code: 'duplicate_metric_version',
        severity: 'error',
        message: `Duplicate metric ID and version: ${def.metricId} v${def.version}`,
        metricId: def.metricId,
        version: def.version,
      });
    }
    seenKeys.add(key);
    const validation = validateDefinitionInput(def);
    issues.push(...validation);
    const statisticalPolicy = await StatisticalPolicyStore.getById(
      queryable,
      def.statisticalPolicyId,
    );
    if (!statisticalPolicy) {
      issues.push({
        code: 'missing_statistical_policy',
        severity: 'error',
        message: `Statistical policy ${def.statisticalPolicyId} not found`,
        metricId: def.metricId,
        version: def.version,
      });
    } else if (!isStatisticalPolicyComplete(statisticalPolicy)) {
      issues.push({
        code: 'incomplete_statistical_policy',
        severity: 'error',
        message: `Statistical policy ${statisticalPolicy.policyId} v${statisticalPolicy.version} is incomplete`,
        metricId: def.metricId,
        version: def.version,
      });
    }
    if (def.attributionPolicyId) {
      const attributionPolicy = await AttributionPolicyStore.getById(
        queryable,
        def.attributionPolicyId,
      );
      if (!attributionPolicy) {
        issues.push({
          code: 'missing_attribution_policy',
          severity: 'error',
          message: `Attribution policy ${def.attributionPolicyId} not found`,
          metricId: def.metricId,
          version: def.version,
        });
      } else if (!isAttributionPolicyComplete(attributionPolicy)) {
        issues.push({
          code: 'incomplete_attribution_policy',
          severity: 'error',
          message: `Attribution policy ${attributionPolicy.policyId} v${attributionPolicy.version} is incomplete`,
          metricId: def.metricId,
          version: def.version,
        });
      }
    }
  }
  const mixedGroups = await findMixedGroups(queryable);
  for (const group of mixedGroups) {
    issues.push({
      code: 'mixed_comparability_group',
      severity: 'error',
      message: `Comparability group ${group.groupId} contains mixed metric meanings`,
    });
  }
  const statisticalPolicies = await StatisticalPolicyStore.listAll(queryable);
  const attributionPolicies = await AttributionPolicyStore.listAll(queryable);
  const rollupPolicies = await RollupPolicyStore.listAll(queryable);
  if (statisticalPolicies.length === 0) {
    issues.push({
      code: 'no_statistical_policies',
      severity: 'error',
      message: 'No statistical policies are registered',
    });
  }
  for (const policy of statisticalPolicies) {
    if (!isStatisticalPolicyComplete(policy)) {
      issues.push({
        code: 'incomplete_statistical_policy',
        severity: 'error',
        message: `Statistical policy ${policy.policyId} v${policy.version} is incomplete`,
        policyId: policy.policyId,
      });
    }
  }
  for (const policy of attributionPolicies) {
    if (!isAttributionPolicyComplete(policy)) {
      issues.push({
        code: 'incomplete_attribution_policy',
        severity: 'error',
        message: `Attribution policy ${policy.policyId} v${policy.version} is incomplete`,
        policyId: policy.policyId,
      });
    }
  }
  for (const policy of rollupPolicies) {
    if (!isRollupPolicyComplete(policy)) {
      issues.push({
        code: 'incomplete_rollup_policy',
        severity: 'error',
        message: `Rollup policy ${policy.policyId} v${policy.version} is incomplete`,
        policyId: policy.policyId,
      });
    }
  }
  if (options?.reference) {
    const referenceResult = validateMetricRegistryAgainstReference(queryable, options.reference);
    const refIssues = (await referenceResult).issues;
    issues.push(...refIssues);
  }
  return { valid: issues.length === 0, issues };
}

export async function validateMetricRegistryAgainstReference(
  queryable: Queryable,
  reference: readonly MetricDefinitionReference[],
): Promise<MetricRegistryValidationResult> {
  const issues: MetricRegistryIssue[] = [];
  const stored = await queryDefinitions(queryable);
  const storedMap = new Map<string, MetricDefinitionShape>();
  for (const def of stored) {
    storedMap.set(`${def.metricId}@v${def.version}`, def);
  }
  const refMap = new Map<string, MetricDefinitionShape>();
  for (const def of reference) {
    refMap.set(`${def.metricId}@v${def.version}`, def);
  }
  for (const [key, ref] of refMap) {
    const storedDef = storedMap.get(key);
    if (!storedDef) {
      issues.push({
        code: 'reference_missing_in_registry',
        severity: 'error',
        message: `Reference metric ${ref.metricId} v${ref.version} is not in the registry`,
        metricId: ref.metricId,
        version: ref.version,
      });
      continue;
    }
    const storedChecksum = computeMetricDefinitionChecksum(storedDef);
    const refChecksum = computeMetricDefinitionChecksum(ref);
    if (storedChecksum !== refChecksum) {
      issues.push({
        code: 'reference_checksum_mismatch',
        severity: 'error',
        message: `Metric ${ref.metricId} v${ref.version} drifted from reference`,
        metricId: ref.metricId,
        version: ref.version,
      });
    }
  }
  for (const [key, def] of storedMap) {
    if (!refMap.has(key)) {
      issues.push({
        code: 'registry_extra_definition',
        severity: 'error',
        message: `Registry contains unexpected metric ${def.metricId} v${def.version}`,
        metricId: def.metricId,
        version: def.version,
      });
    }
  }
  return { valid: issues.length === 0, issues };
}

export async function getMetricReleaseMatrix(
  queryable: Queryable,
  options?: {
    readonly rollupPolicyId?: string;
    readonly includePlannedRecipes?: boolean;
  },
): Promise<readonly MetricReleaseMatrixRow[]> {
  const rows: MetricReleaseMatrixRow[] = [];
  const defaultRollupPolicy = await resolveRollupPolicy(queryable, options?.rollupPolicyId);
  const definitions = await queryDefinitions(queryable);
  for (const def of definitions) {
    const statisticalPolicy = await StatisticalPolicyStore.getById(
      queryable,
      def.statisticalPolicyId,
    );
    const attributionPolicy = def.attributionPolicyId
      ? await AttributionPolicyStore.getById(queryable, def.attributionPolicyId)
      : undefined;
    const rollupPolicy =
      def.distributionPolicy || ['percentile', 'distribution'].includes(def.aggregation)
        ? defaultRollupPolicy
        : undefined;
    rows.push({
      metricId: def.metricId,
      version: def.version,
      label: def.label,
      family: def.family,
      phase: classifyMetricPhase(def.family),
      requiredEvidence: requiredEvidenceFor(def),
      measurementClass: def.measurementClass,
      valueType: def.valueType,
      unit: def.unit,
      grain: def.grain,
      aggregation: def.aggregation,
      additive: isAdditiveAggregation(def.aggregation),
      capabilityGate: capabilityGateFor(def),
      statisticalPolicyId: def.statisticalPolicyId,
      attributionPolicyId: def.attributionPolicyId ?? null,
      rollupPolicyId: rollupPolicy?.id ?? null,
      releaseReadiness: releaseReadinessFor(
        def,
        statisticalPolicy,
        attributionPolicy,
        rollupPolicy,
      ),
      comparabilityGroupId: def.comparabilityGroupId,
    });
  }
  if (options?.includePlannedRecipes !== false) {
    for (const recipe of PLANNED_INSIGHT_RECIPE_CATALOG) {
      const plannedDefinition = buildPlannedMetricDefinitionInput(recipe);
      const comparabilityGroupId = deriveComparabilityGroupIdForDefinition(plannedDefinition);
      rows.push({
        metricId: recipe.metricId,
        version: recipe.version,
        label: recipe.label,
        family: recipe.family,
        phase: recipe.phase,
        requiredEvidence: recipe.requiredEvidence,
        measurementClass: recipe.measurementClass,
        valueType: recipe.valueType,
        unit: recipe.unit,
        grain: recipe.grain,
        aggregation: recipe.aggregation,
        additive: isAdditiveAggregation(recipe.aggregation),
        capabilityGate: `${recipe.phase}:${recipe.measurementClass}:${recipe.aggregation}`,
        statisticalPolicyId: 'planned',
        attributionPolicyId: null,
        rollupPolicyId: null,
        releaseReadiness: recipe.releaseReadiness,
        comparabilityGroupId,
      });
    }
  }
  return rows.sort((a, b) => {
    if (a.phase !== b.phase) return a.phase.localeCompare(b.phase);
    if (a.family !== b.family) return a.family.localeCompare(b.family);
    if (a.metricId !== b.metricId) return a.metricId.localeCompare(b.metricId);
    return a.version - b.version;
  });
}

export function getDefaultPortfolioHeadlineStrata(
  metrics: readonly MetricValueDto[],
): readonly HeadlineStratum[] {
  const strata = new Map<string, HeadlineStratum>();
  for (const metric of metrics) {
    const key = `${metric.comparabilityGroupId}:${metric.metricId}`;
    if (strata.has(key)) {
      continue;
    }
    const version = Number.parseInt(metric.metricVersion, 10);
    strata.set(key, {
      stratumKey: key,
      comparabilityGroupId: metric.comparabilityGroupId,
      metricId: metric.metricId,
      version: Number.isNaN(version) ? 0 : version,
      label: metric.label,
      value: metric.value,
      unit: metric.unit,
      sourceDescription: `stratum by comparability group ${metric.comparabilityGroupId}`,
    });
  }
  return [...strata.values()].sort((a, b) => a.stratumKey.localeCompare(b.stratumKey));
}
