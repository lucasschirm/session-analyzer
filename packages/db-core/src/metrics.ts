import type { SqliteExecutor, SqliteRow, SqliteTransaction, SqliteValue } from './contract.js';
import { deterministicId } from './identity.js';
import type { Migration } from './migrations.js';

type Queryable = SqliteExecutor | SqliteTransaction;

/**
 * Pure-JS FNV-1a 64-bit checksum used for migration integrity. It does not
 * import a runtime crypto implementation, so it keeps `db-core` free of
 * forbidden Node/DOM/Worker dependencies.
 */
function fnv1a64(input: string): bigint {
  let hash = 14695981039346656037n;
  const prime = 1099511628211n;
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = (hash * prime) & 0xffffffffffffffffn;
  }
  return hash;
}

function checksumOf(sql: string): string {
  return fnv1a64(sql).toString(16).padStart(16, '0');
}

function asString(value: SqliteValue): string {
  return value === null || value === undefined ? '' : String(value);
}

function toOptionalString(value: SqliteValue): string | null {
  return value === null || value === undefined ? null : String(value);
}

function toNumber(value: SqliteValue): number {
  return value === null || value === undefined ? 0 : Number(value);
}

function toOptionalNumber(value: SqliteValue): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function toBoolean(value: SqliteValue): boolean {
  return value === 1 || value === true;
}

function toStringList(value: SqliteValue): readonly string[] {
  if (value === null || value === undefined) return [];
  try {
    const parsed = JSON.parse(String(value));
    if (Array.isArray(parsed)) return parsed.map((v) => String(v));
  } catch {
    // fall through
  }
  return [];
}

function fromStringList(value: readonly string[] | undefined | null): string {
  return JSON.stringify(value ?? []);
}

export const MEASUREMENT_CLASSES = ['observed', 'derived', 'estimated', 'heuristic'] as const;
export type MeasurementClass = (typeof MEASUREMENT_CLASSES)[number];

export const VALUE_TYPES = ['integer', 'real', 'currency', 'ratio', 'text'] as const;
export type ValueType = (typeof VALUE_TYPES)[number];

export const MISSING_DATA_BEHAVIORS = ['unknown', 'not_applicable'] as const;
export type MissingDataBehavior = (typeof MISSING_DATA_BEHAVIORS)[number];

export const ROOT_INCLUSIONS = ['root_only', 'inclusive', 'both', 'not_applicable'] as const;
export type RootInclusion = (typeof ROOT_INCLUSIONS)[number];

export const CAPABILITY_STATUSES = ['available', 'partial', 'unavailable', 'incompatible'] as const;
export type CapabilityStatus = (typeof CAPABILITY_STATUSES)[number];

export const METRIC_VALUE_CLASSES = [
  'exact',
  'estimated',
  'allocated',
  'proportional',
  'inherited',
] as const;
export type MetricValueClass = (typeof METRIC_VALUE_CLASSES)[number];

/**
 * Metric definition contract as specified in §9 of the Analytics Data Platform
 * Design. The interface does not include internal bookkeeping columns such as
 * `id`, `createdAt`, `updatedAt`, or `comparabilityGroupId`.
 */
export interface MetricDefinition {
  readonly metricId: string;
  readonly version: number;
  readonly label: string;
  readonly description: string;
  readonly family: string;
  readonly measurementClass: MeasurementClass;
  readonly unit: string;
  readonly valueType: ValueType;
  readonly grain: string;
  readonly dimensions: readonly string[];
  readonly denominator?: string;
  readonly populationRule: string;
  readonly statusRule: string;
  readonly aggregation: string;
  readonly allocationMethod?: string;
  readonly statisticalPolicyId: string;
  readonly comparabilityGroupInputs: readonly string[];
  readonly missingDataBehavior: MissingDataBehavior;
  readonly rootInclusion: RootInclusion;
  readonly distributionPolicy?: string;
  readonly provenanceRequirement: string;
}

/**
 * Properties used to derive a machine-readable `comparability_group_id`.
 * Changing any of these produces a new group, preventing silent aggregation of
 * mixed meanings.
 */
export interface MetricComparabilityInput {
  readonly metricId: string;
  readonly version: number;
  readonly unit: string;
  readonly valueType: ValueType;
  readonly grain: string;
  readonly dimensions: readonly string[];
  readonly denominator?: string | null;
  readonly populationRule: string;
  readonly statusRule: string;
  readonly aggregation: string;
  readonly allocationMethod?: string | null;
  readonly statisticalPolicyId: string;
  readonly attributionPolicyId?: string | null;
  readonly missingDataBehavior: MissingDataBehavior;
  readonly rootInclusion: RootInclusion;
  readonly distributionPolicy?: string | null;
  readonly valueClass?: MetricValueClass | null;
}

function sortedValues(values: readonly string[] | undefined | null): string[] {
  return [...(values ?? [])].sort();
}

/**
 * Derives a deterministic comparability group id from the comparability
 * property set. Exact and estimated values are separated because the
 * `valueClass` is included in the hashed inputs.
 */
export function deriveMetricComparabilityGroupId(input: MetricComparabilityInput): string {
  const parts = [
    'metric-comparability',
    input.metricId,
    String(input.version),
    input.unit,
    input.valueType,
    input.grain,
    sortedValues(input.dimensions).join('\x1f'),
    input.denominator ?? '',
    input.populationRule,
    input.statusRule,
    input.aggregation,
    input.allocationMethod ?? '',
    input.statisticalPolicyId,
    input.attributionPolicyId ?? '',
    input.missingDataBehavior,
    input.rootInclusion,
    input.distributionPolicy ?? '',
    input.valueClass ?? '',
  ];
  return `cg-${deterministicId(...parts)}`;
}

/**
 * Derives a comparability group id for a native, namespaced metric. Native
 * values never share a group with a canonical metric unless an explicit bridge
 * mapping exists and is recorded on the canonical value.
 */
export function deriveNativeMetricComparabilityGroupId(input: {
  readonly nativeMetricId: string;
  readonly valueClass: MetricValueClass;
  readonly estimationMethod?: string | null;
  readonly transformerId?: string | null;
  readonly transformerVersion?: string | null;
}): string {
  const parts = [
    'native-metric-comparability',
    input.nativeMetricId,
    input.valueClass,
    input.estimationMethod ?? '',
    input.transformerId ?? '',
    input.transformerVersion ?? '',
  ];
  return `cg-${deterministicId(...parts)}`;
}

/**
 * Derives a comparability group id for a heuristic, separately-versioned
 * semantic value.
 */
export function deriveHeuristicMetricComparabilityGroupId(input: {
  readonly heuristicId: string;
  readonly version: number;
  readonly valueClass: MetricValueClass;
  readonly targetMetricDefinitionId?: string | null;
}): string {
  const parts = [
    'heuristic-metric-comparability',
    input.heuristicId,
    String(input.version),
    input.valueClass,
    input.targetMetricDefinitionId ?? '',
  ];
  return `cg-${deterministicId(...parts)}`;
}

export const CREATE_STATISTICAL_POLICIES_TABLE = `
CREATE TABLE IF NOT EXISTS statistical_policies (
  id TEXT PRIMARY KEY,
  policy_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  observation_unit TEXT NOT NULL,
  eligibility TEXT NOT NULL,
  micro_weighting TEXT,
  macro_weighting TEXT,
  percentile_algorithm TEXT,
  percentile_minimum_n INTEGER,
  ratio_policy TEXT,
  censoring TEXT,
  outlier_policy TEXT,
  uncertainty TEXT,
  timezone TEXT,
  day_boundary TEXT,
  matching TEXT,
  coverage TEXT,
  insight_suppression TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_statistical_policies_id_version
  ON statistical_policies(policy_id, version);

CREATE INDEX IF NOT EXISTS idx_statistical_policies_name
  ON statistical_policies(name);
`;

export const CREATE_ATTRIBUTION_POLICIES_TABLE = `
CREATE TABLE IF NOT EXISTS attribution_policies (
  id TEXT PRIMARY KEY,
  policy_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  window_boundaries TEXT NOT NULL,
  overlap_handling TEXT NOT NULL,
  allocation TEXT NOT NULL,
  confidence TEXT,
  additive INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_attribution_policies_id_version
  ON attribution_policies(policy_id, version);
`;

export const CREATE_METRIC_DEFINITIONS_TABLE = `
CREATE TABLE IF NOT EXISTS metric_definitions (
  id TEXT PRIMARY KEY,
  metric_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  label TEXT NOT NULL,
  description TEXT NOT NULL,
  family TEXT NOT NULL,
  measurement_class TEXT NOT NULL
    CHECK(measurement_class IN ('observed', 'derived', 'estimated', 'heuristic')),
  unit TEXT NOT NULL,
  value_type TEXT NOT NULL
    CHECK(value_type IN ('integer', 'real', 'currency', 'ratio', 'text')),
  grain TEXT NOT NULL,
  dimensions TEXT NOT NULL DEFAULT '[]',
  denominator TEXT,
  population_rule TEXT NOT NULL,
  status_rule TEXT NOT NULL,
  aggregation TEXT NOT NULL,
  allocation_method TEXT,
  statistical_policy_id TEXT NOT NULL,
  attribution_policy_id TEXT,
  comparability_group_inputs TEXT NOT NULL DEFAULT '[]',
  missing_data_behavior TEXT NOT NULL
    CHECK(missing_data_behavior IN ('unknown', 'not_applicable')),
  root_inclusion TEXT NOT NULL
    CHECK(root_inclusion IN ('root_only', 'inclusive', 'both', 'not_applicable')),
  distribution_policy TEXT,
  provenance_requirement TEXT NOT NULL,
  comparability_group_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (statistical_policy_id) REFERENCES statistical_policies(id) ON DELETE RESTRICT,
  FOREIGN KEY (attribution_policy_id) REFERENCES attribution_policies(id) ON DELETE SET NULL
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_metric_definitions_metric_version
  ON metric_definitions(metric_id, version);

CREATE INDEX IF NOT EXISTS idx_metric_definitions_family
  ON metric_definitions(family);

CREATE INDEX IF NOT EXISTS idx_metric_definitions_comparability
  ON metric_definitions(comparability_group_id);
`;

export const CREATE_TRANSFORMER_METRIC_CAPABILITIES_TABLE = `
CREATE TABLE IF NOT EXISTS transformer_metric_capabilities (
  id TEXT PRIMARY KEY,
  transformer_id TEXT NOT NULL,
  harness TEXT NOT NULL,
  transformer_version TEXT NOT NULL,
  ontology_version TEXT NOT NULL,
  metric_definition_id TEXT NOT NULL,
  capability TEXT NOT NULL
    CHECK(capability IN ('available', 'partial', 'unavailable', 'incompatible')),
  reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (metric_definition_id) REFERENCES metric_definitions(id) ON DELETE CASCADE
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_transformer_capabilities_unique
  ON transformer_metric_capabilities(
    transformer_id,
    harness,
    transformer_version,
    ontology_version,
    metric_definition_id
  );

CREATE INDEX IF NOT EXISTS idx_transformer_capabilities_metric
  ON transformer_metric_capabilities(metric_definition_id);
`;

