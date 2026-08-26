import type {
  InsertSessionInput,
  SqliteExecutor,
  SqliteTransaction,
  UpdateSessionInput,
} from '@lucasschirm/sal-db-core';
import {
  beginGeneration,
  commitGeneration,
  deterministicEnvironmentId,
  deterministicId,
  deterministicIngestionSourceId,
  deterministicPortfolioId,
  deterministicSourceManifestId,
  deterministicSourceProjectId,
  EnvironmentStore,
  getCurrentGenerationId,
  IngestionSourceStore,
  MetricDefinitionStore,
  MetricValueStore,
  NormalizedEventStore,
  PortfolioStore,
  ProjectStore,
  SessionStore,
  SessionSummaryStore,
  SourceManifestStore,
  SourceProjectStore,
  StatisticalPolicyStore,
  TenantStore,
} from '@lucasschirm/sal-db-core';
import type { ManifestSchemaVersion, SyncManifest } from '@lucasschirm/sal-sync-core';
import { MANIFEST_SCHEMA_VERSION, sha256Hex } from '@lucasschirm/sal-sync-core';
import type {
  Artifact,
  Issue,
  Provenance,
  ScalarMetricValue,
  SessionSummary,
  SessionTransformer,
  SourceIdentity,
  TransformerRegistry,
  TransformResult,
  UnknownArtifactBundle,
} from '@lucasschirm/sal-transformer';
import { rebuildAffectedDistributions } from './distributions.js';
import type { ManualIngestionBundle, VerifiedManifestBundle } from './manifest.js';
import type {
  ArtifactBlobStore,
  ArtifactContent,
  ArtifactResolver,
  ContentHasher,
} from './ports.js';
import { applySessionRollupContributions } from './rollup-reconciliation.js';

export interface IngestionIssue {
  readonly code: string;
  readonly severity: 'fatal' | 'recoverable';
  readonly message: string;
  readonly entityId?: string;
  readonly entityType?: string;
}

export interface IngestionReceipt {
  readonly generationId: string;
  readonly sessionId: string;
  readonly status: 'committed' | 'superseded' | 'failed';
  readonly analysisReleaseId: string;
  readonly issueIds: readonly string[];
}

/**
 * A candidate replacement generation. Transformation occurs outside the write
 * transaction; the complete batch is validated before persistence. In one
 * transaction, candidate records coexist with current rows, contributions are
 * subtracted/rebuilt, and the session current generation is the single
 * visibility switch.
 */
export interface AtomicGenerationCommit {
  readonly generationId: string;
  readonly previousGenerationId?: string;
  readonly candidateRecords: readonly unknown[];
  readonly affectedProjectIds: readonly string[];
  readonly rootSessionId: string;
  readonly sessionId: string;
  readonly analysisReleaseId: string;
  /** Full transform result used to build the replacement generation. */
  readonly result?: TransformResult;
  /** Source manifest used to build source manifest metadata, when available. */
  readonly manifest?: SyncManifest;
  /** Source identity used to build canonical identity rows. */
  readonly source?: SourceIdentity;
}

export interface IngestionContext {
  readonly resolver: ArtifactResolver;
  readonly hasher: ContentHasher;
  readonly blobStore?: ArtifactBlobStore;
  readonly registry: TransformerRegistry;
  readonly executor: SqliteExecutor;
  readonly analysisReleaseId: string;
}

export interface IngestionOrchestrator {
  /**
   * Accept an already-resolved, integrity-verified manifest bundle plus
   * source/environment identity, select a transformer from the manifest
   * harness, and orchestrate the full ingestion flow.
   */
  ingestManifest(bundle: VerifiedManifestBundle): Promise<IngestionReceipt>;

  /**
   * Ingest a manually supplied artifact bundle.
   */
  ingestManual(bundle: ManualIngestionBundle): Promise<IngestionReceipt>;

  /**
   * Validate a transformed batch before it is persisted.
   */
  validateBatch(result: TransformResult): Promise<readonly IngestionIssue[]>;

  /**
   * Execute an atomic generation replacement inside a single transaction.
   */
  commitAtomic(commit: AtomicGenerationCommit): Promise<IngestionReceipt>;
}

export interface ValidatedGeneration {
  readonly generationId: string;
  readonly result: TransformResult;
  readonly isValid: boolean;
  readonly issues: readonly IngestionIssue[];
}

export interface GenerationController {
  prepare(commit: AtomicGenerationCommit): Promise<ValidatedGeneration>;
  commit(commit: AtomicGenerationCommit): Promise<IngestionReceipt>;
}

// TextEncoder is not in the ES2021 lib, but it is a stable global in Node and
// browsers. This local declaration keeps the package runtime-agnostic while
// allowing string-to-byte hashing without importing a runtime module.
interface TextEncoder {
  encode(input: string): Uint8Array;
}
declare const TextEncoder: { new (): TextEncoder };

interface TransformMetricValue extends ScalarMetricValue {
  readonly grain: string;
  readonly dimensions: Readonly<Record<string, string>>;
  readonly class: 'observed' | 'derived' | 'estimated' | 'heuristic';
  readonly confidence: number;
  readonly rootScope: 'root_only' | 'inclusive';
  readonly unavailableReason?: string;
  readonly partialReason?: string;
  readonly evidenceRecordIds: readonly string[];
  readonly provenance: readonly Provenance[];
  readonly estimationMethod?: string;
  readonly allocationMethod?: string;
  readonly definition: TransformerMetricDefinition;
}

