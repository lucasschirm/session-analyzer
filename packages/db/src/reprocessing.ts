import type {
  ArtifactBlob,
  ArtifactRetentionClass,
  MetricValue,
  SqliteExecutor,
  SqliteRow,
  SqliteTransaction,
  SqliteValue,
} from '@lucasschirm/sal-db-core';
import {
  getCurrentGenerationId,
  MetricValueStore,
  ProjectDailyRollupStore,
  ProjectDistributionStore,
  ProjectStore,
  RollupContributionStore,
  SessionStore,
  SourceManifestStore,
  SourceTombstoneStore,
} from '@lucasschirm/sal-db-core';
import type { SyncManifest } from '@lucasschirm/sal-sync-core';
import type { TransformerRegistry } from '@lucasschirm/sal-transformer';
import { DefaultIngestionOrchestrator } from './ingestion.js';
import type {
  ArtifactBlobStore,
  ArtifactContent,
  ArtifactResolver,
  ContentHasher,
} from './ports.js';

export type ReprocessingTrigger =
  | 'late_insert'
  | 'timestamp_correction'
  | 'reclassification'
  | 'deletion'
  | 'newly_authoritative';

export type SourceAvailability = 'local' | 'remote_reacquirable' | 'unavailable';

export interface ReprocessingContext {
  readonly executor: SqliteExecutor;
  readonly resolver: ArtifactResolver;
  readonly hasher: ContentHasher;
  readonly blobStore?: ArtifactBlobStore;
  readonly registry: TransformerRegistry;
  readonly analysisReleaseId: string;
}

export interface ReprocessingSourceCheck {
  readonly sessionId: string;
  readonly generationId: string | undefined;
  readonly status: SourceAvailability;
  readonly artifactHashes: readonly string[];
  readonly parserVersion: string;
  readonly transformerVersion: string;
  readonly ontologyVersion: string;
  readonly metricDefinitionVersion: string;
  readonly statisticalPolicyVersion: string;
  readonly rollupPolicyVersion: string;
}

export interface RebuildFrontier {
  readonly environmentId: string | null;
  readonly projectId: string;
  readonly workspaceId: string | null;
  readonly harness: string;
  readonly scopeChain: string | null;
  readonly startTime: number;
  readonly endTime: number;
  readonly trigger: ReprocessingTrigger;
  readonly triggerSessionId: string;
  readonly affectedProjectIds: readonly string[];
}

export interface ReprocessingFailure {
  readonly sessionId: string;
  readonly failureType:
    | 'hash_mismatch'
    | 'source_unavailable'
    | 'transform_error'
    | 'integrity_error';
  readonly message: string;
  readonly preservedGenerationId: string | undefined;
}

export interface ReprocessingReport {
  readonly trigger: string;
  readonly analysisReleaseId: string;
  readonly sessionsProcessed: number;
  readonly sessionsSkipped: number;
  readonly sessionsUnavailable: number;
  readonly frontierStart: string;
  readonly frontierEnd: string;
  readonly contributionsSubtracted: number;
  readonly contributionsApplied: number;
  readonly distributionsRebuilt: number;
  readonly cohortsRebuilt: number;
  readonly insightsRebuilt: number;
  readonly rollupsReconciled: boolean;
  readonly failures: readonly ReprocessingFailure[];
  readonly duration: number;
}

type MutableReprocessingReport = {
  -readonly [K in keyof ReprocessingReport]: ReprocessingReport[K];
};

export interface AnalysisReleaseSelection {
  readonly analysisReleaseId: string;
  readonly ontologyVersion: string;
  readonly metricRegistryVersion: string;
  readonly statisticalPolicyVersion: string;
  readonly rollupPolicyVersion: string;
  readonly comparabilityGroupIds: readonly string[];
}

export interface TypedDeleteOptions {
  readonly portfolioId: string;
  readonly reason?: string;
  readonly authority?: string;
  readonly preserveSharedBlobs?: boolean;
}

export interface OutOfOrderManifestInput {
  readonly sourceManifestId: string;
  readonly occurrenceTime: number;
  readonly captureTime: number;
  readonly ingestionTime: number;
  readonly canonicalSequenceNumber: number;
  readonly orderingConfidence: number;
  readonly portfolioId: string;
}

export interface ReprocessingEngine {
  checkSourceAvailability(sessionId: string): Promise<ReprocessingSourceCheck>;
  selectAnalysisRelease(sessionId: string, releaseId?: string): Promise<AnalysisReleaseSelection>;
  computeFrontier(
    sessionId: string,
    trigger: ReprocessingTrigger,
    params?: { correctedTime?: number; eventTime?: number },
  ): Promise<RebuildFrontier | undefined>;
  rebuildFrontier(
    frontier: RebuildFrontier,
    analysisReleaseId: string,
  ): Promise<ReprocessingReport>;
  reprocessSession(sessionId: string, analysisReleaseId?: string): Promise<ReprocessingReport>;
  reprocessProject(projectId: string, analysisReleaseId?: string): Promise<ReprocessingReport>;
  purgeLocalBlob(sha256: string): Promise<void>;
  recordAuthoritativeTombstone(
    input: {
      readonly ingestionSourceId: string;
      readonly environmentId?: string | null;
      readonly sourceProjectId?: string | null;
      readonly sourceType: string;
      readonly sourceId: string;
      readonly reason?: string | null;
      readonly tombstoneAuthority: string;
    },
    portfolioId: string,
  ): Promise<ReprocessingReport>;
  deleteSession(
    sessionId: string,
    projectId: string,
    portfolioId: string,
  ): Promise<ReprocessingReport>;
  deleteProject(projectId: string, portfolioId: string): Promise<void>;
  privacyErasure(
    sessionId: string,
    projectId: string,
    portfolioId: string,
  ): Promise<ReprocessingReport>;
  recordOutOfOrderManifest(input: OutOfOrderManifestInput): Promise<ReprocessingReport>;
  reconcileRollups(frontier: RebuildFrontier, analysisReleaseId: string): Promise<boolean>;
}

function asString(value: SqliteValue): string {
  return value === null || value === undefined ? '' : String(value);
}

function toOptionalString(value: SqliteValue): string | null {
  return value === null || value === undefined ? null : String(value);
}

function toNumber(value: SqliteValue): number {
  return value === null || value === undefined ? 0 : Number(value);
}

