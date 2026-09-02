import type {
  PortfolioDailyRollup,
  PortfolioDimensionRollup,
  PortfolioDistribution,
  SqliteExecutor,
  SqliteTransaction,
  SqliteValue,
} from '@lucasschirm/sal-db-core';
import {
  ComponentIdentityStore,
  MetricDefinitionStore,
  PortfolioDailyRollupStore,
  PortfolioDimensionRollupStore,
  PortfolioDistributionStore,
  ProjectStore,
} from '@lucasschirm/sal-db-core';
import type {
  AnalyticsQuery,
  ComponentUtilizationPage,
  ComponentUtilizationRow,
  ModelHarnessCohort,
  ModelHarnessCohortPage,
  PortfolioOverview,
  PortfolioTrendSeries,
  PortfolioView,
  ProjectListItem,
  ProjectListPage,
  TimeSeriesPoint,
} from './analytics.js';
import {
  type AnalyticsToken,
  type Coverage,
  type EvidenceLink,
  type MeasurementClass,
  type MetricValueDto,
  makeMetricValueDto,
} from './dto.js';

type Queryable = SqliteExecutor | SqliteTransaction;

const DEFAULT_LIMIT = 50;

/**
 * Maps a stored component kind to its display-friendly form.
 * `configuration.ts` canonicalises `mcp` → `mcp_server` and `settings` →
 * `setting` for storage; we reverse that for display so the chart shows
 * `mcp/github` and `settings/...` as users expect.
 */
function displayKind(kind: string): string {
  if (kind === 'mcp_server') return 'mcp';
  if (kind === 'setting') return 'settings';
  return kind;
}

/**
 * Composes a human-friendly component name from the stored identity fields.
 * Prefers `kind/nativeId` (e.g. `skill/multi-issue-agent`, `agent/developer`,
 * `mcp/github`), falling back to `kind/displayName`, then `componentId`.
 */