interface TransformerMetricDefinition {
  readonly metricId: string;
  readonly version: number;
  readonly label: string;
  readonly description: string;
  readonly family: string;
  readonly measurementClass: 'observed' | 'derived' | 'estimated' | 'heuristic';
  readonly unit: string;
  readonly valueType: 'integer' | 'real' | 'currency' | 'ratio' | 'text';
  readonly grain: string;
  readonly dimensions: readonly string[];
  readonly denominator?: string;
  readonly populationRule: string;
  readonly statusRule: string;
  readonly aggregation: string;
  readonly allocationMethod?: string;
  readonly statisticalPolicyId: string;
  readonly comparabilityGroupInputs: readonly string[];
  readonly missingDataBehavior: 'unknown' | 'not_applicable';
  readonly rootInclusion: 'root_only' | 'inclusive' | 'both' | 'not_applicable';
  readonly distributionPolicy?: string;
  readonly provenanceRequirement: string;
}

interface CanonicalIdentity {
  readonly tenantId: string;
  readonly portfolioId: string;
  readonly ingestionSourceId: string;
  readonly projectId: string;
  readonly sourceProjectId: string;
  readonly environmentId: string | null;
  readonly nativeEnvironmentId: string | null;
  readonly nativeProjectId: string;
  readonly nativeSourceId: string;
  readonly nativeSessionId: string;
}

export function createSha256ContentHasher(): ContentHasher {
  return {
    hash: async (content) => {
      const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
      return sha256Hex(bytes as Uint8Array<ArrayBuffer>);
    },
  };
}

export class DefaultIngestionOrchestrator implements IngestionOrchestrator {
  constructor(private readonly context: IngestionContext) {}

  async ingestManifest(bundle: VerifiedManifestBundle): Promise<IngestionReceipt> {
    const { manifest, resolvedArtifacts } = bundle;

    // 0. Artifact integrity verification (always re-verify at runtime).
    const integrityIssues = await this.verifyArtifactHashes(resolvedArtifacts);
    if (integrityIssues.length > 0) {
      return this.failedReceipt({
        generationId: '',
        sessionId: manifest.sessionId,
        analysisReleaseId: this.context.analysisReleaseId,
        issues: integrityIssues,
      });
    }

    const sourceIdentity = this.buildSourceIdentity(manifest);
    const sourceFingerprint = await this.hashArtifacts(resolvedArtifacts);

    // 1. Select transformer from manifest harness.
    let transformer: SessionTransformer<UnknownArtifactBundle>;
    try {
      transformer = this.context.registry.resolve(manifest.harness);
    } catch (error) {
      return this.failedReceipt({
        generationId: '',
        sessionId: manifest.sessionId,
        analysisReleaseId: this.context.analysisReleaseId,
        issues: [
          {
            code: 'unsupported_harness',
            severity: 'fatal',
            message: error instanceof Error ? error.message : String(error),
            entityType: 'manifest',
            entityId: manifest.harness,
          },
        ],
      });
    }

    // 2. Build transformer bundle and transform outside the write transaction.
    const artifactBundle = this.buildArtifactBundle(
      resolvedArtifacts,
      sourceIdentity,
      sourceFingerprint,
    );
    const transformContext = {
      analysisReleaseId: this.context.analysisReleaseId,
      parserId: transformer.id,
      parserVersion: '0.1.0',
      sourceFingerprint,
      sourceEnvironmentId: sourceIdentity.environmentId,
      sourceProjectId: sourceIdentity.projectId,
      sourceSessionId: sourceIdentity.sessionId,
    };
    const result = transformer.transform(artifactBundle, transformContext);

    // 3. Validate the complete batch before persistence.
    const validationIssues = await this.validateBatch(result);
    if (validationIssues.some((issue) => issue.severity === 'fatal')) {
      return this.failedReceipt({
        generationId: '',
        sessionId: manifest.sessionId,
        analysisReleaseId: this.context.analysisReleaseId,
        issues: validationIssues,
      });
    }

    const rootSession = this.rootSessionSummary(result);
    if (!rootSession) {
      return this.failedReceipt({
        generationId: '',
        sessionId: manifest.sessionId,
        analysisReleaseId: this.context.analysisReleaseId,
        issues: [
          {
            code: 'missing_root_session',
            severity: 'fatal',
            message: 'Transformer produced no root session summary.',
          },
        ],
      });
    }

    const canonical = this.resolveCanonicalIdentity(manifest, sourceIdentity);
    const generationId = this.deterministicGenerationId(canonical, sourceFingerprint, result);

    // 4. Idempotent re-ingestion: if this exact generation is already current,
    //    no work is performed and no metrics are duplicated.
    const current = await getCurrentGenerationId(this.context.executor, rootSession.sessionId);
    if (current === generationId) {
      return this.committedReceipt({
        generationId,
        sessionId: rootSession.sessionId,
        analysisReleaseId: this.context.analysisReleaseId,
        issues: validationIssues,
      });
    }

    return this.commitAtomic({
      generationId,
      sessionId: rootSession.sessionId,
      rootSessionId: rootSession.rootSessionId,
      affectedProjectIds: [canonical.projectId],
      candidateRecords: [],
      analysisReleaseId: this.context.analysisReleaseId,
      result,
      manifest,
      source: sourceIdentity,
    });
  }

