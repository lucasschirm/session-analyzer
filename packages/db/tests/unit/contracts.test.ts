import { describe, expect, it } from 'vitest';
import type {
  AnalyticsDataSource,
  ArtifactBlobStore,
  ArtifactResolver,
  ArtifactVersionView,
  AtomicGenerationCommit,
  ComponentEcosystemView,
  ContentHasher,
  GenerationController,
  IngestionOrchestrator,
  MetadataView,
  PortfolioView,
  ProjectBehaviorView,
  ProjectSessionSearchView,
  SessionEvidenceView,
} from '../../src/index.js';

function typeCheck<T>(_value: T) {
  return true;
}

const stub = <T>(): Promise<T> => Promise.resolve({} as T);

describe('db facade contracts', () => {
  it('defines ArtifactResolver, ContentHasher, and ArtifactBlobStore ports', () => {
    const resolver: ArtifactResolver = {
      resolve: async (reference) => ({ ...reference, content: new Uint8Array(0) }),
    };

    const hasher: ContentHasher = {
      hash: async () => 'sha256',
    };

    const blobStore: ArtifactBlobStore = {
      retain: async (blob) => blob,
      read: async () => undefined,
      remove: async () => true,
      list: async () => [],
    };

    expect(typeCheck<ArtifactResolver>(resolver)).toBe(true);
    expect(typeCheck<ContentHasher>(hasher)).toBe(true);
    expect(typeCheck<ArtifactBlobStore>(blobStore)).toBe(true);
  });

  it('defines the ingestion entry-point and atomic replacement generation contracts', () => {
    const commit: AtomicGenerationCommit = {
      generationId: 'g1',
      candidateRecords: [],
      affectedProjectIds: ['p1'],
      rootSessionId: 'r1',
      sessionId: 's1',
      analysisReleaseId: 'a1',
    };

    const receipt = {
      generationId: 'g1',
      sessionId: 's1',
      status: 'committed' as const,
      analysisReleaseId: 'a1',
      issueIds: [],
    };

    const orchestrator: IngestionOrchestrator = {
      ingestManifest: async () => receipt,
      ingestManual: async () => receipt,
      validateBatch: async () => [],
      commitAtomic: async () => receipt,
    };

    const controller: GenerationController = {
      prepare: async () => ({
        generationId: 'g1',
        result: {} as never,
        isValid: true,
        issues: [],
      }),
      commit: async () => receipt,
    };

    expect(typeCheck<AtomicGenerationCommit>(commit)).toBe(true);
    expect(typeCheck<IngestionOrchestrator>(orchestrator)).toBe(true);
    expect(typeCheck<GenerationController>(controller)).toBe(true);
  });

  it('defines the AnalyticsDataSource interface grouped by view', () => {
    const portfolio: PortfolioView = {
      getOverview: () => stub(),
      getTrends: () => stub(),
      getComponentUtilization: () => stub(),
      getModelHarnessCohorts: () => stub(),
      getProjectList: () => stub(),
    };

    const project: ProjectBehaviorView = {
      getSummary: () => stub(),
      getSessionTrendSeries: () => stub(),
      getConfigurationTimeline: () => stub(),
      getOutliers: () => stub(),
      getComparisons: () => stub(),
    };

    const session: SessionEvidenceView = {
      getSummary: () => stub(),
      getContextTimingSeries: () => stub(),
      getRootChildBreakdown: () => stub(),
      getComponentFacts: () => stub(),
      getValidationSummary: () => stub(),
      getEvidencePages: () => stub(),
      getTranscriptPages: () => stub(),
    };

    const component: ComponentEcosystemView = {
      getSummary: () => stub(),
      getVersions: () => stub(),
      getScopes: () => stub(),
      getUtilization: () => stub(),
      getDistributions: () => stub(),
      getProjectsSessions: () => stub(),
      getLifecycleComparisons: () => stub(),
    };

    const artifact: ArtifactVersionView = {
      getMetadata: () => stub(),
      getDiff: () => stub(),
    };

    const search: ProjectSessionSearchView = {
      getProjectSessionList: () => stub(),
      getRootSessionTree: () => stub(),
      getChildSessionTree: () => stub(),
    };

    const metadata: MetadataView = {
      getFilterMetadata: () => stub(),
      getCoverageExplanation: () => stub(),
    };

    const source: AnalyticsDataSource = {
      portfolio,
      project,
      session,
      component,
      artifact,
      search,
      metadata,
    };

    expect(typeCheck<AnalyticsDataSource>(source)).toBe(true);
    expect(typeof source.portfolio.getOverview).toBe('function');
    expect(typeof source.project.getSummary).toBe('function');
    expect(typeof source.session.getSummary).toBe('function');
    expect(typeof source.component.getSummary).toBe('function');
    expect(typeof source.artifact.getMetadata).toBe('function');
    expect(typeof source.search.getProjectSessionList).toBe('function');
    expect(typeof source.metadata.getFilterMetadata).toBe('function');
  });
});
