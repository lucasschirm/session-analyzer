import type {
  ContributionScope,
  InsertProjectDailyRollupInput,
  InsertProjectDimensionRollupInput,
  RollupPolicy,
  RootInclusion,
  SqliteExecutor,
  SqliteRow,
  SqliteTransaction,
  SqliteValue,
} from '@lucasschirm/sal-db-core';
import {
  deterministicId,
  PortfolioDailyRollupStore,
  PortfolioDimensionRollupStore,
  ProjectDailyRollupStore,
  ProjectDimensionRollupStore,
  RollupContributionStore,
  RollupPolicyStore,
} from '@lucasschirm/sal-db-core';

type Queryable = SqliteExecutor | SqliteTransaction;

const DAILY_BUCKET_TYPE = 'daily' as const;
const DIMENSION_BUCKET_TYPE = 'dimension' as const;

export interface ApplyRollupContributionsInput {
  readonly sessionId: string;
  readonly generationId: string;
  readonly previousGenerationId?: string;
  readonly analysisReleaseId: string;
  readonly isRoot?: boolean;
  readonly generationToken?: string;
  readonly rollupPolicy?: RollupPolicy;
}

export interface RollupReconciliationMismatch {
  readonly scope: 'project' | 'portfolio';
  readonly bucketType: 'daily' | 'dimension';
  readonly scopeId: string;
  readonly analysisReleaseId: string;
  readonly comparabilityGroupId: string;
  readonly metricDefinitionId: string;
  readonly bucketName: string;
  readonly rollupTotal: number;
  readonly contributionTotal: number;
}

interface SessionContext {
  readonly id: string;
  readonly projectId: string;
  readonly portfolioId: string;
  readonly occurrenceTime: number | null;
  readonly createdAt: number;
  readonly harness: string | null;
  readonly mode: string | null;
  readonly taskCohort: string | null;
}

interface AugmentedMetricValue {
  readonly id: string;
  readonly metricDefinitionId: string;
  readonly comparabilityGroupId: string;
  readonly valueType: 'integer' | 'real' | 'currency' | 'ratio' | 'text';
  readonly integerValue: number | null;
  readonly numericValue: number | null;
  readonly textValue: string | null;
  readonly rootInclusion: RootInclusion;
  readonly dimensionsKey: string | null;
  readonly entityType: string | null;
  readonly entityId: string | null;
  readonly confidence: number | null;
  readonly aggregation: string;
  readonly defDimensions: readonly string[];
  readonly metricId: string;
}

interface AffectedBucketKey {
  readonly scope: 'project' | 'portfolio';
  readonly scopeId: string;
  readonly analysisReleaseId: string;
  readonly bucketType: 'daily' | 'dimension';
  readonly comparabilityGroupId: string;
  readonly metricDefinitionId: string;
  readonly bucketName: string;
}

interface DimensionAggregate {
  readonly value: string | null;
  readonly valueSum: number;
  readonly valueCount: number;
  readonly valueMin: number | null;
  readonly valueMax: number | null;
  readonly valueMean: number | null;
}

interface DimensionRollupRow extends DimensionAggregate {
  readonly dimensionValue: string;
  readonly isOther: boolean;
  readonly isUnknown: boolean;
  readonly topNRank: number | null;
}

function asString(value: SqliteValue): string {
  return value === null || value === undefined ? '' : String(value);
}

function asOptionalString(value: SqliteValue): string | null {
  return value === null || value === undefined ? null : String(value);
}

function asNumber(value: SqliteValue): number {
  return value === null || value === undefined ? 0 : Number(value);
}

function asOptionalNumber(value: SqliteValue): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function parseStringList(value: SqliteValue): readonly string[] {
  if (value === null || value === undefined) return [];
  try {
    const parsed = JSON.parse(String(value));
    if (Array.isArray(parsed)) return parsed.map((v) => String(v));
  } catch {
    // fall through to empty list
  }
  return [];
}

function parseJsonRecord<T extends object>(value: SqliteValue, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  try {
    return JSON.parse(String(value)) as T;
  } catch {
    return fallback;
  }
}

function approxEqual(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-9;
}