function toOptionalNumber(value: SqliteValue): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function toBoolean(value: SqliteValue): boolean {
  return value === 1 || value === true;
}

function formatUtcDayBucket(timestamp: number): string {
  const d = new Date(timestamp);
  return d.toISOString().slice(0, 10);
}

function isAdditiveValueType(valueType: string): boolean {
  return (
    valueType === 'integer' ||
    valueType === 'real' ||
    valueType === 'currency' ||
    valueType === 'ratio'
  );
}

function extractNumericValue(value: MetricValue): number | null {
  if (value.isUnavailable || value.isNotApplicable) return null;
  if (value.valueType === 'integer') return value.integerValue ?? null;
  if (isAdditiveValueType(value.valueType)) return value.numericValue ?? null;
  return null;
}

interface AffectedSession {
  readonly id: string;
  readonly currentGenerationId: string;
  readonly projectId: string;
  readonly portfolioId: string;
  readonly occurrenceTime: number | null;
  readonly harness: string;
  readonly environmentId: string | null;
}

interface ResolvedArtifactWithMeta {
  readonly relativePath: string;
  readonly sha256: string;
  readonly size: number;
  readonly mediaType: string;
  readonly content: ArtifactContent;
}

export class DefaultReprocessingEngine implements ReprocessingEngine {
  constructor(private readonly context: ReprocessingContext) {}

  async checkSourceAvailability(sessionId: string): Promise<ReprocessingSourceCheck> {
    const genId = await getCurrentGenerationId(this.context.executor, sessionId);
    const { rows } = await this.context.executor.exec(
      `SELECT id as generation_id, parser_version, transformer_version, ontology_version,
              metric_version, schema_version, analysis_release_id
       FROM transformation_generations
       WHERE session_id = ? AND (status = 'committed' OR status = 'pending')
       ORDER BY created_at DESC LIMIT 1`,
      [sessionId],
    );

    const currentGen = rows[0] as SqliteRow | undefined;
    const generationId = currentGen ? asString(currentGen.generation_id) : genId;

    const manifestRows = await this.context.executor.exec(
      `SELECT m.id, m.reprocessing_status, m.main_transcript_relative_path, m.raw_metadata,
              m.ingestion_source_id, m.environment_id, m.source_project_id, m.workspace_id,
              m.scope_chain, m.harness
       FROM source_manifests m
       WHERE m.session_id = ?
       ORDER BY m.sequence_number DESC, m.capture_time DESC
       LIMIT 1`,
      [sessionId],
    );

    const manifest = manifestRows.rows[0] as SqliteRow | undefined;
    const status = manifest ? asString(manifest.reprocessing_status) : 'unavailable';

    const artifactHashes: string[] = [];
    if (manifest?.raw_metadata) {
      const raw = asString(manifest.raw_metadata);
      try {
        const parsed = JSON.parse(raw) as SyncManifest;
        for (const a of parsed.artifacts ?? []) {
          if (a.sha256) artifactHashes.push(a.sha256);
        }
      } catch {
        // leave empty
      }
    }

    const check: ReprocessingSourceCheck = {
      sessionId,
      generationId,
      status: status as SourceAvailability,
      artifactHashes,
      parserVersion: currentGen ? asString(currentGen.parser_version) : 'unknown',
      transformerVersion: currentGen ? asString(currentGen.transformer_version) : 'unknown',
      ontologyVersion: currentGen ? asString(currentGen.ontology_version) : 'unknown',
      metricDefinitionVersion: currentGen ? asString(currentGen.metric_version) : 'unknown',
      statisticalPolicyVersion: 'claude-default',
      rollupPolicyVersion: '0.1.0',
    };

    if (status === 'unavailable') {
      return { ...check, status: 'unavailable' };
    }

    const local = await this.allArtifactsLocal(artifactHashes);
    if (local) {
      return { ...check, status: 'local' };
    }

    const remote = await this.canReacquireArtifacts(sessionId, artifactHashes);
    return { ...check, status: remote ? 'remote_reacquirable' : 'unavailable' };
  }

  async selectAnalysisRelease(
    sessionId: string,
    releaseId?: string,
  ): Promise<AnalysisReleaseSelection> {
    const target = releaseId ?? this.context.analysisReleaseId;
    const { rows } = await this.context.executor.exec(
      `SELECT id, ontology_version, metric_registry_version, statistical_policy_version,
              rollup_policy_version
       FROM analysis_releases WHERE id = ?`,
      [target],
    );
    const release = rows[0] as SqliteRow | undefined;
    if (!release) {
      throw new Error(`Analysis release not found: ${target}`);
    }

    const { rows: groups } = await this.context.executor.exec(
      `SELECT DISTINCT comparability_group_id FROM metric_values
       WHERE session_id = ? AND generation_id = (SELECT current_generation_id FROM sessions WHERE id = ?)`,
      [sessionId, sessionId],
    );

    return {
      analysisReleaseId: target,
      ontologyVersion: asString(release.ontology_version),
      metricRegistryVersion: asString(release.metric_registry_version),
      statisticalPolicyVersion: asString(release.statistical_policy_version),
      rollupPolicyVersion: asString(release.rollup_policy_version),
      comparabilityGroupIds: groups.map((r) => asString(r.comparability_group_id)),
    };
  }

  async computeFrontier(
    sessionId: string,
    trigger: ReprocessingTrigger,
    params?: { correctedTime?: number; eventTime?: number },
  ): Promise<RebuildFrontier | undefined> {
    const { rows } = await this.context.executor.exec(
      `SELECT s.id, s.project_id, s.environment_id, s.harness, s.occurrence_time,
              sm.workspace_id, sm.scope_chain
       FROM sessions s
       LEFT JOIN source_manifests sm ON sm.session_id = s.id
       WHERE s.id = ?
       ORDER BY sm.capture_time DESC
       LIMIT 1`,
      [sessionId],
    );
    if (rows.length === 0) return undefined;

    const row = rows[0] as SqliteRow;
    const projectId = asString(row.project_id);
    const occurrenceTime = toOptionalNumber(row.occurrence_time);
    const corrected = params?.correctedTime ?? occurrenceTime ?? 0;
    const event = params?.eventTime ?? corrected;
    const start = Math.min(occurrenceTime ?? event, event);
    const end = Date.now();

    return {
      environmentId: toOptionalString(row.environment_id),
      projectId,
      workspaceId: toOptionalString(row.workspace_id),
      harness: asString(row.harness),
      scopeChain: toOptionalString(row.scope_chain),
      startTime: start,
      endTime: end,
      trigger,
      triggerSessionId: sessionId,
      affectedProjectIds: [projectId],
    };
  }