export const CREATE_METRIC_VALUES_TABLE = `
CREATE TABLE IF NOT EXISTS metric_values (
  id TEXT PRIMARY KEY,
  metric_definition_id TEXT NOT NULL,
  comparability_group_id TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  session_id TEXT,
  invocation_id TEXT,
  entity_type TEXT,
  entity_id TEXT,
  dimensions_key TEXT,
  value_type TEXT NOT NULL
    CHECK(value_type IN ('integer', 'real', 'currency', 'ratio', 'text')),
  integer_value INTEGER,
  numeric_value REAL,
  text_value TEXT,
  value_class TEXT NOT NULL DEFAULT 'exact'
    CHECK(value_class IN ('exact', 'estimated', 'allocated', 'proportional', 'inherited')),
  confidence REAL,
  root_inclusion TEXT NOT NULL DEFAULT 'not_applicable'
    CHECK(root_inclusion IN ('root_only', 'inclusive', 'both', 'not_applicable')),
  is_unavailable INTEGER NOT NULL DEFAULT 0,
  unavailable_reason TEXT,
  is_not_applicable INTEGER NOT NULL DEFAULT 0,
  not_applicable_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (metric_definition_id) REFERENCES metric_definitions(id) ON DELETE CASCADE,
  FOREIGN KEY (generation_id) REFERENCES transformation_generations(id) ON DELETE CASCADE,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (invocation_id) REFERENCES invocations(id) ON DELETE CASCADE,
  CHECK(
    (is_unavailable = 0 AND is_not_applicable = 0)
    OR (integer_value IS NULL AND numeric_value IS NULL AND text_value IS NULL)
  ),
  CHECK(is_unavailable = 0 OR unavailable_reason IS NOT NULL),
  CHECK(is_not_applicable = 0 OR not_applicable_reason IS NOT NULL),
  CHECK(is_unavailable + is_not_applicable <= 1)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_metric_values_definition
  ON metric_values(metric_definition_id);

CREATE INDEX IF NOT EXISTS idx_metric_values_comparability
  ON metric_values(comparability_group_id);

CREATE INDEX IF NOT EXISTS idx_metric_values_session
  ON metric_values(session_id);

CREATE INDEX IF NOT EXISTS idx_metric_values_invocation
  ON metric_values(invocation_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_metric_values_unique
  ON metric_values(
    metric_definition_id,
    comparability_group_id,
    generation_id,
    COALESCE(session_id, ''),
    COALESCE(invocation_id, ''),
    COALESCE(entity_type, ''),
    COALESCE(entity_id, ''),
    COALESCE(dimensions_key, ''),
    value_class
  );
`;

export const CREATE_METRIC_DISTRIBUTIONS_TABLE = `
CREATE TABLE IF NOT EXISTS metric_distributions (
  id TEXT PRIMARY KEY,
  metric_definition_id TEXT NOT NULL,
  comparability_group_id TEXT NOT NULL,
  statistical_policy_id TEXT NOT NULL,
  attribution_policy_id TEXT,
  generation_id TEXT NOT NULL,
  eligible_n INTEGER NOT NULL,
  known_n INTEGER NOT NULL,
  unknown_count INTEGER NOT NULL,
  sum REAL,
  min REAL,
  max REAL,
  mean REAL,
  p50 REAL,
  p75 REAL,
  p90 REAL,
  p95 REAL,
  dispersion REAL,
  outlier_rule TEXT,
  coverage REAL,
  dimensions_key TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (metric_definition_id) REFERENCES metric_definitions(id) ON DELETE CASCADE,
  FOREIGN KEY (statistical_policy_id) REFERENCES statistical_policies(id) ON DELETE RESTRICT,
  FOREIGN KEY (attribution_policy_id) REFERENCES attribution_policies(id) ON DELETE SET NULL,
  FOREIGN KEY (generation_id) REFERENCES transformation_generations(id) ON DELETE CASCADE,
  CHECK(eligible_n >= 0),
  CHECK(known_n >= 0),
  CHECK(unknown_count >= 0),
  CHECK(coverage IS NULL OR (coverage >= 0 AND coverage <= 1)),
  CHECK(known_n + unknown_count <= eligible_n)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_metric_distributions_definition
  ON metric_distributions(metric_definition_id);

CREATE INDEX IF NOT EXISTS idx_metric_distributions_comparability
  ON metric_distributions(comparability_group_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_metric_distributions_unique
  ON metric_distributions(
    metric_definition_id,
    comparability_group_id,
    statistical_policy_id,
    COALESCE(attribution_policy_id, ''),
    generation_id,
    COALESCE(dimensions_key, '')
  );
`;

export const CREATE_METRIC_PROVENANCE_TABLE = `
CREATE TABLE IF NOT EXISTS metric_provenance (
  id TEXT PRIMARY KEY,
  metric_value_id TEXT,
  distribution_id TEXT,
  source_artifact_id TEXT,
  source_event_id TEXT,
  source_field TEXT NOT NULL,
  estimation_method TEXT,
  allocation_method TEXT,
  generation_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (metric_value_id) REFERENCES metric_values(id) ON DELETE CASCADE,
  FOREIGN KEY (distribution_id) REFERENCES metric_distributions(id) ON DELETE CASCADE,
  FOREIGN KEY (generation_id) REFERENCES transformation_generations(id) ON DELETE CASCADE,
  CHECK((metric_value_id IS NOT NULL) + (distribution_id IS NOT NULL) = 1)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_metric_provenance_value
  ON metric_provenance(metric_value_id);

CREATE INDEX IF NOT EXISTS idx_metric_provenance_distribution
  ON metric_provenance(distribution_id);

CREATE INDEX IF NOT EXISTS idx_metric_provenance_artifact
  ON metric_provenance(source_artifact_id, source_event_id);
`;

export const CREATE_NATIVE_METRIC_VALUES_TABLE = `
CREATE TABLE IF NOT EXISTS native_metric_values (
  id TEXT PRIMARY KEY,
  native_metric_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  transformer_id TEXT,
  harness TEXT,
  transformer_version TEXT,
  ontology_version TEXT,
  value_type TEXT NOT NULL
    CHECK(value_type IN ('integer', 'real', 'currency', 'ratio', 'text')),
  integer_value INTEGER,
  numeric_value REAL,
  text_value TEXT,
  value_class TEXT NOT NULL DEFAULT 'exact'
    CHECK(value_class IN ('exact', 'estimated', 'allocated', 'proportional', 'inherited')),
  confidence REAL,
  session_id TEXT,
  invocation_id TEXT,
  entity_type TEXT,
  entity_id TEXT,
  dimensions_key TEXT,
  is_unavailable INTEGER NOT NULL DEFAULT 0,
  unavailable_reason TEXT,
  is_not_applicable INTEGER NOT NULL DEFAULT 0,
  not_applicable_reason TEXT,
  estimation_method TEXT,
  comparability_group_id TEXT NOT NULL,
  generation_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (invocation_id) REFERENCES invocations(id) ON DELETE CASCADE,
  FOREIGN KEY (generation_id) REFERENCES transformation_generations(id) ON DELETE SET NULL,
  CHECK(
    (is_unavailable = 0 AND is_not_applicable = 0)
    OR (integer_value IS NULL AND numeric_value IS NULL AND text_value IS NULL)
  ),
  CHECK(is_unavailable = 0 OR unavailable_reason IS NOT NULL),
  CHECK(is_not_applicable = 0 OR not_applicable_reason IS NOT NULL),
  CHECK(is_unavailable + is_not_applicable <= 1)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_native_metric_values_id
  ON native_metric_values(native_metric_id);

CREATE INDEX IF NOT EXISTS idx_native_metric_values_comparability
  ON native_metric_values(comparability_group_id);

CREATE INDEX IF NOT EXISTS idx_native_metric_values_session
  ON native_metric_values(session_id);
`;

export const CREATE_HEURISTIC_METRIC_VALUES_TABLE = `
CREATE TABLE IF NOT EXISTS heuristic_metric_values (
  id TEXT PRIMARY KEY,
  heuristic_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  label TEXT NOT NULL,
  description TEXT,
  target_metric_definition_id TEXT,
  value_type TEXT NOT NULL
    CHECK(value_type IN ('integer', 'real', 'currency', 'ratio', 'text')),
  integer_value INTEGER,
  numeric_value REAL,
  text_value TEXT,
  value_class TEXT NOT NULL DEFAULT 'estimated'
    CHECK(value_class IN ('exact', 'estimated', 'allocated', 'proportional', 'inherited')),
  confidence REAL,
  session_id TEXT,
  invocation_id TEXT,
  entity_type TEXT,
  entity_id TEXT,
  dimensions_key TEXT,
  evidence_json TEXT,
  is_unavailable INTEGER NOT NULL DEFAULT 0,
  unavailable_reason TEXT,
  is_not_applicable INTEGER NOT NULL DEFAULT 0,
  not_applicable_reason TEXT,
  comparability_group_id TEXT NOT NULL,
  generation_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (target_metric_definition_id) REFERENCES metric_definitions(id) ON DELETE SET NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (invocation_id) REFERENCES invocations(id) ON DELETE CASCADE,
  FOREIGN KEY (generation_id) REFERENCES transformation_generations(id) ON DELETE SET NULL,
  CHECK(
    (is_unavailable = 0 AND is_not_applicable = 0)
    OR (integer_value IS NULL AND numeric_value IS NULL AND text_value IS NULL)
  ),
  CHECK(is_unavailable = 0 OR unavailable_reason IS NOT NULL),
  CHECK(is_not_applicable = 0 OR not_applicable_reason IS NOT NULL),
  CHECK(is_unavailable + is_not_applicable <= 1)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_heuristic_metric_values_heuristic
  ON heuristic_metric_values(heuristic_id, version);

CREATE INDEX IF NOT EXISTS idx_heuristic_metric_values_comparability
  ON heuristic_metric_values(comparability_group_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_heuristic_metric_values_unique
  ON heuristic_metric_values(
    heuristic_id,
    version,
    COALESCE(session_id, ''),
    COALESCE(invocation_id, ''),
    COALESCE(entity_type, ''),
    COALESCE(entity_id, ''),
    COALESCE(dimensions_key, '')
  );
`;

/**
 * Combined DDL for all metric registry, value, distribution, provenance, and
 * policy tables. Tests can execute this after `FRESH_SCHEMA_SQL` to set up the
 * metrics schema before the orchestrator merges the migration fragment.
 */
export const METRICS_DDL = `
${CREATE_STATISTICAL_POLICIES_TABLE}
${CREATE_ATTRIBUTION_POLICIES_TABLE}
${CREATE_METRIC_DEFINITIONS_TABLE}
${CREATE_TRANSFORMER_METRIC_CAPABILITIES_TABLE}
${CREATE_METRIC_VALUES_TABLE}
${CREATE_METRIC_DISTRIBUTIONS_TABLE}
${CREATE_METRIC_PROVENANCE_TABLE}
${CREATE_NATIVE_METRIC_VALUES_TABLE}
${CREATE_HEURISTIC_METRIC_VALUES_TABLE}
`.trim();