function toDayBucket(timestamp: number, timeZone = 'UTC'): string {
  const date = new Date(timestamp);
  if (timeZone === 'UTC') {
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  try {
    const formatted = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
    return formatted;
  } catch {
    return toDayBucket(timestamp, 'UTC');
  }
}

function contributionScopeFor(rootInclusion: RootInclusion): ContributionScope | null {
  if (rootInclusion === 'root_only') return 'root_only';
  if (rootInclusion === 'inclusive' || rootInclusion === 'both') return 'inclusive';
  return null;
}

function numericValueFor(metric: AugmentedMetricValue): number | null {
  if (metric.valueType === 'integer') {
    return metric.integerValue === null ? null : Number(metric.integerValue);
  }
  if (
    metric.valueType === 'real' ||
    metric.valueType === 'currency' ||
    metric.valueType === 'ratio'
  ) {
    return metric.numericValue === null ? null : Number(metric.numericValue);
  }
  return null;
}

function metricDayTimestamp(session: SessionContext): number {
  return session.occurrenceTime ?? session.createdAt ?? Date.now();
}

function supportedDimensionsFor(policy: RollupPolicy): readonly string[] {
  return parseStringList(policy.supportedDimensions);
}

function sessionDimensionValue(session: SessionContext, dimensionName: string): string | null {
  if (dimensionName === 'harness') return session.harness;
  if (dimensionName === 'mode') return session.mode;
  if (dimensionName === 'task_cohort') return session.taskCohort;
  return null;
}

function dimensionValueFor(
  metric: AugmentedMetricValue,
  session: SessionContext,
  dimensionName: string,
  sessionModels?: readonly string[],
): string | null {
  if (metric.defDimensions.length > 0 && metric.defDimensions[0] === dimensionName) {
    return metric.dimensionsKey ?? null;
  }
  if (dimensionName === 'component' && metric.entityType === 'component') {
    return metric.entityId ?? null;
  }
  if (dimensionName === 'model') {
    // The model dimension is resolved from model_requests, not the session
    // row. A session may use multiple models; the caller handles fan-out via
    // sessionModels. When sessionModels is provided, return the first model
    // (the caller iterates over all); when empty, return null so the
    // contribution lands in the Unknown bucket.
    if (sessionModels && sessionModels.length > 0) return sessionModels[0]!;
    return null;
  }
  return sessionDimensionValue(session, dimensionName);
}

const SESSION_SELECT = `
  SELECT s.id, s.project_id, p.portfolio_id, s.occurrence_time, s.created_at,
         s.harness, s.mode, s.task_cohort
  FROM sessions s
  JOIN projects p ON p.id = s.project_id
  WHERE s.id = ?
`;

async function readSessionContext(
  queryable: Queryable,
  sessionId: string,
): Promise<SessionContext> {
  const { rows } = await queryable.exec(SESSION_SELECT, [sessionId]);
  if (rows.length === 0) {
    throw new Error(`Session not found: ${sessionId}`);
  }
  const row = rows[0] as SqliteRow;
  return {
    id: asString(row.id),
    projectId: asString(row.project_id),
    portfolioId: asString(row.portfolio_id),
    occurrenceTime: asOptionalNumber(row.occurrence_time),
    createdAt: asNumber(row.created_at),
    harness: asOptionalString(row.harness),
    mode: asOptionalString(row.mode),
    taskCohort: asOptionalString(row.task_cohort),
  };
}

const SESSION_MODELS_SELECT = `
  SELECT DISTINCT mr.model
  FROM model_requests mr
  WHERE mr.session_id = ?
    AND mr.generation_id = ?
  ORDER BY mr.model
`;

async function readSessionModels(
  queryable: Queryable,
  sessionId: string,
  generationId: string,
): Promise<readonly string[]> {
  const { rows } = await queryable.exec(SESSION_MODELS_SELECT, [sessionId, generationId]);
  return rows.map((row) => asString(row.model)).filter((m) => m.length > 0);
}

const METRIC_VALUE_SELECT = `
  SELECT mv.id, mv.metric_definition_id, mv.comparability_group_id, mv.value_type,
         mv.integer_value, mv.numeric_value, mv.text_value, mv.root_inclusion,
         mv.dimensions_key, mv.entity_type, mv.entity_id, mv.confidence,
         md.aggregation, md.dimensions AS def_dimensions, md.metric_id
  FROM metric_values mv
  JOIN metric_definitions md ON md.id = mv.metric_definition_id
  WHERE mv.session_id = ? AND mv.generation_id = ?
    AND mv.is_unavailable = 0 AND mv.is_not_applicable = 0
    AND LOWER(md.aggregation) = 'sum'
`;

async function listAdditiveMetricValues(
  queryable: Queryable,
  sessionId: string,
  generationId: string,
): Promise<readonly AugmentedMetricValue[]> {
  const { rows } = await queryable.exec(METRIC_VALUE_SELECT, [sessionId, generationId]);
  return rows.map((row) => ({
    id: asString(row.id),
    metricDefinitionId: asString(row.metric_definition_id),
    comparabilityGroupId: asString(row.comparability_group_id),
    valueType: asString(row.value_type) as AugmentedMetricValue['valueType'],
    integerValue: asOptionalNumber(row.integer_value),
    numericValue: asOptionalNumber(row.numeric_value),
    textValue: asOptionalString(row.text_value),
    rootInclusion: asString(row.root_inclusion) as RootInclusion,
    dimensionsKey: asOptionalString(row.dimensions_key),
    entityType: asOptionalString(row.entity_type),
    entityId: asOptionalString(row.entity_id),
    confidence: asOptionalNumber(row.confidence),
    aggregation: asString(row.aggregation),
    defDimensions: parseStringList(row.def_dimensions),
    metricId: asString(row.metric_id),
  }));
}

export function makeDefaultRollupPolicy(analysisReleaseId: string): RollupPolicy {
  const now = Date.now();
  return {
    id: 'rp-default',
    policyId: 'default',
    version: 1,
    name: 'Default rollup policy',
    description: null,
    supportedDimensions: JSON.stringify([
      'model',
      'harness',
      'mode',
      'task_cohort',
      'component',
      'confidence',
    ]),
    cardinalityCaps: JSON.stringify({
      model: 10,
      harness: 10,
      mode: 10,
      task_cohort: 10,
      component: 10,
      confidence: 10,
    }),
    topNBehavior: 'cap',
    otherBucketLabel: 'Other',
    unknownBucketLabel: 'Unknown',
    bucketTimezone: 'UTC',
    analysisReleaseId,
    createdAt: now,
    updatedAt: now,
  };
}

export async function loadOrDefaultRollupPolicy(
  queryable: Queryable,
  analysisReleaseId: string,
  policyId?: string,
  version?: number,
): Promise<RollupPolicy> {
  if (policyId !== undefined && version !== undefined) {
    const stored = await RollupPolicyStore.getByPolicyIdAndVersion(queryable, policyId, version);
    if (stored) return stored;
  }
  const list = await RollupPolicyStore.listByAnalysisRelease(queryable, analysisReleaseId);
  if (list.length > 0) return list[list.length - 1];
  return makeDefaultRollupPolicy(analysisReleaseId);
}

function contributionId(
  input: ApplyRollupContributionsInput,
  comparabilityGroupId: string,
  metricDefinitionId: string,
  scope: ContributionScope,
  bucketType: string,
  bucketName: string,
  bucketValue: string | null,
): string {
  return `ru-${deterministicId(
    'rollup-contribution',
    input.sessionId,
    input.generationId,
    input.analysisReleaseId,
    comparabilityGroupId,
    metricDefinitionId,
    scope,
    bucketType,
    bucketName,
    bucketValue ?? '',
  )}`;
}

interface ContributionGroup {
  readonly projectId: string;
  readonly portfolioId: string | null;
  readonly analysisReleaseId: string;
  readonly comparabilityGroupId: string;
  readonly metricDefinitionId: string;
  readonly contributionScope: ContributionScope;
  readonly bucketType: 'daily' | 'dimension';
  readonly bucketName: string;
  readonly bucketValue: string | null;
  additiveValue: number;
  valueCount: number;
}

function makeContributionKey(group: ContributionGroup): string {
  return `${group.projectId}:${group.portfolioId ?? ''}:${group.analysisReleaseId}:${group.comparabilityGroupId}:${group.metricDefinitionId}:${group.contributionScope}:${group.bucketType}:${group.bucketName}:${group.bucketValue ?? ''}`;
}

function buildContributionGroups(
  session: SessionContext,
  metrics: readonly AugmentedMetricValue[],
  input: ApplyRollupContributionsInput,
  policy: RollupPolicy,
  sessionModels: readonly string[] = [],
): { groups: Map<string, ContributionGroup>; keys: AffectedBucketKey[] } {
  const groups = new Map<string, ContributionGroup>();
  const keys: AffectedBucketKey[] = [];
  const projectId = session.projectId;
  const portfolioId = input.isRoot !== false ? session.portfolioId : null;
  const dayBucket = toDayBucket(metricDayTimestamp(session), policy.bucketTimezone);
  const supportedDimensions = supportedDimensionsFor(policy);

  function addToGroup(
    partial: Omit<ContributionGroup, 'additiveValue' | 'valueCount'>,
    numeric: number,
  ): void {
    const key = makeContributionKey(partial as ContributionGroup);
    const existing = groups.get(key);
    if (existing) {
      existing.additiveValue += numeric;
      existing.valueCount += 1;
    } else {
      const group: ContributionGroup = { ...partial, additiveValue: numeric, valueCount: 1 };
      groups.set(key, group);
      const baseKey = {
        analysisReleaseId: partial.analysisReleaseId,
        bucketType: partial.bucketType,
        comparabilityGroupId: partial.comparabilityGroupId,
        metricDefinitionId: partial.metricDefinitionId,
        bucketName: partial.bucketName,
      } as const;
      keys.push({ scope: 'project', scopeId: partial.projectId, ...baseKey });
      if (partial.portfolioId) {
        keys.push({ scope: 'portfolio', scopeId: partial.portfolioId, ...baseKey });
      }
    }
  }

  for (const metric of metrics) {
    const scope = contributionScopeFor(metric.rootInclusion);
    if (scope === null) continue;
    const numeric = numericValueFor(metric);
    if (numeric === null) continue;

    addToGroup(
      {
        projectId,
        portfolioId,
        analysisReleaseId: input.analysisReleaseId,
        comparabilityGroupId: metric.comparabilityGroupId,
        metricDefinitionId: metric.metricDefinitionId,
        contributionScope: scope,
        bucketType: DAILY_BUCKET_TYPE,
        bucketName: dayBucket,
        bucketValue: null,
      },
      numeric,
    );

    for (const dimension of supportedDimensions) {
      // When the metric itself is inherently dimensioned by `model` (e.g. a
      // per-model token metric with defDimensions=['model']), use the
      // metric's own dimensionsKey as the bucket value — same as any other
      // def-dimension. Only fan out from model_requests when the metric is
      // NOT inherently model-dimensioned, so session-level metrics get a
      // real model bucket instead of Unknown.
      const isMetricModelDimensioned =
        metric.defDimensions.length > 0 && metric.defDimensions[0] === dimension;
      if (dimension === 'model' && !isMetricModelDimensioned) {
        // Fan out the model dimension over each distinct model used by the
        // session. When no models are recorded, emit a single Unknown bucket
        // (bucketValue = null) so the contribution is still counted.
        const models = sessionModels.length > 0 ? sessionModels : [null];
        for (const model of models) {
          addToGroup(
            {
              projectId,
              portfolioId,
              analysisReleaseId: input.analysisReleaseId,
              comparabilityGroupId: metric.comparabilityGroupId,
              metricDefinitionId: metric.metricDefinitionId,
              contributionScope: scope,
              bucketType: DIMENSION_BUCKET_TYPE,
              bucketName: dimension,
              bucketValue: model,
            },
            numeric,
          );
        }
        continue;
      }
      const bucketValue = dimensionValueFor(metric, session, dimension, sessionModels);
      addToGroup(
        {
          projectId,
          portfolioId,
          analysisReleaseId: input.analysisReleaseId,
          comparabilityGroupId: metric.comparabilityGroupId,
          metricDefinitionId: metric.metricDefinitionId,
          contributionScope: scope,
          bucketType: DIMENSION_BUCKET_TYPE,
          bucketName: dimension,
          bucketValue,
        },
        numeric,
      );
    }
  }

  return { groups, keys };
}

function affectedKeysFromContributionRow(row: SqliteRow): AffectedBucketKey[] {
  const bucketType = asString(row.bucket_type) as AffectedBucketKey['bucketType'];
  const comparabilityGroupId = asString(row.comparability_group_id);
  const metricDefinitionId = asString(row.metric_definition_id);
  const bucketName = asString(row.bucket_name);
  const analysisReleaseId = asString(row.analysis_release_id);
  const keys: AffectedBucketKey[] = [];
  if (row.project_id !== null && row.project_id !== undefined) {
    keys.push({
      scope: 'project',
      scopeId: asString(row.project_id),
      analysisReleaseId,
      bucketType,
      comparabilityGroupId,
      metricDefinitionId,
      bucketName,
    });
  }
  if (row.portfolio_id !== null && row.portfolio_id !== undefined) {
    keys.push({
      scope: 'portfolio',
      scopeId: asString(row.portfolio_id),
      analysisReleaseId,
      bucketType,
      comparabilityGroupId,
      metricDefinitionId,
      bucketName,
    });
  }
  return keys;
}

function dedupeKeys(keys: readonly AffectedBucketKey[]): AffectedBucketKey[] {
  const seen = new Set<string>();
  const result: AffectedBucketKey[] = [];
  for (const key of keys) {
    const signature = `${key.scope}:${key.scopeId}:${key.analysisReleaseId}:${key.bucketType}:${key.comparabilityGroupId}:${key.metricDefinitionId}:${key.bucketName}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    result.push(key);
  }
  return result;
}

async function collectOldAffectedKeys(
  queryable: Queryable,
  sessionId: string,
  previousGenerationId: string | undefined,
): Promise<AffectedBucketKey[]> {
  if (!previousGenerationId) return [];
  const { rows } = await queryable.exec(
    `SELECT project_id, portfolio_id, analysis_release_id, comparability_group_id,
            metric_definition_id, bucket_type, bucket_name
     FROM rollup_contributions
     WHERE session_id = ? AND generation_id = ?`,
    [sessionId, previousGenerationId],
  );
  return rows.flatMap(affectedKeysFromContributionRow);
}

async function recomputeProjectDailyBucket(
  queryable: Queryable,
  projectId: string,
  analysisReleaseId: string,
  comparabilityGroupId: string,
  metricDefinitionId: string,
  dayBucket: string,
  generationToken: string,
): Promise<void> {
  await queryable.exec(
    `DELETE FROM project_daily_rollups
     WHERE project_id = ? AND analysis_release_id = ? AND comparability_group_id = ? AND day_bucket = ?`,
    [projectId, analysisReleaseId, comparabilityGroupId, dayBucket],
  );
  const { rows } = await queryable.exec(
    `SELECT
       COUNT(*) AS value_count,
       COALESCE(SUM(additive_value), 0) AS value_sum,
       MIN(additive_value) AS value_min,
       MAX(additive_value) AS value_max,
       AVG(additive_value) AS value_mean
     FROM rollup_contributions
     WHERE project_id = ? AND analysis_release_id = ? AND comparability_group_id = ?
       AND metric_definition_id = ? AND bucket_type = ? AND bucket_name = ?`,
    [
      projectId,
      analysisReleaseId,
      comparabilityGroupId,
      metricDefinitionId,
      DAILY_BUCKET_TYPE,
      dayBucket,
    ],
  );
  const row = rows[0] as SqliteRow | undefined;
  if (!row || asNumber(row.value_count) === 0) return;
  const input: InsertProjectDailyRollupInput = {
    projectId,
    analysisReleaseId,
    comparabilityGroupId,
    metricDefinitionId,
    dayBucket,
    valueCount: asNumber(row.value_count),
    valueSum: asNumber(row.value_sum),
    valueMin: asOptionalNumber(row.value_min),
    valueMax: asOptionalNumber(row.value_max),
    valueMean: asOptionalNumber(row.value_mean),
    generationId: generationToken,
  };
  await ProjectDailyRollupStore.insert(queryable, input);
}

async function recomputePortfolioDailyBucket(
  queryable: Queryable,
  portfolioId: string,
  analysisReleaseId: string,
  comparabilityGroupId: string,
  metricDefinitionId: string,
  dayBucket: string,
  generationToken: string,
): Promise<void> {
  await queryable.exec(
    `DELETE FROM portfolio_daily_rollups
     WHERE portfolio_id = ? AND analysis_release_id = ? AND comparability_group_id = ? AND day_bucket = ?`,
    [portfolioId, analysisReleaseId, comparabilityGroupId, dayBucket],
  );
  const { rows } = await queryable.exec(
    `SELECT
       COUNT(*) AS value_count,
       COALESCE(SUM(additive_value), 0) AS value_sum,
       MIN(additive_value) AS value_min,
       MAX(additive_value) AS value_max,
       AVG(additive_value) AS value_mean
     FROM rollup_contributions
     WHERE portfolio_id = ? AND analysis_release_id = ? AND comparability_group_id = ?
       AND metric_definition_id = ? AND bucket_type = ? AND bucket_name = ?`,
    [
      portfolioId,
      analysisReleaseId,
      comparabilityGroupId,
      metricDefinitionId,
      DAILY_BUCKET_TYPE,
      dayBucket,
    ],
  );
  const row = rows[0] as SqliteRow | undefined;
  if (!row || asNumber(row.value_count) === 0) return;
  await PortfolioDailyRollupStore.insert(queryable, {
    portfolioId,
    analysisReleaseId,
    comparabilityGroupId,
    metricDefinitionId,
    dayBucket,
    valueCount: asNumber(row.value_count),
    valueSum: asNumber(row.value_sum),
    valueMin: asOptionalNumber(row.value_min),
    valueMax: asOptionalNumber(row.value_max),
    valueMean: asOptionalNumber(row.value_mean),
    generationId: generationToken,
  });
}

function aggregateRollupRows(
  aggregates: readonly DimensionAggregate[],
): Omit<DimensionRollupRow, 'dimensionValue' | 'isOther' | 'isUnknown' | 'topNRank'> {
  let valueSum = 0;
  let valueCount = 0;
  let valueMin: number | null = null;
  let valueMax: number | null = null;
  for (const a of aggregates) {
    valueSum += a.valueSum;
    valueCount += a.valueCount;
    if (a.valueMin !== null && (valueMin === null || a.valueMin < valueMin)) valueMin = a.valueMin;
    if (a.valueMax !== null && (valueMax === null || a.valueMax > valueMax)) valueMax = a.valueMax;
  }
  return {
    value: null,
    valueSum,
    valueCount,
    valueMin,
    valueMax,
    valueMean: valueCount > 0 ? valueSum / valueCount : null,
  };
}

function buildDimensionRollupRows(
  aggregates: readonly DimensionAggregate[],
  dimensionName: string,
  policy: RollupPolicy,
): DimensionRollupRow[] {
  const caps = parseJsonRecord<Record<string, number>>(policy.cardinalityCaps, {});
  const cap = caps[dimensionName];
  const topNBehavior = policy.topNBehavior;
  const unknownLabel = policy.unknownBucketLabel || 'Unknown';
  const otherLabel = policy.otherBucketLabel || 'Other';
  const unknownEntry = aggregates.find((a) => a.value === null);
  const known = aggregates.filter((a) => a.value !== null).sort((a, b) => b.valueSum - a.valueSum);
  const rows: DimensionRollupRow[] = [];
  if (unknownEntry) {
    rows.push({
      ...unknownEntry,
      dimensionValue: unknownLabel,
      isOther: false,
      isUnknown: true,
      topNRank: null,
    });
  }
  const shouldCap = typeof cap === 'number' && cap >= 0 && topNBehavior !== 'rank';
  if (shouldCap && known.length > cap) {
    const top = known.slice(0, cap);
    const rest = known.slice(cap);
    for (let i = 0; i < top.length; i++) {
      const a = top[i];
      rows.push({
        ...a,
        dimensionValue: a.value ?? otherLabel,
        isOther: false,
        isUnknown: false,
        topNRank: i + 1,
      });
    }
    if (rest.length > 0) {
      const other = aggregateRollupRows(rest);
      rows.push({
        ...other,
        dimensionValue: otherLabel,
        isOther: true,
        isUnknown: false,
        topNRank: null,
      });
    }
  } else {
    for (let i = 0; i < known.length; i++) {
      const a = known[i];
      rows.push({
        ...a,
        dimensionValue: a.value ?? otherLabel,
        isOther: false,
        isUnknown: false,
        topNRank: topNBehavior === 'rank' ? i + 1 : null,
      });
    }
  }
  return rows;
}

async function recomputeProjectDimensionBucket(
  queryable: Queryable,
  projectId: string,
  analysisReleaseId: string,
  comparabilityGroupId: string,
  metricDefinitionId: string,
  dimensionName: string,
  policy: RollupPolicy,
  generationToken: string,
): Promise<void> {
  await queryable.exec(
    `DELETE FROM project_dimension_rollups
     WHERE project_id = ? AND analysis_release_id = ? AND comparability_group_id = ? AND dimension_name = ?`,
    [projectId, analysisReleaseId, comparabilityGroupId, dimensionName],
  );
  const { rows } = await queryable.exec(
    `SELECT
       bucket_value,
       COALESCE(SUM(additive_value), 0) AS value_sum,
       COUNT(*) AS value_count,
       MIN(additive_value) AS value_min,
       MAX(additive_value) AS value_max,
       AVG(additive_value) AS value_mean
     FROM rollup_contributions
     WHERE project_id = ? AND analysis_release_id = ? AND comparability_group_id = ?
       AND metric_definition_id = ? AND bucket_type = ? AND bucket_name = ?
     GROUP BY bucket_value`,
    [
      projectId,
      analysisReleaseId,
      comparabilityGroupId,
      metricDefinitionId,
      DIMENSION_BUCKET_TYPE,
      dimensionName,
    ],
  );
  if (rows.length === 0) return;
  const aggregates: DimensionAggregate[] = rows.map((row) => ({
    value: asOptionalString(row.bucket_value),
    valueSum: asNumber(row.value_sum),
    valueCount: asNumber(row.value_count),
    valueMin: asOptionalNumber(row.value_min),
    valueMax: asOptionalNumber(row.value_max),
    valueMean: asOptionalNumber(row.value_mean),
  }));
  const rollupRows = buildDimensionRollupRows(aggregates, dimensionName, policy);
  for (const r of rollupRows) {
    const input: InsertProjectDimensionRollupInput = {
      projectId,
      analysisReleaseId,
      comparabilityGroupId,
      metricDefinitionId,
      dimensionName,
      dimensionValue: r.dimensionValue,
      isOther: r.isOther,
      isUnknown: r.isUnknown,
      valueCount: r.valueCount,
      valueSum: r.valueSum,
      valueMin: r.valueMin,
      valueMax: r.valueMax,
      valueMean: r.valueMean,
      topNRank: r.topNRank,
      generationId: generationToken,
    };
    await ProjectDimensionRollupStore.insert(queryable, input);
  }
}

async function recomputePortfolioDimensionBucket(
  queryable: Queryable,
  portfolioId: string,
  analysisReleaseId: string,
  comparabilityGroupId: string,
  metricDefinitionId: string,
  dimensionName: string,
  policy: RollupPolicy,
  generationToken: string,
): Promise<void> {
  await queryable.exec(
    `DELETE FROM portfolio_dimension_rollups
     WHERE portfolio_id = ? AND analysis_release_id = ? AND comparability_group_id = ? AND dimension_name = ?`,
    [portfolioId, analysisReleaseId, comparabilityGroupId, dimensionName],
  );
  const { rows } = await queryable.exec(
    `SELECT
       bucket_value,
       COALESCE(SUM(additive_value), 0) AS value_sum,
       COUNT(*) AS value_count,
       MIN(additive_value) AS value_min,
       MAX(additive_value) AS value_max,
       AVG(additive_value) AS value_mean
     FROM rollup_contributions
     WHERE portfolio_id = ? AND analysis_release_id = ? AND comparability_group_id = ?
       AND metric_definition_id = ? AND bucket_type = ? AND bucket_name = ?
     GROUP BY bucket_value`,
    [
      portfolioId,
      analysisReleaseId,
      comparabilityGroupId,
      metricDefinitionId,
      DIMENSION_BUCKET_TYPE,
      dimensionName,
    ],
  );
  if (rows.length === 0) return;
  const aggregates: DimensionAggregate[] = rows.map((row) => ({
    value: asOptionalString(row.bucket_value),
    valueSum: asNumber(row.value_sum),
    valueCount: asNumber(row.value_count),
    valueMin: asOptionalNumber(row.value_min),
    valueMax: asOptionalNumber(row.value_max),
    valueMean: asOptionalNumber(row.value_mean),
  }));
  const rollupRows = buildDimensionRollupRows(aggregates, dimensionName, policy);
  for (const r of rollupRows) {
    await PortfolioDimensionRollupStore.insert(queryable, {
      portfolioId,
      analysisReleaseId,
      comparabilityGroupId,
      metricDefinitionId,
      dimensionName,
      dimensionValue: r.dimensionValue,
      isOther: r.isOther,
      isUnknown: r.isUnknown,
      valueCount: r.valueCount,
      valueSum: r.valueSum,
      valueMin: r.valueMin,
      valueMax: r.valueMax,
      valueMean: r.valueMean,
      topNRank: r.topNRank,
      generationId: generationToken,
    });
  }
}

async function recomputeAffectedBucket(
  queryable: Queryable,
  key: AffectedBucketKey,
  policy: RollupPolicy,
  generationToken: string,
): Promise<void> {
  if (key.scope === 'project') {
    if (key.bucketType === 'daily') {
      await recomputeProjectDailyBucket(
        queryable,
        key.scopeId,
        key.analysisReleaseId,
        key.comparabilityGroupId,
        key.metricDefinitionId,
        key.bucketName,
        generationToken,
      );
    } else {
      await recomputeProjectDimensionBucket(
        queryable,
        key.scopeId,
        key.analysisReleaseId,
        key.comparabilityGroupId,
        key.metricDefinitionId,
        key.bucketName,
        policy,
        generationToken,
      );
    }
  } else {
    if (key.bucketType === 'daily') {
      await recomputePortfolioDailyBucket(
        queryable,
        key.scopeId,
        key.analysisReleaseId,
        key.comparabilityGroupId,
        key.metricDefinitionId,
        key.bucketName,
        generationToken,
      );
    } else {
      await recomputePortfolioDimensionBucket(
        queryable,
        key.scopeId,
        key.analysisReleaseId,
        key.comparabilityGroupId,
        key.metricDefinitionId,
        key.bucketName,
        policy,
        generationToken,
      );
    }
  }
}

export async function applySessionRollupContributions(
  tx: SqliteTransaction,
  input: ApplyRollupContributionsInput,
): Promise<void> {
  const session = await readSessionContext(tx, input.sessionId);
  const policy =
    input.rollupPolicy ?? (await loadOrDefaultRollupPolicy(tx, input.analysisReleaseId));
  const generationToken = input.generationToken ?? input.generationId;
  const oldKeys = await collectOldAffectedKeys(tx, input.sessionId, input.previousGenerationId);
  if (input.previousGenerationId) {
    await tx.exec('DELETE FROM rollup_contributions WHERE session_id = ? AND generation_id = ?', [
      input.sessionId,
      input.previousGenerationId,
    ]);
  }
  // Also delete any existing contributions for the current generation so the
  // function is idempotent when called multiple times for the same generation.
  await tx.exec('DELETE FROM rollup_contributions WHERE session_id = ? AND generation_id = ?', [
    input.sessionId,
    input.generationId,
  ]);
  const metrics = await listAdditiveMetricValues(tx, input.sessionId, input.generationId);
  const sessionModels = await readSessionModels(tx, input.sessionId, input.generationId);
  const { groups, keys: builtKeys } = buildContributionGroups(
    session,
    metrics,
    input,
    policy,
    sessionModels,
  );
  for (const group of groups.values()) {
    await RollupContributionStore.insert(tx, {
      id: contributionId(
        input,
        group.comparabilityGroupId,
        group.metricDefinitionId,
        group.contributionScope,
        group.bucketType,
        group.bucketName,
        group.bucketValue,
      ),
      sessionId: input.sessionId,
      generationId: input.generationId,
      projectId: group.projectId,
      portfolioId: group.portfolioId,
      analysisReleaseId: group.analysisReleaseId,
      comparabilityGroupId: group.comparabilityGroupId,
      metricDefinitionId: group.metricDefinitionId,
      contributionScope: group.contributionScope,
      bucketType: group.bucketType,
      bucketName: group.bucketName,
      bucketValue: group.bucketValue,
      additiveValue: group.additiveValue,
      valueCount: group.valueCount,
    });
  }
  const allKeys = dedupeKeys([...oldKeys, ...builtKeys]);
  for (const key of allKeys) {
    await recomputeAffectedBucket(tx, key, policy, generationToken);
  }
}

export async function replaceSessionRollupContributions(
  tx: SqliteTransaction,
  input: ApplyRollupContributionsInput,
): Promise<void> {
  if (!input.previousGenerationId) {
    throw new Error('replaceSessionRollupContributions requires previousGenerationId');
  }
  return applySessionRollupContributions(tx, input);
}

function aggregateRowsToDimensionGroups(rows: readonly SqliteRow[]): Map<
  string,
  {
    comparabilityGroupId: string;
    metricDefinitionId: string;
    dimensionName: string;
    aggregates: DimensionAggregate[];
  }
> {
  const groups = new Map<
    string,
    {
      comparabilityGroupId: string;
      metricDefinitionId: string;
      dimensionName: string;
      aggregates: DimensionAggregate[];
    }
  >();
  for (const row of rows) {
    const comparabilityGroupId = asString(row.comparability_group_id);
    const metricDefinitionId = asString(row.metric_definition_id);
    const dimensionName = asString(row.bucket_name);
    const key = `${comparabilityGroupId}:${metricDefinitionId}:${dimensionName}`;
    const existing = groups.get(key);
    const aggregate: DimensionAggregate = {
      value: asOptionalString(row.bucket_value),
      valueSum: asNumber(row.value_sum),
      valueCount: asNumber(row.value_count),
      valueMin: asOptionalNumber(row.value_min),
      valueMax: asOptionalNumber(row.value_max),
      valueMean: asOptionalNumber(row.value_mean),
    };
    if (existing) {
      existing.aggregates.push(aggregate);
    } else {
      groups.set(key, {
        comparabilityGroupId,
        metricDefinitionId,
        dimensionName,
        aggregates: [aggregate],
      });
    }
  }
  return groups;
}

async function insertDimensionRollupsForGroups(
  queryable: Queryable,
  scope: 'project' | 'portfolio',
  scopeId: string,
  analysisReleaseId: string,
  groups: Map<
    string,
    {
      comparabilityGroupId: string;
      metricDefinitionId: string;
      dimensionName: string;
      aggregates: DimensionAggregate[];
    }
  >,
  policy: RollupPolicy,
  generationToken: string,
): Promise<void> {
  for (const group of groups.values()) {
    const rows = buildDimensionRollupRows(group.aggregates, group.dimensionName, policy);
    for (const r of rows) {
      if (scope === 'project') {
        await ProjectDimensionRollupStore.insert(queryable, {
          projectId: scopeId,
          analysisReleaseId,
          comparabilityGroupId: group.comparabilityGroupId,
          metricDefinitionId: group.metricDefinitionId,
          dimensionName: group.dimensionName,
          dimensionValue: r.dimensionValue,
          isOther: r.isOther,
          isUnknown: r.isUnknown,
          valueCount: r.valueCount,
          valueSum: r.valueSum,
          valueMin: r.valueMin,
          valueMax: r.valueMax,
          valueMean: r.valueMean,
          topNRank: r.topNRank,
          generationId: generationToken,
        });
      } else {
        await PortfolioDimensionRollupStore.insert(queryable, {
          portfolioId: scopeId,
          analysisReleaseId,
          comparabilityGroupId: group.comparabilityGroupId,
          metricDefinitionId: group.metricDefinitionId,
          dimensionName: group.dimensionName,
          dimensionValue: r.dimensionValue,
          isOther: r.isOther,
          isUnknown: r.isUnknown,
          valueCount: r.valueCount,
          valueSum: r.valueSum,
          valueMin: r.valueMin,
          valueMax: r.valueMax,
          valueMean: r.valueMean,
          topNRank: r.topNRank,
          generationId: generationToken,
        });
      }
    }
  }
}

async function recomputeAllDailyRollups(
  queryable: Queryable,
  scope: 'project' | 'portfolio',
  scopeId: string,
  analysisReleaseId: string,
  generationToken: string,
): Promise<void> {
  const scopeColumn = scope === 'project' ? 'project_id' : 'portfolio_id';
  const table = scope === 'project' ? 'project_daily_rollups' : 'portfolio_daily_rollups';
  await queryable.exec(
    `DELETE FROM ${table} WHERE ${scopeColumn} = ? AND analysis_release_id = ?`,
    [scopeId, analysisReleaseId],
  );
  const { rows } = await queryable.exec(
    `SELECT
       analysis_release_id,
       comparability_group_id,
       metric_definition_id,
       bucket_name,
       COUNT(*) AS value_count,
       COALESCE(SUM(additive_value), 0) AS value_sum,
       MIN(additive_value) AS value_min,
       MAX(additive_value) AS value_max,
       AVG(additive_value) AS value_mean
     FROM rollup_contributions
     WHERE ${scopeColumn} = ? AND analysis_release_id = ? AND bucket_type = ?
     GROUP BY analysis_release_id, comparability_group_id, metric_definition_id, bucket_name`,
    [scopeId, analysisReleaseId, DAILY_BUCKET_TYPE],
  );
  for (const row of rows) {
    if (scope === 'project') {
      await ProjectDailyRollupStore.insert(queryable, {
        projectId: scopeId,
        analysisReleaseId: asString(row.analysis_release_id),
        comparabilityGroupId: asString(row.comparability_group_id),
        metricDefinitionId: asString(row.metric_definition_id),
        dayBucket: asString(row.bucket_name),
        valueCount: asNumber(row.value_count),
        valueSum: asNumber(row.value_sum),
        valueMin: asOptionalNumber(row.value_min),
        valueMax: asOptionalNumber(row.value_max),
        valueMean: asOptionalNumber(row.value_mean),
        generationId: generationToken,
      });
    } else {
      await PortfolioDailyRollupStore.insert(queryable, {
        portfolioId: scopeId,
        analysisReleaseId: asString(row.analysis_release_id),
        comparabilityGroupId: asString(row.comparability_group_id),
        metricDefinitionId: asString(row.metric_definition_id),
        dayBucket: asString(row.bucket_name),
        valueCount: asNumber(row.value_count),
        valueSum: asNumber(row.value_sum),
        valueMin: asOptionalNumber(row.value_min),
        valueMax: asOptionalNumber(row.value_max),
        valueMean: asOptionalNumber(row.value_mean),
        generationId: generationToken,
      });
    }
  }
}

async function recomputeAllDimensionRollups(
  queryable: Queryable,
  scope: 'project' | 'portfolio',
  scopeId: string,
  analysisReleaseId: string,
  policy: RollupPolicy,
  generationToken: string,
): Promise<void> {
  const scopeColumn = scope === 'project' ? 'project_id' : 'portfolio_id';
  const table = scope === 'project' ? 'project_dimension_rollups' : 'portfolio_dimension_rollups';
  await queryable.exec(
    `DELETE FROM ${table} WHERE ${scopeColumn} = ? AND analysis_release_id = ?`,
    [scopeId, analysisReleaseId],
  );
  const { rows } = await queryable.exec(
    `SELECT
       comparability_group_id,
       metric_definition_id,
       bucket_name,
       bucket_value,
       COALESCE(SUM(additive_value), 0) AS value_sum,
       COUNT(*) AS value_count,
       MIN(additive_value) AS value_min,
       MAX(additive_value) AS value_max,
       AVG(additive_value) AS value_mean
     FROM rollup_contributions
     WHERE ${scopeColumn} = ? AND analysis_release_id = ? AND bucket_type = ?
     GROUP BY comparability_group_id, metric_definition_id, bucket_name, bucket_value`,
    [scopeId, analysisReleaseId, DIMENSION_BUCKET_TYPE],
  );
  const groups = aggregateRowsToDimensionGroups(rows);
  await insertDimensionRollupsForGroups(
    queryable,
    scope,
    scopeId,
    analysisReleaseId,
    groups,
    policy,
    generationToken,
  );
}

export async function rebuildProjectPortfolioRollups(
  queryable: Queryable,
  projectId: string,
  portfolioId: string,
  analysisReleaseId: string,
  generationToken?: string,
  policy?: RollupPolicy,
): Promise<void> {
  const resolvedPolicy = policy ?? (await loadOrDefaultRollupPolicy(queryable, analysisReleaseId));
  const token = generationToken ?? 'rebuild';
  await recomputeAllDailyRollups(queryable, 'project', projectId, analysisReleaseId, token);
  await recomputeAllDimensionRollups(
    queryable,
    'project',
    projectId,
    analysisReleaseId,
    resolvedPolicy,
    token,
  );
  await recomputeAllDailyRollups(queryable, 'portfolio', portfolioId, analysisReleaseId, token);
  await recomputeAllDimensionRollups(
    queryable,
    'portfolio',
    portfolioId,
    analysisReleaseId,
    resolvedPolicy,
    token,
  );
}

function makeDailyKey(
  comparabilityGroupId: string,
  metricDefinitionId: string,
  bucketName: string,
): string {
  return `${comparabilityGroupId}:${metricDefinitionId}:${bucketName}`;
}

function makeDimensionKey(
  comparabilityGroupId: string,
  metricDefinitionId: string,
  dimensionName: string,
): string {
  return `${comparabilityGroupId}:${metricDefinitionId}:${dimensionName}`;
}

interface BucketTotals {
  readonly rollupMap: Map<string, number>;
  readonly contributionMap: Map<string, number>;
  readonly scopeId: string;
  readonly analysisReleaseId: string;
  readonly bucketType: 'daily' | 'dimension';
  readonly scope: 'project' | 'portfolio';
}

function reconcileMaps(
  totals: BucketTotals,
  comparabilityGroupIdKey = 0,
  metricDefinitionIdKey = 1,
  bucketNameKey = 2,
): RollupReconciliationMismatch[] {
  const mismatches: RollupReconciliationMismatch[] = [];
  const allKeys = new Set<string>([...totals.rollupMap.keys(), ...totals.contributionMap.keys()]);
  for (const key of allKeys) {
    const rollupTotal = totals.rollupMap.get(key) ?? 0;
    const contributionTotal = totals.contributionMap.get(key) ?? 0;
    if (approxEqual(rollupTotal, contributionTotal)) continue;
    const parts = key.split(':');
    mismatches.push({
      scope: totals.scope,
      bucketType: totals.bucketType,
      scopeId: totals.scopeId,
      analysisReleaseId: totals.analysisReleaseId,
      comparabilityGroupId: parts[comparabilityGroupIdKey] ?? '',
      metricDefinitionId: parts[metricDefinitionIdKey] ?? '',
      bucketName: parts[bucketNameKey] ?? '',
      rollupTotal,
      contributionTotal,
    });
  }
  return mismatches;
}

async function reconcileScopeDaily(
  queryable: Queryable,
  scope: 'project' | 'portfolio',
  scopeId: string,
  analysisReleaseId: string,
): Promise<RollupReconciliationMismatch[]> {
  const scopeColumn = scope === 'project' ? 'project_id' : 'portfolio_id';
  const table = scope === 'project' ? 'project_daily_rollups' : 'portfolio_daily_rollups';
  const { rows: rollupRows } = await queryable.exec(
    `SELECT comparability_group_id, metric_definition_id, day_bucket, value_sum
     FROM ${table}
     WHERE ${scopeColumn} = ? AND analysis_release_id = ?`,
    [scopeId, analysisReleaseId],
  );
  const { rows: contributionRows } = await queryable.exec(
    `SELECT comparability_group_id, metric_definition_id, bucket_name, SUM(additive_value) AS total
     FROM rollup_contributions
     WHERE ${scopeColumn} = ? AND analysis_release_id = ? AND bucket_type = ?
     GROUP BY comparability_group_id, metric_definition_id, bucket_name`,
    [scopeId, analysisReleaseId, DAILY_BUCKET_TYPE],
  );
  const rollupMap = new Map<string, number>();
  for (const row of rollupRows) {
    rollupMap.set(
      makeDailyKey(
        asString(row.comparability_group_id),
        asString(row.metric_definition_id),
        asString(row.day_bucket ?? row.bucket_name),
      ),
      asNumber(row.value_sum),
    );
  }
  const contributionMap = new Map<string, number>();
  for (const row of contributionRows) {
    contributionMap.set(
      makeDailyKey(
        asString(row.comparability_group_id),
        asString(row.metric_definition_id),
        asString(row.bucket_name),
      ),
      asNumber(row.total),
    );
  }
  return reconcileMaps({
    rollupMap,
    contributionMap,
    scopeId,
    analysisReleaseId,
    bucketType: 'daily',
    scope,
  });
}

async function reconcileScopeDimension(
  queryable: Queryable,
  scope: 'project' | 'portfolio',
  scopeId: string,
  analysisReleaseId: string,
): Promise<RollupReconciliationMismatch[]> {
  const scopeColumn = scope === 'project' ? 'project_id' : 'portfolio_id';
  const table = scope === 'project' ? 'project_dimension_rollups' : 'portfolio_dimension_rollups';
  const { rows: rollupRows } = await queryable.exec(
    `SELECT comparability_group_id, metric_definition_id, dimension_name, SUM(value_sum) AS total
     FROM ${table}
     WHERE ${scopeColumn} = ? AND analysis_release_id = ?
     GROUP BY comparability_group_id, metric_definition_id, dimension_name`,
    [scopeId, analysisReleaseId],
  );
  const { rows: contributionRows } = await queryable.exec(
    `SELECT comparability_group_id, metric_definition_id, bucket_name, SUM(additive_value) AS total
     FROM rollup_contributions
     WHERE ${scopeColumn} = ? AND analysis_release_id = ? AND bucket_type = ?
     GROUP BY comparability_group_id, metric_definition_id, bucket_name`,
    [scopeId, analysisReleaseId, DIMENSION_BUCKET_TYPE],
  );
  const rollupMap = new Map<string, number>();
  for (const row of rollupRows) {
    rollupMap.set(
      makeDimensionKey(
        asString(row.comparability_group_id),
        asString(row.metric_definition_id),
        asString(row.dimension_name),
      ),
      asNumber(row.total),
    );
  }
  const contributionMap = new Map<string, number>();
  for (const row of contributionRows) {
    contributionMap.set(
      makeDimensionKey(
        asString(row.comparability_group_id),
        asString(row.metric_definition_id),
        asString(row.bucket_name),
      ),
      asNumber(row.total),
    );
  }
  return reconcileMaps({
    rollupMap,
    contributionMap,
    scopeId,
    analysisReleaseId,
    bucketType: 'dimension',
    scope,
  });
}

export async function reconcileRollupTotals(
  queryable: Queryable,
  projectId: string,
  portfolioId: string,
  analysisReleaseId: string,
): Promise<readonly RollupReconciliationMismatch[]> {
  const mismatches: RollupReconciliationMismatch[] = [];
  mismatches.push(
    ...(await reconcileScopeDaily(queryable, 'project', projectId, analysisReleaseId)),
  );
  mismatches.push(
    ...(await reconcileScopeDaily(queryable, 'portfolio', portfolioId, analysisReleaseId)),
  );
  mismatches.push(
    ...(await reconcileScopeDimension(queryable, 'project', projectId, analysisReleaseId)),
  );
  mismatches.push(
    ...(await reconcileScopeDimension(queryable, 'portfolio', portfolioId, analysisReleaseId)),
  );
  return mismatches;
}

export function isRollupReconciled(mismatches: readonly RollupReconciliationMismatch[]): boolean {
  return mismatches.length === 0;
}