  async ingestManual(bundle: ManualIngestionBundle): Promise<IngestionReceipt> {
    const sourceIdentity: SourceIdentity = {
      sourceId: bundle.source?.sourceId ?? 'manual',
      environmentId: bundle.source?.environmentId,
      projectId: bundle.projectId,
      sessionId: bundle.sessionId,
    };
    const sourceFingerprint = await this.hashArtifacts(bundle.artifacts);

    let transformer: SessionTransformer<UnknownArtifactBundle>;
    try {
      transformer = this.context.registry.resolve(bundle.harness);
    } catch (error) {
      return this.failedReceipt({
        generationId: '',
        sessionId: bundle.sessionId,
        analysisReleaseId: this.context.analysisReleaseId,
        issues: [
          {
            code: 'unsupported_harness',
            severity: 'fatal',
            message: error instanceof Error ? error.message : String(error),
            entityType: 'bundle',
            entityId: bundle.harness,
          },
        ],
      });
    }

    const artifactBundle = this.buildArtifactBundle(
      bundle.artifacts,
      sourceIdentity,
      sourceFingerprint,
    );
    const transformContext = {
      analysisReleaseId: this.context.analysisReleaseId,
      parserId: transformer.id,
      parserVersion: '0.1.0',
      sourceFingerprint,
      sourceEnvironmentId: sourceIdentity.environmentId,
      sourceProjectId: sourceIdentity.projectId,
      sourceSessionId: sourceIdentity.sessionId,
    };
    const result = transformer.transform(artifactBundle, transformContext);

    const validationIssues = await this.validateBatch(result);
    if (validationIssues.some((issue) => issue.severity === 'fatal')) {
      return this.failedReceipt({
        generationId: '',
        sessionId: bundle.sessionId,
        analysisReleaseId: this.context.analysisReleaseId,
        issues: validationIssues,
      });
    }

    const rootSession = this.rootSessionSummary(result);
    if (!rootSession) {
      return this.failedReceipt({
        generationId: '',
        sessionId: bundle.sessionId,
        analysisReleaseId: this.context.analysisReleaseId,
        issues: [
          {
            code: 'missing_root_session',
            severity: 'fatal',
            message: 'Transformer produced no root session summary.',
          },
        ],
      });
    }

    const canonical = this.resolveManualCanonicalIdentity(bundle, sourceIdentity);
    const generationId = this.deterministicGenerationId(canonical, sourceFingerprint, result);

    const current = await getCurrentGenerationId(this.context.executor, rootSession.sessionId);
    if (current === generationId) {
      return this.committedReceipt({
        generationId,
        sessionId: rootSession.sessionId,
        analysisReleaseId: this.context.analysisReleaseId,
        issues: validationIssues,
      });
    }

    return this.commitAtomic({
      generationId,
      sessionId: rootSession.sessionId,
      rootSessionId: rootSession.rootSessionId,
      affectedProjectIds: [canonical.projectId],
      candidateRecords: [],
      analysisReleaseId: this.context.analysisReleaseId,
      result,
      source: sourceIdentity,
    });
  }

  async validateBatch(result: TransformResult): Promise<readonly IngestionIssue[]> {
    const issues: IngestionIssue[] = [];

    for (const error of result.errors) {
      issues.push(mapIssue(error, 'fatal'));
    }
    for (const warning of result.warnings) {
      issues.push(mapIssue(warning, 'recoverable'));
    }

    // Anti-double-counting: a metric may appear once per root/inclusive scope.
    const seen = new Set<string>();
    for (const value of result.metricValues as TransformMetricValue[]) {
      const key = `${value.metricId}|${value.rootScope}|${JSON.stringify(value.dimensions)}`;
      if (seen.has(key)) {
        issues.push({
          code: 'duplicate_metric_value',
          severity: 'fatal',
          message: `Duplicate metric value for ${value.metricId} with scope ${value.rootScope}.`,
          entityType: 'metric',
          entityId: value.metricId,
        });
      }
      seen.add(key);
    }

    return issues;
  }