function componentDisplayName(
  kind: string,
  nativeId: string,
  displayName: string,
  componentId: string,
): string {
  const label = nativeId || displayName || componentId;
  if (!kind || kind === 'unknown') return label;
  return `${displayKind(kind)}/${label}`;
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
  return 'unknown';
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

async function resolvePortfolioId(
  queryable: Queryable,
  query: AnalyticsQuery,
): Promise<string | null> {
  if (query.portfolioId) return query.portfolioId;
  const { rows } = await queryable.exec(
    'SELECT id FROM portfolios ORDER BY created_at LIMIT 1',
    [],
  );
  return rows.length > 0 ? asString(rows[0].id) : null;
}

function resolveTimeRange(
  query: AnalyticsQuery,
  defaultStart: number,
  defaultEnd: number,
): { start: number; end: number } {
  if (query.timeRange) {
    const start = Date.parse(query.timeRange.start);
    const end = Date.parse(query.timeRange.end);
    return {
      start: Number.isNaN(start) ? defaultStart : start,
      end: Number.isNaN(end) ? defaultEnd : end,
    };
  }
  return { start: defaultStart, end: defaultEnd };
}

async function loadMetricDefinitions(
  queryable: Queryable,
  metricDefinitionIds: readonly string[],
): Promise<
  ReadonlyMap<
    string,
    {
      metricId: string;
      version: number;
      label: string;
      unit: string;
      aggregation: string;
      measurementClass: MeasurementClass;
    }
  >
> {
  const map = new Map<
    string,
    {
      metricId: string;
      version: number;
      label: string;
      unit: string;
      aggregation: string;
      measurementClass: MeasurementClass;
    }
  >();
  const uniqueIds = [...new Set(metricDefinitionIds)];
  for (const id of uniqueIds) {
    const definition = await MetricDefinitionStore.getById(queryable, id);
    if (definition) {
      map.set(definition.id, {
        metricId: definition.metricId,
        version: definition.version,
        label: definition.label,
        unit: definition.unit,
        aggregation: definition.aggregation,
        measurementClass: definition.measurementClass,
      });
    }
  }
  return map;
}

function distributionValue(
  distribution: PortfolioDistribution,
  aggregation: string,
): number | null {
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

function isDistributionInQuery(
  distribution: PortfolioDistribution,
  query: AnalyticsQuery,
): boolean {
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

function isDailyRollupInQuery(
  rollup: PortfolioDailyRollup,
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

function isDimensionRollupInQuery(
  rollup: PortfolioDimensionRollup,
  query: AnalyticsQuery,
): boolean {
  if (query.analysisReleaseId && rollup.analysisReleaseId !== query.analysisReleaseId) return false;
  if (query.comparabilityGroupId && rollup.comparabilityGroupId !== query.comparabilityGroupId) {
    return false;
  }
  if (query.generationId && rollup.generationId !== query.generationId) return false;
  return true;
}

function makeBaseToken(
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
  return makeToken(
    analysisReleaseId,
    generationId,
    comparabilityGroupId,
    eligibleN,
    knownN,
    unknownCount,
    measurementClass,
    metricVersion,
    evidenceLinks,
  );
}

function makeMetricValue(
  metricId: string,
  value: number | null,
  unit: string,
  label: string,
  token: AnalyticsToken,
): MetricValueDto {
  return {
    ...makeMetricValueDto(metricId, value, token),
    unit,
    label,
    isExact: token.measurementClass === 'observed',
  };
}

function metricFromDistribution(
  distribution: PortfolioDistribution,
  definition: {
    metricId: string;
    version: number;
    label: string;
    unit: string;
    aggregation: string;
    measurementClass: MeasurementClass;
  },
  baseToken: AnalyticsToken,
): MetricValueDto {
  const value = distributionValue(distribution, definition.aggregation);
  const measurementClass = measurementClassForAggregate(
    definition.measurementClass,
    definition.aggregation,
  );
  const metricToken: AnalyticsToken = {
    ...baseToken,
    analysisReleaseId: distribution.analysisReleaseId,
    generationId: distribution.generationId,
    comparabilityGroupId: distribution.comparabilityGroupId,
    eligibleN: distribution.eligibleN,
    knownN: distribution.knownN,
    unknownCount: distribution.unknownCount,
    coverage: coverageLabel(coverage(distribution.knownN, distribution.eligibleN)),
    measurementClass,
    confidence: confidenceFor(coverage(distribution.knownN, distribution.eligibleN)),
    metricVersion: String(definition.version),
    evidenceLinks: [evidenceLink('portfolio_distribution', distribution.id, definition.label)],
  };
  return makeMetricValue(
    definition.metricId,
    value,
    definition.unit,
    definition.label,
    metricToken,
  );
}

async function countProjectsInPortfolio(
  queryable: Queryable,
  portfolioId: string,
): Promise<number> {
  const { rows } = await queryable.exec(
    'SELECT COUNT(*) AS c FROM projects WHERE portfolio_id = ?',
    [portfolioId],
  );
  return asNumber(rows[0]?.c);
}

async function countSessionsInPortfolio(
  queryable: Queryable,
  portfolioId: string,
  query: AnalyticsQuery,
): Promise<number> {
  const generationId = query.generationId;
  const sql = generationId
    ? `SELECT COUNT(*) AS c
       FROM sessions s
       JOIN projects p ON p.id = s.project_id
       WHERE p.portfolio_id = ? AND s.current_generation_id = ?`
    : `SELECT COUNT(*) AS c
       FROM sessions s
       JOIN projects p ON p.id = s.project_id
       WHERE p.portfolio_id = ?`;
  const params = generationId ? [portfolioId, generationId] : [portfolioId];
  const { rows } = await queryable.exec(sql, params);
  return asNumber(rows[0]?.c);
}

async function sumTotalTokensInPortfolio(
  queryable: Queryable,
  portfolioId: string,
  query: AnalyticsQuery,
): Promise<number> {
  const generationId = query.generationId;
  const sql = generationId
    ? `SELECT COALESCE(SUM(r.value_sum), 0) AS total
       FROM portfolio_daily_rollups r
       JOIN metric_definitions d ON d.id = r.metric_definition_id
       WHERE r.portfolio_id = ? AND r.generation_id = ?
         AND d.metric_id = 'claude:tokens:total:inclusive'`
    : `SELECT COALESCE(SUM(r.value_sum), 0) AS total
       FROM portfolio_daily_rollups r
       JOIN metric_definitions d ON d.id = r.metric_definition_id
       WHERE r.portfolio_id = ?
         AND d.metric_id = 'claude:tokens:total:inclusive'`;
  const params = generationId ? [portfolioId, generationId] : [portfolioId];
  const { rows } = await queryable.exec(sql, params);
  return asNumber(rows[0]?.total);
}

async function countDistinctModelsInPortfolio(
  queryable: Queryable,
  portfolioId: string,
  query: AnalyticsQuery,
): Promise<number> {
  const generationId = query.generationId;
  const sql = generationId
    ? `SELECT COUNT(DISTINCT json_extract(e.raw_details, '$.payload.model')) AS c
       FROM normalized_events e
       JOIN sessions s ON s.id = e.session_id
       JOIN projects p ON p.id = s.project_id
       WHERE p.portfolio_id = ? AND s.current_generation_id = ?
         AND e.event_type = 'model_request'
         AND json_extract(e.raw_details, '$.payload.model') IS NOT NULL`
    : `SELECT COUNT(DISTINCT json_extract(e.raw_details, '$.payload.model')) AS c
       FROM normalized_events e
       JOIN sessions s ON s.id = e.session_id
       JOIN projects p ON p.id = s.project_id
       WHERE p.portfolio_id = ?
         AND e.event_type = 'model_request'
         AND json_extract(e.raw_details, '$.payload.model') IS NOT NULL`;
  const params = generationId ? [portfolioId, generationId] : [portfolioId];
  const { rows } = await queryable.exec(sql, params);
  return asNumber(rows[0]?.c);
}

async function countDistinctHarnessesInPortfolio(
  queryable: Queryable,
  portfolioId: string,
  query: AnalyticsQuery,
): Promise<number> {
  const generationId = query.generationId;
  const sql = generationId
    ? `SELECT COUNT(DISTINCT s.harness) AS c
       FROM sessions s
       JOIN projects p ON p.id = s.project_id
       WHERE p.portfolio_id = ? AND s.current_generation_id = ?`
    : `SELECT COUNT(DISTINCT s.harness) AS c
       FROM sessions s
       JOIN projects p ON p.id = s.project_id
       WHERE p.portfolio_id = ?`;
  const params = generationId ? [portfolioId, generationId] : [portfolioId];
  const { rows } = await queryable.exec(sql, params);
  return asNumber(rows[0]?.c);
}

async function countComponentsByKind(
  queryable: Queryable,
  portfolioId: string,
): Promise<Readonly<Record<string, number>>> {
  const { rows } = await queryable.exec(
    `SELECT kind, COUNT(*) AS c
     FROM component_identities
     WHERE portfolio_id = ?
     GROUP BY kind`,
    [portfolioId],
  );
  const counts: Record<string, number> = {};
  for (const row of rows) {
    counts[asString(row.kind)] = asNumber(row.c);
  }
  return counts;
}

async function findUnusedOfferedComponents(
  queryable: Queryable,
  portfolioId: string,
  query: AnalyticsQuery,
): Promise<readonly string[]> {
  const allIdentities = await ComponentIdentityStore.listByPortfolio(queryable, portfolioId);
  // component_rollups is not populated by the current ingestion pipeline.
  // Use session_component_exposures to determine which components are
  // actually used (exposed) in at least one session.
  const { rows: usedRows } = await queryable.exec(
    `SELECT DISTINCT sce.component_id
     FROM session_component_exposures sce
     JOIN sessions s ON s.id = sce.session_id
     JOIN projects p ON p.id = s.project_id
     WHERE p.portfolio_id = ?
       AND (? IS NULL OR sce.generation_id = ?)`,
    [portfolioId, query.generationId ?? null, query.generationId ?? null],
  );
  const usedIds = new Set(usedRows.map((r) => asString(r.component_id)));
  // Return human-friendly labels (e.g. `skill/multi-issue-agent`), never raw
  // component ids. The UI must never display internal ids to end users; see
  // the `never-display-raw-ids` rule. Falls back to the id only when no
  // nativeId/displayName is available, which is itself a data-quality signal.
  return allIdentities
    .filter((i) => !usedIds.has(i.id))
    .map((i) => componentDisplayName(i.kind, i.nativeId, i.displayName ?? '', i.id));
}

function pageTokens(
  query: AnalyticsQuery,
  distributions: readonly { analysisReleaseId: string; generationId: string }[],
) {
  const analysisReleaseId =
    query.analysisReleaseId ?? distributions[0]?.analysisReleaseId ?? 'unknown';
  const generationId = query.generationId ?? distributions[0]?.generationId ?? 'unknown';
  const comparabilityGroupId = query.comparabilityGroupId ?? 'portfolio-overview';
  return { analysisReleaseId, generationId, comparabilityGroupId };
}

export async function getPortfolioOverview(
  queryable: Queryable,
  query: AnalyticsQuery,
): Promise<PortfolioOverview> {
  const portfolioId = await resolvePortfolioId(queryable, query);
  if (!portfolioId) {
    const emptyToken = makeBaseToken(
      query.analysisReleaseId ?? 'unknown',
      query.generationId ?? 'unknown',
      query.comparabilityGroupId ?? 'portfolio-overview',
      0,
      0,
      0,
      'derived',
      'overview-0.1.0',
      [evidenceLink('portfolio', 'unknown', 'Portfolio overview')],
    );
    return {
      token: emptyToken,
      headlineMetrics: [],
      projectCount: 0,
      sessionCount: 0,
      componentCounts: {},
      unusedOfferedComponents: [],
      totalTokens: 0,
      modelCount: 0,
      harnessCount: 0,
    };
  }

  const allDistributions = await PortfolioDistributionStore.listByPortfolio(queryable, portfolioId);
  const distributions = allDistributions.filter((d) => isDistributionInQuery(d, query));
  const definitions = await loadMetricDefinitions(
    queryable,
    distributions.map((d) => d.metricDefinitionId),
  );

  const tokens = pageTokens(query, distributions);
  const eligibleN = distributions.reduce((s, d) => s + d.eligibleN, 0);
  const knownN = distributions.reduce((s, d) => s + d.knownN, 0);
  const unknownCount = distributions.reduce((s, d) => s + d.unknownCount, 0);
  const overviewToken = makeBaseToken(
    tokens.analysisReleaseId,
    tokens.generationId,
    tokens.comparabilityGroupId,
    eligibleN,
    knownN,
    unknownCount,
    'derived',
    'overview-0.1.0',
    [evidenceLink('portfolio', portfolioId, 'Portfolio overview')],
  );

  const headlineMetrics: MetricValueDto[] = [];
  for (const distribution of distributions) {
    const definition = definitions.get(distribution.metricDefinitionId);
    if (!definition) continue;
    headlineMetrics.push(metricFromDistribution(distribution, definition, overviewToken));
  }

  const projectCount = await countProjectsInPortfolio(queryable, portfolioId);
  const sessionCount = await countSessionsInPortfolio(queryable, portfolioId, query);
  const componentCounts = await countComponentsByKind(queryable, portfolioId);
  const unusedOfferedComponents = await findUnusedOfferedComponents(queryable, portfolioId, query);
  const totalTokens = await sumTotalTokensInPortfolio(queryable, portfolioId, query);
  const modelCount = await countDistinctModelsInPortfolio(queryable, portfolioId, query);
  const harnessCount = await countDistinctHarnessesInPortfolio(queryable, portfolioId, query);

  const countToken: AnalyticsToken = {
    ...overviewToken,
    comparabilityGroupId: 'portfolio-counts',
    measurementClass: 'observed',
    metricVersion: 'count-0.1.0',
    evidenceLinks: [evidenceLink('portfolio', portfolioId, 'Portfolio counts')],
  };

  headlineMetrics.push(
    makeMetricValue('portfolio-project-count', projectCount, 'count', 'Project count', countToken),
  );
  headlineMetrics.push(
    makeMetricValue('portfolio-session-count', sessionCount, 'count', 'Session count', countToken),
  );
  headlineMetrics.push(
    makeMetricValue(
      'portfolio-component-count',
      Object.values(componentCounts).reduce((a, b) => a + b, 0),
      'count',
      'Component count',
      countToken,
    ),
  );
  headlineMetrics.push(
    makeMetricValue(
      'portfolio-unused-components',
      unusedOfferedComponents.length,
      'count',
      'Unused offered components',
      countToken,
    ),
  );

  return {
    token: overviewToken,
    headlineMetrics,
    projectCount,
    sessionCount,
    componentCounts,
    unusedOfferedComponents,
    totalTokens,
    modelCount,
    harnessCount,
  };
}

export async function getPortfolioTrends(
  queryable: Queryable,
  query: AnalyticsQuery,
): Promise<PortfolioTrendSeries> {
  const portfolioId = await resolvePortfolioId(queryable, query);
  const allRollups = portfolioId
    ? await PortfolioDailyRollupStore.listByPortfolio(queryable, portfolioId)
    : [];
  const range = resolveTimeRange(query, 0, Number.MAX_SAFE_INTEGER);
  const rollups = allRollups.filter((r) => isDailyRollupInQuery(r, query, range));
  const definitions = await loadMetricDefinitions(
    queryable,
    rollups.map((r) => r.metricDefinitionId),
  );

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
  series.sort((a, b) => a.time.localeCompare(b.time) || a.metricId.localeCompare(b.metricId));

  const tokens = pageTokens(query, rollups);
  const knownN = series.filter((s) => s.value !== null).length;
  const token = makeBaseToken(
    tokens.analysisReleaseId,
    tokens.generationId,
    tokens.comparabilityGroupId,
    series.length,
    knownN,
    series.length - knownN,
    'derived',
    'trend-0.1.0',
    [evidenceLink('portfolio', portfolioId ?? 'unknown', 'Portfolio trend series')],
  );

  return { token, series };
}

export async function getComponentUtilization(
  queryable: Queryable,
  query: AnalyticsQuery,
): Promise<ComponentUtilizationPage> {
  const portfolioId = await resolvePortfolioId(queryable, query);
  if (!portfolioId) {
    return {
      items: [],
      generationToken: query.generationId ?? 'unknown',
      analysisReleaseToken: query.analysisReleaseId ?? 'unknown',
    };
  }

  const generationId = query.generationId ?? null;

  // Aggregate component utilization from session_component_exposures, which
  // is populated during ingestion. The component_rollups and
  // session_component_stats tables are not populated by the current ingestion
  // pipeline, so querying them yields no rows. session_component_exposures
  // tracks which components are available in which sessions; we count
  // distinct sessions and projects per component and join to
  // component_identities for the kind. Invocation/success counts are not
  // available from this table, so loadRate is null until a rollup pipeline
  // is added.
  const { rows: rollupRows } = await queryable.exec(
    `SELECT
       sce.component_id,
       ci.kind,
       ci.native_id,
       ci.display_name,
       COUNT(DISTINCT sce.session_id) AS session_count,
       COUNT(DISTINCT s.project_id) AS project_count
     FROM session_component_exposures sce
     JOIN sessions s ON s.id = sce.session_id
     JOIN projects p ON p.id = s.project_id
     LEFT JOIN component_identities ci ON ci.id = sce.component_id
     WHERE p.portfolio_id = ?
       AND (? IS NULL OR sce.generation_id = ?)
     GROUP BY sce.component_id, ci.kind, ci.native_id, ci.display_name
     ORDER BY sce.component_id`,
    [portfolioId, generationId, generationId],
  );

  const items: ComponentUtilizationRow[] = [];
  for (const row of rollupRows) {
    const componentId = asString(row.component_id);
    const kind = asString(row.kind ?? 'unknown');
    const nativeId = asOptionalString(row.native_id) ?? '';
    const displayName = asOptionalString(row.display_name) ?? '';
    const projectCount = asNumber(row.project_count);
    const totalInvocations = 0;
    const totalSuccess = 0;
    const sessionCount = asNumber(row.session_count);
    const name = componentDisplayName(kind, nativeId, displayName, componentId);

    const reliability = totalInvocations > 0 ? totalSuccess / totalInvocations : null;
    const token = makeBaseToken(
      query.analysisReleaseId ?? 'unknown',
      query.generationId ?? 'unknown',
      query.comparabilityGroupId ?? 'component-utilization',
      totalInvocations,
      totalInvocations,
      0,
      'derived',
      'load-rate-0.1.0',
      [evidenceLink('component', componentId, `Component ${name} utilization`)],
    );

    items.push({
      componentId,
      name,
      kind,
      projectCount,
      sessionCount,
      loadRate: makeMetricValue('load-rate', reliability, 'ratio', 'Load rate', token),
      token,
    });
  }

  const tokens = pageTokens(query, []);
  return paginate(items, query, {
    generationToken: tokens.generationId,
    analysisReleaseToken: tokens.analysisReleaseId,
  });
}

export async function getModelHarnessCohorts(
  queryable: Queryable,
  query: AnalyticsQuery,
): Promise<ModelHarnessCohortPage> {
  const portfolioId = await resolvePortfolioId(queryable, query);
  if (!portfolioId) {
    return {
      items: [],
      generationToken: query.generationId ?? 'unknown',
      analysisReleaseToken: query.analysisReleaseId ?? 'unknown',
    };
  }

  const generationId = query.generationId ?? null;

  // Build true (model, harness) cohort pairs by joining sessions with
  // model_requests. This avoids the previous per-dimension grouping that
  // produced duplicated "unknown / claude-code" and "Unknown / unknown" rows.
  // Sessions with no model_requests get model = NULL → 'unknown'.
  const { rows: cohortRows } = await queryable.exec(
    `SELECT
       COALESCE(mr.model, 'unknown') AS model,
       COALESCE(s.harness, 'unknown') AS harness,
       COUNT(DISTINCT s.id) AS session_count
     FROM sessions s
     JOIN projects p ON p.id = s.project_id
     LEFT JOIN model_requests mr
       ON mr.session_id = s.id
       AND mr.generation_id = s.current_generation_id
     WHERE p.portfolio_id = ?
       AND (? IS NULL OR s.current_generation_id = ?)
     GROUP BY COALESCE(mr.model, 'unknown'), COALESCE(s.harness, 'unknown')
     ORDER BY session_count DESC, model, harness`,
    [portfolioId, generationId, generationId],
  );

  const analysisReleaseId = query.analysisReleaseId ?? 'unknown';
  const resolvedGenerationId = query.generationId ?? 'unknown';
  const comparabilityGroupId = query.comparabilityGroupId ?? 'model-harness-cohort';

  const items: ModelHarnessCohort[] = [];
  for (const row of cohortRows) {
    const model = asString(row.model) || 'unknown';
    const harness = asString(row.harness) || 'unknown';
    const sessionCount = asNumber(row.session_count);
    const token = makeBaseToken(
      analysisReleaseId,
      resolvedGenerationId,
      comparabilityGroupId,
      sessionCount,
      sessionCount,
      0,
      'derived',
      'model-harness-cohort-0.1.0',
      [evidenceLink('portfolio', portfolioId, `Cohort ${model}/${harness}`)],
    );
    items.push({
      model,
      harness,
      sessionCount,
      metricValues: [],
      token,
    });
  }

  const tokens = pageTokens(query, []);
  return paginate(items, query, {
    generationToken: tokens.generationId,
    analysisReleaseToken: tokens.analysisReleaseId,
  });
}

const COMPLETENESS_PRIORITY: Record<string, number> = {
  complete: 0,
  partial: 1,
  unsupported: 2,
  unknown: 3,
  failed: 3,
  skipped: 3,
  pending: 3,
};

function toCoverage(completeness: string | null): Coverage {
  if (!completeness) return 'unknown';
  if (completeness === 'complete') return 'complete';
  if (completeness === 'partial') return 'partial';
  if (completeness === 'unsupported') return 'unsupported';
  return 'unknown';
}

function worstCompleteness(values: readonly (string | null)[]): Coverage {
  let worst: string | null = null;
  let worstRank = -1;
  for (const value of values) {
    if (!value) continue;
    const rank = COMPLETENESS_PRIORITY[value] ?? 3;
    if (worst === null || rank > worstRank) {
      worst = value;
      worstRank = rank;
    }
  }
  return toCoverage(worst);
}

function aggregateFinality(values: readonly string[]): ProjectListItem['finality'] {
  if (values.length === 0) return 'unknown';
  if (values.every((v) => v === 'final')) return 'final';
  if (values.some((v) => v === 'censored')) return 'censored';
  if (values.some((v) => v === 'open')) return 'open';
  return 'partial';
}

function aggregateIssueState(severities: readonly string[]): ProjectListItem['issueState'] {
  if (severities.length === 0) return 'clean';
  if (severities.some((s) => s === 'fatal')) return 'fatal';
  if (severities.some((s) => s === 'recoverable')) return 'issues';
  return 'clean';
}

interface ProjectListSourceRow {
  readonly projectId: string;
  readonly occurrenceTime: number | null;
  readonly source: string;
  readonly harness: string;
  readonly finality: string;
}

function formatTime(timestamp: number | null | undefined): string | undefined {
  if (timestamp === null || timestamp === undefined) return undefined;
  return new Date(timestamp).toISOString();
}

async function loadProjectListRows(
  queryable: Queryable,
  portfolioId: string,
  query: AnalyticsQuery,
): Promise<ProjectListItem[]> {
  const generationId = query.generationId;
  const baseParams = generationId ? [portfolioId, generationId] : [portfolioId];
  const generationFilter = generationId ? 'AND s.current_generation_id = ?' : '';

  const { rows: sessionRows } = await queryable.exec(
    `SELECT s.project_id, s.occurrence_time, s.ingestion_source_id, s.harness, s.finality
     FROM sessions s
     JOIN projects p ON p.id = s.project_id
     WHERE p.portfolio_id = ? ${generationFilter}
     ORDER BY s.occurrence_time DESC`,
    baseParams,
  );

  const projectSessions = new Map<string, ProjectListSourceRow[]>();
  for (const row of sessionRows) {
    const projectId = asString(row.project_id);
    const list = projectSessions.get(projectId) ?? [];
    list.push({
      projectId,
      occurrenceTime: asOptionalNumber(row.occurrence_time),
      source: asString(row.ingestion_source_id),
      harness: asString(row.harness),
      finality: asString(row.finality),
    });
    projectSessions.set(projectId, list);
  }

  let manifestFilter = '';
  const manifestParams: SqliteValue[] = [portfolioId];
  if (generationId) {
    const sessionIds = sessionRows.map((r) => asString(r.id)).filter((id) => id.length > 0);
    if (sessionIds.length > 0) {
      manifestFilter = ` AND sm.session_id IN (${sessionIds.map(() => '?').join(',')})`;
      manifestParams.push(...sessionIds);
    }
  }

  const { rows: manifestRows } = await queryable.exec(
    `SELECT sm.ingestion_source_id, sm.harness, sm.finality, sm.reprocessing_status,
            sm.capture_time, sp.project_id
     FROM source_manifests sm
     JOIN source_projects sp ON sp.id = sm.source_project_id
     JOIN projects p ON p.id = sp.project_id
     WHERE p.portfolio_id = ? ${manifestFilter}
     ORDER BY sm.capture_time DESC`,
    manifestParams,
  );

  const projectManifests = new Map<
    string,
    {
      source: string;
      harness: string;
      finality: string;
      reprocessing: string;
      captureTime: number | null;
    }[]
  >();
  for (const row of manifestRows) {
    const projectId = asString(row.project_id);
    const list = projectManifests.get(projectId) ?? [];
    list.push({
      source: asString(row.ingestion_source_id),
      harness: asString(row.harness),
      finality: asString(row.finality),
      reprocessing: asString(row.reprocessing_status),
      captureTime: asOptionalNumber(row.capture_time),
    });
    projectManifests.set(projectId, list);
  }

  const { rows: coverageRows } = await queryable.exec(
    `SELECT mc.discovery_completeness, sp.project_id
     FROM manifest_coverage mc
     JOIN source_manifests sm ON sm.id = mc.source_manifest_id
     JOIN source_projects sp ON sp.id = sm.source_project_id
     JOIN projects p ON p.id = sp.project_id
     WHERE p.portfolio_id = ?`,
    [portfolioId],
  );

  const projectCoverage = new Map<string, (string | null)[]>();
  for (const row of coverageRows) {
    const projectId = asString(row.project_id);
    const list = projectCoverage.get(projectId) ?? [];
    list.push(asOptionalString(row.discovery_completeness));
    projectCoverage.set(projectId, list);
  }

  const { rows: issueRows } = await queryable.exec(
    `SELECT ii.severity, s.project_id
     FROM ingestion_issues ii
     JOIN transformation_generations tg ON tg.id = ii.generation_id
     JOIN sessions s ON s.id = tg.session_id
     JOIN projects p ON p.id = s.project_id
     WHERE p.portfolio_id = ? ${generationFilter}`,
    baseParams,
  );

  const projectIssues = new Map<string, string[]>();
  for (const row of issueRows) {
    const projectId = asString(row.project_id);
    const list = projectIssues.get(projectId) ?? [];
    list.push(asString(row.severity));
    projectIssues.set(projectId, list);
  }

  const projects = await ProjectStore.listByPortfolio(queryable, portfolioId);
  const items: ProjectListItem[] = [];

  for (const project of projects) {
    const sessions = projectSessions.get(project.id) ?? [];
    const manifests = projectManifests.get(project.id) ?? [];
    const coverages = projectCoverage.get(project.id) ?? [];
    const issues = projectIssues.get(project.id) ?? [];

    const sessionCount = sessions.length;
    const lastSessionAt = sessions[0]?.occurrenceTime ?? undefined;
    const source = sessions[0]?.source ?? manifests[0]?.source ?? 'unknown';
    const harness = sessions[0]?.harness ?? manifests[0]?.harness ?? 'unknown';
    const completeness = worstCompleteness(coverages);
    const finality = aggregateFinality(sessions.map((s) => s.finality));
    const reprocessing: ProjectListItem['reprocessing'] =
      (manifests[0]?.reprocessing as ProjectListItem['reprocessing']) ?? 'unknown';
    const issueState = aggregateIssueState(issues);

    const eligibleN = sessionCount + 6;
    let knownN = 0;
    if (sessionCount > 0) knownN += 1;
    if (source !== 'unknown') knownN += 1;
    if (harness !== 'unknown') knownN += 1;
    if (coverages.length > 0) knownN += 1;
    if (sessions.length > 0) knownN += 1;
    if (manifests.length > 0) knownN += 1;
    if (issues.length > 0 || manifests.length > 0) knownN += 1;
    const unknownCount = eligibleN - knownN;

    const token = makeBaseToken(
      query.analysisReleaseId ?? 'unknown',
      query.generationId ?? 'unknown',
      query.comparabilityGroupId ?? 'project-list',
      eligibleN,
      knownN,
      unknownCount,
      'derived',
      'project-list-0.1.0',
      [evidenceLink('project', project.id, `Project ${project.name}`)],
    );

    items.push({
      projectId: project.id,
      name: project.name,
      sessionCount,
      lastSessionAt: formatTime(lastSessionAt),
      source,
      harness,
      completeness,
      finality,
      reprocessing,
      issueState,
      coverage: coverageLabel(coverage(knownN, eligibleN)),
      token,
    });
  }

  return items;
}

function paginate<T>(
  allItems: readonly T[],
  query: AnalyticsQuery,
  tokens: { generationToken: string; analysisReleaseToken: string },
): {
  items: readonly T[];
  nextCursor?: string;
  previousCursor?: string;
  generationToken: string;
  analysisReleaseToken: string;
} {
  const limit = query.limit ?? DEFAULT_LIMIT;
  const offset = Number(query.cursor ?? 0);
  const safeOffset = Number.isNaN(offset) || offset < 0 ? 0 : offset;
  const items = allItems.slice(safeOffset, safeOffset + limit);
  return {
    items,
    nextCursor: safeOffset + limit < allItems.length ? String(safeOffset + limit) : undefined,
    previousCursor: safeOffset > 0 ? String(Math.max(0, safeOffset - limit)) : undefined,
    generationToken: tokens.generationToken,
    analysisReleaseToken: tokens.analysisReleaseToken,
  };
}

export async function getProjectList(
  queryable: Queryable,
  query: AnalyticsQuery,
): Promise<ProjectListPage> {
  const portfolioId = await resolvePortfolioId(queryable, query);
  if (!portfolioId) {
    return {
      items: [],
      generationToken: query.generationId ?? 'unknown',
      analysisReleaseToken: query.analysisReleaseId ?? 'unknown',
    };
  }

  const allItems = await loadProjectListRows(queryable, portfolioId, query);
  allItems.sort((a, b) => a.name.localeCompare(b.name) || a.projectId.localeCompare(b.projectId));

  const tokens = pageTokens(query, []);
  return paginate(allItems, query, {
    generationToken: tokens.generationId,
    analysisReleaseToken: tokens.analysisReleaseId,
  });
}

export function createPortfolioView(queryable: Queryable): PortfolioView {
  return {
    getOverview: (query) => getPortfolioOverview(queryable, query),
    getTrends: (query) => getPortfolioTrends(queryable, query),
    getComponentUtilization: (query) => getComponentUtilization(queryable, query),
    getModelHarnessCohorts: (query) => getModelHarnessCohorts(queryable, query),
    getProjectList: (query) => getProjectList(queryable, query),
  };
}