export const METRICS_MIGRATIONS_FRAGMENT: readonly Migration[] = [
  {
    id: 56,
    name: 'create-statistical-policies',
    sql: CREATE_STATISTICAL_POLICIES_TABLE,
    checksum: checksumOf(CREATE_STATISTICAL_POLICIES_TABLE),
  },
  {
    id: 57,
    name: 'create-attribution-policies',
    sql: CREATE_ATTRIBUTION_POLICIES_TABLE,
    checksum: checksumOf(CREATE_ATTRIBUTION_POLICIES_TABLE),
  },
  {
    id: 58,
    name: 'create-metric-definitions',
    sql: CREATE_METRIC_DEFINITIONS_TABLE,
    checksum: checksumOf(CREATE_METRIC_DEFINITIONS_TABLE),
  },
  {
    id: 59,
    name: 'create-transformer-metric-capabilities',
    sql: CREATE_TRANSFORMER_METRIC_CAPABILITIES_TABLE,
    checksum: checksumOf(CREATE_TRANSFORMER_METRIC_CAPABILITIES_TABLE),
  },
  {
    id: 60,
    name: 'create-metric-values',
    sql: CREATE_METRIC_VALUES_TABLE,
    checksum: checksumOf(CREATE_METRIC_VALUES_TABLE),
  },
  {
    id: 61,
    name: 'create-metric-distributions',
    sql: CREATE_METRIC_DISTRIBUTIONS_TABLE,
    checksum: checksumOf(CREATE_METRIC_DISTRIBUTIONS_TABLE),
  },
  {
    id: 62,
    name: 'create-metric-provenance',
    sql: CREATE_METRIC_PROVENANCE_TABLE,
    checksum: checksumOf(CREATE_METRIC_PROVENANCE_TABLE),
  },
  {
    id: 63,
    name: 'create-native-metric-values',
    sql: CREATE_NATIVE_METRIC_VALUES_TABLE,
    checksum: checksumOf(CREATE_NATIVE_METRIC_VALUES_TABLE),
  },
  {
    id: 64,
    name: 'create-heuristic-metric-values',
    sql: CREATE_HEURISTIC_METRIC_VALUES_TABLE,
    checksum: checksumOf(CREATE_HEURISTIC_METRIC_VALUES_TABLE),
  },
];

export interface StatisticalPolicy {
  readonly id: string;
  readonly policyId: string;
  readonly version: number;
  readonly name: string;
  readonly description: string | null;
  readonly observationUnit: string;
  readonly eligibility: string;
  readonly microWeighting: string | null;
  readonly macroWeighting: string | null;
  readonly percentileAlgorithm: string | null;
  readonly percentileMinimumN: number | null;
  readonly ratioPolicy: string | null;
  readonly censoring: string | null;
  readonly outlierPolicy: string | null;
  readonly uncertainty: string | null;
  readonly timezone: string | null;
  readonly dayBoundary: string | null;
  readonly matching: string | null;
  readonly coverage: string | null;
  readonly insightSuppression: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface InsertStatisticalPolicyInput {
  readonly id?: string;
  readonly policyId: string;
  readonly version: number;
  readonly name: string;
  readonly description?: string | null;
  readonly observationUnit: string;
  readonly eligibility: string;
  readonly microWeighting?: string | null;
  readonly macroWeighting?: string | null;
  readonly percentileAlgorithm?: string | null;
  readonly percentileMinimumN?: number | null;
  readonly ratioPolicy?: string | null;
  readonly censoring?: string | null;
  readonly outlierPolicy?: string | null;
  readonly uncertainty?: string | null;
  readonly timezone?: string | null;
  readonly dayBoundary?: string | null;
  readonly matching?: string | null;
  readonly coverage?: string | null;
  readonly insightSuppression?: string | null;
  readonly createdAt?: number;
  readonly updatedAt?: number;
}

// biome-ignore lint/complexity/noStaticOnlyClass: typed metrics store
export class StatisticalPolicyStore {
  private static rowToStatisticalPolicy(row: SqliteRow): StatisticalPolicy {
    return {
      id: asString(row.id),
      policyId: asString(row.policy_id),
      version: toNumber(row.version),
      name: asString(row.name),
      description: toOptionalString(row.description),
      observationUnit: asString(row.observation_unit),
      eligibility: asString(row.eligibility),
      microWeighting: toOptionalString(row.micro_weighting),
      macroWeighting: toOptionalString(row.macro_weighting),
      percentileAlgorithm: toOptionalString(row.percentile_algorithm),
      percentileMinimumN: toOptionalNumber(row.percentile_minimum_n),
      ratioPolicy: toOptionalString(row.ratio_policy),
      censoring: toOptionalString(row.censoring),
      outlierPolicy: toOptionalString(row.outlier_policy),
      uncertainty: toOptionalString(row.uncertainty),
      timezone: toOptionalString(row.timezone),
      dayBoundary: toOptionalString(row.day_boundary),
      matching: toOptionalString(row.matching),
      coverage: toOptionalString(row.coverage),
      insightSuppression: toOptionalString(row.insight_suppression),
      createdAt: toNumber(row.created_at),
      updatedAt: toNumber(row.updated_at),
    };
  }

  static async insert(queryable: Queryable, input: InsertStatisticalPolicyInput): Promise<string> {
    const now = Date.now();
    const id =
      input.id ??
      `sp-${deterministicId('statistical-policy', input.policyId, String(input.version))}`;
    await queryable.exec(
      `INSERT INTO statistical_policies (
        id, policy_id, version, name, description, observation_unit, eligibility,
        micro_weighting, macro_weighting, percentile_algorithm, percentile_minimum_n,
        ratio_policy, censoring, outlier_policy, uncertainty, timezone, day_boundary,
        matching, coverage, insight_suppression, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.policyId,
        input.version,
        input.name,
        input.description ?? null,
        input.observationUnit,
        input.eligibility,
        input.microWeighting ?? null,
        input.macroWeighting ?? null,
        input.percentileAlgorithm ?? null,
        input.percentileMinimumN ?? null,
        input.ratioPolicy ?? null,
        input.censoring ?? null,
        input.outlierPolicy ?? null,
        input.uncertainty ?? null,
        input.timezone ?? null,
        input.dayBoundary ?? null,
        input.matching ?? null,
        input.coverage ?? null,
        input.insightSuppression ?? null,
        input.createdAt ?? now,
        input.updatedAt ?? now,
      ],
    );
    return id;
  }

  static async getById(queryable: Queryable, id: string): Promise<StatisticalPolicy | undefined> {
    const { rows } = await queryable.exec('SELECT * FROM statistical_policies WHERE id = ?', [id]);
    if (rows.length === 0) return undefined;
    return StatisticalPolicyStore.rowToStatisticalPolicy(rows[0]);
  }

  static async getByPolicyIdAndVersion(
    queryable: Queryable,
    policyId: string,
    version: number,
  ): Promise<StatisticalPolicy | undefined> {
    const { rows } = await queryable.exec(
      'SELECT * FROM statistical_policies WHERE policy_id = ? AND version = ?',
      [policyId, version],
    );
    if (rows.length === 0) return undefined;
    return StatisticalPolicyStore.rowToStatisticalPolicy(rows[0]);
  }

  static async listAll(queryable: Queryable): Promise<readonly StatisticalPolicy[]> {
    const { rows } = await queryable.exec('SELECT * FROM statistical_policies ORDER BY name');
    return rows.map(StatisticalPolicyStore.rowToStatisticalPolicy);
  }

  static async update(
    queryable: Queryable,
    id: string,
    input: {
      readonly name: string;
      readonly description?: string | null;
      readonly observationUnit: string;
      readonly eligibility: string;
      readonly microWeighting?: string | null;
      readonly macroWeighting?: string | null;
      readonly percentileAlgorithm?: string | null;
      readonly percentileMinimumN?: number | null;
      readonly ratioPolicy?: string | null;
      readonly censoring?: string | null;
      readonly outlierPolicy?: string | null;
      readonly uncertainty?: string | null;
      readonly timezone?: string | null;
      readonly dayBoundary?: string | null;
      readonly matching?: string | null;
      readonly coverage?: string | null;
      readonly insightSuppression?: string | null;
      readonly updatedAt?: number;
    },
  ): Promise<void> {
    await queryable.exec(
      `UPDATE statistical_policies
       SET name = ?, description = ?, observation_unit = ?, eligibility = ?,
           micro_weighting = ?, macro_weighting = ?, percentile_algorithm = ?,
           percentile_minimum_n = ?, ratio_policy = ?, censoring = ?, outlier_policy = ?,
           uncertainty = ?, timezone = ?, day_boundary = ?, matching = ?, coverage = ?,
           insight_suppression = ?, updated_at = ?
       WHERE id = ?`,
      [
        input.name,
        input.description ?? null,
        input.observationUnit,
        input.eligibility,
        input.microWeighting ?? null,
        input.macroWeighting ?? null,
        input.percentileAlgorithm ?? null,
        input.percentileMinimumN ?? null,
        input.ratioPolicy ?? null,
        input.censoring ?? null,
        input.outlierPolicy ?? null,
        input.uncertainty ?? null,
        input.timezone ?? null,
        input.dayBoundary ?? null,
        input.matching ?? null,
        input.coverage ?? null,
        input.insightSuppression ?? null,
        input.updatedAt ?? Date.now(),
        id,
      ],
    );
  }

  static async delete(queryable: Queryable, id: string): Promise<void> {
    await queryable.exec('DELETE FROM statistical_policies WHERE id = ?', [id]);
  }
}

export interface AttributionPolicy {
  readonly id: string;
  readonly policyId: string;
  readonly version: number;
  readonly name: string;
  readonly description: string | null;
  readonly windowBoundaries: string;
  readonly overlapHandling: string;
  readonly allocation: string;
  readonly confidence: string | null;
  readonly additive: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface InsertAttributionPolicyInput {
  readonly id?: string;
  readonly policyId: string;
  readonly version: number;
  readonly name: string;
  readonly description?: string | null;
  readonly windowBoundaries: string;
  readonly overlapHandling: string;
  readonly allocation: string;
  readonly confidence?: string | null;
  readonly additive?: boolean;
  readonly createdAt?: number;
  readonly updatedAt?: number;
}

// biome-ignore lint/complexity/noStaticOnlyClass: typed metrics store
export class AttributionPolicyStore {
  private static rowToAttributionPolicy(row: SqliteRow): AttributionPolicy {
    return {
      id: asString(row.id),
      policyId: asString(row.policy_id),
      version: toNumber(row.version),
      name: asString(row.name),
      description: toOptionalString(row.description),
      windowBoundaries: asString(row.window_boundaries),
      overlapHandling: asString(row.overlap_handling),
      allocation: asString(row.allocation),
      confidence: toOptionalString(row.confidence),
      additive: toBoolean(row.additive),
      createdAt: toNumber(row.created_at),
      updatedAt: toNumber(row.updated_at),
    };
  }

  static async insert(queryable: Queryable, input: InsertAttributionPolicyInput): Promise<string> {
    const now = Date.now();
    const id =
      input.id ??
      `ap-${deterministicId('attribution-policy', input.policyId, String(input.version))}`;
    await queryable.exec(
      `INSERT INTO attribution_policies (
        id, policy_id, version, name, description, window_boundaries, overlap_handling,
        allocation, confidence, additive, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.policyId,
        input.version,
        input.name,
        input.description ?? null,
        input.windowBoundaries,
        input.overlapHandling,
        input.allocation,
        input.confidence ?? null,
        input.additive ? 1 : 0,
        input.createdAt ?? now,
        input.updatedAt ?? now,
      ],
    );
    return id;
  }