  async commitAtomic(commit: AtomicGenerationCommit): Promise<IngestionReceipt> {
    if (!commit.result) {
      return this.failedReceipt({
        generationId: commit.generationId,
        sessionId: commit.sessionId,
        analysisReleaseId: commit.analysisReleaseId,
        issues: [
          {
            code: 'missing_transform_result',
            severity: 'fatal',
            message: 'commitAtomic requires a TransformResult.',
          },
        ],
      });
    }

    const result = commit.result as TransformResult;

    try {
      await this.context.executor.transaction(async (tx) => {
        // 1. Ensure canonical identity rows exist (deterministic, idempotent).
        const canonical = commit.manifest
          ? this.resolveCanonicalIdentity(
              commit.manifest,
              commit.source ?? this.buildSourceIdentity(commit.manifest),
            )
          : this.resolveManualIdentity(commit);
        await this.ensureCanonicalIdentity(tx, canonical);

        // 2. Ensure default policies and the target analysis release exist.
        await this.ensureStatisticalPolicy(tx);
        await this.ensureAnalysisRelease(tx, commit.analysisReleaseId);

        // 3. Begin the pending generation.
        await beginGeneration(tx, commit.generationId, {
          sessionId: commit.sessionId,
          analysisReleaseId: commit.analysisReleaseId,
          parserVersion: result.parserVersion,
          transformerVersion: result.transformerVersion,
          ontologyVersion: result.ontologyVersion,
          metricVersion: result.metricDefinitionVersion,
          schemaVersion: result.ontologyVersion,
        });

        // 4. Upsert sessions, including child sessions from summaries.
        await this.upsertSessions(tx, canonical, result, commit.generationId);

        // 5. Persist the source manifest and its coverage metadata.
        if (commit.manifest) {
          await this.upsertSourceManifest(
            tx,
            canonical,
            commit.manifest,
            result,
            commit.generationId,
          );
        }

        // 6. Persist metric definitions, values, evidence, and rollups.
        const definitionMap = await this.upsertMetricDefinitions(tx, result);
        await this.upsertMetricValues(
          tx,
          commit.sessionId,
          commit.generationId,
          canonical,
          definitionMap,
          result,
        );
        await this.pruneEvidenceForSessions(tx, result);
        await this.upsertEvidence(tx, commit.generationId, result);
        await this.upsertSessionSummaries(
          tx,
          commit.sessionId,
          commit.generationId,
          commit.analysisReleaseId,
          result,
        );

        // 7. Commit the generation: supersede previous, set session current_generation_id.
        //    Capture the previous generation ID first so rollup contributions can
        //    subtract old values before inserting new ones.
        const { rows: prevGenRows } = await tx.exec(
          'SELECT current_generation_id FROM sessions WHERE id = ?',
          [commit.sessionId],
        );
        const previousGenerationId =
          prevGenRows[0]?.current_generation_id === null ||
          prevGenRows[0]?.current_generation_id === undefined
            ? undefined
            : String(prevGenRows[0].current_generation_id);
        await commitGeneration(tx, commit.sessionId, commit.generationId);

        // Child sessions also switch visibility to the same root generation.
        for (const summary of result.sessionSummaries) {
          if (summary.sessionId !== commit.sessionId) {
            await tx.exec('UPDATE sessions SET current_generation_id = ? WHERE id = ?', [
              commit.generationId,
              summary.sessionId,
            ]);
          }
        }

        // 8. Materialize rollup contributions and distribution buckets for the
        //    new generation so portfolio/project charts are populated at
        //    ingestion time rather than requiring a separate reprocessing step.
        await applySessionRollupContributions(tx, {
          sessionId: commit.sessionId,
          generationId: commit.generationId,
          previousGenerationId: previousGenerationId ?? undefined,
          analysisReleaseId: commit.analysisReleaseId,
          isRoot: true,
        });
        for (const summary of result.sessionSummaries) {
          if (summary.sessionId !== commit.sessionId) {
            await applySessionRollupContributions(tx, {
              sessionId: summary.sessionId,
              generationId: commit.generationId,
              previousGenerationId: previousGenerationId ?? undefined,
              analysisReleaseId: commit.analysisReleaseId,
              isRoot: false,
            });
          }
        }
        await rebuildAffectedDistributions(tx, {
          sessionId: commit.sessionId,
          generationId: commit.generationId,
          previousGenerationId: previousGenerationId ?? undefined,
          analysisReleaseId: commit.analysisReleaseId,
          isRoot: true,
        });
      });

      return this.committedReceipt({
        generationId: commit.generationId,
        sessionId: commit.sessionId,
        analysisReleaseId: commit.analysisReleaseId,
        issues: [],
      });
    } catch (error) {
      return this.failedReceipt({
        generationId: commit.generationId,
        sessionId: commit.sessionId,
        analysisReleaseId: commit.analysisReleaseId,
        issues: [
          {
            code: 'atomic_commit_failed',
            severity: 'fatal',
            message: error instanceof Error ? error.message : String(error),
            entityType: 'generation',
            entityId: commit.generationId,
          },
        ],
      });
    }
  }

  private buildSourceIdentity(manifest: SyncManifest): SourceIdentity {
    return {
      sourceId: manifest.sourceEnvironmentNamespace ?? 'default',
      environmentId: manifest.environmentId,
      projectId: manifest.projectId,
      sessionId: manifest.sessionId,
    };
  }

  private resolveCanonicalIdentity(
    manifest: SyncManifest,
    source: SourceIdentity,
  ): CanonicalIdentity {
    const nativeProjectId = manifest.projectId;
    const nativeSourceId = source?.sourceId ?? manifest.sourceEnvironmentNamespace ?? 'default';
    const tenantId = 'ten-default';
    const portfolioId = deterministicPortfolioId(tenantId, 'default');
    const ingestionSourceId = deterministicIngestionSourceId(portfolioId, nativeSourceId);
    const projectId = `prj-${deterministicId('project', portfolioId, nativeProjectId)}`;
    const sourceProjectId = deterministicSourceProjectId(ingestionSourceId, nativeProjectId);
    const nativeEnvironmentId = manifest.environmentId ?? null;
    const environmentId = nativeEnvironmentId
      ? deterministicEnvironmentId(ingestionSourceId, nativeEnvironmentId)
      : null;

    return {
      tenantId,
      portfolioId,
      ingestionSourceId,
      projectId,
      sourceProjectId,
      environmentId,
      nativeEnvironmentId,
      nativeProjectId,
      nativeSourceId,
      nativeSessionId: manifest.sessionId,
    };
  }

