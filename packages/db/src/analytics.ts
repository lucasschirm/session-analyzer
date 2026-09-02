import type { SqliteExecutor, SqliteTransaction } from '@lucasschirm/sal-db-core';
import { createPortfolioView } from './analytics-portfolio.js';
import {
  createArtifactVersionView,
  createComponentEcosystemView,
  createMetadataView,
  createProjectSessionSearchView,
  createSessionEvidenceView,
} from './analytics-session.js';
import type { AnalyticsToken, Coverage, EvidenceLink, MetricValueDto } from './dto.js';
import { createSha256ContentHasher } from './ingestion.js';
import type { ContentHasher } from './ports.js';
import { createProjectBehaviorView } from './project-behavior.js';

export type FilterOperator = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'contains';

export interface Filter {
  readonly field: string;
  readonly operator: FilterOperator;
  readonly value: string | number | boolean | readonly string[];
}

export interface TimeRange {
  readonly start: string;
  readonly end: string;
}

export interface AnalyticsQuery {
  readonly analysisReleaseId?: string;
  readonly generationId?: string;
  readonly comparabilityGroupId?: string;
  readonly portfolioId?: string;
  readonly timeRange?: TimeRange;
  readonly filters?: readonly Filter[];
  readonly cursor?: string;
  readonly limit?: number;
}

export interface CursorPage<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string;
  readonly previousCursor?: string;
  readonly generationToken: string;
  readonly analysisReleaseToken: string;
}

export interface TimeSeriesPoint {
  readonly time: string;
  readonly value: number | null;
  readonly metricId: string;
  readonly label: string;
  readonly comparabilityGroupId: string;
}

export interface CohortSummary {
  readonly cohortId: string;
  readonly label: string;
  readonly eligibleN: number;
  readonly knownN: number;
  readonly unknownCount: number;
}

export interface ProjectListItem {
  readonly projectId: string;
  readonly name: string;
  readonly sessionCount: number;
  readonly lastSessionAt?: string;
  readonly source: string;
  readonly harness: string;
  readonly completeness: Coverage;
  readonly finality: 'open' | 'final' | 'censored' | 'partial' | 'superseded' | 'unknown';
  readonly reprocessing: 'local' | 'remote_reacquirable' | 'unavailable' | 'unknown';
  readonly issueState: 'clean' | 'issues' | 'fatal' | 'unknown';
  readonly coverage: Coverage;
  readonly token: AnalyticsToken;
}

export interface PortfolioOverview {
  readonly token: AnalyticsToken;
  readonly headlineMetrics: readonly MetricValueDto[];
  readonly projectCount: number;
  readonly sessionCount: number;
  readonly componentCounts: Readonly<Record<string, number>>;
  readonly unusedOfferedComponents: readonly string[];
  readonly totalTokens: number;
  readonly modelCount: number;
  readonly harnessCount: number;
}

/**
 * A period-over-period comparison for one KPI (issue #169). `previous`/
 * `previousN` are omitted — not `0` — when no comparable previous window
 * exists (the "All" time preset has no start bound, so there is no
 * equal-length prior window to compare against). Consumers render "—" in
 * that case rather than fabricating a 0% delta
 * (`.agents/rules/missing-is-never-zero.md`).
 */
export interface PeriodDelta {
  readonly current: number;
  readonly currentN: number;
  readonly previous?: number;
  readonly previousN?: number;
}

/**
 * Token totals for a portfolio KPI window (issue #169). `in`/`out` are each
 * an independent {@link PeriodDelta} because a `model_requests` row can have
 * a known `input_tokens` and a missing `output_tokens` (or vice versa) —
 * `currentN` on each side is the count of requests whose respective token
 * field was non-null, never inflated by the other side's coverage
 * (`.agents/rules/missing-is-never-zero.md`).
 */
export interface PortfolioTokenTotals {
  readonly in: PeriodDelta;
  readonly out: PeriodDelta;
}

