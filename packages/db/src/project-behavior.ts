import type {
  ComparisonCohort,
  ProjectDailyRollup,
  ProjectDistribution,
  SqliteExecutor,
  SqliteRow,
  SqliteTransaction,
  SqliteValue,
  StoredMetricDefinition,
} from '@lucasschirm/sal-db-core';
import {
  MetricDefinitionStore,
  ProjectDailyRollupStore,
  ProjectDistributionStore,
  SessionStore,
} from '@lucasschirm/sal-db-core';
import type {
  AnalyticsQuery,
  CohortSummary,
  ComparisonPage,
  ComparisonRow,
  ConfigurationTimeline,
  ConfigurationTimelineEvent,
  OutlierPage,
  OutlierRow,
  ProjectBehaviorSummary,
  ProjectBehaviorView,
  SessionOutcomeDistribution,
  SessionTrendSeries,
  TimeSeriesPoint,
} from './analytics.js';
import { getSessionOutcomeDistribution } from './analytics-session.js';
import {
  type BuildCohortInput,
  buildMatchedCohort,
  buildObservedBeforeAfterCohort,
  type CohortBuildResult,
  type CohortMetricSummary,
  discloseConcurrentChanges,
  evaluateCohortMetric,
  type RecordInsightInput,
  recordHeuristicInsight,
  recordInsightEvidence,
} from './distributions.js';
import {
  type AnalyticsToken,
  type Coverage,
  type EvidenceLink,
  type MeasurementClass,
  type MetricValueDto,
  makeMetricValueDto,
} from './dto.js';

type Queryable = SqliteExecutor | SqliteTransaction;

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

function toDayBucket(timestamp: number, timeZone = 'UTC'): string {
  const date = new Date(timestamp);
  if (timeZone === 'UTC') {
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  } catch {
    return toDayBucket(timestamp, 'UTC');
  }
}

function coverage(known: number, eligible: number): number | null {
  if (eligible === 0) return null;
  return known / eligible;
}

function confidenceFor(coverageValue: number | null): AnalyticsToken['confidence'] {
  if (coverageValue === null || coverageValue <= 0) return 'unknown';
  if (coverageValue >= 0.8) return 'high';
  if (coverageValue >= 0.5) return 'medium';
  return 'low';
}

function coverageLabel(coverageValue: number | null): Coverage {
  if (coverageValue === null || coverageValue <= 0) return 'unknown';
  if (coverageValue >= 0.8) return 'complete';
  if (coverageValue >= 0.5) return 'partial';
  return 'partial';
}

function numericValueForMetric(row: SqliteRow): number | null {
  const valueType = asString(row.value_type);
  if (valueType === 'integer') return asOptionalNumber(row.integer_value);
  if (valueType === 'real' || valueType === 'currency' || valueType === 'ratio') {
    return asOptionalNumber(row.numeric_value);
  }
  return null;
}

function isKnownMetric(row: SqliteRow): boolean {
  return !(row.is_unavailable === 1 || row.is_not_applicable === 1);
}