  private resolveManualCanonicalIdentity(
    bundle: ManualIngestionBundle,
    source: SourceIdentity,
  ): CanonicalIdentity {
    const nativeProjectId = bundle.projectId;
    const nativeSourceId = source?.sourceId ?? bundle.source?.sourceId ?? 'manual';
    const nativeEnvironmentId = source.environmentId ?? null;
    const tenantId = 'ten-default';
    const portfolioId = deterministicPortfolioId(tenantId, 'default');
    const ingestionSourceId = deterministicIngestionSourceId(portfolioId, nativeSourceId);
    const projectId = `prj-${deterministicId('project', portfolioId, nativeProjectId)}`;
    const sourceProjectId = deterministicSourceProjectId(ingestionSourceId, nativeProjectId);
    const environmentId = nativeEnvironmentId
      ? deterministicEnvironmentId(ingestionSourceId, nativeEnvironmentId)
      : null;

    return {
      tenantId,
      portfolioId,
      ingestionSourceId,
      projectId,
      sourceProjectId,
      environmentId,
      nativeEnvironmentId,
      nativeProjectId,
      nativeSourceId,
      nativeSessionId: bundle.sessionId,
    };
  }

  private resolveManualIdentity(commit: AtomicGenerationCommit): CanonicalIdentity {
    // Fallback for direct commitAtomic calls without a manifest.
    const source = commit.source ?? { sourceId: 'manual' };
    const manifest: SyncManifest = {
      schemaVersion: MANIFEST_SCHEMA_VERSION as ManifestSchemaVersion,
      projectId: source.projectId ?? 'unknown',
      sessionId: commit.sessionId,
      environmentId: source.environmentId,
      harness: 'unknown',
      harnessVersion: '0.0.0',
      syncVersion: '0.0.0',
      pluginVersion: '0.0.0',
      transcriptsCaptured: false,
      artifacts: [],
      syncRuns: [],
    };
    return this.resolveCanonicalIdentity(manifest, source);
  }

  private deterministicGenerationId(
    canonical: CanonicalIdentity,
    sourceFingerprint: string,
    result: TransformResult,
  ): string {
    return `gen-${deterministicId(
      'generation',
      canonical.projectId,
      canonical.nativeSessionId,
      sourceFingerprint,
      this.context.analysisReleaseId,
      result.parserVersion,
      result.transformerVersion,
      result.ontologyVersion,
      result.metricDefinitionVersion,
    )}`;
  }

  private async verifyArtifactHashes(
    artifacts: ReadonlyArray<{ content: ArtifactContent; sha256?: string; relativePath?: string }>,
  ): Promise<IngestionIssue[]> {
    const issues: IngestionIssue[] = [];
    for (const artifact of artifacts) {
      if (!artifact.sha256) {
        issues.push({
          code: 'missing_artifact_hash',
          severity: 'fatal',
          message: `Artifact ${artifact.relativePath ?? 'unknown'} is missing a sha256.`,
          entityType: 'artifact',
          entityId: artifact.relativePath,
        });
        continue;
      }
      const actual = await this.context.hasher.hash(artifact.content);
      if (actual.toLowerCase() !== artifact.sha256.toLowerCase()) {
        issues.push({
          code: 'integrity_hash_mismatch',
          severity: 'fatal',
          message: `Hash mismatch for ${artifact.relativePath ?? 'artifact'}: expected ${artifact.sha256}, got ${actual}.`,
          entityType: 'artifact',
          entityId: artifact.relativePath,
        });
      }
    }
    return issues;
  }

  private async hashArtifacts(
    artifacts: ReadonlyArray<{ content?: ArtifactContent; sha256?: string; relativePath?: string }>,
  ): Promise<string> {
    const fingerprints = await Promise.all(
      artifacts.map(async (a) => {
        const hash = a.sha256 ?? (a.content ? await this.context.hasher.hash(a.content) : '');
        return `${a.relativePath ?? ''}:${hash}`;
      }),
    );
    fingerprints.sort();
    return this.context.hasher.hash(fingerprints.join('\n'));
  }

  private buildArtifactBundle(
    artifacts: ReadonlyArray<{
      content: ArtifactContent;
      sha256?: string;
      size?: number;
      relativePath: string;
      mediaType?: string;
    }>,
    sourceIdentity: SourceIdentity,
    sourceFingerprint: string,
  ): UnknownArtifactBundle {
    const mapped: Artifact[] = artifacts.map((a) => ({
      relativePath: a.relativePath,
      mediaType: a.mediaType ?? 'application/octet-stream',
      content: a.content,
      sha256: a.sha256,
      size: a.size,
      status: 'uploaded' as const,
    }));
    return {
      artifacts: mapped,
      sourceIdentity,
      sourceFingerprint,
    } as UnknownArtifactBundle;
  }

  private rootSessionSummary(result: TransformResult): SessionSummary | undefined {
    return (
      result.sessionSummaries.find((s) => s.rootSessionId === s.sessionId) ??
      result.sessionSummaries[0]
    );
  }