/**
 * Cost coverage for a portfolio KPI window (issue #169). `currentReportedHarnesses`
 * of `currentTotalHarnesses` distinct harnesses observed in the window have
 * at least one non-null `model_usage.cost` row; `currentTotal` sums only
 * those known rows. When zero harnesses report cost, `currentTotal` is
 * `null` — a coverage gap, never a fabricated `$0`
 * (`.agents/rules/missing-is-never-zero.md`). `previousTotal`/
 * `previousReportedHarnesses` are omitted for the "All" time preset, same as
 * {@link PeriodDelta}.
 */
export interface PortfolioCostSummary {
  readonly currentTotal: number | null;
  readonly currentReportedHarnesses: number;
  readonly currentTotalHarnesses: number;
  readonly previousTotal?: number | null;
  readonly previousReportedHarnesses?: number;
  readonly previousTotalHarnesses?: number;
}

/**
 * Clean-completion rate for a portfolio KPI window (issue #169), built on
 * the `session:outcome` signal (issue #178). `value` is `cleanN / knownN`
 * and is `null` when `knownN` is 0 (no classified outcome in the window) —
 * never a fabricated 0%. `eligibleN` is every `finality = 'final'` session
 * in the window; `knownN` is the classified subset.
 */
export interface CleanCompletionRate {
  readonly value: number | null;
  readonly eligibleN: number;
  readonly knownN: number;
}

/**
 * Portfolio KPI band (issue #169): sessions delta, token totals, cost
 * coverage, and clean-completion rate for the query window.
 */
export interface PortfolioKpiBand {
  readonly token: AnalyticsToken;
  readonly sessions: PeriodDelta;
  readonly tokens: PortfolioTokenTotals;
  readonly cost: PortfolioCostSummary;
  readonly cleanCompletionRate: CleanCompletionRate;
}

/** One bar of the sessions-by-model bar list (issue #169). Sessions with no
 * `model_requests` row are grouped under `model: 'unknown'` — a real
 * observed bucket, not a dropped one. */
export interface SessionsByModelBarRow {
  readonly model: string;
  readonly sessionCount: number;
}

export interface SessionsByModelBar {
  readonly token: AnalyticsToken;
  readonly rows: readonly SessionsByModelBarRow[];
}

/**
 * One cell of the model×harness session-count matrix (issue #169).
 * `sessionCount: null` means this (model, harness) combination has never
 * been observed in the portfolio (the harness never runs this model) — a
 * distinct sentinel from a measured `0` (the combination has run before but
 * had no sessions in this window). See
 * `.agents/rules/missing-is-never-zero.md`.
 */
export interface ModelHarnessMatrixCell {
  readonly model: string;
  readonly harness: string;
  readonly sessionCount: number | null;
}

export interface ModelHarnessMatrix {
  readonly token: AnalyticsToken;
  readonly models: readonly string[];
  readonly harnesses: readonly string[];
  readonly cells: readonly ModelHarnessMatrixCell[];
}

/**
 * Invocation counts by canonical domain (issue #169) — implements
 * `portfolio:invocations_by_domain` (`metric-registry.ts`). Exactly the four
 * canonical `kind` values are present; MCP-server calls are counted inside
 * `tool`, never as a fifth bucket
 * (`.agents/rules/analytics-domain-distinctions.md`). `totalInvocations` is
 * the raw count of every invocation in the window, independent of the
 * per-kind breakdown, so consumers can assert
 * `sum(byKind) === totalInvocations` (no double counting).
 */
export interface InvocationsByDomainRow {
  readonly kind: 'tool' | 'skill' | 'agent' | 'sub_agent';
  readonly count: number;
}

export interface InvocationsByDomain {
  readonly token: AnalyticsToken;
  readonly rows: readonly InvocationsByDomainRow[];
  readonly totalInvocations: number;
}

export interface PortfolioTrendSeries {
  readonly token: AnalyticsToken;
  readonly series: readonly TimeSeriesPoint[];
}

export interface ComponentUtilizationRow {
  readonly componentId: string;
  readonly name: string;
  readonly kind: string;
  readonly projectCount: number;
  readonly sessionCount: number;
  readonly loadRate?: MetricValueDto;
  readonly token: AnalyticsToken;
}

