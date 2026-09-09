import {
  deterministicEnvironmentId,
  deterministicId,
  deterministicIngestionSourceId,
  deterministicPortfolioId,
  deterministicSourceProjectId,
  SessionStore,
} from '@lucasschirm/sal-db-core';
import type { ManifestSchemaVersion, SyncManifest } from '@lucasschirm/sal-sync-core';
import { MANIFEST_SCHEMA_VERSION } from '@lucasschirm/sal-sync-core';
import type {
  Artifact,
  ComponentCompleteness,
  RegistryResolution,
  SessionSummary,
  SessionTransformer,
  SourceIdentity,
  TransformResult,
  UnknownArtifactBundle,
} from '@lucasschirm/sal-transformer-shared';
import {
  type AtomicGenerationCommit,
  DefaultIngestionOrchestrator,
  type IngestionContext,
  type IngestionIssue,
  type IngestionReceipt,
} from './ingestion.js';
import type { ManualIngestionBundle } from './manifest.js';
import type { ArtifactContent } from './ports.js';

export interface ManualIngestionFlowInput extends Omit<ManualIngestionBundle, 'harness'> {
  /** User-selected or detected harness. */
  readonly harness?: string;
  /** Opaque batch identifier supplied by the caller runtime. */
  readonly importBatchId?: string;
}

export interface ManualIngestionDetection {
  readonly kind: 'matched' | 'unmatched' | 'ambiguous';
  readonly harness?: string;
  readonly confidence?: number;
  readonly reason?: string;
  readonly candidates?: readonly string[];
}

interface ManualCanonicalIdentity {
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

interface ManualIngestionManifestExtras {
  readonly importBatchId?: string;
  readonly suppliedFileInventory: readonly ManualSuppliedFile[];
  readonly detection: ManualIngestionDetection;
}

interface ManualSuppliedFile {
  readonly relativePath: string;
  readonly sha256: string;
  readonly size: number;
  readonly mediaType: string;
  readonly status: string;
}

interface ManualArtifactReference {
  readonly relativePath: string;
  readonly sha256: string;
  readonly size: number;
  readonly mediaType: string;
  readonly status: string;
  readonly content?: ArtifactContent;
}

/**
 * Manual ingestion orchestrator.
 *
 * Handles transcript-only or partial manual uploads. It preserves
 * directory-relative paths, records source namespace, native session ID,
 * canonical project/workspace, harness choice or detection evidence, hashes,
 * import-batch ID, and the supplied-file inventory. Manual sessions never
 * fabricate a complete configuration snapshot, never emit lifecycle removals,
 * and never contribute configuration-exposure denominators.
 */
export class ManualIngestionOrchestrator {
  private readonly delegate: DefaultIngestionOrchestrator;

  constructor(private readonly context: IngestionContext) {
    this.delegate = new DefaultIngestionOrchestrator(context);
  }