  private async ensureCanonicalIdentity(
    tx: SqliteTransaction,
    canonical: CanonicalIdentity,
  ): Promise<void> {
    if (!(await TenantStore.getById(tx, canonical.tenantId))) {
      await TenantStore.insert(tx, { id: canonical.tenantId, name: 'Default tenant' });
    }
    if (!(await PortfolioStore.getById(tx, canonical.tenantId, canonical.portfolioId))) {
      await PortfolioStore.insert(tx, {
        tenantId: canonical.tenantId,
        id: canonical.portfolioId,
        name: 'Default portfolio',
      });
    }
    if (
      !(await IngestionSourceStore.getById(tx, canonical.portfolioId, canonical.ingestionSourceId))
    ) {
      await IngestionSourceStore.insert(tx, {
        id: canonical.ingestionSourceId,
        portfolioId: canonical.portfolioId,
        nativeSourceId: canonical.nativeSourceId,
        displayName: canonical.nativeSourceId,
        type: 'sync',
        authority: 'local',
        supportsCursor: false,
        supportsCheckpoint: false,
      });
    }
    if (!(await ProjectStore.getById(tx, canonical.portfolioId, canonical.projectId))) {
      await ProjectStore.insert(tx, {
        id: canonical.projectId,
        portfolioId: canonical.portfolioId,
        name: canonical.nativeProjectId,
      });
    }
    if (!(await SourceProjectStore.getById(tx, canonical.portfolioId, canonical.sourceProjectId))) {
      await SourceProjectStore.insert(tx, canonical.portfolioId, {
        projectId: canonical.projectId,
        ingestionSourceId: canonical.ingestionSourceId,
        nativeProjectId: canonical.nativeProjectId,
      });
    }
    if (
      canonical.environmentId &&
      !(await EnvironmentStore.getById(tx, canonical.portfolioId, canonical.environmentId))
    ) {
      await EnvironmentStore.insert(tx, canonical.portfolioId, {
        id: canonical.environmentId,
        ingestionSourceId: canonical.ingestionSourceId,
        nativeEnvironmentId: canonical.nativeEnvironmentId,
      });
    }
  }

  private async ensureStatisticalPolicy(tx: SqliteTransaction): Promise<void> {
    await this.ensureStatisticalPolicyFor(tx, 'claude-default', 1);
  }

  private async ensureStatisticalPolicyFor(
    tx: SqliteTransaction,
    policyId: string,
    version = 1,
  ): Promise<string> {
    const existing = await StatisticalPolicyStore.getByPolicyIdAndVersion(tx, policyId, version);
    if (existing) {
      return existing.id;
    }
    return StatisticalPolicyStore.insert(tx, {
      policyId,
      version,
      name: `${policyId} statistical policy`,
      observationUnit: 'session',
      eligibility: 'all_sessions',
    });
  }