  static async getById(queryable: Queryable, id: string): Promise<AttributionPolicy | undefined> {
    const { rows } = await queryable.exec('SELECT * FROM attribution_policies WHERE id = ?', [id]);
    if (rows.length === 0) return undefined;
    return AttributionPolicyStore.rowToAttributionPolicy(rows[0]);
  }

  static async getByPolicyIdAndVersion(
    queryable: Queryable,
    policyId: string,
    version: number,
  ): Promise<AttributionPolicy | undefined> {
    const { rows } = await queryable.exec(
      'SELECT * FROM attribution_policies WHERE policy_id = ? AND version = ?',
      [policyId, version],
    );
    if (rows.length === 0) return undefined;
    return AttributionPolicyStore.rowToAttributionPolicy(rows[0]);
  }

  static async listAll(queryable: Queryable): Promise<readonly AttributionPolicy[]> {
    const { rows } = await queryable.exec('SELECT * FROM attribution_policies ORDER BY name');
    return rows.map(AttributionPolicyStore.rowToAttributionPolicy);
  }

  static async update(
    queryable: Queryable,
    id: string,
    input: {
      readonly name: string;
      readonly description?: string | null;
      readonly windowBoundaries: string;
      readonly overlapHandling: string;
      readonly allocation: string;
      readonly confidence?: string | null;
      readonly additive?: boolean;
      readonly updatedAt?: number;
    },
  ): Promise<void> {
    await queryable.exec(
      `UPDATE attribution_policies
       SET name = ?, description = ?, window_boundaries = ?, overlap_handling = ?,
           allocation = ?, confidence = ?, additive = ?, updated_at = ?
       WHERE id = ?`,
      [
        input.name,
        input.description ?? null,
        input.windowBoundaries,
        input.overlapHandling,
        input.allocation,
        input.confidence ?? null,
        input.additive ? 1 : 0,
        input.updatedAt ?? Date.now(),
        id,
      ],
    );
  }

  static async delete(queryable: Queryable, id: string): Promise<void> {
    await queryable.exec('DELETE FROM attribution_policies WHERE id = ?', [id]);
  }
}

export interface StoredMetricDefinition extends MetricDefinition {
  readonly id: string;
  readonly attributionPolicyId: string | null;
  readonly comparabilityGroupId: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface InsertMetricDefinitionInput extends MetricDefinition {
  readonly id?: string;
  readonly attributionPolicyId?: string | null;
  readonly createdAt?: number;
  readonly updatedAt?: number;
}

export interface UpdateMetricDefinitionInput {
  readonly label: string;
  readonly description: string;
  readonly updatedAt?: number;
}

// biome-ignore lint/complexity/noStaticOnlyClass: typed metrics store
export class MetricDefinitionStore {
  private static selectColumns = `
    id, metric_id, version, label, description, family, measurement_class, unit, value_type,
    grain, dimensions, denominator, population_rule, status_rule, aggregation, allocation_method,
    statistical_policy_id, attribution_policy_id, comparability_group_inputs, missing_data_behavior,
    root_inclusion, distribution_policy, provenance_requirement, comparability_group_id,
    created_at, updated_at
  `;

  private static rowToStoredMetricDefinition(row: SqliteRow): StoredMetricDefinition {
    return {
      id: asString(row.id),
      metricId: asString(row.metric_id),
      version: toNumber(row.version),
      label: asString(row.label),
      description: asString(row.description),
      family: asString(row.family),
      measurementClass: asString(row.measurement_class) as MeasurementClass,
      unit: asString(row.unit),
      valueType: asString(row.value_type) as ValueType,
      grain: asString(row.grain),
      dimensions: toStringList(row.dimensions),
      denominator: toOptionalString(row.denominator) ?? undefined,
      populationRule: asString(row.population_rule),
      statusRule: asString(row.status_rule),
      aggregation: asString(row.aggregation),
      allocationMethod: toOptionalString(row.allocation_method) ?? undefined,
      statisticalPolicyId: asString(row.statistical_policy_id),
      attributionPolicyId: toOptionalString(row.attribution_policy_id),
      comparabilityGroupInputs: toStringList(row.comparability_group_inputs),
      missingDataBehavior: asString(row.missing_data_behavior) as MissingDataBehavior,
      rootInclusion: asString(row.root_inclusion) as RootInclusion,
      distributionPolicy: toOptionalString(row.distribution_policy) ?? undefined,
      provenanceRequirement: asString(row.provenance_requirement),
      comparabilityGroupId: asString(row.comparability_group_id),
      createdAt: toNumber(row.created_at),
      updatedAt: toNumber(row.updated_at),
    };
  }

  private static toComparabilityInput(
    input: InsertMetricDefinitionInput,
  ): MetricComparabilityInput {
    return {
      metricId: input.metricId,
      version: input.version,
      unit: input.unit,
      valueType: input.valueType,
      grain: input.grain,
      dimensions: input.dimensions,
      denominator: input.denominator,
      populationRule: input.populationRule,
      statusRule: input.statusRule,
      aggregation: input.aggregation,
      allocationMethod: input.allocationMethod,
      statisticalPolicyId: input.statisticalPolicyId,
      attributionPolicyId: input.attributionPolicyId,
      missingDataBehavior: input.missingDataBehavior,
      rootInclusion: input.rootInclusion,
      distributionPolicy: input.distributionPolicy,
    };
  }

  static async insert(queryable: Queryable, input: InsertMetricDefinitionInput): Promise<string> {
    const now = Date.now();
    const id =
      input.id ??
      `md-${deterministicId('metric-definition', input.metricId, String(input.version))}`;
    const comparabilityGroupId = deriveMetricComparabilityGroupId(
      MetricDefinitionStore.toComparabilityInput(input),
    );
    await queryable.exec(
      `INSERT INTO metric_definitions (
        id, metric_id, version, label, description, family, measurement_class, unit, value_type,
        grain, dimensions, denominator, population_rule, status_rule, aggregation, allocation_method,
        statistical_policy_id, attribution_policy_id, comparability_group_inputs, missing_data_behavior,
        root_inclusion, distribution_policy, provenance_requirement, comparability_group_id,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.metricId,
        input.version,
        input.label,
        input.description,
        input.family,
        input.measurementClass,
        input.unit,
        input.valueType,
        input.grain,
        fromStringList(input.dimensions),
        input.denominator ?? null,
        input.populationRule,
        input.statusRule,
        input.aggregation,
        input.allocationMethod ?? null,
        input.statisticalPolicyId,
        input.attributionPolicyId ?? null,
        fromStringList(input.comparabilityGroupInputs),
        input.missingDataBehavior,
        input.rootInclusion,
        input.distributionPolicy ?? null,
        input.provenanceRequirement,
        comparabilityGroupId,
        input.createdAt ?? now,
        input.updatedAt ?? now,
      ],
    );
    return id;
  }

  static async getById(
    queryable: Queryable,
    id: string,
  ): Promise<StoredMetricDefinition | undefined> {
    const { rows } = await queryable.exec(
      `SELECT ${MetricDefinitionStore.selectColumns} FROM metric_definitions WHERE id = ?`,
      [id],
    );
    if (rows.length === 0) return undefined;
    return MetricDefinitionStore.rowToStoredMetricDefinition(rows[0]);
  }

  static async getByMetricIdAndVersion(
    queryable: Queryable,
    metricId: string,
    version: number,
  ): Promise<StoredMetricDefinition | undefined> {
    const { rows } = await queryable.exec(
      `SELECT ${MetricDefinitionStore.selectColumns}
       FROM metric_definitions
       WHERE metric_id = ? AND version = ?`,
      [metricId, version],
    );
    if (rows.length === 0) return undefined;
    return MetricDefinitionStore.rowToStoredMetricDefinition(rows[0]);
  }

  static async listByFamily(
    queryable: Queryable,
    family: string,
  ): Promise<readonly StoredMetricDefinition[]> {
    const { rows } = await queryable.exec(
      `SELECT ${MetricDefinitionStore.selectColumns}
       FROM metric_definitions
       WHERE family = ?
       ORDER BY metric_id, version`,
      [family],
    );
    return rows.map(MetricDefinitionStore.rowToStoredMetricDefinition);
  }

  static async listByComparabilityGroup(
    queryable: Queryable,
    comparabilityGroupId: string,
  ): Promise<readonly StoredMetricDefinition[]> {
    const { rows } = await queryable.exec(
      `SELECT ${MetricDefinitionStore.selectColumns}
       FROM metric_definitions
       WHERE comparability_group_id = ?
       ORDER BY metric_id, version`,
      [comparabilityGroupId],
    );
    return rows.map(MetricDefinitionStore.rowToStoredMetricDefinition);
  }

  static async update(
    queryable: Queryable,
    id: string,
    input: UpdateMetricDefinitionInput,
  ): Promise<void> {
    await queryable.exec(
      `UPDATE metric_definitions
       SET label = ?, description = ?, updated_at = ?
       WHERE id = ?`,
      [input.label, input.description, input.updatedAt ?? Date.now(), id],
    );
  }

  static async delete(queryable: Queryable, id: string): Promise<void> {
    await queryable.exec('DELETE FROM metric_definitions WHERE id = ?', [id]);
  }
}

export interface TransformerMetricCapability {
  readonly id: string;
  readonly transformerId: string;
  readonly harness: string;
  readonly transformerVersion: string;
  readonly ontologyVersion: string;
  readonly metricDefinitionId: string;
  readonly capability: CapabilityStatus;
  readonly reason: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface InsertTransformerMetricCapabilityInput {
  readonly id?: string;
  readonly transformerId: string;
  readonly harness: string;
  readonly transformerVersion: string;
  readonly ontologyVersion: string;
  readonly metricDefinitionId: string;
  readonly capability: CapabilityStatus;
  readonly reason?: string | null;
  readonly createdAt?: number;
  readonly updatedAt?: number;
}

// biome-ignore lint/complexity/noStaticOnlyClass: typed metrics store
export class TransformerMetricCapabilityStore {
  private static rowToTransformerMetricCapability(row: SqliteRow): TransformerMetricCapability {
    return {
      id: asString(row.id),
      transformerId: asString(row.transformer_id),
      harness: asString(row.harness),
      transformerVersion: asString(row.transformer_version),
      ontologyVersion: asString(row.ontology_version),
      metricDefinitionId: asString(row.metric_definition_id),
      capability: asString(row.capability) as CapabilityStatus,
      reason: toOptionalString(row.reason),
      createdAt: toNumber(row.created_at),
      updatedAt: toNumber(row.updated_at),
    };
  }

  static async insert(
    queryable: Queryable,
    input: InsertTransformerMetricCapabilityInput,
  ): Promise<string> {
    const now = Date.now();
    const id =
      input.id ??
      `tc-${deterministicId(
        'transformer-metric-capability',
        input.transformerId,
        input.harness,
        input.transformerVersion,
        input.ontologyVersion,
        input.metricDefinitionId,
      )}`;
    await queryable.exec(
      `INSERT INTO transformer_metric_capabilities (
        id, transformer_id, harness, transformer_version, ontology_version, metric_definition_id,
        capability, reason, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.transformerId,
        input.harness,
        input.transformerVersion,
        input.ontologyVersion,
        input.metricDefinitionId,
        input.capability,
        input.reason ?? null,
        input.createdAt ?? now,
        input.updatedAt ?? now,
      ],
    );
    return id;
  }

