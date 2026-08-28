import type {
  CohortGroupLabel,
  CohortType,
  ComparisonCohort,
  ComparisonCohortMember,
  InsertComparisonCohortInput,
  InsertComparisonCohortMemberInput,
  InsertInsightEvidenceInput,
  InsertPortfolioDistributionInput,
  InsertProjectDistributionInput,
  MetricValue,
  SqliteExecutor,
  SqliteRow,
  SqliteTransaction,
  SqliteValue,
  StatisticalPolicy,
} from '@lucasschirm/sal-db-core';
import {
  ComparisonCohortMemberStore,
  ComparisonCohortStore,
  deterministicId,
  InsightEvidenceStore,
  MetricDefinitionStore,
  MetricValueStore,
  PortfolioDistributionStore,
  ProjectDistributionStore,
  StatisticalPolicyStore,
} from '@lucasschirm/sal-db-core';

type Queryable = SqliteExecutor | SqliteTransaction;

function asString(value: SqliteValue): string {
  return value === null || value === undefined ? '' : String(value);
}

function asOptionalString(value: SqliteValue): string | null {
  return value === null || value === undefined ? null : String(value);
}

function toNumber(value: SqliteValue): number {
  return value === null || value === undefined ? 0 : Number(value);
}

function toOptionalNumber(value: SqliteValue): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function numericValueForMetric(row: SqliteRow): number | null {
  const valueType = asString(row.value_type);
  if (valueType === 'integer') return toOptionalNumber(row.integer_value);
  if (valueType === 'real' || valueType === 'currency' || valueType === 'ratio') {
    return toOptionalNumber(row.numeric_value);
  }
  return null;
}

function isKnownMetric(row: SqliteRow): boolean {
  return !(
    row.is_unavailable === 1 ||
    row.is_unavailable === true ||
    row.is_not_applicable === 1 ||
    row.is_not_applicable === true
  );
}