  async ingestManual(bundle: ManualIngestionFlowInput): Promise<IngestionReceipt> {
    try {
      // 1. Resolve harness: user choice or schema detection.
      const detection = await this.resolveHarness(bundle);
      if (detection.kind !== 'matched' || !detection.harness) {
        return this.failedReceipt({
          generationId: '',
          sessionId: bundle.sessionId,
          issues: [this.detectionIssue(bundle, detection)],
        });
      }

      // 2. Select transformer.
      let transformer: SessionTransformer<unknown>;
      try {
        transformer = this.context.registry.resolve(detection.harness);
      } catch (error) {
        return this.failedReceipt({
          generationId: '',
          sessionId: bundle.sessionId,
          issues: [
            {
              code: 'unsupported_harness',
              severity: 'fatal',
              message: error instanceof Error ? error.message : String(error),
              entityType: 'bundle',
              entityId: detection.harness,
            },
          ],
        });
      }

      // 3. Build source identity and deterministic fingerprint.
      const sourceIdentity: SourceIdentity = {
        sourceId: bundle.source?.sourceId ?? 'manual',
        environmentId: bundle.source?.environmentId,
        projectId: bundle.projectId,
        sessionId: bundle.sessionId,
      };

      const artifactInventory = await this.buildArtifactInventory(bundle.artifacts);
      const sourceFingerprint = await this.hashArtifactInventory(artifactInventory);

      // 4. Transform outside the write transaction.
      const artifactBundle: UnknownArtifactBundle = {
        artifacts: bundle.artifacts as Artifact<unknown>[],
        sourceIdentity,
        sourceFingerprint,
      };

      const transformContext = {
        analysisReleaseId: this.context.analysisReleaseId,
        parserId: transformer.id,
        parserVersion: '0.1.0',
        sourceFingerprint,
        sourceEnvironmentId: sourceIdentity.environmentId,
        sourceProjectId: sourceIdentity.projectId,
        sourceSessionId: sourceIdentity.sessionId,
      };

      const rawResult = transformer.transform(artifactBundle, transformContext);
      const result = this.adjustForManual(rawResult);

      // 5. Validate batch before persistence.
      const validationIssues = await this.delegate.validateBatch(result);
      if (validationIssues.some((issue) => issue.severity === 'fatal')) {
        return this.failedReceipt({
          generationId: '',
          sessionId: bundle.sessionId,
          issues: validationIssues,
        });
      }

      const rootSession = this.rootSessionSummary(result);
      if (!rootSession) {
        return this.failedReceipt({
          generationId: '',
          sessionId: bundle.sessionId,
          issues: [
            {
              code: 'missing_root_session',
              severity: 'fatal',
              message: 'Transformer produced no root session summary.',
            },
          ],
        });
      }

      // 6. Resolve canonical identity and generation id.
      const manualManifest = this.buildManualManifest(
        bundle,
        detection,
        artifactInventory,
        sourceIdentity,
        transformer.ontologyVersion,
      );
      const canonical = this.resolveCanonicalIdentity(manualManifest, sourceIdentity);
      const generationId = this.deterministicGenerationId(canonical, sourceFingerprint, result);

      // 7. Match rules: source namespace + native session id, then exact artifact identity.
      const existingSession = await SessionStore.getById(
        this.context.executor,
        canonical.projectId,
        rootSession.sessionId,
      );

      if (existingSession?.currentGenerationId === generationId) {
        return this.committedReceipt({
          generationId,
          sessionId: rootSession.sessionId,
          analysisReleaseId: this.context.analysisReleaseId,
          issues: validationIssues,
        });
      }

      if (existingSession?.currentGenerationId) {
        return this.failedReceipt({
          generationId,
          sessionId: rootSession.sessionId,
          issues: [
            {
              code: 'manual_conflict',
              severity: 'fatal',
              message: `A different generation already exists for source ${canonical.nativeSourceId} session ${canonical.nativeSessionId}. User resolution is required.`,
              entityType: 'session',
              entityId: rootSession.sessionId,
            },
          ],
        });
      }

      // 8. Atomic commit.
      const commit: AtomicGenerationCommit = {
        generationId,
        sessionId: rootSession.sessionId,
        rootSessionId: rootSession.rootSessionId,
        affectedProjectIds: [canonical.projectId],
        candidateRecords: [],
        analysisReleaseId: this.context.analysisReleaseId,
        result,
        manifest: manualManifest,
        source: sourceIdentity,
      };

      const receipt = await this.delegate.commitAtomic(commit);

      // Preserve recoverable validation issues on a successful commit.
      if (receipt.status === 'committed' && validationIssues.length > 0) {
        return this.committedReceipt({
          generationId: receipt.generationId,
          sessionId: receipt.sessionId,
          analysisReleaseId: receipt.analysisReleaseId,
          issues: validationIssues,
        });
      }

      return receipt;
    } catch (error) {
      return this.failedReceipt({
        generationId: '',
        sessionId: bundle.sessionId,
        issues: [
          {
            code: 'manual_ingestion_failed',
            severity: 'fatal',
            message: error instanceof Error ? error.message : String(error),
            entityType: 'bundle',
            entityId: bundle.sessionId,
          },
        ],
      });
    }
  }

  private async resolveHarness(
    bundle: ManualIngestionFlowInput,
  ): Promise<ManualIngestionDetection> {
    if (bundle.harness) {
      return {
        kind: 'matched',
        harness: bundle.harness,
        confidence: 1,
        reason: 'user-supplied harness',
      };
    }

    const resolution: RegistryResolution = this.context.registry.resolveByDetection({
      artifacts: bundle.artifacts as Artifact<unknown>[],
    });

    if (resolution.kind === 'matched') {
      return {
        kind: 'matched',
        harness: resolution.harness,
        confidence: 1,
        reason: 'schema detection matched a single transformer',
      };
    }

    if (resolution.kind === 'unmatched') {
      return {
        kind: 'unmatched',
        reason: resolution.reason,
      };
    }

    return {
      kind: 'ambiguous',
      reason: resolution.reason,
      candidates: resolution.candidates,
    };
  }

  private detectionIssue(
    bundle: ManualIngestionFlowInput,
    detection: ManualIngestionDetection,
  ): IngestionIssue {
    if (detection.kind === 'ambiguous') {
      return {
        code: 'manual_harness_ambiguous',
        severity: 'fatal',
        message: `Ambiguous manual detection: ${detection.reason ?? 'multiple harnesses matched'}. Candidates: ${detection.candidates?.join(', ') ?? 'unknown'}. User choice is required.`,
        entityType: 'bundle',
        entityId: bundle.sessionId,
      };
    }

    return {
      code: 'manual_harness_unmatched',
      severity: 'fatal',
      message: `No harness detected for manual bundle: ${detection.reason ?? 'no transformer matched'}.`,
      entityType: 'bundle',
      entityId: bundle.sessionId,
    };
  }