export interface ComponentUtilizationPage extends CursorPage<ComponentUtilizationRow> {}

export interface ModelHarnessCohort {
  readonly model: string;
  readonly harness: string;
  readonly sessionCount: number;
  readonly metricValues: readonly MetricValueDto[];
  readonly token: AnalyticsToken;
}

export interface ModelHarnessCohortPage extends CursorPage<ModelHarnessCohort> {}

export interface ProjectListPage extends CursorPage<ProjectListItem> {}

export interface ProjectBehaviorSummary {
  readonly token: AnalyticsToken;
  readonly headlineMetrics: readonly MetricValueDto[];
  readonly trendToken: AnalyticsToken;
}

/**
 * One aggregate stat-strip value (issue #169): `value` is `null` when
 * `knownN` is 0 — a missing signal, never a fabricated 0
 * (`.agents/rules/missing-is-never-zero.md`). `eligibleN` is the population
 * this stat was computed over; `knownN` is the subset with a usable
 * observation (e.g. sessions with both `start_time` and `end_time`).
 * `previousValue`/`previousKnownN` are omitted when no comparable prior
 * window exists.
 */
export interface AggregateStat {
  readonly value: number | null;
  readonly eligibleN: number;
  readonly knownN: number;
  readonly previousValue?: number | null;
  readonly previousEligibleN?: number;
  readonly previousKnownN?: number;
}

/**
 * Project Behavior stat strip (issue #169): sessions delta, session-duration
 * and turn-count percentiles, and tokens/cost per session, all for the query
 * window. Percentiles on small samples (n=1, n=2) are still reported — never
 * suppressed — with their `knownN` alongside so consumers can judge
 * reliability (`.agents/rules/aggregates-expose-sample-size.md`).
 */
export interface ProjectStatStrip {
  readonly token: AnalyticsToken;
  readonly sessions: PeriodDelta;
  readonly durationMedianMs: AggregateStat;
  readonly durationP90Ms: AggregateStat;
  readonly turnsMedian: AggregateStat;
  readonly turnsP90: AggregateStat;
  readonly tokensPerSession: AggregateStat;
  readonly costPerSession: AggregateStat;
}

/** One session-duration histogram bin (issue #169). `endMs: null` marks the
 * open-ended final bin (">= last edge"). Bin edges come from
 * `SESSION_DURATION_HISTOGRAM_BIN_EDGES_MS` (`metric-registry.ts`). */
export interface DurationHistogramBin {
  readonly startMs: number;
  readonly endMs: number | null;
  readonly count: number;
}

/** Session-duration histogram for a project window (issue #169). `knownN` is
 * the subset of `eligibleN` sessions with both `start_time`/`end_time`
 * recorded; the difference is never folded into bin 0. */
export interface SessionDurationHistogram {
  readonly token: AnalyticsToken;
  readonly bins: readonly DurationHistogramBin[];
  readonly eligibleN: number;
  readonly knownN: number;
}

/** One week's tool error rate (issue #169). `rate` is `null` — not `0` —
 * when `toolCallsN` is 0 for that week (no tool calls observed, not a 0%
 * error rate). */
export interface WeeklyToolErrorRatePoint {
  readonly weekBucket: string;
  readonly rate: number | null;
  readonly toolCallsN: number;
  readonly failedN: number;
}

/** Weekly tool error rate series for a project (issue #169). `currentValue`
 * mirrors the latest week's `rate` (also `null` when that week had 0 tool
 * calls). */
export interface WeeklyToolErrorRateSeries {
  readonly token: AnalyticsToken;
  readonly series: readonly WeeklyToolErrorRatePoint[];
  readonly currentValue: number | null;
  readonly currentWeekN: number;
}

/** One tool's invocation count in the top-tools ranking (issue #169), scoped
 * to `kind = 'tool'` invocations only — Skill/Agent/Sub Agent invocations
 * have their own metrics and are never folded into this list
 * (`.agents/rules/analytics-domain-distinctions.md`). */