  static async getById(
    queryable: Queryable,
    id: string,
  ): Promise<TransformerMetricCapability | undefined> {
    const { rows } = await queryable.exec(
      'SELECT * FROM transformer_metric_capabilities WHERE id = ?',
      [id],
    );
    if (rows.length === 0) return undefined;
    return TransformerMetricCapabilityStore.rowToTransformerMetricCapability(rows[0]);
  }

  static async listByMetricDefinition(
    queryable: Queryable,
    metricDefinitionId: string,
  ): Promise<readonly TransformerMetricCapability[]> {
    const { rows } = await queryable.exec(
      `SELECT *
       FROM transformer_metric_capabilities
       WHERE metric_definition_id = ?
       ORDER BY created_at`,
      [metricDefinitionId],
    );
    return rows.map(TransformerMetricCapabilityStore.rowToTransformerMetricCapability);
  }

  static async listByTransformer(
    queryable: Queryable,
    transformerId: string,
    harness: string,
    transformerVersion: string,
    ontologyVersion: string,
  ): Promise<readonly TransformerMetricCapability[]> {
    const { rows } = await queryable.exec(
      `SELECT *
       FROM transformer_metric_capabilities
       WHERE transformer_id = ? AND harness = ? AND transformer_version = ? AND ontology_version = ?
       ORDER BY created_at`,
      [transformerId, harness, transformerVersion, ontologyVersion],
    );
    return rows.map(TransformerMetricCapabilityStore.rowToTransformerMetricCapability);
  }

  static async update(
    queryable: Queryable,
    id: string,
    input: {
      readonly capability: CapabilityStatus;
      readonly reason?: string | null;
      readonly updatedAt?: number;
    },
  ): Promise<void> {
    await queryable.exec(
      `UPDATE transformer_metric_capabilities
       SET capability = ?, reason = ?, updated_at = ?
       WHERE id = ?`,
      [input.capability, input.reason ?? null, input.updatedAt ?? Date.now(), id],
    );
  }

  static async delete(queryable: Queryable, id: string): Promise<void> {
    await queryable.exec('DELETE FROM transformer_metric_capabilities WHERE id = ?', [id]);
  }
}

export interface MetricValue {
  readonly id: string;
  readonly metricDefinitionId: string;
  readonly comparabilityGroupId: string;
  readonly generationId: string;
  readonly sessionId: string | null;
  readonly invocationId: string | null;
  readonly entityType: string | null;
  readonly entityId: string | null;
  readonly dimensionsKey: string | null;
  readonly valueType: ValueType;
  readonly integerValue: number | null;
  readonly numericValue: number | null;
  readonly textValue: string | null;
  readonly valueClass: MetricValueClass;
  readonly confidence: number | null;
  readonly rootInclusion: RootInclusion;
  readonly isUnavailable: boolean;
  readonly unavailableReason: string | null;
  readonly isNotApplicable: boolean;
  readonly notApplicableReason: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface InsertMetricValueInput {
  readonly id?: string;
  readonly metricDefinitionId: string;
  readonly comparabilityGroupId?: string;
  readonly generationId: string;
  readonly sessionId?: string | null;
  readonly invocationId?: string | null;
  readonly entityType?: string | null;
  readonly entityId?: string | null;
  readonly dimensionsKey?: string | null;
  readonly valueType: ValueType;
  readonly integerValue?: number | null;
  readonly numericValue?: number | null;
  readonly textValue?: string | null;
  readonly valueClass: MetricValueClass;
  readonly confidence?: number | null;
  readonly rootInclusion: RootInclusion;
  readonly isUnavailable?: boolean;
  readonly unavailableReason?: string | null;
  readonly isNotApplicable?: boolean;
  readonly notApplicableReason?: string | null;
  readonly createdAt?: number;
  readonly updatedAt?: number;
}

// biome-ignore lint/complexity/noStaticOnlyClass: typed metrics store
export class MetricValueStore {
  private static selectColumns = `
    id, metric_definition_id, comparability_group_id, generation_id, session_id, invocation_id,
    entity_type, entity_id, dimensions_key, value_type, integer_value, numeric_value, text_value,
    value_class, confidence, root_inclusion, is_unavailable, unavailable_reason, is_not_applicable,
    not_applicable_reason, created_at, updated_at
  `;

  private static rowToMetricValue(row: SqliteRow): MetricValue {
    return {
      id: asString(row.id),
      metricDefinitionId: asString(row.metric_definition_id),
      comparabilityGroupId: asString(row.comparability_group_id),
      generationId: asString(row.generation_id),
      sessionId: toOptionalString(row.session_id),
      invocationId: toOptionalString(row.invocation_id),
      entityType: toOptionalString(row.entity_type),
      entityId: toOptionalString(row.entity_id),
      dimensionsKey: toOptionalString(row.dimensions_key),
      valueType: asString(row.value_type) as ValueType,
      integerValue: toOptionalNumber(row.integer_value),
      numericValue: toOptionalNumber(row.numeric_value),
      textValue: toOptionalString(row.text_value),
      valueClass: asString(row.value_class) as MetricValueClass,
      confidence: toOptionalNumber(row.confidence),
      rootInclusion: asString(row.root_inclusion) as RootInclusion,
      isUnavailable: toBoolean(row.is_unavailable),
      unavailableReason: toOptionalString(row.unavailable_reason),
      isNotApplicable: toBoolean(row.is_not_applicable),
      notApplicableReason: toOptionalString(row.not_applicable_reason),
      createdAt: toNumber(row.created_at),
      updatedAt: toNumber(row.updated_at),
    };
  }

  private static async requireDefinition(
    queryable: Queryable,
    metricDefinitionId: string,
  ): Promise<StoredMetricDefinition> {
    const def = await MetricDefinitionStore.getById(queryable, metricDefinitionId);
    if (!def) {
      throw new Error(`Metric definition not found: ${metricDefinitionId}`);
    }
    return def;
  }