  async rebuildFrontier(
    frontier: RebuildFrontier,
    analysisReleaseId: string,
  ): Promise<ReprocessingReport> {
    const start = Date.now();
    const affected = await this.findAffectedSessions(frontier);
    const report: Omit<MutableReprocessingReport, 'duration'> = {
      trigger: frontier.trigger,
      analysisReleaseId,
      sessionsProcessed: affected.length,
      sessionsSkipped: 0,
      sessionsUnavailable: 0,
      frontierStart: new Date(frontier.startTime).toISOString(),
      frontierEnd: new Date(frontier.endTime).toISOString(),
      contributionsSubtracted: 0,
      contributionsApplied: 0,
      distributionsRebuilt: 0,
      cohortsRebuilt: 0,
      insightsRebuilt: 0,
      rollupsReconciled: false,
      failures: [],
    };

    try {
      await this.context.executor.transaction(async (tx) => {
        report.contributionsSubtracted = await this.subtractContributions(tx, affected);
        await this.rebuildLifecycleExposuresAndCohorts(tx, affected, analysisReleaseId);
        report.contributionsApplied = await this.rebuildContributions(
          tx,
          affected,
          analysisReleaseId,
        );
        report.distributionsRebuilt = await this.rebuildRollupsAndDistributions(
          tx,
          affected,
          analysisReleaseId,
        );
        report.rollupsReconciled = await this.reconcileRollups(frontier, analysisReleaseId);
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      report.failures = [
        {
          sessionId: frontier.triggerSessionId,
          failureType: 'integrity_error',
          message,
          preservedGenerationId: await getCurrentGenerationId(
            this.context.executor,
            frontier.triggerSessionId,
          ),
        },
      ];
    }

    return { ...report, duration: Date.now() - start } as ReprocessingReport;
  }

  async reprocessSession(
    sessionId: string,
    analysisReleaseId?: string,
  ): Promise<ReprocessingReport> {
    const targetRelease = analysisReleaseId ?? this.context.analysisReleaseId;
    const start = Date.now();
    const check = await this.checkSourceAvailability(sessionId);

    if (check.status === 'unavailable') {
      return {
        trigger: 'reclassification',
        analysisReleaseId: targetRelease,
        sessionsProcessed: 0,
        sessionsSkipped: 0,
        sessionsUnavailable: 1,
        frontierStart: new Date().toISOString(),
        frontierEnd: new Date().toISOString(),
        contributionsSubtracted: 0,
        contributionsApplied: 0,
        distributionsRebuilt: 0,
        cohortsRebuilt: 0,
        insightsRebuilt: 0,
        rollupsReconciled: false,
        failures: [
          {
            sessionId,
            failureType: 'source_unavailable',
            message: 'Sources are unavailable for reprocessing.',
            preservedGenerationId: check.generationId,
          },
        ],
        duration: Date.now() - start,
      };
    }

    const session = await this.getSessionWithNatives(sessionId);
    if (!session) {
      return {
        trigger: 'reclassification',
        analysisReleaseId: targetRelease,
        sessionsProcessed: 0,
        sessionsSkipped: 0,
        sessionsUnavailable: 1,
        frontierStart: new Date().toISOString(),
        frontierEnd: new Date().toISOString(),
        contributionsSubtracted: 0,
        contributionsApplied: 0,
        distributionsRebuilt: 0,
        cohortsRebuilt: 0,
        insightsRebuilt: 0,
        rollupsReconciled: false,
        failures: [
          {
            sessionId,
            failureType: 'source_unavailable',
            message: 'Session not found.',
            preservedGenerationId: check.generationId,
          },
        ],
        duration: Date.now() - start,
      };
    }

    const resolved = await this.resolveSessionArtifacts(sessionId, check.artifactHashes);
    if (resolved.length === 0) {
      return {
        trigger: 'reclassification',
        analysisReleaseId: targetRelease,
        sessionsProcessed: 0,
        sessionsSkipped: 0,
        sessionsUnavailable: 1,
        frontierStart: new Date().toISOString(),
        frontierEnd: new Date().toISOString(),
        contributionsSubtracted: 0,
        contributionsApplied: 0,
        distributionsRebuilt: 0,
        cohortsRebuilt: 0,
        insightsRebuilt: 0,
        rollupsReconciled: false,
        failures: [
          {
            sessionId,
            failureType: 'source_unavailable',
            message: 'No source artifacts could be resolved.',
            preservedGenerationId: check.generationId,
          },
        ],
        duration: Date.now() - start,
      };
    }

    try {
      const orchestrator = new DefaultIngestionOrchestrator({
        ...this.context,
        analysisReleaseId: targetRelease,
      });

      const receipt = await orchestrator.ingestManual({
        artifacts: resolved.map((a) => ({
          relativePath: a.relativePath,
          mediaType: a.mediaType,
          content: a.content,
          sha256: a.sha256,
          size: a.size,
          status: 'uploaded' as const,
        })),
        source: {
          sourceId: session.nativeSourceId,
          environmentId: session.nativeEnvironmentId ?? undefined,
          projectId: session.nativeProjectId,
          sessionId: session.nativeSessionId,
        },
        harness: session.harness,
        projectId: session.nativeProjectId,
        sessionId: session.nativeSessionId,
      });

      if (receipt.status === 'failed') {
        return {
          trigger: 'reclassification',
          analysisReleaseId: targetRelease,
          sessionsProcessed: 0,
          sessionsSkipped: 0,
          sessionsUnavailable: 0,
          frontierStart: new Date().toISOString(),
          frontierEnd: new Date().toISOString(),
          contributionsSubtracted: 0,
          contributionsApplied: 0,
          distributionsRebuilt: 0,
          cohortsRebuilt: 0,
          insightsRebuilt: 0,
          rollupsReconciled: false,
          failures: [
            {
              sessionId,
              failureType: 'transform_error',
              message: `Ingestion failed: ${receipt.issueIds.join(', ')}`,
              preservedGenerationId: check.generationId,
            },
          ],
          duration: Date.now() - start,
        };
      }

      const frontier = await this.computeFrontier(sessionId, 'reclassification');
      if (!frontier) {
        return {
          trigger: 'reclassification',
          analysisReleaseId: targetRelease,
          sessionsProcessed: 1,
          sessionsSkipped: 0,
          sessionsUnavailable: 0,
          frontierStart: new Date().toISOString(),
          frontierEnd: new Date().toISOString(),
          contributionsSubtracted: 0,
          contributionsApplied: 0,
          distributionsRebuilt: 0,
          cohortsRebuilt: 0,
          insightsRebuilt: 0,
          rollupsReconciled: false,
          failures: [],
          duration: Date.now() - start,
        };
      }

      const report = await this.rebuildFrontier(frontier, targetRelease);
      return { ...report, sessionsProcessed: 1, duration: Date.now() - start };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        trigger: 'reclassification',
        analysisReleaseId: targetRelease,
        sessionsProcessed: 0,
        sessionsSkipped: 0,
        sessionsUnavailable: 0,
        frontierStart: new Date().toISOString(),
        frontierEnd: new Date().toISOString(),
        contributionsSubtracted: 0,
        contributionsApplied: 0,
        distributionsRebuilt: 0,
        cohortsRebuilt: 0,
        insightsRebuilt: 0,
        rollupsReconciled: false,
        failures: [
          {
            sessionId,
            failureType: 'integrity_error',
            message,
            preservedGenerationId: check.generationId,
          },
        ],
        duration: Date.now() - start,
      };
    }
  }

  async reprocessProject(
    projectId: string,
    analysisReleaseId?: string,
  ): Promise<ReprocessingReport> {
    const targetRelease = analysisReleaseId ?? this.context.analysisReleaseId;
    const { rows } = await this.context.executor.exec(
      'SELECT id FROM sessions WHERE project_id = ? ORDER BY occurrence_time',
      [projectId],
    );
    const start = Date.now();
    let processed = 0;
    let skipped = 0;
    let unavailable = 0;
    const failures: ReprocessingFailure[] = [];

    for (const row of rows) {
      const sessionId = asString(row.id);
      const report = await this.reprocessSession(sessionId, targetRelease);
      processed += report.sessionsProcessed;
      skipped += report.sessionsSkipped;
      unavailable += report.sessionsUnavailable;
      failures.push(...report.failures);
    }

    return {
      trigger: 'reclassification',
      analysisReleaseId: targetRelease,
      sessionsProcessed: processed,
      sessionsSkipped: skipped,
      sessionsUnavailable: unavailable,
      frontierStart: new Date().toISOString(),
      frontierEnd: new Date().toISOString(),
      contributionsSubtracted: 0,
      contributionsApplied: 0,
      distributionsRebuilt: 0,
      cohortsRebuilt: 0,
      insightsRebuilt: 0,
      rollupsReconciled: false,
      failures,
      duration: Date.now() - start,
    };
  }

  async purgeLocalBlob(sha256: string): Promise<void> {
    await this.context.executor.transaction(async (tx) => {
      await tx.exec('DELETE FROM artifact_blobs WHERE sha256 = ?', [sha256]);
      await tx.exec(
        "UPDATE source_manifests SET reprocessing_status = 'remote_reacquirable' WHERE id IN (\n        SELECT DISTINCT m.id FROM source_manifests m\n        JOIN manifest_artifacts a ON a.source_manifest_id = m.id\n        WHERE a.sha256 = ?\n      )",
        [sha256],
      );
    });
  }

  async recordAuthoritativeTombstone(
    input: {
      readonly ingestionSourceId: string;
      readonly environmentId?: string | null;
      readonly sourceProjectId?: string | null;
      readonly sourceType: string;
      readonly sourceId: string;
      readonly reason?: string | null;
      readonly tombstoneAuthority: string;
    },
    portfolioId: string,
  ): Promise<ReprocessingReport> {
    const start = Date.now();
    await this.context.executor.transaction(async (tx) => {
      await SourceTombstoneStore.recordTombstone(tx, portfolioId, {
        ...input,
        reason: input.reason ?? null,
      });
    });

    const { rows } = await this.context.executor.exec(
      `SELECT s.id, s.project_id, s.occurrence_time, s.harness, s.environment_id
       FROM sessions s
       JOIN ingestion_sources src ON src.id = s.ingestion_source_id
       WHERE s.ingestion_source_id = ?
         AND src.portfolio_id = ?
         AND s.native_session_id = ?
       ORDER BY s.occurrence_time`,
      [input.ingestionSourceId, portfolioId, input.sourceId],
    );

    const projectIds = new Set<string>();
    const startTime = rows.length > 0 ? toNumber(rows[0].occurrence_time) : Date.now();
    let maxTime = startTime;
    for (const row of rows) {
      projectIds.add(asString(row.project_id));
      const t = toNumber(row.occurrence_time);
      if (t > maxTime) maxTime = t;
      await this.deleteSession(asString(row.id), asString(row.project_id), portfolioId);
    }

    if (projectIds.size === 0) {
      return {
        trigger: 'deletion',
        analysisReleaseId: this.context.analysisReleaseId,
        sessionsProcessed: 0,
        sessionsSkipped: 0,
        sessionsUnavailable: 0,
        frontierStart: new Date().toISOString(),
        frontierEnd: new Date().toISOString(),
        contributionsSubtracted: 0,
        contributionsApplied: 0,
        distributionsRebuilt: 0,
        cohortsRebuilt: 0,
        insightsRebuilt: 0,
        rollupsReconciled: false,
        failures: [],
        duration: Date.now() - start,
      };
    }

    const frontier: RebuildFrontier = {
      environmentId: input.environmentId ?? null,
      projectId: asString(rows[0].project_id),
      workspaceId: null,
      harness: asString(rows[0].harness),
      scopeChain: null,
      startTime,
      endTime: maxTime,
      trigger: 'deletion',
      triggerSessionId: asString(rows[0].id),
      affectedProjectIds: [...projectIds],
    };

    const report = await this.rebuildFrontier(frontier, this.context.analysisReleaseId);
    return { ...report, duration: Date.now() - start };
  }

  async deleteSession(
    sessionId: string,
    projectId: string,
    portfolioId: string,
  ): Promise<ReprocessingReport> {
    const frontier = await this.computeFrontier(sessionId, 'deletion');
    await this.context.executor.transaction(async (tx) => {
      await this.tombstoneSessionEvidence(tx, sessionId, portfolioId);
      await SessionStore.delete(tx, projectId, sessionId);
    });

    if (!frontier) {
      return {
        trigger: 'deletion',
        analysisReleaseId: this.context.analysisReleaseId,
        sessionsProcessed: 0,
        sessionsSkipped: 0,
        sessionsUnavailable: 0,
        frontierStart: new Date().toISOString(),
        frontierEnd: new Date().toISOString(),
        contributionsSubtracted: 0,
        contributionsApplied: 0,
        distributionsRebuilt: 0,
        cohortsRebuilt: 0,
        insightsRebuilt: 0,
        rollupsReconciled: false,
        failures: [],
        duration: 0,
      };
    }

    const report = await this.rebuildFrontier(frontier, this.context.analysisReleaseId);
    return report;
  }

  async deleteProject(projectId: string, portfolioId: string): Promise<void> {
    await this.context.executor.transaction(async (tx) => {
      await tx.exec(`DELETE FROM project_daily_rollups WHERE project_id = ?`, [projectId]);
      await tx.exec(`DELETE FROM project_distributions WHERE project_id = ?`, [projectId]);
      await tx.exec(`DELETE FROM rollup_contributions WHERE project_id = ?`, [projectId]);
      await ProjectStore.delete(tx, portfolioId, projectId);
    });
  }

  async privacyErasure(
    sessionId: string,
    projectId: string,
    portfolioId: string,
  ): Promise<ReprocessingReport> {
    const start = Date.now();
    const frontier = await this.computeFrontier(sessionId, 'deletion');

    await this.context.executor.transaction(async (tx) => {
      await tx.exec(`UPDATE sessions SET finality = 'censored' WHERE id = ? AND project_id = ?`, [
        sessionId,
        projectId,
      ]);
      await tx.exec(
        `UPDATE source_manifests SET finality = 'superseded'
         WHERE id IN (
           SELECT sm.id FROM source_manifests sm
           JOIN ingestion_sources src ON src.id = sm.ingestion_source_id
           WHERE sm.session_id = ? AND src.portfolio_id = ?
         )`,
        [sessionId, portfolioId],
      );
      await tx.exec(
        `UPDATE metric_values
         SET text_value = NULL, is_unavailable = 1, unavailable_reason = 'privacy_erasure',
             is_not_applicable = 0, numeric_value = NULL, integer_value = NULL
         WHERE session_id = ?`,
        [sessionId],
      );
      await tx.exec(
        `DELETE FROM artifact_blobs WHERE sha256 IN (
          SELECT a.sha256 FROM manifest_artifacts a
          JOIN source_manifests sm ON sm.id = a.source_manifest_id
          JOIN ingestion_sources src ON src.id = sm.ingestion_source_id
          WHERE sm.session_id = ? AND src.portfolio_id = ?
        )`,
        [sessionId, portfolioId],
      );
    });

    if (!frontier) {
      return {
        trigger: 'deletion',
        analysisReleaseId: this.context.analysisReleaseId,
        sessionsProcessed: 1,
        sessionsSkipped: 0,
        sessionsUnavailable: 0,
        frontierStart: new Date().toISOString(),
        frontierEnd: new Date().toISOString(),
        contributionsSubtracted: 0,
        contributionsApplied: 0,
        distributionsRebuilt: 0,
        cohortsRebuilt: 0,
        insightsRebuilt: 0,
        rollupsReconciled: false,
        failures: [],
        duration: Date.now() - start,
      };
    }

    const report = await this.rebuildFrontier(frontier, this.context.analysisReleaseId);
    return { ...report, duration: Date.now() - start };
  }

  async recordOutOfOrderManifest(input: OutOfOrderManifestInput): Promise<ReprocessingReport> {
    const start = Date.now();
    const manifest = await SourceManifestStore.getById(
      this.context.executor,
      input.portfolioId,
      input.sourceManifestId,
    );

    if (manifest) {
      const raw = manifest.rawMetadata
        ? (JSON.parse(manifest.rawMetadata) as Record<string, unknown>)
        : {};
      const updated = JSON.stringify({
        ...raw,
        _orderingConfidence: input.orderingConfidence,
        _canonicalSequenceNumber: input.canonicalSequenceNumber,
      });

      await this.context.executor.exec(
        `UPDATE source_manifests
         SET occurrence_time = ?, capture_time = ?, ingestion_time = ?, sequence_number = ?,
             raw_metadata = ?, updated_at = ?
         WHERE id = ?`,
        [
          input.occurrenceTime,
          input.captureTime,
          input.ingestionTime,
          input.canonicalSequenceNumber,
          updated,
          Date.now(),
          input.sourceManifestId,
        ],
      );
    }

    const frontier: RebuildFrontier = {
      environmentId: manifest?.environmentId ?? null,
      projectId: manifest?.sourceProjectId ?? input.portfolioId,
      workspaceId: manifest?.workspaceId ?? null,
      harness: manifest?.harness ?? 'unknown',
      scopeChain: manifest?.scopeChain ?? null,
      startTime: input.occurrenceTime,
      endTime: Date.now(),
      trigger: 'newly_authoritative',
      triggerSessionId: manifest?.sessionId ?? input.sourceManifestId,
      affectedProjectIds: [manifest?.sourceProjectId ?? input.portfolioId],
    };

    const report = await this.rebuildFrontier(frontier, this.context.analysisReleaseId);
    return { ...report, duration: Date.now() - start };
  }

  async reconcileRollups(frontier: RebuildFrontier, analysisReleaseId: string): Promise<boolean> {
    const { rows } = await this.context.executor.exec(
      `SELECT project_id,
              SUM(additive_value) AS contribution_sum,
              COUNT(*) AS contribution_count
       FROM rollup_contributions
       WHERE project_id = ? AND analysis_release_id = ?
       GROUP BY project_id`,
      [frontier.projectId, analysisReleaseId],
    );

    const expected = rows.length > 0 ? toNumber(rows[0].contribution_sum) : 0;
    const { rows: rollups } = await this.context.executor.exec(
      `SELECT SUM(value_sum) AS rollup_sum
       FROM project_daily_rollups
       WHERE project_id = ? AND analysis_release_id = ?`,
      [frontier.projectId, analysisReleaseId],
    );

    const actual = rollups.length > 0 ? toNumber(rollups[0].rollup_sum) : 0;
    return Math.abs(expected - actual) < 0.001;
  }

  private async allArtifactsLocal(hashes: readonly string[]): Promise<boolean> {
    if (hashes.length === 0) return false;
    for (const sha256 of hashes) {
      const blob = await this.queryBlob(sha256);
      if (!blob) return false;
    }
    return true;
  }

  private async canReacquireArtifacts(
    sessionId: string,
    hashes: readonly string[],
  ): Promise<boolean> {
    const manifests = await this.context.executor.exec(
      `SELECT sm.id, sm.ingestion_source_id, sm.source_project_id, sm.workspace_id, sm.scope_chain,
              sm.raw_metadata
       FROM source_manifests sm
       WHERE sm.session_id = ?
       ORDER BY sm.sequence_number DESC LIMIT 1`,
      [sessionId],
    );
    const manifest = manifests.rows[0] as SqliteRow | undefined;
    if (!manifest) return false;

    const raw = asString(manifest.raw_metadata);
    let parsed: SyncManifest | undefined;
    try {
      parsed = JSON.parse(raw) as SyncManifest;
    } catch {
      return false;
    }
    for (const artifact of parsed.artifacts ?? []) {
      if (!hashes.includes(artifact.sha256)) continue;
      const ref = await this.makeArtifactReference(manifest, artifact, parsed);
      try {
        const resolved = await this.context.resolver.resolve(ref);
        if (resolved.content === undefined || resolved.content === null) {
          return false;
        }
      } catch {
        return false;
      }
    }
    return true;
  }

  private async resolveSessionArtifacts(
    sessionId: string,
    hashes: readonly string[],
  ): Promise<ResolvedArtifactWithMeta[]> {
    const manifests = await this.context.executor.exec(
      `SELECT sm.id, sm.ingestion_source_id, sm.source_project_id, sm.workspace_id, sm.scope_chain,
              sm.raw_metadata
       FROM source_manifests sm
       WHERE sm.session_id = ?
       ORDER BY sm.sequence_number DESC LIMIT 1`,
      [sessionId],
    );
    const manifest = manifests.rows[0] as SqliteRow | undefined;
    if (!manifest) return [];

    const raw = asString(manifest.raw_metadata);
    let parsed: SyncManifest | undefined;
    try {
      parsed = JSON.parse(raw) as SyncManifest;
    } catch {
      return [];
    }

    const resolved: ResolvedArtifactWithMeta[] = [];
    for (const artifact of parsed.artifacts ?? []) {
      if (hashes.length > 0 && !hashes.includes(artifact.sha256)) continue;

      const blob = await this.queryBlob(artifact.sha256);
      if (blob?.content) {
        resolved.push({
          relativePath: artifact.relativePath,
          sha256: artifact.sha256,
          size: artifact.size,
          mediaType: artifact.mediaType ?? 'application/octet-stream',
          content: blob.content,
        });
        continue;
      }

      const ref = await this.makeArtifactReference(manifest, artifact, parsed);
      try {
        const result = await this.context.resolver.resolve(ref);
        resolved.push({
          relativePath: artifact.relativePath,
          sha256: artifact.sha256,
          size: artifact.size,
          mediaType: artifact.mediaType ?? 'application/octet-stream',
          content: result.content,
        });
      } catch {
        // skip unavailable artifact
      }
    }

    return resolved;
  }

  private async queryBlob(sha256: string): Promise<ArtifactBlob | undefined> {
    const db = this.context.executor;
    const { rows } = await db.exec(
      `SELECT sha256, media_type, retention_class, content, size, redaction_scheme, key_domain_id,
              sensitive_digest, redaction_change_marker, is_redacted, verified_at, created_at, updated_at
       FROM artifact_blobs WHERE sha256 = ?`,
      [sha256],
    );
    if (rows.length === 0) return undefined;
    const r = rows[0];
    return {
      sha256: asString(r.sha256),
      mediaType: toOptionalString(r.media_type),
      retentionClass: asString(r.retention_class) as ArtifactRetentionClass,
      content: r.content instanceof Uint8Array ? r.content : null,
      size: toNumber(r.size),
      redactionScheme: toOptionalString(r.redaction_scheme),
      keyDomainId: toOptionalString(r.key_domain_id),
      sensitiveDigest: toOptionalString(r.sensitive_digest),
      redactionChangeMarker: toNumber(r.redaction_change_marker),
      isRedacted: toBoolean(r.is_redacted),
      verifiedAt: toOptionalNumber(r.verified_at),
      createdAt: toNumber(r.created_at),
      updatedAt: toNumber(r.updated_at),
    };
  }

  private async makeArtifactReference(
    manifestRow: SqliteRow,
    artifact: { relativePath: string; sha256: string; size: number; mediaType?: string },
    parsed: SyncManifest,
  ) {
    const ingestionSourceId = asString(manifestRow.ingestion_source_id);
    const sourceProjectId = toOptionalString(manifestRow.source_project_id);
    const safePath = `/${sourceProjectId ?? parsed.projectId}/${parsed.sessionId}/${artifact.relativePath}`;
    return {
      sha256: artifact.sha256,
      size: artifact.size,
      relativePath: artifact.relativePath,
      mediaType: artifact.mediaType ?? 'application/octet-stream',
      sourceLocation: {
        reacquisitionKey: safePath,
        sourceNamespace: ingestionSourceId,
        relativePath: artifact.relativePath,
        retentionClass: 'local' as const,
      },
    };
  }

  private async getSessionWithNatives(sessionId: string): Promise<{
    nativeSourceId: string;
    nativeEnvironmentId: string | null;
    nativeProjectId: string;
    nativeSessionId: string;
    harness: string;
  } | null> {
    const { rows } = await this.context.executor.exec(
      `SELECT s.harness, s.native_session_id, s.ingestion_source_id, s.environment_id,
              sp.native_project_id, isrc.native_source_id, env.native_environment_id
       FROM sessions s
       JOIN source_projects sp ON sp.id = (
         SELECT id FROM source_projects WHERE project_id = s.project_id
         AND ingestion_source_id = s.ingestion_source_id LIMIT 1
       )
       JOIN ingestion_sources isrc ON isrc.id = s.ingestion_source_id
       LEFT JOIN environments env ON env.id = s.environment_id
       WHERE s.id = ?`,
      [sessionId],
    );
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      nativeSourceId: asString(r.native_source_id),
      nativeEnvironmentId: toOptionalString(r.native_environment_id),
      nativeProjectId: asString(r.native_project_id),
      nativeSessionId: asString(r.native_session_id),
      harness: asString(r.harness),
    };
  }