export interface TopToolRow {
  readonly componentId: string;
  readonly displayName: string | null;
  readonly invocationCount: number;
}

export interface TopToolsList {
  readonly token: AnalyticsToken;
  readonly rows: readonly TopToolRow[];
  readonly totalInvocations: number;
}

/**
 * One (model, harness) cohort row scoped to a single project (issue #169).
 * `medianTokens`/`medianCost` are `null` when no session in the cohort has a
 * known value (a coverage gap, never a fabricated 0). `lowN` flags cohorts
 * with `n < MODEL_HARNESS_COHORT_LOW_N_THRESHOLD` (`metric-registry.ts`) so
 * consumers can visually de-emphasize statistically unreliable rows without
 * suppressing them.
 */
export interface ProjectModelHarnessCohortRow {
  readonly model: string;
  readonly harness: string;
  readonly n: number;
  readonly medianTokens: number | null;
  readonly medianCost: number | null;
  readonly cleanRate: number | null;
  readonly cleanRateKnownN: number;
  readonly lowN: boolean;
}

export interface ProjectModelHarnessCohorts {
  readonly token: AnalyticsToken;
  readonly rows: readonly ProjectModelHarnessCohortRow[];
}

export interface SessionTrendSeries {
  readonly token: AnalyticsToken;
  readonly series: readonly TimeSeriesPoint[];
}

export interface ConfigurationTimelineEvent {
  readonly sequence: number;
  readonly captureTime?: string;
  readonly changeType: 'added' | 'updated' | 'removed';
  readonly componentId: string;
  readonly componentKind: string;
  readonly fromVersion?: string;
  readonly toVersion?: string;
}

export interface ConfigurationTimeline {
  readonly token: AnalyticsToken;
  readonly events: readonly ConfigurationTimelineEvent[];
}

export interface OutlierRow {
  readonly sessionId: string;
  readonly metricId: string;
  readonly value: number;
  readonly deviation: number | null;
  readonly evidenceLinks: readonly EvidenceLink[];
}

export interface OutlierPage extends CursorPage<OutlierRow> {}

export interface ComparisonRow {
  readonly comparisonId: string;
  readonly kind: string;
  readonly cohortA: CohortSummary;
  readonly cohortB: CohortSummary;
  readonly metricValues: readonly MetricValueDto[];
}

export interface ComparisonPage extends CursorPage<ComparisonRow> {}

export interface SessionEvidenceSummary {
  readonly token: AnalyticsToken;
  readonly sessionId: string;
  readonly rootSessionId: string;
  readonly parentSessionId?: string;
  readonly harness: string;
  readonly headlineMetrics: readonly MetricValueDto[];
}

export interface ContextTimingPoint {
  readonly turnNumber: number;
  readonly timestamp?: string;
  readonly totalTokens: number | null;
  readonly contextTokens: number | null;
  readonly generationTokens: number | null;
}

export interface ContextTimingSeries {
  readonly token: AnalyticsToken;
  readonly points: readonly ContextTimingPoint[];
}

export interface RootChildEntry {
  readonly sessionId: string;
  readonly isRoot: boolean;
  readonly childCount: number;
  readonly contributionMetrics: readonly MetricValueDto[];
}

export interface RootChildBreakdown {
  readonly token: AnalyticsToken;
  readonly root: RootChildEntry;
  readonly children: readonly RootChildEntry[];
}

export interface ComponentFactRow {
  readonly componentId: string;
  readonly kind: string;
  readonly invocationCount: number;
  readonly outcome: 'success' | 'failure' | 'partial' | 'unknown';
  readonly metricValues: readonly MetricValueDto[];
}

export interface ComponentFactPage extends CursorPage<ComponentFactRow> {}

export interface SessionValidation {
  readonly validationType: string;
  readonly status: 'passed' | 'failed' | 'pending' | 'unknown';
  readonly count: number;
}

