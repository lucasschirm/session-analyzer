import type { SqliteExecutor, SqliteRow, SqliteTransaction } from '@lucasschirm/sal-db-core';
import {
  ComponentIdentityStore,
  SessionComponentStatStore,
  SessionOutcomeStore,
  SourceTombstoneStore,
  ValidationStore,
} from '@lucasschirm/sal-db-core';
import type {
  AnalyticsQuery,
  ArtifactDiff,
  ArtifactVersionMetadata,
  ArtifactVersionView,
  ComponentDistributionPage,
  ComponentDistributionRow,
  ComponentEcosystemSummary,
  ComponentEcosystemView,
  ComponentFactPage,
  ComponentFactRow,
  ComponentProjectSessionPage,
  ComponentProjectSessionRow,
  ComponentScope,
  ComponentScopePage,
  ComponentUtilizationDetail,
  ComponentVersion,
  ComponentVersionPage,
  ContextTimingPoint,
  ContextTimingSeries,
  CoverageExplanation,
  EvidencePage,
  EvidenceRow,
  FilterField,
  FilterMetadata,
  FilterOperator,
  LifecycleComparisonPage,
  LifecycleComparisonRow,
  MetadataView,
  ProjectSessionListItem,
  ProjectSessionListPage,
  ProjectSessionSearchView,
  RootChildBreakdown,
  RootChildEntry,
  SessionEvidenceSummary,
  SessionEvidenceView,
  SessionOutcomeDistribution,
  SessionTree,
  SessionTreeNode,
  SessionValidation,
  SessionValidationSummary,
} from './analytics.js';
import { ArtifactDiffRepository } from './artifact-diff.js';
import type {
  AnalyticsToken,
  Coverage,
  EvidenceLink,
  MeasurementClass,
  MetricValueDto,
} from './dto.js';
import { makeMetricValueDto } from './dto.js';
import { createSha256ContentHasher } from './ingestion.js';
import type { ContentHasher } from './ports.js';

type Queryable = SqliteExecutor | SqliteTransaction;

const DEFAULT_LIMIT = 50;