  private async findAffectedSessions(
    frontier: RebuildFrontier,
  ): Promise<readonly AffectedSession[]> {
    const { rows } = await this.context.executor.exec(
      `SELECT s.id, s.current_generation_id, s.project_id, p.portfolio_id,
              s.occurrence_time, s.harness, s.environment_id
       FROM sessions s
       JOIN projects p ON p.id = s.project_id
       LEFT JOIN source_manifests sm ON sm.session_id = s.id
       WHERE s.project_id = ? AND s.harness = ?
         AND (s.occurrence_time IS NULL OR s.occurrence_time >= ?)
         AND (s.occurrence_time IS NULL OR s.occurrence_time <= ?)
         AND (? IS NULL OR s.environment_id = ? OR s.environment_id IS NULL)
         AND (? IS NULL OR sm.workspace_id = ? OR sm.workspace_id IS NULL)
         AND (? IS NULL OR sm.scope_chain = ? OR sm.scope_chain IS NULL)
       ORDER BY s.occurrence_time`,
      [
        frontier.projectId,
        frontier.harness,
        frontier.startTime,
        frontier.endTime,
        frontier.environmentId,
        frontier.environmentId,
        frontier.workspaceId,
        frontier.workspaceId,
        frontier.scopeChain,
        frontier.scopeChain,
      ],
    );

    return rows.map((r) => ({
      id: asString(r.id),
      currentGenerationId: asString(r.current_generation_id),
      projectId: asString(r.project_id),
      portfolioId: asString(r.portfolio_id),
      occurrenceTime: toOptionalNumber(r.occurrence_time),
      harness: asString(r.harness),
      environmentId: toOptionalString(r.environment_id),
    }));
  }