export interface SessionValidationSummary {
  readonly token: AnalyticsToken;
  readonly validations: readonly SessionValidation[];
}

/**
 * One outcome bucket from `SessionOutcomeStore.rollupByProject` (db-core).
 * `outcome: null` is the "unreadable tail / not classifiable" bucket — a
 * distinct, always-present count, never folded into a real outcome or
 * dropped (missing-is-never-zero).
 */
export interface SessionOutcomeBucket {
  readonly outcome: 'clean' | 'interrupted_by_user' | 'ended_on_error' | null;
  readonly count: number;
}

/**
 * Project-scoped session outcome distribution backing the `session:outcome`
 * metric (`packages/db/src/metric-registry.ts`). `token.eligibleN` is every
 * `finality = 'final'` session in the project; `token.knownN` is the subset
 * with a classified outcome; `token.unknownCount` is the `null` bucket's
 * count — the coverage breakdown (n classified / n missing) sub-issue #169's
 * DTO consumers need, exposed here without wiring it into
 * {@link AnalyticsDataSource} (out of scope for issue #178).
 */
export interface SessionOutcomeDistribution {
  readonly token: AnalyticsToken;
  readonly buckets: readonly SessionOutcomeBucket[];
}

export interface EvidenceRow {
  readonly evidenceId: string;
  readonly entityType: string;
  readonly turnNumber?: number;
  readonly timestamp?: string;
  readonly summary: string;
  readonly evidenceLinks: readonly EvidenceLink[];
}

export interface EvidencePage extends CursorPage<EvidenceRow> {}

export interface ComponentEcosystemSummary {
  readonly token: AnalyticsToken;
  readonly countsByKind: Readonly<Record<string, number>>;
  readonly topByUtilization: readonly MetricValueDto[];
}

export interface ComponentVersion {
  readonly version: string;
  readonly sessionCount: number;
  readonly projectCount: number;
  readonly firstSeen?: string;
  readonly lastSeen?: string;
}

export interface ComponentVersionPage extends CursorPage<ComponentVersion> {}

export interface ComponentScope {
  readonly scope: string;
  readonly installationCount: number;
}

export interface ComponentScopePage extends CursorPage<ComponentScope> {}

export interface ComponentUtilizationDetail {
  readonly token: AnalyticsToken;
  readonly loadRate: MetricValueDto;
  readonly invokeRate: MetricValueDto;
  readonly overhead: MetricValueDto;
}

export interface ComponentDistributionRow {
  readonly metricId: string;
  readonly values: readonly MetricValueDto[];
  readonly bins?: Readonly<Record<string, number>>;
}

export interface ComponentDistributionPage extends CursorPage<ComponentDistributionRow> {}

export interface ComponentProjectSessionRow {
  readonly projectId: string;
  readonly sessionId: string;
  readonly lastUsed?: string;
  readonly metricValues: readonly MetricValueDto[];
}

export interface ComponentProjectSessionPage extends CursorPage<ComponentProjectSessionRow> {}

export interface LifecycleComparisonRow {
  readonly eventId: string;
  readonly changeType: 'added' | 'updated' | 'removed';
  readonly beforeVersion?: string;
  readonly afterVersion?: string;
  readonly affectedSessions: number;
}

export interface LifecycleComparisonPage extends CursorPage<LifecycleComparisonRow> {}

export interface ArtifactVersionMetadata {
  readonly artifactId: string;
  readonly sha256: string;
  readonly size: number;
  readonly mediaType: string;
  readonly captureTime?: string;
  readonly retentionClass: string;
  readonly sessionIds: readonly string[];
  readonly componentIds: readonly string[];
}

export interface DiffLine {
  readonly lineNumber: number;
  readonly text: string;
  readonly changeType: 'unchanged' | 'added' | 'removed';
}

export interface SideBySideDiff {
  readonly left: readonly DiffLine[];
  readonly right: readonly DiffLine[];
}

export interface MetadataChange {
  readonly field: string;
  readonly oldValue: string | null;
  readonly newValue: string | null;
}