  static async insert(queryable: Queryable, input: InsertMetricValueInput): Promise<string> {
    const now = Date.now();
    const definition = await MetricValueStore.requireDefinition(
      queryable,
      input.metricDefinitionId,
    );
    const expectedGroup = deriveMetricComparabilityGroupId({
      metricId: definition.metricId,
      version: definition.version,
      unit: definition.unit,
      valueType: definition.valueType,
      grain: definition.grain,
      dimensions: definition.dimensions,
      denominator: definition.denominator,
      populationRule: definition.populationRule,
      statusRule: definition.statusRule,
      aggregation: definition.aggregation,
      allocationMethod: definition.allocationMethod,
      statisticalPolicyId: definition.statisticalPolicyId,
      attributionPolicyId: definition.attributionPolicyId,
      missingDataBehavior: definition.missingDataBehavior,
      rootInclusion: definition.rootInclusion,
      distributionPolicy: definition.distributionPolicy,
      valueClass: input.valueClass,
    });
    const comparabilityGroupId = input.comparabilityGroupId ?? expectedGroup;
    if (input.comparabilityGroupId !== undefined && input.comparabilityGroupId !== expectedGroup) {
      throw new Error(
        `Comparability group mismatch for metric value: expected ${expectedGroup}, got ${input.comparabilityGroupId}`,
      );
    }
    const id =
      input.id ??
      `mv-${deterministicId(
        'metric-value',
        input.metricDefinitionId,
        input.valueClass,
        comparabilityGroupId,
        input.sessionId ?? '',
        input.generationId,
        input.dimensionsKey ?? '',
        String(now),
      )}`;
    await queryable.exec(
      `INSERT INTO metric_values (
        id, metric_definition_id, comparability_group_id, generation_id, session_id, invocation_id,
        entity_type, entity_id, dimensions_key, value_type, integer_value, numeric_value, text_value,
        value_class, confidence, root_inclusion, is_unavailable, unavailable_reason, is_not_applicable,
        not_applicable_reason, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.metricDefinitionId,
        comparabilityGroupId,
        input.generationId,
        input.sessionId ?? null,
        input.invocationId ?? null,
        input.entityType ?? null,
        input.entityId ?? null,
        input.dimensionsKey ?? null,
        input.valueType,
        input.integerValue ?? null,
        input.numericValue ?? null,
        input.textValue ?? null,
        input.valueClass,
        input.confidence ?? null,
        input.rootInclusion,
        input.isUnavailable ? 1 : 0,
        input.unavailableReason ?? null,
        input.isNotApplicable ? 1 : 0,
        input.notApplicableReason ?? null,
        input.createdAt ?? now,
        input.updatedAt ?? now,
      ],
    );
    return id;
  }

  static async getById(queryable: Queryable, id: string): Promise<MetricValue | undefined> {
    const { rows } = await queryable.exec(
      `SELECT ${MetricValueStore.selectColumns} FROM metric_values WHERE id = ?`,
      [id],
    );
    if (rows.length === 0) return undefined;
    return MetricValueStore.rowToMetricValue(rows[0]);
  }

  static async getByIdAndGroup(
    queryable: Queryable,
    id: string,
    comparabilityGroupId: string,
  ): Promise<MetricValue | undefined> {
    const { rows } = await queryable.exec(
      `SELECT ${MetricValueStore.selectColumns}
       FROM metric_values
       WHERE id = ? AND comparability_group_id = ?`,
      [id, comparabilityGroupId],
    );
    if (rows.length === 0) return undefined;
    return MetricValueStore.rowToMetricValue(rows[0]);
  }

  static async listByMetricDefinition(
    queryable: Queryable,
    metricDefinitionId: string,
  ): Promise<readonly MetricValue[]> {
    const { rows } = await queryable.exec(
      `SELECT ${MetricValueStore.selectColumns}
       FROM metric_values
       WHERE metric_definition_id = ?
       ORDER BY created_at`,
      [metricDefinitionId],
    );
    return rows.map(MetricValueStore.rowToMetricValue);
  }

  static async listBySession(
    queryable: Queryable,
    sessionId: string,
  ): Promise<readonly MetricValue[]> {
    const { rows } = await queryable.exec(
      `SELECT ${MetricValueStore.selectColumns}
       FROM metric_values
       WHERE session_id = ?
       ORDER BY created_at`,
      [sessionId],
    );
    return rows.map(MetricValueStore.rowToMetricValue);
  }

  static async listByComparabilityGroup(
    queryable: Queryable,
    comparabilityGroupId: string,
  ): Promise<readonly MetricValue[]> {
    const { rows } = await queryable.exec(
      `SELECT ${MetricValueStore.selectColumns}
       FROM metric_values
       WHERE comparability_group_id = ?
       ORDER BY created_at`,
      [comparabilityGroupId],
    );
    return rows.map(MetricValueStore.rowToMetricValue);
  }

  static async listByDefinitionAndGroup(
    queryable: Queryable,
    metricDefinitionId: string,
    comparabilityGroupId: string,
  ): Promise<readonly MetricValue[]> {
    const { rows } = await queryable.exec(
      `SELECT ${MetricValueStore.selectColumns}
       FROM metric_values
       WHERE metric_definition_id = ? AND comparability_group_id = ?
       ORDER BY created_at`,
      [metricDefinitionId, comparabilityGroupId],
    );
    return rows.map(MetricValueStore.rowToMetricValue);
  }

  static async update(
    queryable: Queryable,
    id: string,
    input: {
      readonly integerValue?: number | null;
      readonly numericValue?: number | null;
      readonly textValue?: string | null;
      readonly confidence?: number | null;
      readonly isUnavailable?: boolean;
      readonly unavailableReason?: string | null;
      readonly isNotApplicable?: boolean;
      readonly notApplicableReason?: string | null;
      readonly updatedAt?: number;
    },
  ): Promise<void> {
    await queryable.exec(
      `UPDATE metric_values
       SET integer_value = ?, numeric_value = ?, text_value = ?, confidence = ?,
           is_unavailable = ?, unavailable_reason = ?, is_not_applicable = ?,
           not_applicable_reason = ?, updated_at = ?
       WHERE id = ?`,
      [
        input.integerValue ?? null,
        input.numericValue ?? null,
        input.textValue ?? null,
        input.confidence ?? null,
        input.isUnavailable ? 1 : 0,
        input.unavailableReason ?? null,
        input.isNotApplicable ? 1 : 0,
        input.notApplicableReason ?? null,
        input.updatedAt ?? Date.now(),
        id,
      ],
    );
  }

  static async delete(queryable: Queryable, id: string): Promise<void> {
    await queryable.exec('DELETE FROM metric_values WHERE id = ?', [id]);
  }
}

export interface MetricDistribution {
  readonly id: string;
  readonly metricDefinitionId: string;
  readonly comparabilityGroupId: string;
  readonly statisticalPolicyId: string;
  readonly attributionPolicyId: string | null;
  readonly generationId: string;
  readonly eligibleN: number;
  readonly knownN: number;
  readonly unknownCount: number;
  readonly sum: number | null;
  readonly min: number | null;
  readonly max: number | null;
  readonly mean: number | null;
  readonly p50: number | null;
  readonly p75: number | null;
  readonly p90: number | null;
  readonly p95: number | null;
  readonly dispersion: number | null;
  readonly outlierRule: string | null;
  readonly coverage: number | null;
  readonly dimensionsKey: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface InsertMetricDistributionInput {
  readonly id?: string;
  readonly metricDefinitionId: string;
  readonly comparabilityGroupId: string;
  readonly statisticalPolicyId: string;
  readonly attributionPolicyId?: string | null;
  readonly generationId: string;
  readonly eligibleN: number;
  readonly knownN: number;
  readonly unknownCount: number;
  readonly sum?: number | null;
  readonly min?: number | null;
  readonly max?: number | null;
  readonly mean?: number | null;
  readonly p50?: number | null;
  readonly p75?: number | null;
  readonly p90?: number | null;
  readonly p95?: number | null;
  readonly dispersion?: number | null;
  readonly outlierRule?: string | null;
  readonly coverage?: number | null;
  readonly dimensionsKey?: string | null;
  readonly createdAt?: number;
  readonly updatedAt?: number;
}

// biome-ignore lint/complexity/noStaticOnlyClass: typed metrics store
export class MetricDistributionStore {
  private static selectColumns = `
    id, metric_definition_id, comparability_group_id, statistical_policy_id, attribution_policy_id,
    generation_id, eligible_n, known_n, unknown_count, sum, min, max, mean, p50, p75, p90, p95,
    dispersion, outlier_rule, coverage, dimensions_key, created_at, updated_at
  `;

  private static rowToMetricDistribution(row: SqliteRow): MetricDistribution {
    return {
      id: asString(row.id),
      metricDefinitionId: asString(row.metric_definition_id),
      comparabilityGroupId: asString(row.comparability_group_id),
      statisticalPolicyId: asString(row.statistical_policy_id),
      attributionPolicyId: toOptionalString(row.attribution_policy_id),
      generationId: asString(row.generation_id),
      eligibleN: toNumber(row.eligible_n),
      knownN: toNumber(row.known_n),
      unknownCount: toNumber(row.unknown_count),
      sum: toOptionalNumber(row.sum),
      min: toOptionalNumber(row.min),
      max: toOptionalNumber(row.max),
      mean: toOptionalNumber(row.mean),
      p50: toOptionalNumber(row.p50),
      p75: toOptionalNumber(row.p75),
      p90: toOptionalNumber(row.p90),
      p95: toOptionalNumber(row.p95),
      dispersion: toOptionalNumber(row.dispersion),
      outlierRule: toOptionalString(row.outlier_rule),
      coverage: toOptionalNumber(row.coverage),
      dimensionsKey: toOptionalString(row.dimensions_key),
      createdAt: toNumber(row.created_at),
      updatedAt: toNumber(row.updated_at),
    };
  }

  static async insert(queryable: Queryable, input: InsertMetricDistributionInput): Promise<string> {
    const now = Date.now();
    const id =
      input.id ??
      `mdist-${deterministicId('metric-distribution', input.metricDefinitionId, input.comparabilityGroupId, String(now))}`;
    await queryable.exec(
      `INSERT INTO metric_distributions (
        id, metric_definition_id, comparability_group_id, statistical_policy_id, attribution_policy_id,
        generation_id, eligible_n, known_n, unknown_count, sum, min, max, mean, p50, p75, p90, p95,
        dispersion, outlier_rule, coverage, dimensions_key, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.metricDefinitionId,
        input.comparabilityGroupId,
        input.statisticalPolicyId,
        input.attributionPolicyId ?? null,
        input.generationId,
        input.eligibleN,
        input.knownN,
        input.unknownCount,
        input.sum ?? null,
        input.min ?? null,
        input.max ?? null,
        input.mean ?? null,
        input.p50 ?? null,
        input.p75 ?? null,
        input.p90 ?? null,
        input.p95 ?? null,
        input.dispersion ?? null,
        input.outlierRule ?? null,
        input.coverage ?? null,
        input.dimensionsKey ?? null,
        input.createdAt ?? now,
        input.updatedAt ?? now,
      ],
    );
    return id;
  }

  static async getById(queryable: Queryable, id: string): Promise<MetricDistribution | undefined> {
    const { rows } = await queryable.exec(
      `SELECT ${MetricDistributionStore.selectColumns} FROM metric_distributions WHERE id = ?`,
      [id],
    );
    if (rows.length === 0) return undefined;
    return MetricDistributionStore.rowToMetricDistribution(rows[0]);
  }

  static async listByMetricDefinition(
    queryable: Queryable,
    metricDefinitionId: string,
  ): Promise<readonly MetricDistribution[]> {
    const { rows } = await queryable.exec(
      `SELECT ${MetricDistributionStore.selectColumns}
       FROM metric_distributions
       WHERE metric_definition_id = ?
       ORDER BY created_at`,
      [metricDefinitionId],
    );
    return rows.map(MetricDistributionStore.rowToMetricDistribution);
  }

  static async listByComparabilityGroup(
    queryable: Queryable,
    comparabilityGroupId: string,
  ): Promise<readonly MetricDistribution[]> {
    const { rows } = await queryable.exec(
      `SELECT ${MetricDistributionStore.selectColumns}
       FROM metric_distributions
       WHERE comparability_group_id = ?
       ORDER BY created_at`,
      [comparabilityGroupId],
    );
    return rows.map(MetricDistributionStore.rowToMetricDistribution);
  }

  static async listByDefinitionAndGroup(
    queryable: Queryable,
    metricDefinitionId: string,
    comparabilityGroupId: string,
  ): Promise<readonly MetricDistribution[]> {
    const { rows } = await queryable.exec(
      `SELECT ${MetricDistributionStore.selectColumns}
       FROM metric_distributions
       WHERE metric_definition_id = ? AND comparability_group_id = ?
       ORDER BY created_at`,
      [metricDefinitionId, comparabilityGroupId],
    );
    return rows.map(MetricDistributionStore.rowToMetricDistribution);
  }

  static async update(
    queryable: Queryable,
    id: string,
    input: {
      readonly eligibleN: number;
      readonly knownN: number;
      readonly unknownCount: number;
      readonly sum?: number | null;
      readonly min?: number | null;
      readonly max?: number | null;
      readonly mean?: number | null;
      readonly p50?: number | null;
      readonly p75?: number | null;
      readonly p90?: number | null;
      readonly p95?: number | null;
      readonly dispersion?: number | null;
      readonly outlierRule?: string | null;
      readonly coverage?: number | null;
      readonly updatedAt?: number;
    },
  ): Promise<void> {
    await queryable.exec(
      `UPDATE metric_distributions
       SET eligible_n = ?, known_n = ?, unknown_count = ?, sum = ?, min = ?, max = ?, mean = ?,
           p50 = ?, p75 = ?, p90 = ?, p95 = ?, dispersion = ?, outlier_rule = ?, coverage = ?,
           updated_at = ?
       WHERE id = ?`,
      [
        input.eligibleN,
        input.knownN,
        input.unknownCount,
        input.sum ?? null,
        input.min ?? null,
        input.max ?? null,
        input.mean ?? null,
        input.p50 ?? null,
        input.p75 ?? null,
        input.p90 ?? null,
        input.p95 ?? null,
        input.dispersion ?? null,
        input.outlierRule ?? null,
        input.coverage ?? null,
        input.updatedAt ?? Date.now(),
        id,
      ],
    );
  }