  private async buildArtifactInventory(
    artifacts: ReadonlyArray<Artifact<ArtifactContent>>,
  ): Promise<readonly ManualArtifactReference[]> {
    const inventory: ManualArtifactReference[] = [];
    for (const artifact of artifacts) {
      const sha256 =
        artifact.sha256 ??
        (artifact.content !== undefined ? await this.context.hasher.hash(artifact.content) : '');
      inventory.push({
        relativePath: artifact.relativePath,
        sha256,
        size: artifact.size ?? 0,
        mediaType: artifact.mediaType ?? 'application/octet-stream',
        status: artifact.status ?? 'uploaded',
        content: artifact.content,
      });
    }
    return inventory;
  }

  private async hashArtifactInventory(
    inventory: ReadonlyArray<Pick<ManualArtifactReference, 'relativePath' | 'sha256'>>,
  ): Promise<string> {
    const fingerprints = inventory.map((item) => `${item.relativePath}:${item.sha256}`).sort();
    return this.context.hasher.hash(fingerprints.join('\n'));
  }

  private buildManualManifest(
    bundle: ManualIngestionFlowInput,
    detection: ManualIngestionDetection,
    inventory: ReadonlyArray<ManualArtifactReference>,
    source: SourceIdentity,
    harnessVersion: string,
  ): SyncManifest & ManualIngestionManifestExtras {
    const mainTranscript = inventory.find(
      (item) => item.mediaType === 'application/jsonl' || item.relativePath.endsWith('.jsonl'),
    );

    return {
      schemaVersion: MANIFEST_SCHEMA_VERSION as ManifestSchemaVersion,
      projectId: bundle.projectId,
      sessionId: bundle.sessionId,
      harness: detection.harness ?? 'unknown',
      harnessVersion: bundle.harnessVersion ?? harnessVersion,
      sourceEnvironmentNamespace: source.sourceId,
      environmentId: source.environmentId,
      finality: 'partial',
      captureTime: new Date().toISOString(),
      ingestionTime: new Date().toISOString(),
      sequenceNumber: -1,
      workspaceId: bundle.workspaceId,
      repositoryId: bundle.repositoryId,
      syncVersion: 'manual',
      pluginVersion: 'manual',
      transcriptsCaptured: mainTranscript !== undefined,
      mainTranscriptRelativePath: mainTranscript?.relativePath,
      artifacts: [],
      syncRuns: [],
      importBatchId: bundle.importBatchId,
      suppliedFileInventory: inventory.map((item) => ({
        relativePath: item.relativePath,
        sha256: item.sha256,
        size: item.size,
        mediaType: item.mediaType,
        status: item.status,
      })),
      detection,
    } as SyncManifest & ManualIngestionManifestExtras;
  }

  private resolveCanonicalIdentity(
    manifest: SyncManifest,
    source: SourceIdentity,
  ): ManualCanonicalIdentity {
    const nativeProjectId = manifest.projectId;
    const nativeSourceId = source.sourceId ?? manifest.sourceEnvironmentNamespace ?? 'manual';
    const nativeEnvironmentId = source.environmentId ?? manifest.environmentId ?? null;
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
      nativeSessionId: manifest.sessionId,
    };
  }

  private deterministicGenerationId(
    canonical: ManualCanonicalIdentity,
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

  private adjustForManual(result: TransformResult): TransformResult {
    const completeness: Record<string, ComponentCompleteness> = {};
    for (const [kind, value] of Object.entries(result.configurationSnapshot.completeness)) {
      if (value === 'complete') {
        completeness[kind] = 'partial';
      } else {
        completeness[kind] = value;
      }
    }

    return {
      ...result,
      configurationSnapshot: {
        ...result.configurationSnapshot,
        completeness,
        temporalRole: 'capture_only',
      },
    };
  }

  private rootSessionSummary(result: TransformResult): SessionSummary | undefined {
    return (
      result.sessionSummaries.find((s) => s.rootSessionId === s.sessionId) ??
      result.sessionSummaries[0]
    );
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
      issueIds: input.issues?.map((issue) => issue.code) ?? [],
    };
  }

  private failedReceipt(input: {
    generationId: string;
    sessionId: string;
    issues: readonly IngestionIssue[];
  }): IngestionReceipt {
    return {
      generationId: input.generationId,
      sessionId: input.sessionId,
      status: 'failed',
      analysisReleaseId: this.context.analysisReleaseId,
      issueIds: input.issues.map((issue) => issue.code),
    };
  }
}