export interface ArtifactDiff {
  readonly artifactId: string;
  readonly leftVersion: string;
  readonly rightVersion: string;
  readonly unifiedDiff?: string;
  readonly sideBySideDiff?: SideBySideDiff;
  readonly metadataChanges: readonly MetadataChange[];
  readonly sessionExposure: Readonly<Record<string, number>>;
}

export interface ProjectSessionListItem {
  readonly sessionId: string;
  readonly rootSessionId: string;
  readonly parentSessionId?: string;
  readonly harness: string;
  readonly finality: 'final' | 'partial' | 'censored';
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly coverage: Coverage;
}

export interface ProjectSessionListPage extends CursorPage<ProjectSessionListItem> {}

export interface SessionTreeNode {
  readonly sessionId: string;
  readonly children: readonly SessionTreeNode[];
  readonly generationToken: string;
}

export interface SessionTree {
  readonly rootSessionId: string;
  readonly nodes: readonly SessionTreeNode[];
}

export interface FilterField {
  readonly field: string;
  readonly type: string;
  readonly operators: readonly FilterOperator[];
  readonly comparabilityGroupIds?: readonly string[];
}

export interface FilterMetadata {
  readonly availableFields: readonly FilterField[];
  readonly availableComparabilityGroups: readonly string[];
  readonly generationToken: string;
  readonly analysisReleaseToken: string;
}

/**
 * `kind` vocabulary for a full-detail session-events row (issue #169): the
 * four canonical invocation kinds (`INVOCATION_KINDS` in
 * `packages/db-core/src/session-evidence.ts`) plus the two message kinds.
 * Nothing else — MCP is a sub-classification within `tool`, never a
 * separate kind (`.agents/rules/analytics-domain-distinctions.md`).
 */
export type SessionEventKind =
  | 'tool'
  | 'skill'
  | 'agent'
  | 'sub_agent'
  | 'user_message'
  | 'assistant_message';

/**
 * A payload attached to a session-events row, capped at
 * `PAYLOAD_TRUNCATION_BYTES` (db-core) for the bulk transfer. When
 * `truncated` is true, the full body is available via
 * `SessionEvidenceView.getEventPayload`. `tokens` is omitted (never `0`)
 * when neither exact nor estimated token counts were recorded.
 */
export interface SessionEventPayloadSummary {
  readonly payloadId: string;
  readonly content: string | null;
  readonly truncated: boolean;
  readonly sizeBytes?: number;
  readonly tokens?: number;
}

/**
 * One row of the full-detail, non-paginated session-events DTO. `timestamp`,
 * `turnNumber`, `tokens`, and `durationMs` are all optional-missing (never
 * coerced to `0`) — see the documented invocation/turn-linkage limitation in
 * `packages/db-core/src/session-events-detail.ts`.
 */
export interface SessionEventRow {
  readonly id: string;
  readonly timestamp?: string;
  readonly turnNumber?: number;
  readonly kind: SessionEventKind;
  readonly name: string;
  readonly target?: string;
  readonly tokens?: number;
  readonly durationMs?: number;
  readonly status: string;
  readonly inputPayload?: SessionEventPayloadSummary;
  readonly resultPayload?: SessionEventPayloadSummary;
}

/**
 * Full (non-paginated) session-events DTO. `token.eligibleN`/`knownN` are
 * the total event count and the count with a fully-populated `timestamp`
 * respectively, per `.agents/rules/aggregates-expose-sample-size.md`. This
 * exists alongside `getEvidencePages` (still the paginated path for
 * existing consumers) — see the docstring on `SessionEvidenceView`.
 */
export interface SessionEventsDetail {
  readonly token: AnalyticsToken;
  readonly sessionId: string;
  readonly events: readonly SessionEventRow[];
}

/** The full, untruncated body of one payload — the "fetch full payload" affordance. */
export interface SessionEventPayloadDetail {
  readonly payloadId: string;
  readonly content: string | null;
  readonly sizeBytes?: number;
  readonly tokens?: number;
}