function asString(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

function asOptionalString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function asNumber(value: unknown): number {
  return value === null || value === undefined ? 0 : Number(value);
}

function asOptionalNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function _asBoolean(value: unknown): boolean {
  return value === 1 || value === true || value === '1';
}

function safeJsonParse<T>(text: string | null, fallback: T): T {
  if (text === null || text === undefined) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function parseJsonRecord(text: string | null): Record<string, unknown> {
  return safeJsonParse<Record<string, unknown>>(text ?? '{}', {});
}

function formatTimestamp(value: unknown): string | undefined {
  const ts = asOptionalNumber(value);
  if (ts === null || ts <= 0) return undefined;
  return new Date(ts).toISOString();
}

function parseCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const n = Number.parseInt(cursor, 10);
  return Number.isNaN(n) || n < 0 ? 0 : n;
}

function pageLimit(query: AnalyticsQuery | undefined): number {
  return query?.limit && query.limit > 0 ? query.limit : DEFAULT_LIMIT;
}

function pageOffset(query: AnalyticsQuery | undefined): number {
  return parseCursor(query?.cursor);
}

interface PageTokens {
  readonly analysisReleaseId: string;
  readonly generationId: string;
  readonly comparabilityGroupId: string;
}

function pageTokens(query: AnalyticsQuery | undefined, fallback: PageTokens | null): PageTokens {
  if (fallback) {
    return {
      analysisReleaseId: query?.analysisReleaseId ?? fallback.analysisReleaseId,
      generationId: query?.generationId ?? fallback.generationId,
      comparabilityGroupId: query?.comparabilityGroupId ?? fallback.comparabilityGroupId,
    };
  }
  return {
    analysisReleaseId: query?.analysisReleaseId ?? 'unknown',
    generationId: query?.generationId ?? 'unknown',
    comparabilityGroupId: query?.comparabilityGroupId ?? 'unknown',
  };
}

function _pageCursorTokens(_query: AnalyticsQuery | undefined, tokens: PageTokens) {
  return {
    nextCursor: undefined as string | undefined,
    previousCursor: undefined as string | undefined,
    generationToken: tokens.generationId,
    analysisReleaseToken: tokens.analysisReleaseId,
  };
}

function evidenceLink(entityType: string, entityId: string, label: string): EvidenceLink {
  return { evidenceId: entityId, entityType, entityId, label };
}

function coverage(known: number, eligible: number): number | null {
  if (eligible === 0) return null;
  return known / eligible;
}

function coverageLabel(coverageValue: number | null): Coverage {
  if (coverageValue === null || coverageValue <= 0) return 'unknown';
  if (coverageValue >= 0.8) return 'complete';
  if (coverageValue >= 0.5) return 'partial';
  return 'unknown';
}

function confidenceFor(coverageValue: number | null): AnalyticsToken['confidence'] {
  if (coverageValue === null) return 'unknown';
  if (coverageValue >= 0.8) return 'high';
  if (coverageValue >= 0.5) return 'medium';
  return 'low';
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

function makeMetricValue(
  metricId: string,
  value: number | null,
  token: AnalyticsToken,
  unit = 'count',
  label = metricId,
  evidenceLinks?: readonly EvidenceLink[],
): MetricValueDto {
  return {
    ...makeMetricValueDto(metricId, value, token, evidenceLinks),
    unit,
    label,
  };
}

function metricValuesFromHeadline(
  headline: string | null,
  token: AnalyticsToken,
): readonly MetricValueDto[] {
  const parsed = safeJsonParse<unknown[]>(headline ?? '[]', []);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .map((item) =>
      makeMetricValue(
        asString(item.metricId ?? 'unknown'),
        asOptionalNumber(item.value),
        token,
        asString(item.unit ?? 'count'),
        asString(item.label ?? asString(item.metricId ?? 'unknown')),
      ),
    );
}

interface SessionContext {
  readonly id: string;
  readonly projectId: string;
  readonly ingestionSourceId: string;
  readonly nativeSessionId: string;
  readonly currentGenerationId: string | null;
  readonly harness: string;
  readonly finality: string;
  readonly mode: string | null;
  readonly taskCohort: string | null;
  readonly startTime: number | null;
  readonly endTime: number | null;
  readonly occurrenceTime: number | null;
}

async function getSessionContext(
  queryable: Queryable,
  sessionId: string,
): Promise<SessionContext | undefined> {
  const { rows } = await queryable.exec(
    `SELECT id, project_id, ingestion_source_id, native_session_id, current_generation_id,
            harness, finality, mode, task_cohort, start_time, end_time, occurrence_time
     FROM sessions WHERE id = ?`,
    [sessionId],
  );
  if (rows.length === 0) return undefined;
  const row = rows[0] as SqliteRow;
  return {
    id: asString(row.id),
    projectId: asString(row.project_id),
    ingestionSourceId: asString(row.ingestion_source_id),
    nativeSessionId: asString(row.native_session_id),
    currentGenerationId: asOptionalString(row.current_generation_id),
    harness: asString(row.harness),
    finality: asString(row.finality),
    mode: asOptionalString(row.mode),
    taskCohort: asOptionalString(row.task_cohort),
    startTime: asOptionalNumber(row.start_time),
    endTime: asOptionalNumber(row.end_time),
    occurrenceTime: asOptionalNumber(row.occurrence_time),
  };
}

async function getPortfolioIdForProject(
  queryable: Queryable,
  projectId: string,
): Promise<string | null> {
  const { rows } = await queryable.exec('SELECT portfolio_id FROM projects WHERE id = ?', [
    projectId,
  ]);
  if (rows.length === 0) return null;
  return asOptionalString(rows[0].portfolio_id);
}

function sessionFinalityToCoverage(finality: string): Coverage {
  if (finality === 'final') return 'complete';
  if (finality === 'censored') return 'unsupported';
  return 'partial';
}

function finalityForList(finality: string): ProjectSessionListItem['finality'] {
  if (finality === 'final') return 'final';
  if (finality === 'censored') return 'censored';
  return 'partial';
}

interface EvidenceState {
  readonly status: 'ok' | 'tombstone';
  readonly reason?: string;
  readonly deletedAt?: number;
  readonly generationId: string | null;
}

async function resolveEvidenceState(
  queryable: Queryable,
  sessionId: string,
  query: AnalyticsQuery | undefined,
): Promise<EvidenceState> {
  const session = await getSessionContext(queryable, sessionId);
  if (!session) return { status: 'ok', generationId: null };

  const generationId = query?.generationId ?? session.currentGenerationId;

  if (generationId) {
    const { rows } = await queryable.exec(
      'SELECT status, superseded_by_id FROM transformation_generations WHERE id = ?',
      [generationId],
    );
    if (rows.length > 0) {
      const status = asString(rows[0].status);
      if (status === 'superseded') {
        return {
          status: 'tombstone',
          reason: `Superseded by generation ${asString(rows[0].superseded_by_id)}`,
          generationId,
        };
      }
      if (status !== 'committed') {
        return {
          status: 'tombstone',
          reason: `Evidence not available for generation in ${status} status`,
          generationId,
        };
      }
    }
  }

  const portfolioId = await getPortfolioIdForProject(queryable, session.projectId);
  if (portfolioId) {
    const tombstoned = await SourceTombstoneStore.isTombstoned(
      queryable,
      portfolioId,
      session.ingestionSourceId,
      'session',
      session.nativeSessionId,
    );
    if (tombstoned) {
      const tombstone = await SourceTombstoneStore.getTombstone(
        queryable,
        portfolioId,
        session.ingestionSourceId,
        'session',
        session.nativeSessionId,
      );
      return {
        status: 'tombstone',
        reason: tombstone?.reason ?? 'Session source has been deleted',
        deletedAt: tombstone?.deletedAt,
        generationId,
      };
    }
  }

  return { status: 'ok', generationId };
}

async function getCurrentSummary(
  queryable: Queryable,
  sessionId: string,
  generationId: string | null,
): Promise<{
  summary: { headlineMetrics: string; analysisReleaseId: string; generationId: string } | null;
  analysisReleaseId: string;
  generationId: string;
} | null> {
  const { rows } = await queryable.exec(
    `SELECT headline_metrics, analysis_release_id, generation_id
     FROM session_summaries
     WHERE session_id = ? AND root_inclusion = 'root_only'
       AND (COALESCE(?, '') = '' OR generation_id = ?)
     ORDER BY updated_at DESC LIMIT 1`,
    [sessionId, generationId ?? '', generationId ?? ''],
  );
  if (rows.length === 0) return null;
  return {
    summary: {
      headlineMetrics: asString(rows[0].headline_metrics),
      analysisReleaseId: asString(rows[0].analysis_release_id),
      generationId: asString(rows[0].generation_id),
    },
    analysisReleaseId: asString(rows[0].analysis_release_id),
    generationId: asString(rows[0].generation_id),
  };
}

async function getSessionRelation(
  queryable: Queryable,
  sessionId: string,
): Promise<{ rootSessionId: string; parentSessionId: string | null } | null> {
  const { rows } = await queryable.exec(
    'SELECT root_session_id, parent_session_id FROM session_relations WHERE session_id = ?',
    [sessionId],
  );
  if (rows.length === 0) return null;
  return {
    rootSessionId: asString(rows[0].root_session_id),
    parentSessionId: asOptionalString(rows[0].parent_session_id),
  };
}

async function getChildCount(queryable: Queryable, parentSessionId: string): Promise<number> {
  const { rows } = await queryable.exec(
    'SELECT COUNT(*) AS c FROM session_relations WHERE parent_session_id = ?',
    [parentSessionId],
  );
  return asNumber(rows[0]?.c);
}

async function getRootAndParent(
  queryable: Queryable,
  sessionId: string,
): Promise<{ rootSessionId: string; parentSessionId?: string }> {
  const relation = await getSessionRelation(queryable, sessionId);
  if (relation) {
    return {
      rootSessionId: relation.rootSessionId,
      parentSessionId: relation.parentSessionId ?? undefined,
    };
  }
  return { rootSessionId: sessionId };
}

// Session evidence view

export function createSessionEvidenceView(queryable: Queryable): SessionEvidenceView {
  return {
    getSummary: (sessionId, query) => getSessionEvidenceSummary(queryable, sessionId, query),
    getContextTimingSeries: (sessionId, query) =>
      getContextTimingSeries(queryable, sessionId, query),
    getRootChildBreakdown: (sessionId, query) => getRootChildBreakdown(queryable, sessionId, query),
    getComponentFacts: (sessionId, query) => getComponentFacts(queryable, sessionId, query),
    getValidationSummary: (sessionId, query) => getValidationSummary(queryable, sessionId, query),
    getEvidencePages: (sessionId, query) => getEvidencePages(queryable, sessionId, query),
    getTranscriptPages: (sessionId, query) => getTranscriptPages(queryable, sessionId, query),
  };
}

async function getSessionEvidenceSummary(
  queryable: Queryable,
  sessionId: string,
  query: AnalyticsQuery | undefined,
): Promise<SessionEvidenceSummary> {
  const state = await resolveEvidenceState(queryable, sessionId, query);
  const session = await getSessionContext(queryable, sessionId);
  const { rootSessionId, parentSessionId } = await getRootAndParent(queryable, sessionId);

  const analysisReleaseId = query?.analysisReleaseId ?? 'unknown';
  const generationId = state.generationId ?? query?.generationId ?? 'unknown';
  const comparabilityGroupId = query?.comparabilityGroupId ?? 'session-evidence';

  const token = makeToken(
    analysisReleaseId,
    generationId,
    comparabilityGroupId,
    1,
    state.status === 'ok' ? 1 : 0,
    state.status === 'ok' ? 0 : 1,
    'derived',
    ANALYTICS_DTO_VERSION,
    [evidenceLink('session', sessionId, `Session ${sessionId}`)],
  );

  const headlineMetrics: MetricValueDto[] = [];
  if (state.status === 'ok') {
    const current = await getCurrentSummary(queryable, sessionId, state.generationId);
    if (current?.summary) {
      headlineMetrics.push(...metricValuesFromHeadline(current.summary.headlineMetrics, token));
    }
  }

  return {
    token,
    sessionId,
    rootSessionId,
    parentSessionId,
    harness: session?.harness ?? 'unknown',
    headlineMetrics,
  };
}

async function getContextTimingSeries(
  queryable: Queryable,
  sessionId: string,
  query: AnalyticsQuery | undefined,
): Promise<ContextTimingSeries> {
  const state = await resolveEvidenceState(queryable, sessionId, query);
  const tokens = pageTokens(query, {
    analysisReleaseId: 'unknown',
    generationId: state.generationId ?? 'unknown',
    comparabilityGroupId: 'session-context-timing',
  });
  const token = makeToken(
    tokens.analysisReleaseId,
    tokens.generationId,
    tokens.comparabilityGroupId,
    0,
    0,
    0,
    'derived',
    ANALYTICS_DTO_VERSION,
    [evidenceLink('session', sessionId, `Session ${sessionId}`)],
  );

  const points: ContextTimingPoint[] = [];
  if (state.status === 'ok' && state.generationId) {
    const { rows } = await queryable.exec(
      `SELECT series_type, bucket_index, turn_index, bucket_start, metric_value
       FROM session_chart_series
       WHERE session_id = ? AND (COALESCE(?, '') = '' OR generation_id = ?)
         AND series_type IN ('total_tokens', 'context_tokens', 'generation_tokens')
       ORDER BY bucket_index, turn_index`,
      [sessionId, state.generationId, state.generationId],
    );

    const byBucket = new Map<
      number,
      {
        total: number | null;
        context: number | null;
        generation: number | null;
        timestamp: string | undefined;
      }
    >();
    for (const row of rows) {
      const bucket = asNumber(row.bucket_index);
      const existing = byBucket.get(bucket) ?? {
        total: null,
        context: null,
        generation: null,
        timestamp: undefined,
      };
      existing.timestamp = formatTimestamp(row.bucket_start);
      const value = asOptionalNumber(row.metric_value);
      const type = asString(row.series_type);
      if (type === 'total_tokens') existing.total = value;
      if (type === 'context_tokens') existing.context = value;
      if (type === 'generation_tokens') existing.generation = value;
      byBucket.set(bucket, existing);
    }

    for (const [bucket, point] of byBucket) {
      points.push({
        turnNumber: bucket,
        timestamp: point.timestamp,
        totalTokens: point.total,
        contextTokens: point.context,
        generationTokens: point.generation,
      });
    }
  }

  return { token, points };
}

async function getRootChildBreakdown(
  queryable: Queryable,
  sessionId: string,
  query: AnalyticsQuery | undefined,
): Promise<RootChildBreakdown> {
  const state = await resolveEvidenceState(queryable, sessionId, query);
  const { rootSessionId, parentSessionId } = await getRootAndParent(queryable, sessionId);

  const tokens = pageTokens(query, {
    analysisReleaseId: 'unknown',
    generationId: state.generationId ?? 'unknown',
    comparabilityGroupId: 'session-root-child',
  });
  const token = makeToken(
    tokens.analysisReleaseId,
    tokens.generationId,
    tokens.comparabilityGroupId,
    1,
    1,
    0,
    'derived',
    ANALYTICS_DTO_VERSION,
    [evidenceLink('session', rootSessionId, `Root session ${rootSessionId}`)],
  );

  const rootMetrics = await getContributionMetrics(
    queryable,
    rootSessionId,
    state.generationId,
    token,
  );
  const root: RootChildEntry = {
    sessionId: rootSessionId,
    isRoot: parentSessionId === undefined,
    childCount: await getChildCount(queryable, rootSessionId),
    contributionMetrics: rootMetrics,
  };

  const children: RootChildEntry[] = [];
  if (state.status === 'ok') {
    const { rows } = await queryable.exec(
      `SELECT session_id FROM session_relations WHERE parent_session_id = ? ORDER BY created_at`,
      [rootSessionId],
    );
    for (const row of rows) {
      const childId = asString(row.session_id);
      const childToken = makeToken(
        token.analysisReleaseId,
        token.generationId,
        token.comparabilityGroupId,
        1,
        1,
        0,
        'derived',
        token.metricVersion,
        [evidenceLink('session', childId, `Child session ${childId}`)],
      );
      children.push({
        sessionId: childId,
        isRoot: false,
        childCount: await getChildCount(queryable, childId),
        contributionMetrics: await getContributionMetrics(
          queryable,
          childId,
          state.generationId,
          childToken,
        ),
      });
    }
  }

  return { token, root, children };
}

async function getContributionMetrics(
  queryable: Queryable,
  sessionId: string,
  generationId: string | null,
  token: AnalyticsToken,
): Promise<readonly MetricValueDto[]> {
  const current = await getCurrentSummary(queryable, sessionId, generationId);
  if (!current?.summary) return [];
  return metricValuesFromHeadline(current.summary.headlineMetrics, token);
}

async function getComponentFacts(
  queryable: Queryable,
  sessionId: string,
  query: AnalyticsQuery | undefined,
): Promise<ComponentFactPage> {
  const state = await resolveEvidenceState(queryable, sessionId, query);
  const tokens = pageTokens(query, {
    analysisReleaseId: 'unknown',
    generationId: state.generationId ?? 'unknown',
    comparabilityGroupId: 'session-component-facts',
  });

  const items: ComponentFactRow[] = [];
  if (state.status === 'ok') {
    const stats = await SessionComponentStatStore.listBySession(queryable, sessionId);
    for (const stat of stats) {
      if (query?.generationId && stat.generationId !== query.generationId) continue;
      const identity = await ComponentIdentityStore.getById(queryable, '', stat.componentId);
      const token = makeToken(
        tokens.analysisReleaseId,
        tokens.generationId,
        tokens.comparabilityGroupId,
        stat.invocationCount,
        stat.invocationCount,
        0,
        'derived',
        ANALYTICS_DTO_VERSION,
        [
          evidenceLink('session', sessionId, `Session ${sessionId}`),
          evidenceLink('component', stat.componentId, `Component ${stat.componentId}`),
        ],
      );
      const statusCounts = parseJsonRecord(stat.statusCounts);
      const outcome = computeOutcome(statusCounts, stat.outcomeState);
      const metricValues: MetricValueDto[] = [
        makeMetricValue('invocations', stat.invocationCount, token, 'count', 'Invocations'),
        makeMetricValue('payloads', stat.payloadCount, token, 'count', 'Payloads'),
        makeMetricValue('payload-bytes', stat.payloadBytes, token, 'bytes', 'Payload bytes'),
      ];
      for (const [status, count] of Object.entries(statusCounts)) {
        if (typeof count === 'number') {
          metricValues.push(
            makeMetricValue(`status-${status}`, count, token, 'count', `Status ${status}`),
          );
        }
      }
      items.push({
        componentId: stat.componentId,
        kind: identity?.kind ?? stat.kind ?? 'unknown',
        invocationCount: stat.invocationCount,
        outcome,
        metricValues,
      });
    }
  }

  return {
    items,
    generationToken: tokens.generationId,
    analysisReleaseToken: tokens.analysisReleaseId,
  };
}

function computeOutcome(
  statusCounts: Record<string, unknown>,
  outcomeState: string | null,
): 'success' | 'failure' | 'partial' | 'unknown' {
  if (outcomeState) {
    if (outcomeState === 'success') return 'success';
    if (outcomeState === 'failure') return 'failure';
    if (outcomeState === 'partial') return 'partial';
  }
  let successes = 0;
  let failures = 0;
  for (const [status, count] of Object.entries(statusCounts)) {
    if (typeof count !== 'number') continue;
    if (status === 'success' || status === 'pass') successes += count;
    else if (status === 'failure' || status === 'fail' || status === 'error') failures += count;
  }
  if (successes > 0 && failures > 0) return 'partial';
  if (successes > 0) return 'success';
  if (failures > 0) return 'failure';
  return 'unknown';
}

async function getValidationSummary(
  queryable: Queryable,
  sessionId: string,
  query: AnalyticsQuery | undefined,
): Promise<SessionValidationSummary> {
  const state = await resolveEvidenceState(queryable, sessionId, query);
  const tokens = pageTokens(query, {
    analysisReleaseId: 'unknown',
    generationId: state.generationId ?? 'unknown',
    comparabilityGroupId: 'session-validations',
  });
  const token = makeToken(
    tokens.analysisReleaseId,
    tokens.generationId,
    tokens.comparabilityGroupId,
    1,
    1,
    0,
    'derived',
    ANALYTICS_DTO_VERSION,
    [evidenceLink('session', sessionId, `Session ${sessionId}`)],
  );

  const validations: SessionValidation[] = [];
  if (state.status === 'ok') {
    const rows = await ValidationStore.listBySession(queryable, sessionId);
    const byType = new Map<string, Map<string, number>>();
    for (const row of rows) {
      if (query?.generationId && row.generationId !== query.generationId) continue;
      const inner = byType.get(row.validationType) ?? new Map<string, number>();
      inner.set(row.result, (inner.get(row.result) ?? 0) + 1);
      byType.set(row.validationType, inner);
    }
    for (const [validationType, results] of byType) {
      let passed = 0;
      let failed = 0;
      let pending = 0;
      let unknown = 0;
      for (const [result, count] of results) {
        if (result === 'pass') passed += count;
        else if (result === 'fail' || result === 'error') failed += count;
        else if (result === 'unknown' || result === 'skip') unknown += count;
        else pending += count;
      }
      const status: SessionValidation['status'] =
        failed > 0 ? 'failed' : passed > 0 ? 'passed' : pending > 0 ? 'pending' : 'unknown';
      validations.push({
        validationType,
        status,
        count: passed + failed + pending + unknown,
      });
    }
  }

  return { token, validations };
}

/**
 * Project-scoped session outcome distribution for the `session:outcome`
 * metric. Exposes the db-core rollup (finality='final' sessions grouped by
 * outcome, including the `null`/unclassifiable bucket) as an
 * `AnalyticsToken`-wrapped DTO with sample size, per
 * `.agents/rules/aggregates-expose-sample-size.md`. Not wired into
 * {@link AnalyticsDataSource} — that is sub-issue #169's scope; this
 * function is what it will call.
 */
export async function getSessionOutcomeDistribution(
  queryable: Queryable,
  projectId: string,
  query?: AnalyticsQuery,
): Promise<SessionOutcomeDistribution> {
  const rows = await SessionOutcomeStore.rollupByProject(queryable, projectId);
  const eligibleN = rows.reduce((sum, row) => sum + row.count, 0);
  const knownN = rows
    .filter((row) => row.outcome !== null)
    .reduce((sum, row) => sum + row.count, 0);
  const unknownCount = eligibleN - knownN;

  const tokens = pageTokens(query, {
    analysisReleaseId: 'unknown',
    generationId: 'unknown',
    comparabilityGroupId: 'project-session-outcome',
  });
  const token = makeToken(
    tokens.analysisReleaseId,
    tokens.generationId,
    tokens.comparabilityGroupId,
    eligibleN,
    knownN,
    unknownCount,
    'observed',
    ANALYTICS_DTO_VERSION,
    [evidenceLink('project', projectId, `Project ${projectId}`)],
  );

  return {
    token,
    buckets: rows.map((row) => ({ outcome: row.outcome, count: row.count })),
  };
}

async function getEvidencePages(
  queryable: Queryable,
  sessionId: string,
  query: AnalyticsQuery | undefined,
): Promise<EvidencePage> {
  const state = await resolveEvidenceState(queryable, sessionId, query);
  const tokens = pageTokens(query, {
    analysisReleaseId: 'unknown',
    generationId: state.generationId ?? 'unknown',
    comparabilityGroupId: 'session-evidence-page',
  });

  if (state.status === 'tombstone') {
    return {
      items: [
        {
          evidenceId: `tombstone-${sessionId}`,
          entityType: 'tombstone',
          summary: `Evidence for session ${sessionId} is no longer available: ${state.reason ?? 'deleted or superseded'}`,
          evidenceLinks: [evidenceLink('session', sessionId, `Session ${sessionId}`)],
        },
      ],
      generationToken: tokens.generationId,
      analysisReleaseToken: tokens.analysisReleaseId,
    };
  }

  const generationId = state.generationId ?? '';
  const limit = pageLimit(query);
  const offset = pageOffset(query);
  const page = limit + 1;

  const { rows } = await queryable.exec(
    `SELECT * FROM (
      SELECT 'turn' AS entity_type, id, ordering AS turn_number, created_at AS ts,
             'Turn ' || ordering || ' (' || COALESCE(role, 'unknown') || ')' AS summary
      FROM turns WHERE session_id = ? AND ( ? IS NULL OR generation_id = ? )
      UNION ALL
      SELECT 'message' AS entity_type, id, ordering AS turn_number, COALESCE(timestamp, created_at) AS ts,
             'Message ' || ordering || ' (' || COALESCE(role, 'unknown') || ')' AS summary
      FROM messages WHERE session_id = ? AND ( ? IS NULL OR generation_id = ? )
      UNION ALL
      SELECT 'invocation' AS entity_type, id, 0 AS turn_number, created_at AS ts,
             'Invocation (' || COALESCE(kind, 'unknown') || '): ' || COALESCE(status, 'unknown') AS summary
      FROM invocations WHERE session_id = ? AND ( ? IS NULL OR generation_id = ? )
      UNION ALL
      SELECT 'validation' AS entity_type, id, 0 AS turn_number, COALESCE(start_time, created_at) AS ts,
             'Validation (' || COALESCE(validation_type, 'unknown') || '): ' || COALESCE(result, 'unknown') AS summary
      FROM validations WHERE session_id = ? AND ( ? IS NULL OR generation_id = ? )
      UNION ALL
      SELECT 'file_operation' AS entity_type, id, 0 AS turn_number, COALESCE(start_time, created_at) AS ts,
             'File ' || COALESCE(operation, 'unknown') || ' (' || COALESCE(status, 'pending') || ')' AS summary
      FROM file_operations WHERE session_id = ? AND ( ? IS NULL OR generation_id = ? )
      UNION ALL
      SELECT 'command_execution' AS entity_type, id, 0 AS turn_number, COALESCE(start_time, created_at) AS ts,
             'Command (' || COALESCE(command_category, 'unknown') || '): ' || COALESCE(status, 'unknown') AS summary
      FROM command_executions WHERE session_id = ? AND ( ? IS NULL OR generation_id = ? )
    ) ORDER BY ts, entity_type, id LIMIT ? OFFSET ?`,
    [
      sessionId,
      generationId,
      generationId,
      sessionId,
      generationId,
      generationId,
      sessionId,
      generationId,
      generationId,
      sessionId,
      generationId,
      generationId,
      sessionId,
      generationId,
      generationId,
      sessionId,
      generationId,
      generationId,
      page,
      offset,
    ],
  );

  const hasMore = rows.length > limit;
  const pageRows = rows.slice(0, limit);
  const items: EvidenceRow[] = pageRows.map((row: SqliteRow) => ({
    evidenceId: asString(row.id),
    entityType: asString(row.entity_type),
    turnNumber: asNumber(row.turn_number) || undefined,
    timestamp: formatTimestamp(row.ts),
    summary: asString(row.summary),
    evidenceLinks: [
      evidenceLink(asString(row.entity_type), asString(row.id), asString(row.summary)),
    ],
  }));

  return {
    items,
    nextCursor: hasMore ? String(offset + limit) : undefined,
    previousCursor: offset > 0 ? String(Math.max(0, offset - limit)) : undefined,
    generationToken: tokens.generationId,
    analysisReleaseToken: tokens.analysisReleaseId,
  };
}

function isTextContentBlock(block: unknown): block is { type: 'text'; text: string } {
  return (
    typeof block === 'object' &&
    block !== null &&
    (block as { type?: unknown }).type === 'text' &&
    typeof (block as { text?: unknown }).text === 'string'
  );
}

function extractMessageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(isTextContentBlock)
    .map((block) => block.text)
    .join('\n\n');
}

async function getTranscriptPages(
  queryable: Queryable,
  sessionId: string,
  query: AnalyticsQuery | undefined,
): Promise<EvidencePage> {
  const state = await resolveEvidenceState(queryable, sessionId, query);
  const tokens = pageTokens(query, {
    analysisReleaseId: 'unknown',
    generationId: state.generationId ?? 'unknown',
    comparabilityGroupId: 'session-transcript-page',
  });

  if (state.status === 'tombstone') {
    return {
      items: [
        {
          evidenceId: `tombstone-${sessionId}`,
          entityType: 'tombstone',
          summary: `Transcript for session ${sessionId} is no longer available: ${state.reason ?? 'deleted or superseded'}`,
          evidenceLinks: [evidenceLink('session', sessionId, `Session ${sessionId}`)],
        },
      ],
      generationToken: tokens.generationId,
      analysisReleaseToken: tokens.analysisReleaseId,
    };
  }

  const generationId = state.generationId ?? '';
  const limit = pageLimit(query);
  const offset = pageOffset(query);
  const page = limit + 1;

  const { rows } = await queryable.exec(
    `SELECT id, ordering AS turn_number, COALESCE(timestamp, created_at) AS ts, retained_content,
            'Message ' || ordering || ' (' || COALESCE(role, 'unknown') || ')' ||
            COALESCE('\n\n' || retained_content, '') AS summary
     FROM messages
     WHERE session_id = ? AND ( ? IS NULL OR generation_id = ? )
     ORDER BY timestamp, created_at, id LIMIT ? OFFSET ?`,
    [sessionId, generationId, generationId, page, offset],
  );

  if (rows.length > 0) {
    const hasMore = rows.length > limit;
    const pageRows = rows.slice(0, limit);
    const items: EvidenceRow[] = pageRows.map((row: SqliteRow) => ({
      evidenceId: asString(row.id),
      entityType: 'message',
      turnNumber: asNumber(row.turn_number) || undefined,
      timestamp: formatTimestamp(row.ts),
      summary: asString(row.summary),
      evidenceLinks: [evidenceLink('message', asString(row.id), asString(row.summary))],
    }));

    return {
      items,
      nextCursor: hasMore ? String(offset + limit) : undefined,
      previousCursor: offset > 0 ? String(Math.max(0, offset - limit)) : undefined,
      generationToken: tokens.generationId,
      analysisReleaseToken: tokens.analysisReleaseId,
    };
  }

  // Fallback: the ingestion pipeline currently persists message evidence as
  // raw normalized events. Surface those when the dedicated messages table has
  // not been populated yet, so the transcript view is not empty.
  const { rows: fallbackRows } = await queryable.exec(
    `SELECT id, raw_details
     FROM normalized_events
     WHERE session_id = ? AND event_type = 'message' AND retain_raw = 1
       AND ( ? IS NULL OR generation_id = ? )
     ORDER BY COALESCE(json_extract(raw_details, '$.payload.timestamp'), ''), id
     LIMIT ? OFFSET ?`,
    [sessionId, generationId, generationId, page, offset],
  );

  const hasMore = fallbackRows.length > limit;
  const pageRows = fallbackRows.slice(0, limit);
  const items: EvidenceRow[] = pageRows.map((row: SqliteRow, index: number) => {
    const record = parseJsonRecord(asString(row.raw_details));
    const payload = record.payload as Record<string, unknown> | undefined;
    const rawRole = typeof payload?.role === 'string' ? payload.role : 'unknown';
    const role = rawRole === 'human' ? 'user' : rawRole;
    const content = extractMessageText(payload?.content);
    const ordering = index + offset + 1;
    const timestamp = typeof payload?.timestamp === 'string' ? payload.timestamp : undefined;
    const summary = `Message ${ordering} (${role})\n\n${content}`;
    const evidenceId = asString(row.id);
    return {
      evidenceId,
      entityType: 'message',
      turnNumber: ordering,
      timestamp,
      summary,
      evidenceLinks: [evidenceLink('message', evidenceId, summary)],
    };
  });

  return {
    items,
    nextCursor: hasMore ? String(offset + limit) : undefined,
    previousCursor: offset > 0 ? String(Math.max(0, offset - limit)) : undefined,
    generationToken: tokens.generationId,
    analysisReleaseToken: tokens.analysisReleaseId,
  };
}

// Component ecosystem view

export function createComponentEcosystemView(queryable: Queryable): ComponentEcosystemView {
  return {
    getSummary: (query) => getComponentEcosystemSummary(queryable, query),
    getVersions: (componentId, query) => getComponentVersions(queryable, componentId, query),
    getScopes: (componentId, query) => getComponentScopes(queryable, componentId, query),
    getUtilization: (componentId, query) => getComponentUtilization(queryable, componentId, query),
    getDistributions: (componentId, query) =>
      getComponentDistributions(queryable, componentId, query),
    getProjectsSessions: (componentId, query) =>
      getComponentProjectsSessions(queryable, componentId, query),
    getLifecycleComparisons: (componentId, query) =>
      getComponentLifecycleComparisons(queryable, componentId, query),
  };
}

async function resolvePortfolioId(
  queryable: Queryable,
  query: AnalyticsQuery | undefined,
): Promise<string | null> {
  if (query?.portfolioId) return query.portfolioId;
  const { rows } = await queryable.exec('SELECT id FROM portfolios ORDER BY created_at LIMIT 1');
  return rows.length > 0 ? asString(rows[0].id) : null;
}

async function getComponentEcosystemSummary(
  queryable: Queryable,
  query: AnalyticsQuery,
): Promise<ComponentEcosystemSummary> {
  const portfolioId = await resolvePortfolioId(queryable, query);
  const tokens = pageTokens(query, {
    analysisReleaseId: 'unknown',
    generationId: 'unknown',
    comparabilityGroupId: 'component-ecosystem',
  });

  const countsByKind: Record<string, number> = {};
  if (portfolioId) {
    const { rows } = await queryable.exec(
      'SELECT kind, COUNT(*) AS c FROM component_identities WHERE portfolio_id = ? GROUP BY kind',
      [portfolioId],
    );
    for (const row of rows) {
      const kind = asString(row.kind) || 'unknown';
      countsByKind[kind] = asNumber(row.c);
    }
  }

  const topByUtilization: MetricValueDto[] = [];
  if (portfolioId) {
    const { rows } = await queryable.exec(
      `SELECT scs.component_id, ci.kind, SUM(scs.invocation_count) AS total,
              COUNT(DISTINCT scs.session_id) AS sessions
       FROM session_component_stats scs
       JOIN component_identities ci ON ci.id = scs.component_id
       JOIN sessions s ON s.id = scs.session_id
       JOIN projects p ON p.id = s.project_id
       WHERE p.portfolio_id = ?
         AND (COALESCE(?, '') = '' OR scs.generation_id = ?)
       GROUP BY scs.component_id, ci.kind
       ORDER BY total DESC
       LIMIT 10`,
      [portfolioId, query?.generationId ?? '', query?.generationId ?? ''],
    );
    for (const row of rows) {
      const componentId = asString(row.component_id);
      const kind = asString(row.kind);
      const total = asNumber(row.total);
      const token = makeToken(
        tokens.analysisReleaseId,
        tokens.generationId,
        tokens.comparabilityGroupId,
        asNumber(row.sessions),
        asNumber(row.sessions),
        0,
        'derived',
        ANALYTICS_DTO_VERSION,
        [evidenceLink('component', componentId, `Component ${componentId}`)],
      );
      topByUtilization.push(
        makeMetricValue('component-utilization', total, token, 'count', `${kind} ${componentId}`),
      );
    }
  }

  const total = Object.values(countsByKind).reduce((sum, n) => sum + n, 0);
  const token = makeToken(
    tokens.analysisReleaseId,
    tokens.generationId,
    tokens.comparabilityGroupId,
    total,
    total,
    0,
    'derived',
    ANALYTICS_DTO_VERSION,
    [evidenceLink('portfolio', portfolioId ?? 'unknown', `Portfolio ${portfolioId ?? 'unknown'}`)],
  );

  return { token, countsByKind, topByUtilization };
}

async function getComponentVersions(
  queryable: Queryable,
  componentId: string,
  query: AnalyticsQuery | undefined,
): Promise<ComponentVersionPage> {
  const tokens = pageTokens(query, {
    analysisReleaseId: 'unknown',
    generationId: query?.generationId ?? 'unknown',
    comparabilityGroupId: 'component-versions',
  });

  const limit = pageLimit(query);
  const offset = pageOffset(query);
  const page = limit + 1;

  const { rows } = await queryable.exec(
    `SELECT cv.id, cv.created_at,
            COUNT(DISTINCT scs.session_id) AS session_count,
            COUNT(DISTINCT s.project_id) AS project_count
     FROM component_versions cv
     LEFT JOIN session_component_stats scs ON scs.component_version_id = cv.id
       AND (COALESCE(?, '') = '' OR scs.generation_id = ?)
     LEFT JOIN sessions s ON s.id = scs.session_id
     WHERE cv.component_id = ?
     GROUP BY cv.id
     ORDER BY cv.created_at DESC, cv.id
     LIMIT ? OFFSET ?`,
    [query?.generationId ?? '', query?.generationId ?? '', componentId, page, offset],
  );

  const hasMore = rows.length > limit;
  const pageRows = rows.slice(0, limit);
  const items: ComponentVersion[] = pageRows.map((row: SqliteRow) => ({
    version: asString(row.id),
    sessionCount: asNumber(row.session_count),
    projectCount: asNumber(row.project_count),
    firstSeen: formatTimestamp(row.created_at),
    lastSeen: formatTimestamp(row.created_at),
  }));

  return {
    items,
    nextCursor: hasMore ? String(offset + limit) : undefined,
    previousCursor: offset > 0 ? String(Math.max(0, offset - limit)) : undefined,
    generationToken: tokens.generationId,
    analysisReleaseToken: tokens.analysisReleaseId,
  };
}

async function getComponentScopes(
  queryable: Queryable,
  componentId: string,
  query: AnalyticsQuery | undefined,
): Promise<ComponentScopePage> {
  const tokens = pageTokens(query, {
    analysisReleaseId: 'unknown',
    generationId: query?.generationId ?? 'unknown',
    comparabilityGroupId: 'component-scopes',
  });

  const limit = pageLimit(query);
  const offset = pageOffset(query);
  const page = limit + 1;

  const { rows } = await queryable.exec(
    `SELECT scope, COUNT(*) AS c
     FROM component_installations
     WHERE component_id = ?
       AND (COALESCE(?, '') = '' OR ? IS NULL OR effective_end_at IS NULL OR effective_end_at > ?)
     GROUP BY scope
     ORDER BY scope
     LIMIT ? OFFSET ?`,
    [componentId, query?.generationId ?? '', query?.generationId ?? '', Date.now(), page, offset],
  );

  const hasMore = rows.length > limit;
  const pageRows = rows.slice(0, limit);
  const items: ComponentScope[] = pageRows.map((row: SqliteRow) => ({
    scope: asString(row.scope),
    installationCount: asNumber(row.c),
  }));

  return {
    items,
    nextCursor: hasMore ? String(offset + limit) : undefined,
    previousCursor: offset > 0 ? String(Math.max(0, offset - limit)) : undefined,
    generationToken: tokens.generationId,
    analysisReleaseToken: tokens.analysisReleaseId,
  };
}

async function getComponentUtilization(
  queryable: Queryable,
  componentId: string,
  query: AnalyticsQuery | undefined,
): Promise<ComponentUtilizationDetail> {
  const tokens = pageTokens(query, {
    analysisReleaseId: 'unknown',
    generationId: query?.generationId ?? 'unknown',
    comparabilityGroupId: 'component-utilization',
  });

  const { rows } = await queryable.exec(
    `SELECT
       SUM(invocation_count) AS invocations,
       SUM(success_count) AS successes,
       SUM(total_latency_ms) AS total_latency,
       SUM(overhead_ms) AS total_overhead
     FROM component_rollups
     WHERE component_id = ?
       AND (COALESCE(?, '') = '' OR analysis_release_id = ?)
       AND (COALESCE(?, '') = '' OR comparability_group_id = ?)
       AND (COALESCE(?, '') = '' OR generation_id = ?)`,
    [
      componentId,
      query?.analysisReleaseId ?? '',
      query?.analysisReleaseId ?? '',
      query?.comparabilityGroupId ?? '',
      query?.comparabilityGroupId ?? '',
      query?.generationId ?? '',
      query?.generationId ?? '',
    ],
  );
  const invocations = asNumber(rows[0]?.invocations);
  const successes = asNumber(rows[0]?.successes);
  const _latency = asOptionalNumber(rows[0]?.total_latency);
  const overhead = asOptionalNumber(rows[0]?.total_overhead);

  const { rows: sessionRows } = await queryable.exec(
    `SELECT COUNT(DISTINCT session_id) AS c FROM session_component_stats
     WHERE component_id = ? AND (COALESCE(?, '') = '' OR generation_id = ?)`,
    [componentId, query?.generationId ?? '', query?.generationId ?? ''],
  );
  const sessionCount = asNumber(sessionRows[0]?.c);

  const token = makeToken(
    tokens.analysisReleaseId,
    tokens.generationId,
    tokens.comparabilityGroupId,
    invocations,
    successes,
    invocations - successes,
    'derived',
    ANALYTICS_DTO_VERSION,
    [evidenceLink('component', componentId, `Component ${componentId}`)],
  );

  const loadRate = invocations > 0 ? successes / invocations : null;
  const invokeRate = sessionCount > 0 ? invocations / sessionCount : null;

  return {
    token,
    loadRate: makeMetricValue('load-rate', loadRate, token, 'ratio', 'Load rate'),
    invokeRate: makeMetricValue(
      'invoke-rate',
      invokeRate,
      token,
      'count',
      'Invocations per session',
    ),
    overhead: makeMetricValue('overhead', overhead, token, 'ms', 'Overhead latency'),
  };
}

async function getComponentDistributions(
  queryable: Queryable,
  componentId: string,
  query: AnalyticsQuery | undefined,
): Promise<ComponentDistributionPage> {
  const tokens = pageTokens(query, {
    analysisReleaseId: query?.analysisReleaseId ?? 'unknown',
    generationId: query?.generationId ?? 'unknown',
    comparabilityGroupId: query?.comparabilityGroupId ?? 'component-distributions',
  });

  const { rows } = await queryable.exec(
    `SELECT cr.id, cr.outcome_distribution, cr.invocation_count, cr.generation_id,
            cr.analysis_release_id, cr.comparability_group_id,
            md.metric_id, md.unit
     FROM component_rollups cr
     JOIN metric_definitions md ON md.id = cr.metric_definition_id
     WHERE cr.component_id = ?
       AND (COALESCE(?, '') = '' OR cr.analysis_release_id = ?)
       AND (COALESCE(?, '') = '' OR cr.comparability_group_id = ?)
       AND (COALESCE(?, '') = '' OR cr.generation_id = ?)
     ORDER BY md.metric_id, cr.created_at`,
    [
      componentId,
      query?.analysisReleaseId ?? '',
      query?.analysisReleaseId ?? '',
      query?.comparabilityGroupId ?? '',
      query?.comparabilityGroupId ?? '',
      query?.generationId ?? '',
      query?.generationId ?? '',
    ],
  );

  const items: ComponentDistributionRow[] = rows.map((row: SqliteRow) => {
    const distribution = parseJsonRecord(asString(row.outcome_distribution));
    const known = Object.values(distribution).reduce(
      (sum: number, v: unknown) => (typeof v === 'number' ? sum + v : sum),
      0,
    );
    const eligible = asNumber(row.invocation_count);
    const token = makeToken(
      asString(row.analysis_release_id),
      asString(row.generation_id),
      asString(row.comparability_group_id),
      eligible,
      known,
      Math.max(0, eligible - known),
      'derived',
      ANALYTICS_DTO_VERSION,
      [
        evidenceLink('component', componentId, `Component ${componentId}`),
        evidenceLink('metric', asString(row.metric_id), `Metric ${asString(row.metric_id)}`),
      ],
    );
    const values: MetricValueDto[] = [];
    const bins: Record<string, number> = {};
    for (const [outcome, count] of Object.entries(distribution)) {
      if (typeof count === 'number') {
        bins[outcome] = count;
        values.push(makeMetricValue(outcome, count, token, asString(row.unit), outcome));
      }
    }
    return {
      metricId: asString(row.metric_id),
      values,
      bins,
    };
  });

  return {
    items,
    generationToken: tokens.generationId,
    analysisReleaseToken: tokens.analysisReleaseId,
  };
}

async function getComponentProjectsSessions(
  queryable: Queryable,
  componentId: string,
  query: AnalyticsQuery | undefined,
): Promise<ComponentProjectSessionPage> {
  const tokens = pageTokens(query, {
    analysisReleaseId: query?.analysisReleaseId ?? 'unknown',
    generationId: query?.generationId ?? 'unknown',
    comparabilityGroupId: query?.comparabilityGroupId ?? 'component-projects-sessions',
  });

  const limit = pageLimit(query);
  const offset = pageOffset(query);
  const page = limit + 1;

  const { rows } = await queryable.exec(
    `SELECT s.project_id, s.id AS session_id, MAX(scs.updated_at) AS last_used,
            SUM(scs.invocation_count) AS invocations,
            SUM(scs.payload_count) AS payloads,
            SUM(scs.payload_bytes) AS payload_bytes
     FROM session_component_stats scs
     JOIN sessions s ON s.id = scs.session_id
     WHERE scs.component_id = ?
       AND (COALESCE(?, '') = '' OR s.project_id = ?)
       AND (COALESCE(?, '') = '' OR scs.generation_id = ?)
     GROUP BY s.id
     ORDER BY last_used DESC, s.id
     LIMIT ? OFFSET ?`,
    [
      componentId,
      filterValue(query, 'projectId') ?? '',
      filterValue(query, 'projectId') ?? '',
      query?.generationId ?? '',
      query?.generationId ?? '',
      page,
      offset,
    ],
  );

  const hasMore = rows.length > limit;
  const pageRows = rows.slice(0, limit);
  const items: ComponentProjectSessionRow[] = pageRows.map((row: SqliteRow) => {
    const projectId = asString(row.project_id);
    const sessionId = asString(row.session_id);
    const token = makeToken(
      tokens.analysisReleaseId,
      tokens.generationId,
      tokens.comparabilityGroupId,
      asNumber(row.invocations),
      asNumber(row.invocations),
      0,
      'derived',
      ANALYTICS_DTO_VERSION,
      [
        evidenceLink('project', projectId, `Project ${projectId}`),
        evidenceLink('session', sessionId, `Session ${sessionId}`),
      ],
    );
    return {
      projectId,
      sessionId,
      lastUsed: formatTimestamp(row.last_used),
      metricValues: [
        makeMetricValue('invocations', asNumber(row.invocations), token, 'count', 'Invocations'),
        makeMetricValue('payloads', asNumber(row.payloads), token, 'count', 'Payloads'),
        makeMetricValue(
          'payload-bytes',
          asNumber(row.payload_bytes),
          token,
          'bytes',
          'Payload bytes',
        ),
      ],
    };
  });

  return {
    items,
    nextCursor: hasMore ? String(offset + limit) : undefined,
    previousCursor: offset > 0 ? String(Math.max(0, offset - limit)) : undefined,
    generationToken: tokens.generationId,
    analysisReleaseToken: tokens.analysisReleaseId,
  };
}

async function getComponentLifecycleComparisons(
  queryable: Queryable,
  componentId: string,
  query: AnalyticsQuery | undefined,
): Promise<LifecycleComparisonPage> {
  const tokens = pageTokens(query, {
    analysisReleaseId: query?.analysisReleaseId ?? 'unknown',
    generationId: query?.generationId ?? 'unknown',
    comparabilityGroupId: query?.comparabilityGroupId ?? 'component-lifecycle',
  });

  const limit = pageLimit(query);
  const offset = pageOffset(query);
  const page = limit + 1;

  const { rows } = await queryable.exec(
    `SELECT cle.id, cle.event_type, cle.before_version_id, cle.after_version_id, cle.created_at,
            (SELECT COUNT(DISTINCT session_id) FROM session_component_exposures
             WHERE component_id = ? AND created_at <= cle.created_at) AS affected_sessions
     FROM component_lifecycle_events cle
     WHERE cle.component_id = ?
     ORDER BY cle.created_at DESC, cle.id
     LIMIT ? OFFSET ?`,
    [componentId, componentId, page, offset],
  );

  const hasMore = rows.length > limit;
  const pageRows = rows.slice(0, limit);
  const items: LifecycleComparisonRow[] = pageRows.map((row: SqliteRow) => ({
    eventId: asString(row.id),
    changeType: lifecycleChangeType(asString(row.event_type)),
    beforeVersion: asOptionalString(row.before_version_id) ?? undefined,
    afterVersion: asOptionalString(row.after_version_id) ?? undefined,
    affectedSessions: asNumber(row.affected_sessions),
  }));

  return {
    items,
    nextCursor: hasMore ? String(offset + limit) : undefined,
    previousCursor: offset > 0 ? String(Math.max(0, offset - limit)) : undefined,
    generationToken: tokens.generationId,
    analysisReleaseToken: tokens.analysisReleaseId,
  };
}

function lifecycleChangeType(eventType: string): LifecycleComparisonRow['changeType'] {
  if (eventType === 'removed') return 'removed';
  if (eventType === 'updated') return 'updated';
  return 'added';
}

// Artifact version view

export function createArtifactVersionView(
  queryable: Queryable,
  hasher?: ContentHasher,
): ArtifactVersionView {
  const diffEngine = new ArtifactDiffRepository(hasher ?? createSha256ContentHasher());

  return {
    getMetadata: (artifactId, query) => getArtifactMetadata(queryable, artifactId, query),
    getDiff: (leftArtifactId, rightArtifactId, query) =>
      getArtifactDiff(queryable, diffEngine, leftArtifactId, rightArtifactId, query),
  };
}

async function getArtifactMetadata(
  queryable: Queryable,
  artifactId: string,
  _query: AnalyticsQuery | undefined,
): Promise<ArtifactVersionMetadata> {
  const { rows } = await queryable.exec(
    `SELECT a.id, a.sha256, a.size, a.media_type, a.relative_path,
            sm.capture_time, b.retention_class, b.media_type AS blob_media_type
     FROM manifest_artifacts a
     JOIN source_manifests sm ON sm.id = a.source_manifest_id
     LEFT JOIN artifact_blobs b ON b.sha256 = a.sha256
     WHERE a.id = ?`,
    [artifactId],
  );

  const manifestArtifact = rows[0];
  if (!manifestArtifact) {
    return {
      artifactId,
      sha256: '',
      size: 0,
      mediaType: 'unknown',
      retentionClass: 'unknown',
      sessionIds: [],
      componentIds: [],
    };
  }

  const { rows: refRows } = await queryable.exec(
    `SELECT observing_session_id, component_id
     FROM artifact_references
     WHERE manifest_artifact_id = ?`,
    [artifactId],
  );

  const sessionIds = new Set<string>();
  const componentIds = new Set<string>();
  for (const row of refRows) {
    const sessionId = asOptionalString(row.observing_session_id);
    if (sessionId) sessionIds.add(sessionId);
    const componentId = asOptionalString(row.component_id);
    if (componentId) componentIds.add(componentId);
  }

  return {
    artifactId,
    sha256: asString(manifestArtifact.sha256),
    size: asNumber(manifestArtifact.size),
    mediaType:
      asOptionalString(manifestArtifact.media_type) ??
      asOptionalString(manifestArtifact.blob_media_type) ??
      'unknown',
    captureTime: formatTimestamp(manifestArtifact.capture_time),
    retentionClass: asOptionalString(manifestArtifact.retention_class) ?? 'retained',
    sessionIds: Array.from(sessionIds),
    componentIds: Array.from(componentIds),
  };
}

interface ResolvedReference {
  readonly referenceId: string;
  readonly portfolioId: string;
}

async function resolveArtifactReference(
  queryable: Queryable,
  artifactId: string,
): Promise<ResolvedReference> {
  let { rows } = await queryable.exec(
    `SELECT src.portfolio_id, r.id
     FROM artifact_references r
     JOIN manifest_artifacts a ON a.id = r.manifest_artifact_id
     JOIN source_manifests sm ON sm.id = a.source_manifest_id
     JOIN ingestion_sources src ON src.id = sm.ingestion_source_id
     WHERE r.id = ?`,
    [artifactId],
  );
  if (rows.length > 0) {
    return {
      referenceId: asString(rows[0].id),
      portfolioId: asString(rows[0].portfolio_id),
    };
  }

  ({ rows } = await queryable.exec(
    `SELECT src.portfolio_id, r.id
     FROM artifact_references r
     JOIN manifest_artifacts a ON a.id = r.manifest_artifact_id
     JOIN source_manifests sm ON sm.id = a.source_manifest_id
     JOIN ingestion_sources src ON src.id = sm.ingestion_source_id
     WHERE a.id = ?
       AND (r.relationship = 'contains' OR COALESCE(r.source_pointer, '') = '')
     ORDER BY r.created_at
     LIMIT 1`,
    [artifactId],
  ));
  if (rows.length > 0) {
    return {
      referenceId: asString(rows[0].id),
      portfolioId: asString(rows[0].portfolio_id),
    };
  }

  throw new Error(`Artifact reference not found for ${artifactId}`);
}

async function getArtifactDiff(
  queryable: Queryable,
  diffEngine: ArtifactDiffRepository,
  leftArtifactId: string,
  rightArtifactId: string,
  _query: AnalyticsQuery | undefined,
): Promise<ArtifactDiff> {
  const left = await resolveArtifactReference(queryable, leftArtifactId);
  const right = await resolveArtifactReference(queryable, rightArtifactId);
  const diff = await diffEngine.getDiff(
    queryable,
    left.portfolioId,
    left.referenceId,
    right.referenceId,
  );
  if (!diff) {
    return {
      artifactId: leftArtifactId,
      leftVersion: leftArtifactId,
      rightVersion: rightArtifactId,
      unifiedDiff: undefined,
      sideBySideDiff: undefined,
      metadataChanges: [
        {
          field: 'availability',
          oldValue: 'available',
          newValue: 'unavailable',
        },
      ],
      sessionExposure: {},
    };
  }
  return diff;
}

// Project session search view

export function createProjectSessionSearchView(queryable: Queryable): ProjectSessionSearchView {
  return {
    getProjectSessionList: (projectId, query) => getProjectSessionList(queryable, projectId, query),
    getRootSessionTree: (sessionId) => getRootSessionTree(queryable, sessionId),
    getChildSessionTree: (sessionId) => getChildSessionTree(queryable, sessionId),
  };
}

function filterValue(query: AnalyticsQuery | undefined, field: string): string | null {
  const filter = query?.filters?.find((f) => f.field === field);
  if (!filter) return null;
  if (typeof filter.value === 'string') return filter.value;
  if (Array.isArray(filter.value) && filter.value.length > 0) return String(filter.value[0]);
  return null;
}

function filterTimeRange(query: AnalyticsQuery | undefined): {
  start: number | null;
  end: number | null;
} {
  if (!query?.timeRange) return { start: null, end: null };
  const start = Date.parse(query.timeRange.start);
  const end = Date.parse(query.timeRange.end);
  return {
    start: Number.isNaN(start) ? null : start,
    end: Number.isNaN(end) ? null : end,
  };
}

async function getProjectSessionList(
  queryable: Queryable,
  projectId: string,
  query: AnalyticsQuery,
): Promise<ProjectSessionListPage> {
  const tokens = pageTokens(query, {
    analysisReleaseId: query.analysisReleaseId ?? 'unknown',
    generationId: query.generationId ?? 'unknown',
    comparabilityGroupId: query.comparabilityGroupId ?? 'project-sessions',
  });

  const harness = filterValue(query, 'harness');
  const mode = filterValue(query, 'mode');
  const taskCohort = filterValue(query, 'taskCohort');
  const finality = filterValue(query, 'finality');
  const { start, end } = filterTimeRange(query);

  const limit = pageLimit(query);
  const offset = pageOffset(query);
  const page = limit + 1;

  const { rows } = await queryable.exec(
    `SELECT s.id, s.harness, s.finality, s.mode, s.task_cohort,
            s.start_time, s.end_time, s.occurrence_time, s.created_at,
            sr.root_session_id, sr.parent_session_id
     FROM sessions s
     LEFT JOIN session_relations sr ON sr.session_id = s.id
     WHERE s.project_id = ?
       AND (COALESCE(?, '') = '' OR s.harness = ?)
       AND (COALESCE(?, '') = '' OR s.mode = ?)
       AND (COALESCE(?, '') = '' OR s.task_cohort = ?)
       AND (COALESCE(?, '') = '' OR s.finality = ?)
       AND (? IS NULL OR ? IS NULL OR (s.occurrence_time >= ? AND s.occurrence_time <= ?))
     ORDER BY s.occurrence_time DESC, s.created_at DESC, s.id
     LIMIT ? OFFSET ?`,
    [
      projectId,
      harness ?? '',
      harness ?? '',
      mode ?? '',
      mode ?? '',
      taskCohort ?? '',
      taskCohort ?? '',
      finality ?? '',
      finality ?? '',
      start,
      end,
      start ?? 0,
      end ?? 0,
      page,
      offset,
    ],
  );

  const hasMore = rows.length > limit;
  const pageRows = rows.slice(0, limit);
  const items: ProjectSessionListItem[] = pageRows.map((row: SqliteRow) => ({
    sessionId: asString(row.id),
    rootSessionId: asOptionalString(row.root_session_id) ?? asString(row.id),
    parentSessionId: asOptionalString(row.parent_session_id) ?? undefined,
    harness: asString(row.harness),
    finality: finalityForList(asString(row.finality)),
    startedAt: formatTimestamp(row.start_time ?? row.occurrence_time),
    endedAt: formatTimestamp(row.end_time),
    coverage: sessionFinalityToCoverage(asString(row.finality)),
  }));

  return {
    items,
    nextCursor: hasMore ? String(offset + limit) : undefined,
    previousCursor: offset > 0 ? String(Math.max(0, offset - limit)) : undefined,
    generationToken: tokens.generationId,
    analysisReleaseToken: tokens.analysisReleaseId,
  };
}

async function getRootSessionTree(queryable: Queryable, sessionId: string): Promise<SessionTree> {
  const { rootSessionId } = await getRootAndParent(queryable, sessionId);
  return buildSessionTree(queryable, rootSessionId, rootSessionId);
}

async function getChildSessionTree(queryable: Queryable, sessionId: string): Promise<SessionTree> {
  return buildSessionTree(queryable, sessionId, sessionId);
}

async function buildSessionTree(
  queryable: Queryable,
  treeRoot: string,
  querySessionId: string,
): Promise<SessionTree> {
  const rootForQuery = (await getRootAndParent(queryable, querySessionId)).rootSessionId;
  const { rows } = await queryable.exec(
    `SELECT sr.session_id, sr.parent_session_id, sr.root_session_id, s.current_generation_id
     FROM session_relations sr
     JOIN sessions s ON s.id = sr.session_id
     WHERE sr.root_session_id = ?
     ORDER BY sr.depth, sr.created_at`,
    [rootForQuery],
  );

  const nodesByParent = new Map<string, string[]>();
  const generationTokens = new Map<string, string>();

  for (const row of rows) {
    const id = asString(row.session_id);
    const parent = asOptionalString(row.parent_session_id) ?? rootForQuery;
    const children = nodesByParent.get(parent) ?? [];
    children.push(id);
    nodesByParent.set(parent, children);
    generationTokens.set(id, asOptionalString(row.current_generation_id) ?? 'unknown');
  }

  if (!generationTokens.has(treeRoot)) {
    const { rows: sessionRows } = await queryable.exec(
      'SELECT current_generation_id FROM sessions WHERE id = ?',
      [treeRoot],
    );
    generationTokens.set(
      treeRoot,
      asOptionalString(sessionRows[0]?.current_generation_id) ?? 'unknown',
    );
  }

  function buildNode(id: string): SessionTreeNode {
    const children = (nodesByParent.get(id) ?? []).map(buildNode);
    return {
      sessionId: id,
      children,
      generationToken: generationTokens.get(id) ?? 'unknown',
    };
  }

  return {
    rootSessionId: treeRoot,
    nodes: [buildNode(treeRoot)],
  };
}

// Metadata view

export function createMetadataView(queryable: Queryable): MetadataView {
  return {
    getFilterMetadata: (query) => getFilterMetadata(queryable, query),
    getCoverageExplanation: (metricId, query) => getCoverageExplanation(queryable, metricId, query),
  };
}

async function getFilterMetadata(
  queryable: Queryable,
  query: AnalyticsQuery | undefined,
): Promise<FilterMetadata> {
  const tokens = pageTokens(query, {
    analysisReleaseId: query?.analysisReleaseId ?? 'unknown',
    generationId: query?.generationId ?? 'unknown',
    comparabilityGroupId: query?.comparabilityGroupId ?? 'metadata',
  });

  const { rows } = await queryable.exec(
    `SELECT metric_id, value_type, comparability_group_id, label
     FROM metric_definitions
     ORDER BY metric_id, version`,
  );

  const fields: FilterField[] = rows.map((row: SqliteRow) => ({
    field: asString(row.metric_id),
    type: asString(row.value_type),
    operators: operatorsForType(asString(row.value_type)),
    comparabilityGroupIds: [asString(row.comparability_group_id)],
  }));

  const groupRows = await queryable.exec(
    'SELECT DISTINCT comparability_group_id FROM metric_definitions ORDER BY comparability_group_id',
  );

  return {
    availableFields: fields,
    availableComparabilityGroups: groupRows.rows.map((row: SqliteRow) =>
      asString(row.comparability_group_id),
    ),
    generationToken: tokens.generationId,
    analysisReleaseToken: tokens.analysisReleaseId,
  };
}

function operatorsForType(valueType: string): readonly FilterOperator[] {
  if (
    valueType === 'integer' ||
    valueType === 'real' ||
    valueType === 'currency' ||
    valueType === 'ratio'
  ) {
    return ['eq', 'neq', 'gt', 'gte', 'lt', 'lte'];
  }
  if (valueType === 'text') {
    return ['eq', 'neq', 'contains', 'in'];
  }
  return ['eq', 'neq'];
}

async function getCoverageExplanation(
  queryable: Queryable,
  metricId: string,
  query: AnalyticsQuery | undefined,
): Promise<CoverageExplanation> {
  const { rows: defRows } = await queryable.exec(
    'SELECT id, metric_id, value_type, comparability_group_id FROM metric_definitions WHERE metric_id = ? ORDER BY version DESC LIMIT 1',
    [metricId],
  );

  if (defRows.length === 0) {
    return {
      metricId,
      coverage: 'unknown',
      capabilityState: 'unavailable',
      reason: 'Metric definition not found',
      eligibleN: 0,
      knownN: 0,
      unknownCount: 0,
      evidenceLinks: [],
    };
  }

  const definitionId = asString(defRows[0].id);
  const comparabilityGroupId = asString(defRows[0].comparability_group_id);
  const _tokens = pageTokens(query, {
    analysisReleaseId: query?.analysisReleaseId ?? 'unknown',
    generationId: query?.generationId ?? 'unknown',
    comparabilityGroupId,
  });

  const projectId = query?.filters?.find((f) => f.field === 'projectId')?.value as
    | string
    | undefined;
  const generationId = query?.generationId;

  const { rows: distRows } = await queryable.exec(
    `SELECT eligible_n, known_n, unknown_count, coverage
     FROM project_distributions
     WHERE metric_definition_id = ?
       AND (COALESCE(?, '') = '' OR project_id = ?)
       AND (COALESCE(?, '') = '' OR comparability_group_id = ?)
       AND (COALESCE(?, '') = '' OR generation_id = ?)
       AND COALESCE(dimensions_key, '') = ''
     ORDER BY created_at DESC
     LIMIT 1`,
    [
      definitionId,
      projectId ?? '',
      projectId ?? '',
      query?.comparabilityGroupId ?? '',
      query?.comparabilityGroupId ?? '',
      generationId ?? '',
      generationId ?? '',
    ],
  );

  let eligibleN = 0;
  let knownN = 0;
  let unknownCount = 0;
  let coverageValue: number | null = null;

  if (distRows.length > 0) {
    eligibleN = asNumber(distRows[0].eligible_n);
    knownN = asNumber(distRows[0].known_n);
    unknownCount = asNumber(distRows[0].unknown_count);
    coverageValue = asOptionalNumber(distRows[0].coverage);
  } else {
    const { rows: valueRows } = await queryable.exec(
      `SELECT
         COUNT(*) AS n,
         SUM(CASE WHEN is_unavailable = 1 THEN 1 ELSE 0 END) AS u
       FROM metric_values
       WHERE metric_definition_id = ?
         AND (COALESCE(?, '') = '' OR session_id IN (SELECT id FROM sessions WHERE project_id = ?))
         AND (COALESCE(?, '') = '' OR comparability_group_id = ?)
         AND (COALESCE(?, '') = '' OR generation_id = ?)`,
      [
        definitionId,
        projectId ?? '',
        projectId ?? '',
        query?.comparabilityGroupId ?? '',
        query?.comparabilityGroupId ?? '',
        generationId ?? '',
        generationId ?? '',
      ],
    );
    eligibleN = asNumber(valueRows[0]?.n);
    unknownCount = asNumber(valueRows[0]?.u);
    knownN = Math.max(0, eligibleN - unknownCount);
  }

  const effectiveCoverage = coverageValue ?? coverage(knownN, eligibleN);
  const coverageStatus = coverageLabel(effectiveCoverage);

  const { rows: capRows } = await queryable.exec(
    `SELECT capability, reason FROM transformer_metric_capabilities
     WHERE metric_definition_id = ?
     ORDER BY created_at DESC
     LIMIT 1`,
    [definitionId],
  );

  const capability = capRows.length > 0 ? asString(capRows[0].capability) : 'unavailable';
  const reason =
    capRows.length > 0
      ? (asOptionalString(capRows[0].reason) ?? `Metric capability is ${capability}`)
      : 'No capability record for this metric';

  return {
    metricId,
    coverage: coverageStatus,
    capabilityState: capability as CoverageExplanation['capabilityState'],
    reason,
    eligibleN,
    knownN,
    unknownCount,
    evidenceLinks: [
      evidenceLink('metric', metricId, `Metric ${metricId}`),
      evidenceLink(
        'comparability-group',
        comparabilityGroupId,
        `Comparability group ${comparabilityGroupId}`,
      ),
    ],
  };
}

const ANALYTICS_DTO_VERSION = '0.1.0';