  static async delete(queryable: Queryable, id: string): Promise<void> {
    await queryable.exec('DELETE FROM metric_distributions WHERE id = ?', [id]);
  }
}

export interface MetricProvenance {
  readonly id: string;
  readonly metricValueId: string | null;
  readonly distributionId: string | null;
  readonly sourceArtifactId: string | null;
  readonly sourceEventId: string | null;
  readonly sourceField: string;
  readonly estimationMethod: string | null;
  readonly allocationMethod: string | null;
  readonly generationId: string;
  readonly createdAt: number;
}

export interface InsertMetricProvenanceInput {
  readonly id?: string;
  readonly metricValueId?: string | null;
  readonly distributionId?: string | null;
  readonly sourceArtifactId?: string | null;
  readonly sourceEventId?: string | null;
  readonly sourceField: string;
  readonly estimationMethod?: string | null;
  readonly allocationMethod?: string | null;
  readonly generationId: string;
  readonly createdAt?: number;
}

// biome-ignore lint/complexity/noStaticOnlyClass: typed metrics store
export class MetricProvenanceStore {
  private static rowToMetricProvenance(row: SqliteRow): MetricProvenance {
    return {
      id: asString(row.id),
      metricValueId: toOptionalString(row.metric_value_id),
      distributionId: toOptionalString(row.distribution_id),
      sourceArtifactId: toOptionalString(row.source_artifact_id),
      sourceEventId: toOptionalString(row.source_event_id),
      sourceField: asString(row.source_field),
      estimationMethod: toOptionalString(row.estimation_method),
      allocationMethod: toOptionalString(row.allocation_method),
      generationId: asString(row.generation_id),
      createdAt: toNumber(row.created_at),
    };
  }

  static async insert(queryable: Queryable, input: InsertMetricProvenanceInput): Promise<string> {
    const now = Date.now();
    const hasValue = input.metricValueId ? 1 : 0;
    const hasDistribution = input.distributionId ? 1 : 0;
    if (hasValue + hasDistribution !== 1) {
      throw new Error('Provenance requires exactly one of metricValueId or distributionId');
    }
    const id =
      input.id ??
      `mpv-${deterministicId(
        'metric-provenance',
        input.metricValueId ?? input.distributionId ?? '',
        input.sourceField,
        String(now),
      )}`;
    await queryable.exec(
      `INSERT INTO metric_provenance (
        id, metric_value_id, distribution_id, source_artifact_id, source_event_id, source_field,
        estimation_method, allocation_method, generation_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.metricValueId ?? null,
        input.distributionId ?? null,
        input.sourceArtifactId ?? null,
        input.sourceEventId ?? null,
        input.sourceField,
        input.estimationMethod ?? null,
        input.allocationMethod ?? null,
        input.generationId,
        input.createdAt ?? now,
      ],
    );
    return id;
  }

  static async getById(queryable: Queryable, id: string): Promise<MetricProvenance | undefined> {
    const { rows } = await queryable.exec('SELECT * FROM metric_provenance WHERE id = ?', [id]);
    if (rows.length === 0) return undefined;
    return MetricProvenanceStore.rowToMetricProvenance(rows[0]);
  }

  static async listByMetricValue(
    queryable: Queryable,
    metricValueId: string,
  ): Promise<readonly MetricProvenance[]> {
    const { rows } = await queryable.exec(
      `SELECT *
       FROM metric_provenance
       WHERE metric_value_id = ?
       ORDER BY created_at`,
      [metricValueId],
    );
    return rows.map(MetricProvenanceStore.rowToMetricProvenance);
  }

  static async listByDistribution(
    queryable: Queryable,
    distributionId: string,
  ): Promise<readonly MetricProvenance[]> {
    const { rows } = await queryable.exec(
      `SELECT *
       FROM metric_provenance
       WHERE distribution_id = ?
       ORDER BY created_at`,
      [distributionId],
    );
    return rows.map(MetricProvenanceStore.rowToMetricProvenance);
  }

  static async delete(queryable: Queryable, id: string): Promise<void> {
    await queryable.exec('DELETE FROM metric_provenance WHERE id = ?', [id]);
  }
}

export interface NativeMetricValue {
  readonly id: string;
  readonly nativeMetricId: string;
  readonly namespace: string;
  readonly transformerId: string | null;
  readonly harness: string | null;
  readonly transformerVersion: string | null;
  readonly ontologyVersion: string | null;
  readonly valueType: ValueType;
  readonly integerValue: number | null;
  readonly numericValue: number | null;
  readonly textValue: string | null;
  readonly valueClass: MetricValueClass;
  readonly confidence: number | null;
  readonly sessionId: string | null;
  readonly invocationId: string | null;
  readonly entityType: string | null;
  readonly entityId: string | null;
  readonly dimensionsKey: string | null;
  readonly isUnavailable: boolean;
  readonly unavailableReason: string | null;
  readonly isNotApplicable: boolean;
  readonly notApplicableReason: string | null;
  readonly estimationMethod: string | null;
  readonly comparabilityGroupId: string;
  readonly generationId: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface InsertNativeMetricValueInput {
  readonly id?: string;
  readonly nativeMetricId: string;
  readonly namespace?: string;
  readonly transformerId?: string | null;
  readonly harness?: string | null;
  readonly transformerVersion?: string | null;
  readonly ontologyVersion?: string | null;
  readonly valueType: ValueType;
  readonly integerValue?: number | null;
  readonly numericValue?: number | null;
  readonly textValue?: string | null;
  readonly valueClass: MetricValueClass;
  readonly confidence?: number | null;
  readonly sessionId?: string | null;
  readonly invocationId?: string | null;
  readonly entityType?: string | null;
  readonly entityId?: string | null;
  readonly dimensionsKey?: string | null;
  readonly isUnavailable?: boolean;
  readonly unavailableReason?: string | null;
  readonly isNotApplicable?: boolean;
  readonly notApplicableReason?: string | null;
  readonly estimationMethod?: string | null;
  readonly comparabilityGroupId?: string;
  readonly generationId?: string | null;
  readonly createdAt?: number;
  readonly updatedAt?: number;
}

// biome-ignore lint/complexity/noStaticOnlyClass: typed metrics store
export class NativeMetricValueStore {
  private static selectColumns = `
    id, native_metric_id, namespace, transformer_id, harness, transformer_version, ontology_version,
    value_type, integer_value, numeric_value, text_value, value_class, confidence, session_id,
    invocation_id, entity_type, entity_id, dimensions_key, is_unavailable, unavailable_reason,
    is_not_applicable, not_applicable_reason, estimation_method, comparability_group_id,
    generation_id, created_at, updated_at
  `;

  private static rowToNativeMetricValue(row: SqliteRow): NativeMetricValue {
    return {
      id: asString(row.id),
      nativeMetricId: asString(row.native_metric_id),
      namespace: asString(row.namespace),
      transformerId: toOptionalString(row.transformer_id),
      harness: toOptionalString(row.harness),
      transformerVersion: toOptionalString(row.transformer_version),
      ontologyVersion: toOptionalString(row.ontology_version),
      valueType: asString(row.value_type) as ValueType,
      integerValue: toOptionalNumber(row.integer_value),
      numericValue: toOptionalNumber(row.numeric_value),
      textValue: toOptionalString(row.text_value),
      valueClass: asString(row.value_class) as MetricValueClass,
      confidence: toOptionalNumber(row.confidence),
      sessionId: toOptionalString(row.session_id),
      invocationId: toOptionalString(row.invocation_id),
      entityType: toOptionalString(row.entity_type),
      entityId: toOptionalString(row.entity_id),
      dimensionsKey: toOptionalString(row.dimensions_key),
      isUnavailable: toBoolean(row.is_unavailable),
      unavailableReason: toOptionalString(row.unavailable_reason),
      isNotApplicable: toBoolean(row.is_not_applicable),
      notApplicableReason: toOptionalString(row.not_applicable_reason),
      estimationMethod: toOptionalString(row.estimation_method),
      comparabilityGroupId: asString(row.comparability_group_id),
      generationId: toOptionalString(row.generation_id),
      createdAt: toNumber(row.created_at),
      updatedAt: toNumber(row.updated_at),
    };
  }

  static async insert(queryable: Queryable, input: InsertNativeMetricValueInput): Promise<string> {
    const now = Date.now();
    const comparabilityGroupId =
      input.comparabilityGroupId ??
      deriveNativeMetricComparabilityGroupId({
        nativeMetricId: input.nativeMetricId,
        valueClass: input.valueClass,
        estimationMethod: input.estimationMethod,
        transformerId: input.transformerId,
        transformerVersion: input.transformerVersion,
      });
    const namespace =
      input.namespace ?? (input.nativeMetricId.split('.').slice(0, -1).join('.') || 'native');
    const id =
      input.id ??
      `nmv-${deterministicId('native-metric-value', input.nativeMetricId, String(now))}`;
    await queryable.exec(
      `INSERT INTO native_metric_values (
        id, native_metric_id, namespace, transformer_id, harness, transformer_version, ontology_version,
        value_type, integer_value, numeric_value, text_value, value_class, confidence, session_id,
        invocation_id, entity_type, entity_id, dimensions_key, is_unavailable, unavailable_reason,
        is_not_applicable, not_applicable_reason, estimation_method, comparability_group_id,
        generation_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.nativeMetricId,
        namespace,
        input.transformerId ?? null,
        input.harness ?? null,
        input.transformerVersion ?? null,
        input.ontologyVersion ?? null,
        input.valueType,
        input.integerValue ?? null,
        input.numericValue ?? null,
        input.textValue ?? null,
        input.valueClass,
        input.confidence ?? null,
        input.sessionId ?? null,
        input.invocationId ?? null,
        input.entityType ?? null,
        input.entityId ?? null,
        input.dimensionsKey ?? null,
        input.isUnavailable ? 1 : 0,
        input.unavailableReason ?? null,
        input.isNotApplicable ? 1 : 0,
        input.notApplicableReason ?? null,
        input.estimationMethod ?? null,
        comparabilityGroupId,
        input.generationId ?? null,
        input.createdAt ?? now,
        input.updatedAt ?? now,
      ],
    );
    return id;
  }

  static async getById(queryable: Queryable, id: string): Promise<NativeMetricValue | undefined> {
    const { rows } = await queryable.exec(
      `SELECT ${NativeMetricValueStore.selectColumns} FROM native_metric_values WHERE id = ?`,
      [id],
    );
    if (rows.length === 0) return undefined;
    return NativeMetricValueStore.rowToNativeMetricValue(rows[0]);
  }

  static async listByNativeMetricId(
    queryable: Queryable,
    nativeMetricId: string,
  ): Promise<readonly NativeMetricValue[]> {
    const { rows } = await queryable.exec(
      `SELECT ${NativeMetricValueStore.selectColumns}
       FROM native_metric_values
       WHERE native_metric_id = ?
       ORDER BY created_at`,
      [nativeMetricId],
    );
    return rows.map(NativeMetricValueStore.rowToNativeMetricValue);
  }

  static async listBySession(
    queryable: Queryable,
    sessionId: string,
  ): Promise<readonly NativeMetricValue[]> {
    const { rows } = await queryable.exec(
      `SELECT ${NativeMetricValueStore.selectColumns}
       FROM native_metric_values
       WHERE session_id = ?
       ORDER BY created_at`,
      [sessionId],
    );
    return rows.map(NativeMetricValueStore.rowToNativeMetricValue);
  }