/**
 * Distinct dimension-value lists observed over the *unfiltered* store for a
 * portfolio (issue #169) — backs the filter-bar chips. An empty list is a
 * legitimate "nothing observed yet", not an error.
 */
export interface DimensionDomains {
  readonly token: AnalyticsToken;
  readonly projects: readonly string[];
  readonly harnesses: readonly string[];
  readonly models: readonly string[];
}

export interface CoverageExplanation {
  readonly metricId: string;
  readonly coverage: Coverage;
  readonly capabilityState: 'available' | 'partial' | 'unavailable' | 'incompatible';
  readonly reason: string;
  readonly eligibleN: number;
  readonly knownN: number;
  readonly unknownCount: number;
  readonly evidenceLinks: readonly EvidenceLink[];
}

export interface PortfolioView {
  getOverview(query: AnalyticsQuery): Promise<PortfolioOverview>;
  getKpiBand(query: AnalyticsQuery): Promise<PortfolioKpiBand>;
  getTrends(query: AnalyticsQuery): Promise<PortfolioTrendSeries>;
  getComponentUtilization(query: AnalyticsQuery): Promise<ComponentUtilizationPage>;
  getModelHarnessCohorts(query: AnalyticsQuery): Promise<ModelHarnessCohortPage>;
  getProjectList(query: AnalyticsQuery): Promise<ProjectListPage>;
  getSessionsByModel(query: AnalyticsQuery): Promise<SessionsByModelBar>;
  getModelHarnessMatrix(query: AnalyticsQuery): Promise<ModelHarnessMatrix>;
  getInvocationsByDomain(query: AnalyticsQuery): Promise<InvocationsByDomain>;
}

export interface ProjectBehaviorView {
  getSummary(projectId: string, query: AnalyticsQuery): Promise<ProjectBehaviorSummary>;
  getSessionTrendSeries(projectId: string, query: AnalyticsQuery): Promise<SessionTrendSeries>;
  getConfigurationTimeline(
    projectId: string,
    query: AnalyticsQuery,
  ): Promise<ConfigurationTimeline>;
  getOutliers(projectId: string, query: AnalyticsQuery): Promise<OutlierPage>;
  getComparisons(projectId: string, query: AnalyticsQuery): Promise<ComparisonPage>;
  /**
   * Session outcome mix (clean / interrupted-by-user / ended-on-error, plus
   * the unreadable-tail bucket) for the project-behavior drill-down. Built
   * on the `session:outcome` signal from issue #178
   * (`SessionOutcomeStore.rollupByProject` / `getSessionOutcomeDistribution`
   * in `analytics-session.ts`) — this method only wires that existing DTO
   * into the read contract, it does not reclassify anything.
   */
  getOutcomeMix(projectId: string, query?: AnalyticsQuery): Promise<SessionOutcomeDistribution>;
  /** Stat strip: sessions delta, duration/turns percentiles, tokens/cost per session (issue #169). */
  getStatStrip(projectId: string, query: AnalyticsQuery): Promise<ProjectStatStrip>;
  /** Session-duration histogram binned by `SESSION_DURATION_HISTOGRAM_BIN_EDGES_MS` (issue #169). */
  getDurationHistogram(projectId: string, query: AnalyticsQuery): Promise<SessionDurationHistogram>;
  /** Weekly tool error rate series, gap-filled for weeks with 0 tool calls (issue #169). */
  getWeeklyToolErrorRate(
    projectId: string,
    query?: AnalyticsQuery,
  ): Promise<WeeklyToolErrorRateSeries>;
  /** Top tools by invocation count, `kind = 'tool'` only (issue #169). */
  getTopTools(projectId: string, query: AnalyticsQuery): Promise<TopToolsList>;
  /** Model×harness cohort rows scoped to this project (issue #169). */
  getModelHarnessCohorts(
    projectId: string,
    query: AnalyticsQuery,
  ): Promise<ProjectModelHarnessCohorts>;
}