function parseTime(value: string | number | undefined): number {
  if (value === undefined) return Date.now();
  if (typeof value === 'number') return value;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Date.now() : parsed;
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

function resolveTimeRange(
  query: AnalyticsQuery,
  defaultStart: number,
  defaultEnd: number,
): { start: number; end: number } {
  if (query.timeRange) {
    return {
      start: parseTime(query.timeRange.start),
      end: parseTime(query.timeRange.end),
    };
  }
  return { start: defaultStart, end: defaultEnd };
}

function evidenceLink(entityType: string, entityId: string, label: string): EvidenceLink {
  return { evidenceId: entityId, entityType, entityId, label };
}

function makeToken(
  analysisReleaseId: string,
  generationId: string,
  comparabilityGroupId: string,
  eligibleN: number,
  knownN: number,
  unknownCount: number,
  measurementClass: MeasurementClass,
  metricVersion: string,
  evidenceLinks: readonly EvidenceLink[],
): AnalyticsToken {
  const coverageValue = coverage(knownN, eligibleN);
  return {
    analysisReleaseId,
    generationId,
    comparabilityGroupId,
    eligibleN,
    knownN,
    unknownCount,
    coverage: coverageLabel(coverageValue),
    measurementClass,
    confidence: confidenceFor(coverageValue),
    metricVersion,
    evidenceLinks,
  };
}

async function loadMetricDefinitions(
  queryable: Queryable,
  metricDefinitionIds: readonly string[],
): Promise<ReadonlyMap<string, StoredMetricDefinition>> {
  const map = new Map<string, StoredMetricDefinition>();
  const uniqueIds = [...new Set(metricDefinitionIds)];
  for (const id of uniqueIds) {
    const definition = await MetricDefinitionStore.getById(queryable, id);
    if (definition) map.set(definition.id, definition);
  }
  return map;
}

function distributionValue(distribution: ProjectDistribution, aggregation: string): number | null {
  const lower = aggregation.toLowerCase();
  if (lower === 'sum' || lower === 'count') return distribution.sum;
  return distribution.mean;
}

function measurementClassForAggregate(
  baseClass: MeasurementClass,
  aggregation: string,
): MeasurementClass {
  const lower = aggregation.toLowerCase();
  if (lower === 'sum' || lower === 'count') return baseClass;
  return 'derived';
}

function isDistributionInQuery(distribution: ProjectDistribution, query: AnalyticsQuery): boolean {
  if (query.analysisReleaseId && distribution.analysisReleaseId !== query.analysisReleaseId) {
    return false;
  }
  if (
    query.comparabilityGroupId &&
    distribution.comparabilityGroupId !== query.comparabilityGroupId
  ) {
    return false;
  }
  if (query.generationId && distribution.generationId !== query.generationId) {
    return false;
  }
  return true;
}

function isRollupInQuery(
  rollup: ProjectDailyRollup,
  query: AnalyticsQuery,
  range: { start: number; end: number },
): boolean {
  if (query.analysisReleaseId && rollup.analysisReleaseId !== query.analysisReleaseId) return false;
  if (query.comparabilityGroupId && rollup.comparabilityGroupId !== query.comparabilityGroupId) {
    return false;
  }
  if (query.generationId && rollup.generationId !== query.generationId) return false;
  const dayStart = toDayBucket(range.start);
  const dayEnd = toDayBucket(range.end);
  return rollup.dayBucket >= dayStart && rollup.dayBucket <= dayEnd;
}

function parseOutlierMultiplier(rule: string | null): number {
  if (!rule) return 1.5;
  const match = rule.match(/(?:iqr|sigma|z):([\d.]+)/i);
  return match ? Number(match[1]) : 1.5;
}

function outlierBounds(
  distribution: ProjectDistribution,
  multiplier: number,
): { lower: number; upper: number } | null {
  if (distribution.p50 === null || distribution.p75 === null) return null;
  const q1 = 2 * distribution.p50 - distribution.p75;
  const q3 = distribution.p75;
  const iqr = q3 - q1;
  return {
    lower: q1 - multiplier * iqr,
    upper: q3 + multiplier * iqr,
  };
}

function changeTypeForLifecycle(eventType: string): ConfigurationTimelineEvent['changeType'] {
  if (eventType === 'removed') return 'removed';
  if (eventType === 'added' || eventType === 'baseline') return 'added';
  return 'updated';
}

function changeTypeForContext(eventType: string): ConfigurationTimelineEvent['changeType'] {
  if (eventType === 'removed') return 'removed';
  if (eventType === 'loaded' || eventType === 'listed' || eventType === 'discovered')
    return 'added';
  return 'updated';
}

export interface RecordProjectBehaviorInsightInput extends RecordInsightInput {}

export async function recordProjectBehaviorInsight(
  queryable: Queryable,
  input: RecordProjectBehaviorInsightInput,
): Promise<string> {
  return recordInsightEvidence(queryable, input);
}

export async function recordHeuristicProjectBehaviorInsight(
  queryable: Queryable,
  input: RecordProjectBehaviorInsightInput,
): Promise<string> {
  return recordHeuristicInsight(queryable, input);
}

export async function getProjectBehaviorSummary(
  queryable: Queryable,
  projectId: string,
  query: AnalyticsQuery,
): Promise<ProjectBehaviorSummary> {
  // Headline metrics are sourced from project_daily_rollups, which are
  // populated at ingestion. The previous implementation read
  // project_distributions, which only materialise for metrics with
  // aggregation='distribution' — none exist — so the overview always showed
  // "No metrics available." Daily rollups aggregate per metric definition
  // across day buckets; we sum them to produce project-level totals.
  const allRollups = await ProjectDailyRollupStore.listByProject(queryable, projectId);
  const range = resolveTimeRange(query, 0, Number.MAX_SAFE_INTEGER);
  const rollups = allRollups.filter((r) => isRollupInQuery(r, query, range));
  const sessions = await SessionStore.listByProject(queryable, projectId);

  const definitionIds = rollups.map((r) => r.metricDefinitionId);
  const definitions = await loadMetricDefinitions(queryable, definitionIds);

  // Aggregate rollups per metric definition: sum valueSum for sum/count
  // aggregations, or take the mean of bucket means for mean aggregations.
  const perMetric = new Map<
    string,
    {
      definition: StoredMetricDefinition;
      sum: number;
      count: number;
      knownBuckets: number;
    }
  >();
  for (const rollup of rollups) {
    const definition = definitions.get(rollup.metricDefinitionId);
    if (!definition) continue;
    const lower = definition.aggregation.toLowerCase();
    const contribution = lower === 'sum' || lower === 'count' ? rollup.valueSum : rollup.valueMean;
    if (contribution === null) continue;
    const existing = perMetric.get(rollup.metricDefinitionId);
    if (existing) {
      existing.sum += contribution;
      existing.count += 1;
      if (rollup.valueCount > 0) existing.knownBuckets += 1;
    } else {
      perMetric.set(rollup.metricDefinitionId, {
        definition,
        sum: contribution,
        count: 1,
        knownBuckets: rollup.valueCount > 0 ? 1 : 0,
      });
    }
  }

  const headlineMetrics: MetricValueDto[] = [];
  let totalEligibleN = 0;
  let totalKnownN = 0;

  for (const { definition, sum, count, knownBuckets } of perMetric.values()) {
    const lower = definition.aggregation.toLowerCase();
    const value = lower === 'sum' || lower === 'count' ? sum : count > 0 ? sum / count : null;
    const measurementClass = measurementClassForAggregate(
      definition.measurementClass,
      definition.aggregation,
    );
    const analysisReleaseId =
      rollups.find((r) => r.metricDefinitionId === definition.id)?.analysisReleaseId ??
      query.analysisReleaseId ??
      'unknown';
    const generationId =
      rollups.find((r) => r.metricDefinitionId === definition.id)?.generationId ??
      query.generationId ??
      'unknown';
    const comparabilityGroupId =
      rollups.find((r) => r.metricDefinitionId === definition.id)?.comparabilityGroupId ??
      query.comparabilityGroupId ??
      'unknown';
    const token = makeToken(
      analysisReleaseId,
      generationId,
      comparabilityGroupId,
      count,
      knownBuckets,
      count - knownBuckets,
      measurementClass,
      String(definition.version),
      [evidenceLink('project_daily_rollup', definition.id, definition.label)],
    );
    headlineMetrics.push({
      ...makeMetricValueDto(definition.metricId, value, token),
      unit: definition.unit,
      label: definition.label,
    });
    totalEligibleN += count;
    totalKnownN += knownBuckets;
  }

  const analysisReleaseId = query.analysisReleaseId ?? rollups[0]?.analysisReleaseId ?? 'unknown';
  const generationId = rollups[0]?.generationId ?? query.generationId ?? 'unknown';
  const comparabilityGroupId =
    query.comparabilityGroupId ?? rollups[0]?.comparabilityGroupId ?? 'unknown';

  const token = makeToken(
    analysisReleaseId,
    generationId,
    comparabilityGroupId,
    sessions.length || totalEligibleN,
    Math.min(totalKnownN, sessions.length || totalEligibleN),
    Math.max(
      0,
      (sessions.length || totalEligibleN) -
        Math.min(totalKnownN, sessions.length || totalEligibleN),
    ),
    'derived',
    'summary-0.1.0',
    [evidenceLink('project', projectId, 'Project behavior summary')],
  );

  const trendToken = makeToken(
    analysisReleaseId,
    generationId,
    comparabilityGroupId,
    sessions.length,
    sessions.length,
    0,
    'derived',
    'trend-0.1.0',
    [evidenceLink('project', projectId, 'Session trend series')],
  );

  return { token, headlineMetrics, trendToken };
}

export async function getSessionTrendSeries(
  queryable: Queryable,
  projectId: string,
  query: AnalyticsQuery,
): Promise<SessionTrendSeries> {
  const allRollups = await ProjectDailyRollupStore.listByProject(queryable, projectId);
  const range = resolveTimeRange(query, 0, Number.MAX_SAFE_INTEGER);
  const rollups = allRollups.filter((r) => isRollupInQuery(r, query, range));

  const definitionIds = rollups.map((r) => r.metricDefinitionId);
  const definitions = await loadMetricDefinitions(queryable, definitionIds);

  const series: TimeSeriesPoint[] = [];
  for (const rollup of rollups) {
    const definition = definitions.get(rollup.metricDefinitionId);
    if (!definition) continue;
    const lower = definition.aggregation.toLowerCase();
    const value = lower === 'sum' || lower === 'count' ? rollup.valueSum : rollup.valueMean;
    series.push({
      time: rollup.dayBucket,
      value,
      metricId: definition.metricId,
      label: definition.label,
      comparabilityGroupId: rollup.comparabilityGroupId,
    });
  }

  const analysisReleaseId = query.analysisReleaseId ?? rollups[0]?.analysisReleaseId ?? 'unknown';
  const generationId = rollups[0]?.generationId ?? query.generationId ?? 'unknown';
  const comparabilityGroupId =
    query.comparabilityGroupId ?? rollups[0]?.comparabilityGroupId ?? 'unknown';
  const knownN = series.filter((s) => s.value !== null).length;

  const token = makeToken(
    analysisReleaseId,
    generationId,
    comparabilityGroupId,
    series.length,
    knownN,
    series.length - knownN,
    'derived',
    'trend-0.1.0',
    [evidenceLink('project', projectId, 'Session trend series')],
  );

  return { token, series };
}

export async function getConfigurationTimeline(
  queryable: Queryable,
  projectId: string,
  query: AnalyticsQuery,
): Promise<ConfigurationTimeline> {
  const range = resolveTimeRange(query, 0, Date.now());
  const sessions = await SessionStore.listByProject(queryable, projectId);
  const sessionIds = sessions
    .filter((s) => {
      if (s.occurrenceTime === null) return true;
      return s.occurrenceTime >= range.start && s.occurrenceTime <= range.end;
    })
    .map((s) => s.id);

  const events: ConfigurationTimelineEvent[] = [];

  if (sessionIds.length > 0) {
    const placeholders = sessionIds.map(() => '?').join(',');
    const { rows: contextRows } = await queryable.exec(
      `SELECT
         cce.id, cce.component_id, cce.event_type, cce.start_time, cce.source_pointer,
         ci.kind AS component_kind
       FROM component_context_events cce
       JOIN component_identities ci ON ci.id = cce.component_id
       WHERE cce.session_id IN (${placeholders})
         AND cce.start_time >= ? AND cce.start_time <= ?
       ORDER BY cce.start_time`,
      [...sessionIds, range.start, range.end],
    );
    for (const row of contextRows) {
      events.push({
        sequence: events.length + 1,
        captureTime: formatTime(asNumber(row.start_time)),
        changeType: changeTypeForContext(asString(row.event_type)),
        componentId: asString(row.component_id),
        componentKind: asString(row.component_kind),
        toVersion: asOptionalString(row.source_pointer) ?? undefined,
      });
    }
  }

  const { rows: lifecycleRows } = await queryable.exec(
    `SELECT
       cle.id, cle.component_id, cle.event_type, cle.before_version_id, cle.after_version_id,
       cle.created_at, ci.kind AS component_kind,
       bv.source_pointer AS from_version, av.source_pointer AS to_version
     FROM component_lifecycle_events cle
     JOIN transformation_generations tg ON tg.id = cle.generation_id
     JOIN sessions s ON s.id = tg.session_id
     JOIN component_identities ci ON ci.id = cle.component_id
     LEFT JOIN component_versions bv ON bv.id = cle.before_version_id AND bv.component_id = cle.component_id
     LEFT JOIN component_versions av ON av.id = cle.after_version_id AND av.component_id = cle.component_id
     WHERE s.project_id = ? AND cle.created_at >= ? AND cle.created_at <= ?
     ORDER BY cle.created_at`,
    [projectId, range.start, range.end],
  );
  for (const row of lifecycleRows) {
    events.push({
      sequence: events.length + 1,
      captureTime: formatTime(asNumber(row.created_at)),
      changeType: changeTypeForLifecycle(asString(row.event_type)),
      componentId: asString(row.component_id),
      componentKind: asString(row.component_kind),
      fromVersion: asOptionalString(row.from_version) ?? undefined,
      toVersion: asOptionalString(row.to_version) ?? undefined,
    });
  }

  events.sort((a, b) => {
    const ta = a.captureTime ? Date.parse(a.captureTime) : 0;
    const tb = b.captureTime ? Date.parse(b.captureTime) : 0;
    return ta - tb;
  });
  for (let i = 0; i < events.length; i++) {
    events[i] = { ...events[i], sequence: i + 1 };
  }

  const analysisReleaseId = query.analysisReleaseId ?? 'unknown';
  const generationId = query.generationId ?? 'unknown';
  const comparabilityGroupId = query.comparabilityGroupId ?? 'unknown';

  const token = makeToken(
    analysisReleaseId,
    generationId,
    comparabilityGroupId,
    sessions.length,
    events.length,
    Math.max(0, sessions.length - events.length),
    'derived',
    'timeline-0.1.0',
    [evidenceLink('project', projectId, 'Configuration timeline')],
  );

  return { token, events };
}

export async function getOutliers(
  queryable: Queryable,
  projectId: string,
  query: AnalyticsQuery,
): Promise<OutlierPage> {
  const allDistributions = await ProjectDistributionStore.listByProject(queryable, projectId);
  const distributions = allDistributions.filter((d) => isDistributionInQuery(d, query));

  const items: OutlierRow[] = [];
  if (distributions.length === 0) {
    return {
      items,
      generationToken: query.generationId ?? 'unknown',
      analysisReleaseToken: query.analysisReleaseId ?? 'unknown',
    };
  }

  const definitionIds = distributions.map((d) => d.metricDefinitionId);
  const definitions = await loadMetricDefinitions(queryable, definitionIds);

  const metricDefinitionIds = [...new Set(distributions.map((d) => d.metricDefinitionId))];
  const comparabilityGroupIds = [...new Set(distributions.map((d) => d.comparabilityGroupId))];
  const analysisReleaseId = query.analysisReleaseId ?? distributions[0].analysisReleaseId;

  const metricPlaceholders = metricDefinitionIds.map(() => '?').join(',');
  const groupPlaceholders = comparabilityGroupIds.map(() => '?').join(',');

  const { rows: valueRows } = await queryable.exec(
    `SELECT
       mv.id, mv.session_id, mv.metric_definition_id, mv.comparability_group_id,
       mv.value_type, mv.integer_value, mv.numeric_value,
       md.metric_id
     FROM metric_values mv
     JOIN sessions s ON s.id = mv.session_id
     JOIN metric_definitions md ON md.id = mv.metric_definition_id
     JOIN transformation_generations tg ON tg.id = mv.generation_id
     WHERE s.project_id = ?
       AND mv.metric_definition_id IN (${metricPlaceholders})
       AND mv.comparability_group_id IN (${groupPlaceholders})
       AND tg.analysis_release_id = ?
       AND s.current_generation_id = mv.generation_id
       AND mv.is_unavailable = 0 AND mv.is_not_applicable = 0`,
    [projectId, ...metricDefinitionIds, ...comparabilityGroupIds, analysisReleaseId],
  );

  const valuesByGroup = new Map<string, SqliteRow[]>();
  for (const row of valueRows) {
    if (!isKnownMetric(row)) continue;
    const key = `${asString(row.metric_definition_id)}:${asString(row.comparability_group_id)}`;
    const list = valuesByGroup.get(key) ?? [];
    list.push(row);
    valuesByGroup.set(key, list);
  }

  for (const distribution of distributions) {
    const definition = definitions.get(distribution.metricDefinitionId);
    if (!definition) continue;
    const multiplier = parseOutlierMultiplier(distribution.outlierRule);
    const bounds = outlierBounds(distribution, multiplier);
    if (!bounds) continue;

    const key = `${distribution.metricDefinitionId}:${distribution.comparabilityGroupId}`;
    const values = valuesByGroup.get(key) ?? [];
    for (const row of values) {
      const numeric = numericValueForMetric(row);
      if (numeric === null) continue;
      if (numeric < bounds.lower || numeric > bounds.upper) {
        const sessionId = asString(row.session_id);
        const metricValueId = asString(row.id);
        const deviation = distribution.mean === null ? null : numeric - distribution.mean;
        items.push({
          sessionId,
          metricId: definition.metricId,
          value: numeric,
          deviation,
          evidenceLinks: [
            evidenceLink('metric_value', metricValueId, `Metric value ${definition.metricId}`),
            evidenceLink('session', sessionId, `Session ${sessionId}`),
          ],
        });
      }
    }
  }

  return {
    items,
    generationToken: query.generationId ?? distributions[0].generationId,
    analysisReleaseToken: query.analysisReleaseId ?? distributions[0].analysisReleaseId,
  };
}

export interface ProjectBehaviorComparisonOptions {
  readonly recipeId?: string;
  readonly recipeVersion?: number;
  readonly referenceTime?: number;
  readonly startTime?: number;
  readonly endTime?: number;
  readonly matchingDimension?: string | null;
  readonly dimensionName?: string | null;
  readonly dimensionValue?: string | null;
  readonly metricDefinitionId?: string;
  readonly comparabilityGroupId?: string;
  readonly direction?: 'higher_is_worse' | 'lower_is_worse';
  readonly regressionThreshold?: number;
  readonly buildObserved?: boolean;
  readonly buildMatched?: boolean;
  readonly discloseConcurrent?: boolean;
}

function metricValueFromCohortSummary(
  metricId: string,
  value: number | null,
  unit: string,
  label: string,
  token: AnalyticsToken,
): MetricValueDto {
  return { ...makeMetricValueDto(metricId, value, token), unit, label };
}

function buildCohortSummary(
  cohort: ComparisonCohort,
  groupLabel: 'before' | 'after' | 'control' | 'treatment',
  summary: { eligibleN: number; knownN: number; unknownCount: number },
): CohortSummary {
  return {
    cohortId: cohort.id,
    label: groupLabel,
    eligibleN: summary.eligibleN,
    knownN: summary.knownN,
    unknownCount: summary.unknownCount,
  };
}

function cohortSummaryToken(
  base: AnalyticsToken,
  before: { eligibleN: number; knownN: number; unknownCount: number },
  after: { eligibleN: number; knownN: number; unknownCount: number },
): AnalyticsToken {
  const eligibleN = before.eligibleN + after.eligibleN;
  const knownN = before.knownN + after.knownN;
  const unknownCount = before.unknownCount + after.unknownCount;
  const coverageValue = coverage(knownN, eligibleN);
  return {
    ...base,
    eligibleN,
    knownN,
    unknownCount,
    coverage: coverageLabel(coverageValue),
    confidence: confidenceFor(coverageValue),
  };
}

function comparisonRowFromSummary(
  kind: 'observed' | 'matched',
  cohort: ComparisonCohort,
  _buildResult: CohortBuildResult,
  summary: CohortMetricSummary,
  definition: StoredMetricDefinition,
  token: AnalyticsToken,
  direction: 'higher_is_worse' | 'lower_is_worse',
  threshold: number,
): ComparisonRow {
  const isRegression =
    !summary.claimsSuppressed &&
    !summary.relativeDeltaUndefined &&
    summary.relativeDelta !== null &&
    ((direction === 'higher_is_worse' && summary.relativeDelta > threshold) ||
      (direction === 'lower_is_worse' && summary.relativeDelta < -threshold));

  const beforeLabel = kind === 'observed' ? 'before' : 'control';
  const afterLabel = kind === 'observed' ? 'after' : 'treatment';
  const comparisonToken = cohortSummaryToken(token, summary.before, summary.after);

  return {
    comparisonId: cohort.id,
    kind,
    cohortA: buildCohortSummary(cohort, beforeLabel, summary.before),
    cohortB: buildCohortSummary(cohort, afterLabel, summary.after),
    metricValues: [
      metricValueFromCohortSummary(
        'absolute-delta',
        summary.absoluteDelta,
        definition.unit,
        `${definition.label} absolute delta`,
        comparisonToken,
      ),
      metricValueFromCohortSummary(
        'relative-delta',
        summary.relativeDelta,
        'ratio',
        `${definition.label} relative delta`,
        comparisonToken,
      ),
      metricValueFromCohortSummary(
        'regression',
        isRegression ? 1 : 0,
        'flag',
        `${definition.label} regression`,
        comparisonToken,
      ),
    ],
  };
}

async function findComparisonMetric(
  queryable: Queryable,
  projectId: string,
  query: AnalyticsQuery,
): Promise<{ distribution: ProjectDistribution; definition: StoredMetricDefinition } | null> {
  const allDistributions = await ProjectDistributionStore.listByProject(queryable, projectId);
  const distributions = allDistributions.filter((d) => isDistributionInQuery(d, query));
  if (distributions.length === 0) return null;
  const distribution = distributions[0];
  const definition = await MetricDefinitionStore.getById(
    queryable,
    distribution.metricDefinitionId,
  );
  if (!definition) return null;
  return { distribution, definition };
}

export async function getComparisons(
  queryable: Queryable,
  projectId: string,
  query: AnalyticsQuery,
  options: ProjectBehaviorComparisonOptions = {},
): Promise<ComparisonPage> {
  const metricPair = await findComparisonMetric(queryable, projectId, query);
  if (!metricPair) {
    return {
      items: [],
      generationToken: query.generationId ?? 'unknown',
      analysisReleaseToken: query.analysisReleaseId ?? 'unknown',
    };
  }
  const { distribution, definition } = metricPair;

  const range = resolveTimeRange(query, options.startTime ?? 0, options.endTime ?? Date.now());
  const referenceTime = options.referenceTime ?? Math.floor((range.start + range.end) / 2);

  const analysisReleaseId = query.analysisReleaseId ?? distribution.analysisReleaseId;
  const generationToken = query.generationId ?? distribution.generationId;

  const buildCohortInput: BuildCohortInput = {
    analysisReleaseId,
    recipeId: options.recipeId ?? `pb-${projectId}`,
    recipeVersion: options.recipeVersion ?? 1,
    scope: 'project',
    scopeId: projectId,
    referenceTime,
    startTime: range.start,
    endTime: range.end,
    matchingDimension: options.matchingDimension ?? 'taskCohort',
    dimensionName: options.dimensionName ?? null,
    dimensionValue: options.dimensionValue ?? null,
    generationToken,
    metadata: { direction: options.direction ?? 'higher_is_worse' },
  };

  const direction = options.direction ?? 'higher_is_worse';
  const threshold = options.regressionThreshold ?? 0.2;

  const token = makeToken(
    analysisReleaseId,
    generationToken,
    distribution.comparabilityGroupId,
    0,
    0,
    0,
    'derived',
    String(definition.version),
    [evidenceLink('project', projectId, 'Project comparison')],
  );

  const items: ComparisonRow[] = [];

  const buildObserved = options.buildObserved !== false;
  const buildMatched = options.buildMatched !== false;
  const discloseConcurrent = options.discloseConcurrent !== false;

  if (buildObserved) {
    const observed = await buildObservedBeforeAfterCohort(queryable, buildCohortInput);
    if (discloseConcurrent) await discloseConcurrentChanges(queryable, observed.cohort.id);
    const summary = await evaluateCohortMetric(
      queryable,
      observed.cohort.id,
      distribution.metricDefinitionId,
      distribution.comparabilityGroupId,
    );
    items.push(
      comparisonRowFromSummary(
        'observed',
        observed.cohort,
        observed,
        summary,
        definition,
        token,
        direction,
        threshold,
      ),
    );
  }

  if (buildMatched) {
    const matched = await buildMatchedCohort(queryable, buildCohortInput);
    if (discloseConcurrent) await discloseConcurrentChanges(queryable, matched.cohort.id);
    const summary = await evaluateCohortMetric(
      queryable,
      matched.cohort.id,
      distribution.metricDefinitionId,
      distribution.comparabilityGroupId,
    );
    items.push(
      comparisonRowFromSummary(
        'matched',
        matched.cohort,
        matched,
        summary,
        definition,
        token,
        direction,
        threshold,
      ),
    );
  }

  return {
    items,
    generationToken,
    analysisReleaseToken: analysisReleaseId,
  };
}

export function createProjectBehaviorView(queryable: Queryable): ProjectBehaviorView {
  return {
    getSummary: (projectId, query) => getProjectBehaviorSummary(queryable, projectId, query),
    getSessionTrendSeries: (projectId, query) => getSessionTrendSeries(queryable, projectId, query),
    getConfigurationTimeline: (projectId, query) =>
      getConfigurationTimeline(queryable, projectId, query),
    getOutliers: (projectId, query) => getOutliers(queryable, projectId, query),
    getComparisons: (projectId, query) => getComparisons(queryable, projectId, query),
    getOutcomeMix: (projectId, query) => getOutcomeMix(queryable, projectId, query),
  };
}

function getOutcomeMix(
  queryable: Queryable,
  projectId: string,
  query: AnalyticsQuery | undefined,
): Promise<SessionOutcomeDistribution> {
  return getSessionOutcomeDistribution(queryable, projectId, query);
}