  static async listByComparabilityGroup(
    queryable: Queryable,
    comparabilityGroupId: string,
  ): Promise<readonly NativeMetricValue[]> {
    const { rows } = await queryable.exec(
      `SELECT ${NativeMetricValueStore.selectColumns}
       FROM native_metric_values
       WHERE comparability_group_id = ?
       ORDER BY created_at`,
      [comparabilityGroupId],
    );
    return rows.map(NativeMetricValueStore.rowToNativeMetricValue);
  }

  static async update(
    queryable: Queryable,
    id: string,
    input: {
      readonly integerValue?: number | null;
      readonly numericValue?: number | null;
      readonly textValue?: string | null;
      readonly confidence?: number | null;
      readonly isUnavailable?: boolean;
      readonly unavailableReason?: string | null;
      readonly isNotApplicable?: boolean;
      readonly notApplicableReason?: string | null;
      readonly updatedAt?: number;
    },
  ): Promise<void> {
    await queryable.exec(
      `UPDATE native_metric_values
       SET integer_value = ?, numeric_value = ?, text_value = ?, confidence = ?,
           is_unavailable = ?, unavailable_reason = ?, is_not_applicable = ?,
           not_applicable_reason = ?, updated_at = ?
       WHERE id = ?`,
      [
        input.integerValue ?? null,
        input.numericValue ?? null,
        input.textValue ?? null,
        input.confidence ?? null,
        input.isUnavailable ? 1 : 0,
        input.unavailableReason ?? null,
        input.isNotApplicable ? 1 : 0,
        input.notApplicableReason ?? null,
        input.updatedAt ?? Date.now(),
        id,
      ],
    );
  }

  static async delete(queryable: Queryable, id: string): Promise<void> {
    await queryable.exec('DELETE FROM native_metric_values WHERE id = ?', [id]);
  }
}

export interface HeuristicMetricValue {
  readonly id: string;
  readonly heuristicId: string;
  readonly version: number;
  readonly label: string;
  readonly description: string | null;
  readonly targetMetricDefinitionId: string | null;
  readonly valueType: ValueType;
  readonly integerValue: number | null;
  readonly numericValue: number | null;
  readonly textValue: string | null;
  readonly valueClass: MetricValueClass;
  readonly confidence: number | null;
  readonly sessionId: string | null;
  readonly invocationId: string | null;
  readonly entityType: string | null;
  readonly entityId: string | null;
  readonly dimensionsKey: string | null;
  readonly evidenceJson: string | null;
  readonly isUnavailable: boolean;
  readonly unavailableReason: string | null;
  readonly isNotApplicable: boolean;
  readonly notApplicableReason: string | null;
  readonly comparabilityGroupId: string;
  readonly generationId: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface InsertHeuristicMetricValueInput {
  readonly id?: string;
  readonly heuristicId: string;
  readonly version: number;
  readonly label: string;
  readonly description?: string | null;
  readonly targetMetricDefinitionId?: string | null;
  readonly valueType: ValueType;
  readonly integerValue?: number | null;
  readonly numericValue?: number | null;
  readonly textValue?: string | null;
  readonly valueClass: MetricValueClass;
  readonly confidence?: number | null;
  readonly sessionId?: string | null;
  readonly invocationId?: string | null;
  readonly entityType?: string | null;
  readonly entityId?: string | null;
  readonly dimensionsKey?: string | null;
  readonly evidenceJson?: string | null;
  readonly isUnavailable?: boolean;
  readonly unavailableReason?: string | null;
  readonly isNotApplicable?: boolean;
  readonly notApplicableReason?: string | null;
  readonly comparabilityGroupId?: string;
  readonly generationId?: string | null;
  readonly createdAt?: number;
  readonly updatedAt?: number;
}

// biome-ignore lint/complexity/noStaticOnlyClass: typed metrics store
export class HeuristicMetricValueStore {
  private static selectColumns = `
    id, heuristic_id, version, label, description, target_metric_definition_id, value_type,
    integer_value, numeric_value, text_value, value_class, confidence, session_id, invocation_id,
    entity_type, entity_id, dimensions_key, evidence_json, is_unavailable, unavailable_reason,
    is_not_applicable, not_applicable_reason, comparability_group_id, generation_id,
    created_at, updated_at
  `;

  private static rowToHeuristicMetricValue(row: SqliteRow): HeuristicMetricValue {
    return {
      id: asString(row.id),
      heuristicId: asString(row.heuristic_id),
      version: toNumber(row.version),
      label: asString(row.label),
      description: toOptionalString(row.description),
      targetMetricDefinitionId: toOptionalString(row.target_metric_definition_id),
      valueType: asString(row.value_type) as ValueType,
      integerValue: toOptionalNumber(row.integer_value),
      numericValue: toOptionalNumber(row.numeric_value),
      textValue: toOptionalString(row.text_value),
      valueClass: asString(row.value_class) as MetricValueClass,
      confidence: toOptionalNumber(row.confidence),
      sessionId: toOptionalString(row.session_id),
      invocationId: toOptionalString(row.invocation_id),
      entityType: toOptionalString(row.entity_type),
      entityId: toOptionalString(row.entity_id),
      dimensionsKey: toOptionalString(row.dimensions_key),
      evidenceJson: toOptionalString(row.evidence_json),
      isUnavailable: toBoolean(row.is_unavailable),
      unavailableReason: toOptionalString(row.unavailable_reason),
      isNotApplicable: toBoolean(row.is_not_applicable),
      notApplicableReason: toOptionalString(row.not_applicable_reason),
      comparabilityGroupId: asString(row.comparability_group_id),
      generationId: toOptionalString(row.generation_id),
      createdAt: toNumber(row.created_at),
      updatedAt: toNumber(row.updated_at),
    };
  }

  static async insert(
    queryable: Queryable,
    input: InsertHeuristicMetricValueInput,
  ): Promise<string> {
    const now = Date.now();
    const comparabilityGroupId =
      input.comparabilityGroupId ??
      deriveHeuristicMetricComparabilityGroupId({
        heuristicId: input.heuristicId,
        version: input.version,
        valueClass: input.valueClass,
        targetMetricDefinitionId: input.targetMetricDefinitionId,
      });
    const id =
      input.id ??
      `hmv-${deterministicId('heuristic-metric-value', input.heuristicId, String(input.version), String(now))}`;
    await queryable.exec(
      `INSERT INTO heuristic_metric_values (
        id, heuristic_id, version, label, description, target_metric_definition_id, value_type,
        integer_value, numeric_value, text_value, value_class, confidence, session_id, invocation_id,
        entity_type, entity_id, dimensions_key, evidence_json, is_unavailable, unavailable_reason,
        is_not_applicable, not_applicable_reason, comparability_group_id, generation_id,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.heuristicId,
        input.version,
        input.label,
        input.description ?? null,
        input.targetMetricDefinitionId ?? null,
        input.valueType,
        input.integerValue ?? null,
        input.numericValue ?? null,
        input.textValue ?? null,
        input.valueClass,
        input.confidence ?? null,
        input.sessionId ?? null,
        input.invocationId ?? null,
        input.entityType ?? null,
        input.entityId ?? null,
        input.dimensionsKey ?? null,
        input.evidenceJson ?? null,
        input.isUnavailable ? 1 : 0,
        input.unavailableReason ?? null,
        input.isNotApplicable ? 1 : 0,
        input.notApplicableReason ?? null,
        comparabilityGroupId,
        input.generationId ?? null,
        input.createdAt ?? now,
        input.updatedAt ?? now,
      ],
    );
    return id;
  }

  static async getById(
    queryable: Queryable,
    id: string,
  ): Promise<HeuristicMetricValue | undefined> {
    const { rows } = await queryable.exec(
      `SELECT ${HeuristicMetricValueStore.selectColumns} FROM heuristic_metric_values WHERE id = ?`,
      [id],
    );
    if (rows.length === 0) return undefined;
    return HeuristicMetricValueStore.rowToHeuristicMetricValue(rows[0]);
  }

  static async listByHeuristicId(
    queryable: Queryable,
    heuristicId: string,
  ): Promise<readonly HeuristicMetricValue[]> {
    const { rows } = await queryable.exec(
      `SELECT ${HeuristicMetricValueStore.selectColumns}
       FROM heuristic_metric_values
       WHERE heuristic_id = ?
       ORDER BY version, created_at`,
      [heuristicId],
    );
    return rows.map(HeuristicMetricValueStore.rowToHeuristicMetricValue);
  }

  static async listBySession(
    queryable: Queryable,
    sessionId: string,
  ): Promise<readonly HeuristicMetricValue[]> {
    const { rows } = await queryable.exec(
      `SELECT ${HeuristicMetricValueStore.selectColumns}
       FROM heuristic_metric_values
       WHERE session_id = ?
       ORDER BY created_at`,
      [sessionId],
    );
    return rows.map(HeuristicMetricValueStore.rowToHeuristicMetricValue);
  }

  static async listByComparabilityGroup(
    queryable: Queryable,
    comparabilityGroupId: string,
  ): Promise<readonly HeuristicMetricValue[]> {
    const { rows } = await queryable.exec(
      `SELECT ${HeuristicMetricValueStore.selectColumns}
       FROM heuristic_metric_values
       WHERE comparability_group_id = ?
       ORDER BY created_at`,
      [comparabilityGroupId],
    );
    return rows.map(HeuristicMetricValueStore.rowToHeuristicMetricValue);
  }

  static async update(
    queryable: Queryable,
    id: string,
    input: {
      readonly label: string;
      readonly description?: string | null;
      readonly integerValue?: number | null;
      readonly numericValue?: number | null;
      readonly textValue?: string | null;
      readonly confidence?: number | null;
      readonly isUnavailable?: boolean;
      readonly unavailableReason?: string | null;
      readonly isNotApplicable?: boolean;
      readonly notApplicableReason?: string | null;
      readonly evidenceJson?: string | null;
      readonly updatedAt?: number;
    },
  ): Promise<void> {
    await queryable.exec(
      `UPDATE heuristic_metric_values
       SET label = ?, description = ?, integer_value = ?, numeric_value = ?, text_value = ?,
           confidence = ?, is_unavailable = ?, unavailable_reason = ?, is_not_applicable = ?,
           not_applicable_reason = ?, evidence_json = ?, updated_at = ?
       WHERE id = ?`,
      [
        input.label,
        input.description ?? null,
        input.integerValue ?? null,
        input.numericValue ?? null,
        input.textValue ?? null,
        input.confidence ?? null,
        input.isUnavailable ? 1 : 0,
        input.unavailableReason ?? null,
        input.isNotApplicable ? 1 : 0,
        input.notApplicableReason ?? null,
        input.evidenceJson ?? null,
        input.updatedAt ?? Date.now(),
        id,
      ],
    );
  }

  static async delete(queryable: Queryable, id: string): Promise<void> {
    await queryable.exec('DELETE FROM heuristic_metric_values WHERE id = ?', [id]);
  }
}