/**
 * `getSessionEvents`/`getEventPayload` are the new full-detail,
 * non-paginated read path for the redesigned evidence table (issue #169).
 * `getEvidencePages`/`getTranscriptPages` remain the cursor-paginated path
 * for existing consumers until that page migrates.
 */
export interface SessionEvidenceView {
  getSummary(sessionId: string, query?: AnalyticsQuery): Promise<SessionEvidenceSummary>;
  getContextTimingSeries(sessionId: string, query?: AnalyticsQuery): Promise<ContextTimingSeries>;
  getRootChildBreakdown(sessionId: string, query?: AnalyticsQuery): Promise<RootChildBreakdown>;
  getComponentFacts(sessionId: string, query?: AnalyticsQuery): Promise<ComponentFactPage>;
  getValidationSummary(
    sessionId: string,
    query?: AnalyticsQuery,
  ): Promise<SessionValidationSummary>;
  getEvidencePages(sessionId: string, query?: AnalyticsQuery): Promise<EvidencePage>;
  getTranscriptPages(sessionId: string, query?: AnalyticsQuery): Promise<EvidencePage>;
  getSessionEvents(sessionId: string, query?: AnalyticsQuery): Promise<SessionEventsDetail>;
  getEventPayload(
    sessionId: string,
    payloadId: string,
    query?: AnalyticsQuery,
  ): Promise<SessionEventPayloadDetail | null>;
}

export interface ComponentEcosystemView {
  getSummary(query: AnalyticsQuery): Promise<ComponentEcosystemSummary>;
  getVersions(componentId: string, query?: AnalyticsQuery): Promise<ComponentVersionPage>;
  getScopes(componentId: string, query?: AnalyticsQuery): Promise<ComponentScopePage>;
  getUtilization(componentId: string, query?: AnalyticsQuery): Promise<ComponentUtilizationDetail>;
  getDistributions(componentId: string, query?: AnalyticsQuery): Promise<ComponentDistributionPage>;
  getProjectsSessions(
    componentId: string,
    query?: AnalyticsQuery,
  ): Promise<ComponentProjectSessionPage>;
  getLifecycleComparisons(
    componentId: string,
    query?: AnalyticsQuery,
  ): Promise<LifecycleComparisonPage>;
}

export interface ArtifactVersionView {
  getMetadata(artifactId: string, query?: AnalyticsQuery): Promise<ArtifactVersionMetadata>;
  getDiff(
    leftArtifactId: string,
    rightArtifactId: string,
    query?: AnalyticsQuery,
  ): Promise<ArtifactDiff>;
}

export interface ProjectSessionSearchView {
  getProjectSessionList(projectId: string, query: AnalyticsQuery): Promise<ProjectSessionListPage>;
  getRootSessionTree(sessionId: string): Promise<SessionTree>;
  getChildSessionTree(sessionId: string): Promise<SessionTree>;
}

export interface MetadataView {
  getFilterMetadata(query?: AnalyticsQuery): Promise<FilterMetadata>;
  getCoverageExplanation(metricId: string, query?: AnalyticsQuery): Promise<CoverageExplanation>;
  getDimensionDomains(query?: AnalyticsQuery): Promise<DimensionDomains>;
}

export interface AnalyticsDataSource {
  readonly portfolio: PortfolioView;
  readonly project: ProjectBehaviorView;
  readonly session: SessionEvidenceView;
  readonly component: ComponentEcosystemView;
  readonly artifact: ArtifactVersionView;
  readonly search: ProjectSessionSearchView;
  readonly metadata: MetadataView;
}

export function createAnalyticsDataSource(
  queryable: SqliteExecutor | SqliteTransaction,
  hasher?: ContentHasher,
): AnalyticsDataSource {
  return {
    portfolio: createPortfolioView(queryable),
    project: createProjectBehaviorView(queryable),
    session: createSessionEvidenceView(queryable),
    component: createComponentEcosystemView(queryable),
    artifact: createArtifactVersionView(queryable, hasher ?? createSha256ContentHasher()),
    search: createProjectSessionSearchView(queryable),
    metadata: createMetadataView(queryable),
  };
}