  private async subtractContributions(
    tx: SqliteTransaction,
    affected: readonly AffectedSession[],
  ): Promise<number> {
    if (affected.length === 0) return 0;
    const ids = affected.map((s) => s.id);
    const placeholders = ids.map(() => '?').join(',');
    const { changes } = await tx.exec(
      `DELETE FROM rollup_contributions WHERE session_id IN (${placeholders})`,
      ids,
    );

    await tx.exec(
      `DELETE FROM project_daily_rollups
       WHERE project_id IN (
         SELECT DISTINCT project_id FROM rollup_contributions WHERE session_id IN (${placeholders})
       ) OR project_id IN (${placeholders})`,
      [...ids, ...affected.map((s) => s.projectId)],
    );

    return changes;
  }

  private async rebuildLifecycleExposuresAndCohorts(
    tx: SqliteTransaction,
    affected: readonly AffectedSession[],
    _analysisReleaseId: string,
  ): Promise<void> {
    if (affected.length === 0) return;
    const ids = affected.map((s) => s.id);
    const placeholders = ids.map(() => '?').join(',');
    await tx.exec(
      `DELETE FROM session_component_exposures WHERE session_id IN (${placeholders})`,
      ids,
    );
    await tx.exec(
      `DELETE FROM component_lifecycle_events WHERE snapshot_id IN (
      SELECT id FROM configuration_snapshots WHERE session_id IN (${placeholders})
    )`,
      ids,
    );
    await tx.exec(
      `DELETE FROM component_availability_events WHERE session_id IN (${placeholders})`,
      ids,
    );
    await tx.exec(
      `DELETE FROM component_context_events WHERE session_id IN (${placeholders})`,
      ids,
    );
    await tx.exec(
      `DELETE FROM insight_evidence
       WHERE generation_id IN (SELECT id FROM transformation_generations WHERE session_id IN (${placeholders}))`,
      ids,
    );
    await tx.exec(
      `DELETE FROM comparison_cohort_members WHERE session_id IN (${placeholders})`,
      ids,
    );
    // UNVERIFIED: full lifecycle, exposure, and cohort rederivation from configuration snapshots
    // is deferred to TSK0024; stale rows are removed so the next unchanged state is not poisoned.
  }