function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * p;
  const lower = Math.floor(pos);
  const upper = Math.ceil(pos);
  if (lower === upper) return sorted[lower];
  const weight = pos - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function sampleStandardDeviation(values: readonly number[], mean: number): number | null {
  if (values.length < 2) return null;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function outlierRuleFor(policy: StatisticalPolicy | undefined): string | null {
  if (policy?.outlierPolicy) return policy.outlierPolicy;
  return 'iqr:1.5';
}

function percentileMinimumFor(policy: StatisticalPolicy | undefined): number {
  return policy?.percentileMinimumN ?? 1;
}

function coverage(known: number, eligible: number): number | null {
  if (eligible === 0) return null;
  return known / eligible;
}

interface DistributionBucket {
  readonly scope: 'project' | 'portfolio';
  readonly scopeId: string;
  readonly analysisReleaseId: string;
  readonly comparabilityGroupId: string;
  readonly metricDefinitionId: string;
  readonly dimensionsKey: string | null;
}

function bucketKey(bucket: DistributionBucket): string {
  return `${bucket.scope}:${bucket.scopeId}:${bucket.analysisReleaseId}:${bucket.comparabilityGroupId}:${bucket.metricDefinitionId}:${bucket.dimensionsKey ?? ''}`;
}

interface SessionContext {
  readonly projectId: string;
  readonly portfolioId: string;
}

async function readSessionContext(
  queryable: Queryable,
  sessionId: string,
): Promise<SessionContext> {
  const { rows } = await queryable.exec(
    `SELECT s.project_id, p.portfolio_id
     FROM sessions s
     JOIN projects p ON p.id = s.project_id
     WHERE s.id = ?`,
    [sessionId],
  );
  if (rows.length === 0) {
    throw new Error(`Session not found: ${sessionId}`);
  }
  return {
    projectId: asString(rows[0].project_id),
    portfolioId: asString(rows[0].portfolio_id),
  };
}

interface RebuildDistributionsInput {
  readonly sessionId: string;
  readonly generationId: string;
  readonly previousGenerationId?: string;
  readonly analysisReleaseId: string;
  readonly isRoot?: boolean;
  readonly generationToken?: string;
}

async function collectAffectedDistributionBuckets(
  queryable: Queryable,
  sessionId: string,
  generationId: string,
  analysisReleaseId: string,
  scope: 'project' | 'portfolio',
  scopeId: string,
): Promise<readonly DistributionBucket[]> {
  const { rows } = await queryable.exec(
    `SELECT DISTINCT mv.comparability_group_id, mv.metric_definition_id, mv.dimensions_key
     FROM metric_values mv
     JOIN metric_definitions md ON md.id = mv.metric_definition_id
     WHERE mv.session_id = ? AND mv.generation_id = ?
       AND LOWER(md.aggregation) = 'distribution'`,
    [sessionId, generationId],
  );
  return rows.map((row) => ({
    scope,
    scopeId,
    analysisReleaseId,
    comparabilityGroupId: asString(row.comparability_group_id),
    metricDefinitionId: asString(row.metric_definition_id),
    dimensionsKey: asOptionalString(row.dimensions_key),
  }));
}

interface DistributionStats {
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
  readonly coverage: number | null;
}

function buildDistributionStats(
  values: readonly number[],
  eligibleN: number,
  unknownCount: number,
  policy: StatisticalPolicy | undefined,
): DistributionStats {
  const knownN = values.length;
  if (knownN === 0) {
    return {
      eligibleN,
      knownN,
      unknownCount,
      sum: null,
      min: null,
      max: null,
      mean: null,
      p50: null,
      p75: null,
      p90: null,
      p95: null,
      dispersion: null,
      coverage: coverage(knownN, eligibleN),
    };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const mean = sum / knownN;
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const minForPercentiles = percentileMinimumFor(policy);
  const shouldSuppress = knownN < minForPercentiles;
  return {
    eligibleN,
    knownN,
    unknownCount,
    sum,
    min,
    max,
    mean,
    p50: shouldSuppress ? null : percentile(sorted, 0.5),
    p75: shouldSuppress ? null : percentile(sorted, 0.75),
    p90: shouldSuppress ? null : percentile(sorted, 0.9),
    p95: shouldSuppress ? null : percentile(sorted, 0.95),
    dispersion: shouldSuppress ? null : sampleStandardDeviation(sorted, mean),
    coverage: coverage(knownN, eligibleN),
  };
}

async function queryCurrentDistributionValues(
  queryable: Queryable,
  bucket: DistributionBucket,
): Promise<{ values: number[]; eligibleN: number; unknownCount: number }> {
  const scopeColumn = bucket.scope === 'project' ? 's.project_id' : 'p.portfolio_id';
  const scopeJoin = bucket.scope === 'project' ? '' : 'JOIN projects p ON p.id = s.project_id';
  const { rows } = await queryable.exec(
    `SELECT mv.value_type, mv.integer_value, mv.numeric_value, mv.is_unavailable, mv.is_not_applicable
     FROM metric_values mv
     JOIN metric_definitions md ON md.id = mv.metric_definition_id
     JOIN sessions s ON s.id = mv.session_id
     JOIN transformation_generations tg ON tg.id = mv.generation_id
     ${scopeJoin}
     WHERE ${scopeColumn} = ? AND tg.analysis_release_id = ?
       AND mv.comparability_group_id = ?
       AND mv.metric_definition_id = ?
       AND COALESCE(mv.dimensions_key, '') = COALESCE(?, '')
       AND LOWER(md.aggregation) = 'distribution'
       AND s.current_generation_id = mv.generation_id`,
    [
      bucket.scopeId,
      bucket.analysisReleaseId,
      bucket.comparabilityGroupId,
      bucket.metricDefinitionId,
      bucket.dimensionsKey ?? '',
    ],
  );
  const values: number[] = [];
  let unknownCount = 0;
  for (const row of rows) {
    if (isKnownMetric(row)) {
      const numeric = numericValueForMetric(row);
      if (numeric !== null) {
        values.push(numeric);
      } else {
        unknownCount++;
      }
    } else {
      unknownCount++;
    }
  }
  return { values, eligibleN: rows.length, unknownCount };
}

async function recomputeDistributionBucket(
  queryable: Queryable,
  bucket: DistributionBucket,
  generationToken: string,
): Promise<void> {
  const definition = await MetricDefinitionStore.getById(queryable, bucket.metricDefinitionId);
  if (!definition) {
    throw new Error(`Metric definition not found: ${bucket.metricDefinitionId}`);
  }
  const policy = definition.statisticalPolicyId
    ? await StatisticalPolicyStore.getById(queryable, definition.statisticalPolicyId)
    : undefined;
  const { values, eligibleN, unknownCount } = await queryCurrentDistributionValues(
    queryable,
    bucket,
  );
  const stats = buildDistributionStats(values, eligibleN, unknownCount, policy);
  const rule = outlierRuleFor(policy);
  const outlierRule = stats.knownN > 0 ? rule : null;
  const baseInput = {
    analysisReleaseId: bucket.analysisReleaseId,
    comparabilityGroupId: bucket.comparabilityGroupId,
    metricDefinitionId: bucket.metricDefinitionId,
    dimensionsKey: bucket.dimensionsKey,
    statisticalPolicyId: definition.statisticalPolicyId,
    attributionPolicyId: definition.attributionPolicyId ?? null,
    generationId: generationToken,
    ...stats,
    outlierRule,
  };
  if (bucket.scope === 'project') {
    const existing = await ProjectDistributionStore.getByProjectGroupAndKey(
      queryable,
      bucket.scopeId,
      bucket.analysisReleaseId,
      bucket.comparabilityGroupId,
      bucket.dimensionsKey,
    );
    if (existing) {
      await ProjectDistributionStore.delete(queryable, existing.id);
    }
    const input: InsertProjectDistributionInput = { ...baseInput, projectId: bucket.scopeId };
    await ProjectDistributionStore.insert(queryable, input);
  } else {
    const existing = await PortfolioDistributionStore.getByPortfolioGroupAndKey(
      queryable,
      bucket.scopeId,
      bucket.analysisReleaseId,
      bucket.comparabilityGroupId,
      bucket.dimensionsKey,
    );
    if (existing) {
      await PortfolioDistributionStore.delete(queryable, existing.id);
    }
    const input: InsertPortfolioDistributionInput = { ...baseInput, portfolioId: bucket.scopeId };
    await PortfolioDistributionStore.insert(queryable, input);
  }
}

export interface RebuildDistributionsResult {
  readonly projectBucketsRebuilt: number;
  readonly portfolioBucketsRebuilt: number;
}

/**
 * Recompute exact percentile/distribution buckets for the project and portfolio
 * bounded cohorts affected by a session's current generation.
 */
export async function rebuildAffectedDistributions(
  queryable: Queryable,
  input: RebuildDistributionsInput,
): Promise<RebuildDistributionsResult> {
  const context = await readSessionContext(queryable, input.sessionId);
  const token = input.generationToken ?? input.generationId;
  const projectBuckets: DistributionBucket[] = [];
  const portfolioBuckets: DistributionBucket[] = [];
  projectBuckets.push(
    ...(await collectAffectedDistributionBuckets(
      queryable,
      input.sessionId,
      input.generationId,
      input.analysisReleaseId,
      'project',
      context.projectId,
    )),
  );
  if (input.isRoot !== false) {
    portfolioBuckets.push(
      ...(await collectAffectedDistributionBuckets(
        queryable,
        input.sessionId,
        input.generationId,
        input.analysisReleaseId,
        'portfolio',
        context.portfolioId,
      )),
    );
  }
  if (input.previousGenerationId) {
    projectBuckets.push(
      ...(await collectAffectedDistributionBuckets(
        queryable,
        input.sessionId,
        input.previousGenerationId,
        input.analysisReleaseId,
        'project',
        context.projectId,
      )),
    );
    if (input.isRoot !== false) {
      portfolioBuckets.push(
        ...(await collectAffectedDistributionBuckets(
          queryable,
          input.sessionId,
          input.previousGenerationId,
          input.analysisReleaseId,
          'portfolio',
          context.portfolioId,
        )),
      );
    }
  }
  const dedupe = new Map<string, DistributionBucket>();
  for (const bucket of projectBuckets) dedupe.set(bucketKey(bucket), bucket);
  const dedupedProject = [...dedupe.values()];
  dedupe.clear();
  for (const bucket of portfolioBuckets) dedupe.set(bucketKey(bucket), bucket);
  const dedupedPortfolio = [...dedupe.values()];
  for (const bucket of dedupedProject) {
    await recomputeDistributionBucket(queryable, bucket, token);
  }
  for (const bucket of dedupedPortfolio) {
    await recomputeDistributionBucket(queryable, bucket, token);
  }
  return {
    projectBucketsRebuilt: dedupedProject.length,
    portfolioBucketsRebuilt: dedupedPortfolio.length,
  };
}

/**
 * Full rebuild of all project distribution buckets from current session
 * contributions. Useful for reprocessing and repair workflows.
 */
export async function rebuildProjectDistributions(
  queryable: Queryable,
  projectId: string,
  analysisReleaseId: string,
  generationToken: string,
): Promise<number> {
  const { rows } = await queryable.exec(
    `SELECT DISTINCT mv.comparability_group_id, mv.metric_definition_id, mv.dimensions_key
     FROM metric_values mv
     JOIN metric_definitions md ON md.id = mv.metric_definition_id
     JOIN sessions s ON s.id = mv.session_id
     JOIN transformation_generations tg ON tg.id = mv.generation_id
     WHERE s.project_id = ? AND tg.analysis_release_id = ?
       AND LOWER(md.aggregation) = 'distribution'
       AND s.current_generation_id = mv.generation_id`,
    [projectId, analysisReleaseId],
  );
  await queryable.exec(
    'DELETE FROM project_distributions WHERE project_id = ? AND analysis_release_id = ?',
    [projectId, analysisReleaseId],
  );
  for (const row of rows) {
    await recomputeDistributionBucket(
      queryable,
      {
        scope: 'project',
        scopeId: projectId,
        analysisReleaseId,
        comparabilityGroupId: asString(row.comparability_group_id),
        metricDefinitionId: asString(row.metric_definition_id),
        dimensionsKey: asOptionalString(row.dimensions_key),
      },
      generationToken,
    );
  }
  return rows.length;
}

/**
 * Full rebuild of all portfolio distribution buckets from current session
 * contributions.
 */
export async function rebuildPortfolioDistributions(
  queryable: Queryable,
  portfolioId: string,
  analysisReleaseId: string,
  generationToken: string,
): Promise<number> {
  const { rows } = await queryable.exec(
    `SELECT DISTINCT mv.comparability_group_id, mv.metric_definition_id, mv.dimensions_key
     FROM metric_values mv
     JOIN metric_definitions md ON md.id = mv.metric_definition_id
     JOIN sessions s ON s.id = mv.session_id
     JOIN transformation_generations tg ON tg.id = mv.generation_id
     JOIN projects p ON p.id = s.project_id
     WHERE p.portfolio_id = ? AND tg.analysis_release_id = ?
       AND LOWER(md.aggregation) = 'distribution'
       AND s.current_generation_id = mv.generation_id`,
    [portfolioId, analysisReleaseId],
  );
  await queryable.exec(
    'DELETE FROM portfolio_distributions WHERE portfolio_id = ? AND analysis_release_id = ?',
    [portfolioId, analysisReleaseId],
  );
  for (const row of rows) {
    await recomputeDistributionBucket(
      queryable,
      {
        scope: 'portfolio',
        scopeId: portfolioId,
        analysisReleaseId,
        comparabilityGroupId: asString(row.comparability_group_id),
        metricDefinitionId: asString(row.metric_definition_id),
        dimensionsKey: asOptionalString(row.dimensions_key),
      },
      generationToken,
    );
  }
  return rows.length;
}

// ---------------------------------------------------------------------------
// Cohorts
// ---------------------------------------------------------------------------

export interface BuildCohortInput {
  readonly analysisReleaseId: string;
  readonly recipeId: string;
  readonly recipeVersion: number;
  readonly scope: 'project' | 'portfolio';
  readonly scopeId: string;
  readonly referenceTime: number;
  readonly startTime: number;
  readonly endTime: number;
  readonly dimensionName?: string | null;
  readonly dimensionValue?: string | null;
  readonly matchingDimension?: string | null;
  readonly generationToken?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface CohortBuildResult {
  readonly cohort: ComparisonCohort;
  readonly beforeN: number;
  readonly afterN: number;
  readonly matchedPairs: number;
  readonly members: readonly ComparisonCohortMember[];
}

interface CohortSession {
  readonly id: string;
  readonly projectId: string;
  readonly occurrenceTime: number | null;
  readonly harness: string | null;
  readonly mode: string | null;
  readonly taskCohort: string | null;
  readonly currentGenerationId: string | null;
}

function sessionDimensionValue(session: CohortSession, dimensionName: string): string | null {
  const record = session as unknown as Record<string, unknown>;
  const value = record[dimensionName];
  if (value === null || value === undefined) return null;
  return String(value);
}

function isKnownValue(value: MetricValue): boolean {
  return !value.isUnavailable && !value.isNotApplicable;
}

function numericValue(value: MetricValue): number | null {
  if (!isKnownValue(value)) return null;
  if (value.valueType === 'integer') return value.integerValue;
  if (value.valueType === 'real' || value.valueType === 'currency' || value.valueType === 'ratio') {
    return value.numericValue;
  }
  return null;
}

async function listEligibleSessions(
  queryable: Queryable,
  input: BuildCohortInput,
): Promise<readonly CohortSession[]> {
  const scopeColumn = input.scope === 'project' ? 's.project_id' : 'p.portfolio_id';
  const scopeJoin = input.scope === 'project' ? '' : 'JOIN projects p ON p.id = s.project_id';
  const dimensionColumns: Record<string, string> = {
    harness: 's.harness',
    mode: 's.mode',
    taskCohort: 's.task_cohort',
    task_cohort: 's.task_cohort',
  };
  const dimensionColumn =
    input.dimensionName && input.dimensionName in dimensionColumns
      ? dimensionColumns[input.dimensionName]
      : null;
  const dimensionFilter = dimensionColumn ? ` AND ${dimensionColumn} = ?` : '';
  const params: SqliteValue[] = [input.scopeId, input.startTime, input.endTime];
  if (input.dimensionValue !== undefined && input.dimensionValue !== null) {
    params.push(input.dimensionValue);
  }
  const { rows } = await queryable.exec(
    `SELECT s.id, s.project_id, s.occurrence_time, s.harness, s.mode, s.task_cohort,
            s.current_generation_id
     FROM sessions s
     JOIN transformation_generations tg ON tg.id = s.current_generation_id
     ${scopeJoin}
     WHERE ${scopeColumn} = ?
       AND s.occurrence_time >= ?
       AND s.occurrence_time <= ?
       AND tg.analysis_release_id = ?
       ${dimensionFilter}
     ORDER BY s.occurrence_time`,
    [...params, input.analysisReleaseId],
  );
  return rows.map((row) => ({
    id: asString(row.id),
    projectId: asString(row.project_id),
    occurrenceTime: toOptionalNumber(row.occurrence_time),
    harness: asOptionalString(row.harness),
    mode: asOptionalString(row.mode),
    taskCohort: asOptionalString(row.task_cohort),
    currentGenerationId: asOptionalString(row.current_generation_id),
  })) as unknown as CohortSession[];
}

function groupLabelFor(occurrenceTime: number | null, referenceTime: number): CohortGroupLabel {
  if (occurrenceTime === null || occurrenceTime === undefined) return 'before';
  return occurrenceTime < referenceTime ? 'before' : 'after';
}

async function upsertComparisonCohort(
  queryable: Queryable,
  input: BuildCohortInput,
  cohortType: CohortType,
): Promise<ComparisonCohort> {
  const existing = await ComparisonCohortStore.getByRecipeAndType(
    queryable,
    input.analysisReleaseId,
    input.recipeId,
    input.recipeVersion,
    cohortType,
    input.dimensionName ?? null,
    input.dimensionValue ?? null,
  );
  if (existing) {
    await queryable.exec('DELETE FROM comparison_cohort_members WHERE cohort_id = ?', [
      existing.id,
    ]);
    await ComparisonCohortStore.update(queryable, existing.id, {
      referenceTime: input.referenceTime,
      startTime: input.startTime,
      endTime: input.endTime,
      metadata: JSON.stringify(input.metadata ?? {}),
    });
    return (await ComparisonCohortStore.getById(queryable, existing.id)) as ComparisonCohort;
  }
  const insert: InsertComparisonCohortInput = {
    analysisReleaseId: input.analysisReleaseId,
    cohortType,
    recipeId: input.recipeId,
    recipeVersion: input.recipeVersion,
    dimensionName: input.dimensionName ?? null,
    dimensionValue: input.dimensionValue ?? null,
    referenceTime: input.referenceTime,
    startTime: input.startTime,
    endTime: input.endTime,
    metadata: JSON.stringify(input.metadata ?? {}),
  };
  const id = await ComparisonCohortStore.insert(queryable, insert);
  return (await ComparisonCohortStore.getById(queryable, id)) as ComparisonCohort;
}

/**
 * Build a simple observed before/after cohort. Members are assigned to the
 * 'before' or 'after' group based on `referenceTime`.
 */
export async function buildObservedBeforeAfterCohort(
  queryable: Queryable,
  input: BuildCohortInput,
): Promise<CohortBuildResult> {
  const sessions = await listEligibleSessions(queryable, input);
  const cohortGenerationId = input.generationToken ?? sessions[0]?.currentGenerationId;
  if (!cohortGenerationId) {
    throw new Error(
      'BuildCohortInput requires generationToken or sessions with a current generation',
    );
  }
  const cohort = await upsertComparisonCohort(queryable, input, 'before_after');
  const members: ComparisonCohortMember[] = [];
  for (const session of sessions) {
    const label = groupLabelFor(session.occurrenceTime, input.referenceTime);
    const memberInput: InsertComparisonCohortMemberInput = {
      cohortId: cohort.id,
      sessionId: session.id,
      generationId: cohortGenerationId,
      groupLabel: label,
      concurrentEventId: null,
    };
    const memberId = await ComparisonCohortMemberStore.insert(queryable, memberInput);
    const member = (await ComparisonCohortMemberStore.getById(
      queryable,
      memberId,
    )) as ComparisonCohortMember;
    members.push(member);
  }
  return {
    cohort,
    beforeN: members.filter((m) => m.groupLabel === 'before').length,
    afterN: members.filter((m) => m.groupLabel === 'after').length,
    matchedPairs: 0,
    members,
  };
}

/**
 * Build a matched before/after cohort. First builds an observed cohort, then
 * pairs before and after sessions on `matchingDimension`. Matched pairs are
 * stored with 'control' (before) and 'treatment' (after) group labels.
 */
export async function buildMatchedCohort(
  queryable: Queryable,
  input: BuildCohortInput,
): Promise<CohortBuildResult> {
  const sessions = await listEligibleSessions(queryable, input);
  const cohortGenerationId = input.generationToken ?? sessions[0]?.currentGenerationId;
  if (!cohortGenerationId) {
    throw new Error(
      'BuildCohortInput requires generationToken or sessions with a current generation',
    );
  }
  const cohort = await upsertComparisonCohort(queryable, input, 'matched');
  const before = sessions.filter((s) => (s.occurrenceTime ?? 0) < input.referenceTime);
  const after = sessions.filter((s) => (s.occurrenceTime ?? 0) >= input.referenceTime);
  const unmatchedBefore = new Map<string, (CohortSession & { matched: boolean })[]>();
  for (const session of before) {
    const key = sessionDimensionValue(session, input.matchingDimension ?? 'taskCohort') ?? '';
    const list = unmatchedBefore.get(key) ?? [];
    list.push({ ...session, matched: false } as CohortSession & { matched: boolean });
    unmatchedBefore.set(key, list);
  }
  const members: ComparisonCohortMember[] = [];
  let matchedPairs = 0;
  for (const afterSession of after) {
    const key = sessionDimensionValue(afterSession, input.matchingDimension ?? 'taskCohort') ?? '';
    const list = unmatchedBefore.get(key);
    const pair = list?.find((s) => !s.matched);
    if (!pair) continue;
    pair.matched = true;
    matchedPairs++;
    const controlInput: InsertComparisonCohortMemberInput = {
      cohortId: cohort.id,
      sessionId: pair.id,
      generationId: cohortGenerationId,
      groupLabel: 'control',
      concurrentEventId: null,
    };
    const treatmentInput: InsertComparisonCohortMemberInput = {
      cohortId: cohort.id,
      sessionId: afterSession.id,
      generationId: cohortGenerationId,
      groupLabel: 'treatment',
      concurrentEventId: null,
    };
    const controlId = await ComparisonCohortMemberStore.insert(queryable, controlInput);
    const treatmentId = await ComparisonCohortMemberStore.insert(queryable, treatmentInput);
    members.push(
      (await ComparisonCohortMemberStore.getById(queryable, controlId)) as ComparisonCohortMember,
    );
    members.push(
      (await ComparisonCohortMemberStore.getById(queryable, treatmentId)) as ComparisonCohortMember,
    );
  }
  return {
    cohort,
    beforeN: before.length,
    afterN: after.length,
    matchedPairs,
    members,
  };
}

/**
 * Group and attach concurrent configuration changes to cohort members.
 * Does not isolate causal credit; it only discloses what changed in the
 * same window as the cohort.
 */
export async function discloseConcurrentChanges(
  queryable: Queryable,
  cohortId: string,
): Promise<number> {
  const members = await ComparisonCohortMemberStore.listByCohort(queryable, cohortId);
  const cohort = await ComparisonCohortStore.getById(queryable, cohortId);
  if (!cohort) return 0;
  const sessionIds = [...new Set(members.map((m) => m.sessionId))];
  if (sessionIds.length === 0) return 0;
  const placeholders = sessionIds.map(() => '?').join(',');
  const { rows } = await queryable.exec(
    `SELECT id, session_id, id AS concurrent_event_group_id,
            'context' AS source
     FROM component_context_events
     WHERE session_id IN (${placeholders})
       AND start_time >= ? AND start_time <= ?
     UNION
     SELECT l.id, tg.session_id,
            COALESCE(l.concurrent_event_group_id, l.id) AS concurrent_event_group_id,
            'lifecycle' AS source
     FROM component_lifecycle_events l
     JOIN transformation_generations tg ON tg.id = l.generation_id
     WHERE tg.session_id IN (${placeholders})
       AND l.created_at >= ? AND l.created_at <= ?`,
    [
      ...sessionIds,
      cohort.startTime ?? 0,
      cohort.endTime ?? Number.MAX_SAFE_INTEGER,
      ...sessionIds,
      cohort.startTime ?? 0,
      cohort.endTime ?? Number.MAX_SAFE_INTEGER,
    ],
  );
  const eventsBySession = new Map<string, string>();
  for (const row of rows) {
    const sessionId = asString(row.session_id);
    const groupId = asOptionalString(row.concurrent_event_group_id) ?? asString(row.id);
    if (!eventsBySession.has(sessionId)) {
      eventsBySession.set(sessionId, groupId);
    }
  }
  let updated = 0;
  for (const member of members) {
    const eventId = eventsBySession.get(member.sessionId);
    if (eventId === undefined) continue;
    await ComparisonCohortMemberStore.update(queryable, member.id, {
      concurrentEventId: eventId,
    });
    updated++;
  }
  return updated;
}

// ---------------------------------------------------------------------------
// Cohort metric summaries and deltas
// ---------------------------------------------------------------------------

export interface CohortMetricSummary {
  readonly before: {
    readonly eligibleN: number;
    readonly knownN: number;
    readonly unknownCount: number;
    readonly coverage: number | null;
    readonly sum: number;
    readonly mean: number | null;
    readonly p50: number | null;
  };
  readonly after: {
    readonly eligibleN: number;
    readonly knownN: number;
    readonly unknownCount: number;
    readonly coverage: number | null;
    readonly sum: number;
    readonly mean: number | null;
    readonly p50: number | null;
  };
  readonly absoluteDelta: number;
  readonly relativeDelta: number | null;
  readonly relativeDeltaUndefined: boolean;
  readonly claimsSuppressed: boolean;
  readonly suppressionReason: string | null;
}

async function currentMetricValueForSession(
  queryable: Queryable,
  sessionId: string,
  metricDefinitionId: string,
  comparabilityGroupId: string,
  dimensionsKey: string | null,
): Promise<MetricValue | undefined> {
  const values = await MetricValueStore.listBySession(queryable, sessionId);
  return values.find(
    (v) =>
      v.metricDefinitionId === metricDefinitionId &&
      v.comparabilityGroupId === comparabilityGroupId &&
      (v.dimensionsKey ?? null) === (dimensionsKey ?? null) &&
      v.isUnavailable === false &&
      v.isNotApplicable === false,
  );
}

function groupMetricValues(values: (number | null)[]): {
  eligibleN: number;
  knownN: number;
  unknownCount: number;
  coverage: number | null;
  sum: number;
  mean: number | null;
  p50: number | null;
} {
  const eligibleN = values.length;
  const known = values.filter((v): v is number => v !== null);
  const knownN = known.length;
  const unknownCount = eligibleN - knownN;
  const sum = known.reduce((a, b) => a + b, 0);
  const mean = knownN > 0 ? sum / knownN : null;
  const p50 =
    knownN > 0
      ? percentile(
          known.sort((a, b) => a - b),
          0.5,
        )
      : null;
  return {
    eligibleN,
    knownN,
    unknownCount,
    coverage: coverage(knownN, eligibleN),
    sum,
    mean,
    p50,
  };
}

/**
 * Evaluate a metric across a comparison cohort. Enforces the versioned
 * statistical policy for small cohorts: it shows eligible `N`, known `n`,
 * unknown count, and coverage; it suppresses unsupported relative-delta claims
 * but still reports the absolute delta and raw evidence.
 */
export async function evaluateCohortMetric(
  queryable: Queryable,
  cohortId: string,
  metricDefinitionId: string,
  comparabilityGroupId: string,
  options?: {
    readonly dimensionsKey?: string | null;
    readonly statisticalPolicyId?: string;
  },
): Promise<CohortMetricSummary> {
  const members = await ComparisonCohortMemberStore.listByCohort(queryable, cohortId);
  const beforeValues: (number | null)[] = [];
  const afterValues: (number | null)[] = [];
  for (const member of members) {
    const value = await currentMetricValueForSession(
      queryable,
      member.sessionId,
      metricDefinitionId,
      comparabilityGroupId,
      options?.dimensionsKey ?? null,
    );
    const numeric = value ? numericValue(value) : null;
    if (member.groupLabel === 'before' || member.groupLabel === 'control') {
      beforeValues.push(numeric);
    } else if (member.groupLabel === 'after' || member.groupLabel === 'treatment') {
      afterValues.push(numeric);
    }
  }
  const before = groupMetricValues(beforeValues);
  const after = groupMetricValues(afterValues);
  const absoluteDelta = after.sum - before.sum;
  let relativeDelta: number | null = null;
  let relativeDeltaUndefined = false;
  if (before.sum === 0) {
    relativeDeltaUndefined = true;
  } else {
    relativeDelta = absoluteDelta / before.sum;
  }
  const policy = options?.statisticalPolicyId
    ? await StatisticalPolicyStore.getById(queryable, options.statisticalPolicyId)
    : undefined;
  const minN = percentileMinimumFor(policy);
  const claimsSuppressed = before.knownN < minN || after.knownN < minN;
  let suppressionReason: string | null = null;
  if (claimsSuppressed) {
    suppressionReason = `small cohort: known n before=${before.knownN} after=${after.knownN} below minimum ${minN}`;
  }
  return {
    before,
    after,
    absoluteDelta,
    relativeDelta: claimsSuppressed ? null : relativeDelta,
    relativeDeltaUndefined,
    claimsSuppressed,
    suppressionReason,
  };
}

// ---------------------------------------------------------------------------
// Deterministic insights
// ---------------------------------------------------------------------------

export interface RecordInsightInput {
  readonly analysisReleaseId: string;
  readonly recipeId: string;
  readonly recipeVersion: number;
  readonly insightKind: 'trend' | 'anomaly' | 'comparison' | 'coverage' | 'performance';
  readonly wordingInputs?: Record<string, string>;
  readonly evidenceIds?: readonly string[];
  readonly confidence?: number;
  readonly confidenceReason?: string;
  readonly determinismVersion: string;
  readonly generationId?: string | null;
}

function isDeterministic(version: string): boolean {
  return version.startsWith('deterministic');
}

function deterministicInsightId(input: RecordInsightInput): string {
  const sortedEvidence = [...(input.evidenceIds ?? [])].sort();
  const sortedWordingKeys = Object.keys(input.wordingInputs ?? {}).sort();
  const wordingParts = sortedWordingKeys.map((k) => `${k}=${input.wordingInputs?.[k] ?? ''}`);
  return `iev-${deterministicId(
    'insight-evidence',
    input.analysisReleaseId,
    input.recipeId,
    String(input.recipeVersion),
    input.insightKind,
    input.determinismVersion,
    wordingParts.join('\x1f'),
    sortedEvidence.join('\x1f'),
    input.generationId ?? '',
  )}`;
}

/**
 * Record deterministic insight evidence. The recipe id is deterministic from
 * the recipe, wording inputs, evidence IDs, and determinism version, so the
 * same logical insight always maps to the same row.
 */
export async function recordInsightEvidence(
  queryable: Queryable,
  input: RecordInsightInput,
): Promise<string> {
  if (!isDeterministic(input.determinismVersion)) {
    throw new Error(`Insight is not deterministic: ${input.determinismVersion}`);
  }
  const id = deterministicInsightId(input);
  const existing = await InsightEvidenceStore.getById(queryable, id);
  if (existing) return existing.id;
  const insert: InsertInsightEvidenceInput = {
    id,
    analysisReleaseId: input.analysisReleaseId,
    recipeId: input.recipeId,
    recipeVersion: input.recipeVersion,
    insightKind: input.insightKind,
    wordingInputs: JSON.stringify(input.wordingInputs ?? {}),
    evidenceIds: JSON.stringify([...(input.evidenceIds ?? [])]),
    confidence: input.confidence ?? null,
    confidenceReason: input.confidenceReason ?? null,
    determinismVersion: input.determinismVersion,
    generationId: input.generationId ?? null,
  };
  return InsightEvidenceStore.insert(queryable, insert);
}

/**
 * Record a heuristic insight. A deterministic variant for the same recipe must
 * already exist before a heuristic variant is stored.
 */
export async function recordHeuristicInsight(
  queryable: Queryable,
  input: RecordInsightInput,
): Promise<string> {
  if (isDeterministic(input.determinismVersion)) {
    throw new Error(`Use recordInsightEvidence for deterministic insights`);
  }
  const deterministic = await InsightEvidenceStore.getByRecipeAndKind(
    queryable,
    input.analysisReleaseId,
    input.recipeId,
    input.recipeVersion,
    input.insightKind,
    input.generationId ?? null,
  );
  if (!deterministic || !isDeterministic(deterministic.determinismVersion)) {
    throw new Error(
      `Deterministic insight must exist before heuristic variant: ${input.recipeId} v${input.recipeVersion}`,
    );
  }
  const id = `iev-heuristic-${deterministicId(
    'insight-evidence-heuristic',
    input.analysisReleaseId,
    input.recipeId,
    String(input.recipeVersion),
    input.insightKind,
    input.determinismVersion,
    JSON.stringify(input.wordingInputs ?? {}),
    JSON.stringify([...(input.evidenceIds ?? [])]),
    input.generationId ?? '',
    String(Date.now()),
  )}`;
  const insert: InsertInsightEvidenceInput = {
    id,
    analysisReleaseId: input.analysisReleaseId,
    recipeId: input.recipeId,
    recipeVersion: input.recipeVersion,
    insightKind: input.insightKind,
    wordingInputs: JSON.stringify(input.wordingInputs ?? {}),
    evidenceIds: JSON.stringify([...(input.evidenceIds ?? [])]),
    confidence: input.confidence ?? null,
    confidenceReason: input.confidenceReason ?? null,
    determinismVersion: input.determinismVersion,
    generationId: input.generationId ?? null,
  };
  return InsightEvidenceStore.insert(queryable, insert);
}

export interface ReconcileDistributionsResult {
  readonly projectMismatches: readonly DistributionReconciliationMismatch[];
  readonly portfolioMismatches: readonly DistributionReconciliationMismatch[];
}

export interface DistributionReconciliationMismatch {
  readonly scope: 'project' | 'portfolio';
  readonly scopeId: string;
  readonly analysisReleaseId: string;
  readonly comparabilityGroupId: string;
  readonly metricDefinitionId: string;
  readonly dimensionsKey: string | null;
  readonly expectedCount: number;
  readonly actualCount: number;
}

/**
 * Verify that the materialized distribution counts match the current session
 * contributions for a project and portfolio.
 */
export async function reconcileDistributionCounts(
  queryable: Queryable,
  projectId: string,
  portfolioId: string,
  analysisReleaseId: string,
): Promise<ReconcileDistributionsResult> {
  const projectMismatches: DistributionReconciliationMismatch[] = [];
  const portfolioMismatches: DistributionReconciliationMismatch[] = [];
  for (const scope of ['project', 'portfolio'] as const) {
    const scopeId = scope === 'project' ? projectId : portfolioId;
    const table = scope === 'project' ? 'project_distributions' : 'portfolio_distributions';
    const { rows: rollupRows } = await queryable.exec(
      `SELECT comparability_group_id, metric_definition_id, dimensions_key, known_n
       FROM ${table}
       WHERE ${scope}_id = ? AND analysis_release_id = ?`,
      [scopeId, analysisReleaseId],
    );
    const scopeColumn = scope === 'project' ? 's.project_id' : 'p.portfolio_id';
    const scopeJoin = scope === 'project' ? '' : 'JOIN projects p ON p.id = s.project_id';
    for (const row of rollupRows) {
      const comparabilityGroupId = asString(row.comparability_group_id);
      const metricDefinitionId = asString(row.metric_definition_id);
      const dimensionsKey = asOptionalString(row.dimensions_key);
      const { rows: valueRows } = await queryable.exec(
        `SELECT COUNT(*) AS c
         FROM metric_values mv
         JOIN metric_definitions md ON md.id = mv.metric_definition_id
         JOIN sessions s ON s.id = mv.session_id
         JOIN transformation_generations tg ON tg.id = mv.generation_id
         ${scopeJoin}
         WHERE ${scopeColumn} = ? AND tg.analysis_release_id = ?
           AND mv.comparability_group_id = ?
           AND mv.metric_definition_id = ?
           AND COALESCE(mv.dimensions_key, '') = COALESCE(?, '')
           AND LOWER(md.aggregation) = 'distribution'
           AND s.current_generation_id = mv.generation_id
           AND mv.is_unavailable = 0 AND mv.is_not_applicable = 0`,
        [scopeId, analysisReleaseId, comparabilityGroupId, metricDefinitionId, dimensionsKey ?? ''],
      );
      const expected = toNumber(valueRows[0]?.c);
      const actual = toNumber(row.known_n);
      if (expected !== actual) {
        const mismatch: DistributionReconciliationMismatch = {
          scope,
          scopeId,
          analysisReleaseId,
          comparabilityGroupId,
          metricDefinitionId,
          dimensionsKey,
          expectedCount: expected,
          actualCount: actual,
        };
        if (scope === 'project') projectMismatches.push(mismatch);
        else portfolioMismatches.push(mismatch);
      }
    }
  }
  return { projectMismatches, portfolioMismatches };
}

export function isDistributionsReconciled(result: ReconcileDistributionsResult): boolean {
  return result.projectMismatches.length === 0 && result.portfolioMismatches.length === 0;
}