  private async ensureAnalysisRelease(tx: SqliteTransaction, releaseId: string): Promise<void> {
    const { rows } = await tx.exec('SELECT 1 FROM analysis_releases WHERE id = ?', [releaseId]);
    if (rows.length > 0) {
      return;
    }
    await tx.exec(
      `INSERT INTO analysis_releases (
        id, ontology_version, metric_registry_version, statistical_policy_version,
        rollup_policy_version, mapping_version, created_at, is_default
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [releaseId, '0.1.0', '0.1.0', 'claude-default', '0.1.0', '0.1.0', Date.now(), 0],
    );
  }

  private async upsertSessions(
    tx: SqliteTransaction,
    canonical: CanonicalIdentity,
    result: TransformResult,
    _generationId: string,
  ): Promise<void> {
    const rootSession = this.rootSessionSummary(result);
    const rootSessionId = rootSession?.sessionId;

    for (const summary of result.sessionSummaries) {
      const existing = await SessionStore.getById(tx, canonical.projectId, summary.sessionId);
      const occurrence = summary.startTime ? new Date(summary.startTime).getTime() : null;
      const startTime = summary.startTime ? new Date(summary.startTime).getTime() : null;
      const endTime = summary.endTime ? new Date(summary.endTime).getTime() : null;
      const finality = this.mapFinality(summary.finality);
      const nativeSessionId =
        summary.sessionId === rootSessionId ? canonical.nativeSessionId : summary.sessionId;

      const baseInput = {
        environmentId: canonical.environmentId,
        finality,
        occurrenceTime: occurrence,
        startTime,
        endTime,
        mode: null,
        taskCohort: null,
        aiTitle: null,
        slug: null,
        agentName: null,
        cwd: null,
        gitBranch: null,
        cliVersions: null,
        isSidechain: false,
        agentId: null,
        currentGenerationId: null,
      };

      if (existing) {
        await SessionStore.update(
          tx,
          canonical.projectId,
          summary.sessionId,
          baseInput as UpdateSessionInput,
        );
      } else {
        const insertInput = {
          id: summary.sessionId,
          projectId: canonical.projectId,
          ingestionSourceId: canonical.ingestionSourceId,
          harness: summary.harness,
          nativeSessionId,
          ...baseInput,
        };
        await SessionStore.insert(tx, insertInput as InsertSessionInput);
      }
    }
  }

  private async upsertSourceManifest(
    tx: SqliteTransaction,
    canonical: CanonicalIdentity,
    manifest: SyncManifest,
    result: TransformResult,
    _generationId: string,
  ): Promise<void> {
    const sourceManifestId = deterministicSourceManifestId(
      canonical.ingestionSourceId,
      canonical.nativeSessionId,
      manifest.sequenceNumber ?? 0,
    );
    const existing = await SourceManifestStore.getById(tx, canonical.portfolioId, sourceManifestId);
    if (existing) {
      return;
    }
    const sourceFingerprint = result.bundleHash ?? (await this.hashArtifacts(manifest.artifacts));
    await SourceManifestStore.insert(tx, canonical.portfolioId, {
      id: sourceManifestId,
      ingestionSourceId: canonical.ingestionSourceId,
      environmentId: canonical.environmentId,
      sourceProjectId: canonical.sourceProjectId,
      sessionId: result.sessionSummaries[0]?.sessionId ?? manifest.sessionId,
      manifestSchemaVersion: manifest.schemaVersion,
      finality: manifest.finality ?? 'partial',
      occurrenceTime: manifest.occurrenceTime ? new Date(manifest.occurrenceTime).getTime() : null,
      captureTime: manifest.captureTime ? new Date(manifest.captureTime).getTime() : null,
      ingestionTime: manifest.ingestionTime ? new Date(manifest.ingestionTime).getTime() : null,
      sequenceNumber: manifest.sequenceNumber ?? 0,
      nativeProjectId: manifest.projectId,
      nativeSessionId: manifest.sessionId,
      repositoryId: manifest.repositoryId,
      scopeChain: manifest.scopeChain?.join(',') ?? null,
      collectorVersion: manifest.collectorVersion,
      sanitizationPolicyVersion: manifest.sanitizationPolicyVersion,
      syncVersion: manifest.syncVersion,
      pluginVersion: manifest.pluginVersion,
      harness: manifest.harness,
      harnessVersion: manifest.harnessVersion,
      model: manifest.model,
      startedAt: manifest.startedAt ?? null,
      endedAt: manifest.endedAt ?? null,
      durationMs: manifest.durationMs ?? null,
      endReason: manifest.endReason ?? null,
      transcriptsCaptured: manifest.transcriptsCaptured,
      mainTranscriptRelativePath: manifest.mainTranscriptRelativePath ?? null,
      rawMetadata: JSON.stringify(manifest),
      manifestHash: sourceFingerprint,
      reprocessingStatus: 'local',
    });
  }

  private async upsertMetricDefinitions(
    tx: SqliteTransaction,
    result: TransformResult,
  ): Promise<ReadonlyMap<string, string>> {
    const map = new Map<string, string>();
    const metricValues = result.metricValues as TransformMetricValue[];
    for (const value of metricValues) {
      const def = value.definition;
      const existing = await MetricDefinitionStore.getByMetricIdAndVersion(
        tx,
        def.metricId,
        def.version,
      );
      if (existing) {
        map.set(def.metricId, existing.id);
      } else {
        const statisticalPolicyId = await this.ensureStatisticalPolicyFor(
          tx,
          def.statisticalPolicyId,
          1,
        );
        const id = await MetricDefinitionStore.insert(tx, {
          metricId: def.metricId,
          version: def.version,
          label: def.label,
          description: def.description,
          family: def.family,
          measurementClass: def.measurementClass,
          unit: def.unit,
          valueType: def.valueType,
          grain: def.grain,
          dimensions: def.dimensions,
          denominator: def.denominator,
          populationRule: def.populationRule,
          statusRule: def.statusRule,
          aggregation: def.aggregation,
          allocationMethod: def.allocationMethod,
          statisticalPolicyId,
          comparabilityGroupInputs: def.comparabilityGroupInputs,
          missingDataBehavior: def.missingDataBehavior,
          rootInclusion: def.rootInclusion,
          distributionPolicy: def.distributionPolicy,
          provenanceRequirement: def.provenanceRequirement,
        });
        map.set(def.metricId, id);
      }
    }
    return map;
  }

  private async upsertMetricValues(
    tx: SqliteTransaction,
    sessionId: string,
    generationId: string,
    _canonical: CanonicalIdentity,
    definitionMap: ReadonlyMap<string, string>,
    result: TransformResult,
  ): Promise<void> {
    const metricValues = result.metricValues as TransformMetricValue[];
    for (const value of metricValues) {
      const metricDefinitionId = definitionMap.get(value.metricId);
      if (!metricDefinitionId) {
        throw new Error(`Metric definition not found for ${value.metricId}`);
      }

      const valueClass = value.exact
        ? 'exact'
        : value.class === 'derived'
          ? 'inherited'
          : 'estimated';
      const rootInclusion = value.rootScope;
      const unavailable = value.value === null || value.value === undefined;

      let integerValue: number | null = null;
      let numericValue: number | null = null;
      let textValue: string | null = null;
      if (!unavailable) {
        if (value.definition.valueType === 'integer') {
          integerValue = Math.round(value.value as number);
        } else if (
          value.definition.valueType === 'real' ||
          value.definition.valueType === 'currency' ||
          value.definition.valueType === 'ratio'
        ) {
          numericValue = value.value as number;
        } else if (value.definition.valueType === 'text') {
          textValue = String(value.value);
        }
      }

      const dimensionsKey =
        value.dimensions && Object.keys(value.dimensions).length > 0
          ? Object.values(value.dimensions).join('/')
          : null;

      await MetricValueStore.insert(tx, {
        metricDefinitionId,
        sessionId,
        generationId,
        entityType: null,
        entityId: null,
        dimensionsKey,
        valueType: value.definition.valueType,
        integerValue,
        numericValue,
        textValue,
        valueClass,
        confidence: unavailable ? 0 : value.confidence,
        rootInclusion,
        isUnavailable: unavailable,
        unavailableReason: unavailable ? (value.unavailableReason ?? 'unknown') : null,
        isNotApplicable: false,
      });
    }
  }

  private async pruneEvidenceForSessions(
    tx: SqliteTransaction,
    result: TransformResult,
  ): Promise<void> {
    const sessionIds = new Set<string>();
    for (const summary of result.sessionSummaries) {
      sessionIds.add(summary.sessionId);
    }
    for (const record of result.evidence) {
      sessionIds.add(record.sessionId);
    }
    for (const sessionId of sessionIds) {
      await tx.exec('DELETE FROM normalized_events WHERE session_id = ?', [sessionId]);
    }
  }

  private async upsertEvidence(
    tx: SqliteTransaction,
    generationId: string,
    result: TransformResult,
  ): Promise<void> {
    for (const record of result.evidence) {
      await NormalizedEventStore.insert(tx, {
        id: record.recordId,
        sessionId: record.sessionId,
        generationId,
        eventType: record.recordType,
        eventVersion: 1,
        rawDetails: JSON.stringify(record),
        retainRaw: true,
      });
    }
  }

  private async upsertSessionSummaries(
    tx: SqliteTransaction,
    rootSessionId: string,
    generationId: string,
    analysisReleaseId: string,
    result: TransformResult,
  ): Promise<void> {
    const metricValues = result.metricValues as TransformMetricValue[];

    for (const summary of result.sessionSummaries) {
      const isRoot =
        summary.rootSessionId === summary.sessionId || summary.sessionId === rootSessionId;
      const inclusions: ('root_only' | 'inclusive')[] = isRoot
        ? ['root_only', 'inclusive']
        : ['inclusive'];

      for (const inclusion of inclusions) {
        const headlineMetrics = metricValues
          .filter((m) => m.rootScope === inclusion)
          .map((m) => ({
            metricId: m.metricId,
            value: m.value,
            unit: m.unit,
            exact: m.exact,
            rootScope: m.rootScope,
            dimensions: m.dimensions,
          }));

        const capabilityCoverage = (result.capabilities ?? []).map((c) => ({
          metricId: c.metricId,
          state: c.state,
          reason: c.reason,
        }));

        const sourceCompleteness = result.configurationSnapshot
          ? { completeness: result.configurationSnapshot.completeness }
          : {};

        await SessionSummaryStore.insert(tx, {
          sessionId: summary.sessionId,
          generationId,
          analysisReleaseId,
          rootInclusion: inclusion,
          headlineMetrics: JSON.stringify(headlineMetrics),
          capabilityCoverage: JSON.stringify(capabilityCoverage),
          observedOutcomeState: this.mapFinality(summary.finality),
          sourceCompleteness: JSON.stringify(sourceCompleteness),
        });
      }
    }
  }

  private mapFinality(finality?: string): 'open' | 'final' | 'censored' {
    if (finality === 'final') return 'final';
    if (finality === 'censored') return 'censored';
    return 'open';
  }

  private committedReceipt(input: {
    generationId: string;
    sessionId: string;
    analysisReleaseId: string;
    issues?: readonly IngestionIssue[];
  }): IngestionReceipt {
    return {
      generationId: input.generationId,
      sessionId: input.sessionId,
      status: 'committed',
      analysisReleaseId: input.analysisReleaseId,
      issueIds: input.issues?.map((i) => i.code) ?? [],
    };
  }

  private failedReceipt(input: {
    generationId: string;
    sessionId: string;
    analysisReleaseId: string;
    issues: readonly IngestionIssue[];
  }): IngestionReceipt {
    return {
      generationId: input.generationId,
      sessionId: input.sessionId,
      status: 'failed',
      analysisReleaseId: input.analysisReleaseId,
      issueIds: input.issues.map((i) => i.code),
    };
  }
}

function mapIssue(issue: Issue, severity: 'fatal' | 'recoverable'): IngestionIssue {
  return {
    code: issue.code,
    severity,
    message: issue.message,
    entityType: issue.provenance?.path ? 'artifact' : undefined,
    entityId: issue.provenance?.path,
  };
}

export class DefaultGenerationController implements GenerationController {
  constructor(private readonly orchestrator: IngestionOrchestrator) {}

  async prepare(commit: AtomicGenerationCommit): Promise<ValidatedGeneration> {
    const issues = commit.result ? await this.orchestrator.validateBatch(commit.result) : [];
    return {
      generationId: commit.generationId,
      result: commit.result as never,
      isValid: !issues.some((i) => i.severity === 'fatal'),
      issues,
    };
  }

  async commit(commit: AtomicGenerationCommit): Promise<IngestionReceipt> {
    return this.orchestrator.commitAtomic(commit);
  }
}