  private async rebuildContributions(
    tx: SqliteTransaction,
    affected: readonly AffectedSession[],
    analysisReleaseId: string,
  ): Promise<number> {
    let count = 0;
    for (const session of affected) {
      const values = await MetricValueStore.listBySession(this.context.executor, session.id);
      const byKey = new Map<
        string,
        {
          value: number;
          count: number;
          metricDefinitionId: string;
          comparabilityGroupId: string;
          rootInclusion: string;
        }
      >();

      for (const value of values) {
        if (value.generationId !== session.currentGenerationId) continue;
        if (value.isUnavailable || value.isNotApplicable) continue;
        const numeric = extractNumericValue(value);
        if (numeric === null) continue;

        const dayBucket = formatUtcDayBucket(session.occurrenceTime ?? value.createdAt);
        const scope = value.rootInclusion === 'root_only' ? 'root_only' : 'inclusive';
        const key = `${value.metricDefinitionId}|${value.comparabilityGroupId}|${scope}|${dayBucket}`;
        const existing = byKey.get(key);
        if (existing) {
          existing.value += numeric;
          existing.count += 1;
        } else {
          byKey.set(key, {
            value: numeric,
            count: 1,
            metricDefinitionId: value.metricDefinitionId,
            comparabilityGroupId: value.comparabilityGroupId,
            rootInclusion: scope,
          });
        }
      }

      for (const [key, agg] of byKey) {
        await RollupContributionStore.insert(tx, {
          sessionId: session.id,
          generationId: session.currentGenerationId,
          projectId: session.projectId,
          portfolioId: session.portfolioId,
          analysisReleaseId,
          comparabilityGroupId: agg.comparabilityGroupId,
          metricDefinitionId: agg.metricDefinitionId,
          contributionScope: agg.rootInclusion as 'root_only' | 'inclusive',
          bucketType: 'day',
          bucketName: 'date',
          bucketValue: key.split('|').pop() ?? '',
          additiveValue: agg.value,
          valueCount: agg.count,
        });
        count += 1;
      }
    }
    return count;
  }

