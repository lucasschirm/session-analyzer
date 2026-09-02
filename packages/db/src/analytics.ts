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
  getTrends(query: AnalyticsQuery): Promise<PortfolioTrendSeries>;
  getComponentUtilization(query: AnalyticsQuery): Promise<ComponentUtilizationPage>;
  getModelHarnessCohorts(query: AnalyticsQuery): Promise<ModelHarnessCohortPage>;
  getProjectList(query: AnalyticsQuery): Promise<ProjectListPage>;
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
}

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