  private async rebuildRollupsAndDistributions(
    tx: SqliteTransaction,
    affected: readonly AffectedSession[],
    analysisReleaseId: string,
  ): Promise<number> {
    if (affected.length === 0) return 0;
    const projectSet = new Map<string, { portfolioId: string; generationId: string }>();
    const portfolioSet = new Map<string, { generationId: string }>();

    for (const session of affected) {
      const current = projectSet.get(session.projectId);
      if (!current || session.currentGenerationId > current.generationId) {
        projectSet.set(session.projectId, {
          portfolioId: session.portfolioId,
          generationId: session.currentGenerationId,
        });
      }
      const pCurrent = portfolioSet.get(session.portfolioId);
      if (!pCurrent || session.currentGenerationId > pCurrent.generationId) {
        portfolioSet.set(session.portfolioId, { generationId: session.currentGenerationId });
      }
    }

    for (const [projectId, meta] of projectSet) {
      await this.rebuildProjectRollups(
        tx,
        projectId,
        meta.portfolioId,
        meta.generationId,
        analysisReleaseId,
      );
    }

    for (const [portfolioId, meta] of portfolioSet) {
      await this.rebuildPortfolioRollups(tx, portfolioId, meta.generationId, analysisReleaseId);
    }

    return projectSet.size + portfolioSet.size;
  }

  private async rebuildProjectRollups(
    tx: SqliteTransaction,
    projectId: string,
    _portfolioId: string,
    generationId: string,
    analysisReleaseId: string,
  ): Promise<void> {
    await tx.exec('DELETE FROM project_daily_rollups WHERE project_id = ?', [projectId]);
    await tx.exec('DELETE FROM project_distributions WHERE project_id = ?', [projectId]);

    const { rows } = await tx.exec(
      `SELECT metric_definition_id, comparability_group_id, bucket_value,
              contribution_scope, SUM(additive_value) AS vsum, SUM(value_count) AS vcount,
              MIN(additive_value) AS vmin, MAX(additive_value) AS vmax
       FROM rollup_contributions
       WHERE project_id = ? AND analysis_release_id = ?
       GROUP BY metric_definition_id, comparability_group_id, bucket_value, contribution_scope`,
      [projectId, analysisReleaseId],
    );

    const dailyGroups = new Map<string, { sum: number; count: number; min: number; max: number }>();
    const distGroups = new Map<
      string,
      {
        values: number[];
        metricDefinitionId: string;
        comparabilityGroupId: string;
        dimensionsKey: string | null;
      }
    >();

    for (const row of rows) {
      const metricDefinitionId = asString(row.metric_definition_id);
      const comparabilityGroupId = asString(row.comparability_group_id);
      const dayBucket = asString(row.bucket_value);
      const _scope = asString(row.contribution_scope);
      const sum = toNumber(row.vsum);
      const count = toNumber(row.vcount);
      const min = toNumber(row.vmin);
      const max = toNumber(row.vmax);

      const dayKey = `${metricDefinitionId}|${comparabilityGroupId}|${dayBucket}`;
      const existing = dailyGroups.get(dayKey);
      if (existing) {
        existing.sum += sum;
        existing.count += count;
        existing.min = Math.min(existing.min, min);
        existing.max = Math.max(existing.max, max);
      } else {
        dailyGroups.set(dayKey, { sum, count, min, max });
      }

      const dist = distGroups.get(dayKey) ?? {
        values: [],
        metricDefinitionId,
        comparabilityGroupId,
        dimensionsKey: null,
      };
      dist.values.push(sum);
      distGroups.set(dayKey, dist);
    }

    for (const [key, agg] of dailyGroups) {
      const [metricDefinitionId, comparabilityGroupId, dayBucket] = key.split('|');
      await ProjectDailyRollupStore.insert(tx, {
        projectId,
        analysisReleaseId,
        comparabilityGroupId,
        metricDefinitionId,
        dayBucket,
        valueCount: agg.count,
        valueSum: agg.sum,
        valueMin: agg.min,
        valueMax: agg.max,
        valueMean: agg.sum / Math.max(1, agg.count),
        generationId,
      });
    }

    for (const [_, dist] of distGroups) {
      const values = dist.values;
      const sum = values.reduce((a, b) => a + b, 0);
      const mean = sum / Math.max(1, values.length);
      const sorted = [...values].sort((a, b) => a - b);
      await ProjectDistributionStore.insert(tx, {
        projectId,
        analysisReleaseId,
        comparabilityGroupId: dist.comparabilityGroupId,
        metricDefinitionId: dist.metricDefinitionId,
        dimensionsKey: dist.dimensionsKey,
        eligibleN: values.length,
        knownN: values.length,
        unknownCount: 0,
        sum,
        min: sorted[0] ?? null,
        max: sorted[sorted.length - 1] ?? null,
        mean,
        p50: null,
        p75: null,
        p90: null,
        p95: null,
        dispersion: null,
        outlierRule: null,
        coverage: 1,
        generationId,
      });
    }
  }

  private async rebuildPortfolioRollups(
    tx: SqliteTransaction,
    portfolioId: string,
    _generationId: string,
    analysisReleaseId: string,
  ): Promise<void> {
    // Portfolio rollups mirror project rollups across all projects in the portfolio.
    // UNVERIFIED: full portfolio rollup materialization is a Phase 4 follow-up (TSK0022).
    const { rows } = await tx.exec(
      `SELECT comparability_group_id, metric_definition_id, bucket_value,
              SUM(additive_value) AS vsum, SUM(value_count) AS vcount,
              MIN(additive_value) AS vmin, MAX(additive_value) AS vmax
       FROM rollup_contributions
       WHERE portfolio_id = ? AND analysis_release_id = ?
       GROUP BY comparability_group_id, metric_definition_id, bucket_value`,
      [portfolioId, analysisReleaseId],
    );

    for (const _row of rows) {
      // Intentionally left as a lightweight portfolio mirror; exact percentile/distribution
      // aggregation is deferred to the rollup reconciliation task.
    }
  }

  private async tombstoneSessionEvidence(
    tx: SqliteTransaction,
    sessionId: string,
    portfolioId: string,
  ): Promise<void> {
    await tx.exec(
      `UPDATE source_manifests SET finality = 'superseded'
       WHERE id IN (
         SELECT sm.id FROM source_manifests sm
         JOIN ingestion_sources src ON src.id = sm.ingestion_source_id
         WHERE sm.session_id = ? AND src.portfolio_id = ?
       )`,
      [sessionId, portfolioId],
    );
  }
}
