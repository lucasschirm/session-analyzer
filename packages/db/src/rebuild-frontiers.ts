import type {
  ReassignmentHooks,
  SqliteExecutor,
  SqliteRow,
  SqliteTransaction,
  SqliteValue,
} from '@lucasschirm/sal-db-core';
import {
  ComparisonCohortMemberStore,
  ComponentAvailabilityEventStore,
  ComponentContextEventStore,
  ComponentLifecycleEventStore,
  deterministicId,
  ProjectMappingStore,
  SessionComponentExposureStore,
} from '@lucasschirm/sal-db-core';
import {
  buildObservedBeforeAfterCohort,
  rebuildAffectedDistributions,
  rebuildPortfolioDistributions,
  rebuildProjectDistributions,
  recordInsightEvidence,
} from './distributions.js';
import type { RebuildFrontier, ReprocessingFailure } from './reprocessing.js';
import {
  applySessionRollupContributions,
  isRollupReconciled,
  rebuildProjectPortfolioRollups,
  reconcileRollupTotals,
} from './rollup-reconciliation.js';

type Queryable = SqliteExecutor | SqliteTransaction;

type ReprocessingTrigger =
  | 'late_insert'
  | 'timestamp_correction'
  | 'reclassification'
  | 'deletion'
  | 'newly_authoritative';

const DEFAULT_BUDGET: RebuildFrontierBudget = {
  maxAffectedSessions: 100,
  maxAffectedSnapshots: 500,
  maxDurationMillis: 5_000,
};

const REBUILD_MAINTENANCE_JOBS_DDL = `
CREATE TABLE IF NOT EXISTS rebuild_maintenance_jobs (
  id TEXT PRIMARY KEY,
  frontier_json TEXT NOT NULL,
  analysis_release_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  last_snapshot_id TEXT,
  next_start_time INTEGER,
  processed_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  total_cost_json TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE INDEX IF NOT EXISTS idx_rebuild_maintenance_jobs_status
  ON rebuild_maintenance_jobs(status);

CREATE INDEX IF NOT EXISTS idx_rebuild_maintenance_jobs_release
  ON rebuild_maintenance_jobs(analysis_release_id);
`;

export interface RebuildFrontierBudget {
  readonly maxAffectedSessions: number;
  readonly maxAffectedSnapshots: number;
  readonly maxDurationMillis: number;
}

export interface RebuildFrontierCost {
  readonly affectedSessions: number;
  readonly affectedSnapshots: number;
  readonly affectedMetricValues: number;
  readonly estimatedMillis: number;
}

export interface RebuildFrontierReport {
  readonly trigger: ReprocessingTrigger;
  readonly analysisReleaseId: string;
  readonly sessionsProcessed: number;
  readonly sessionsSkipped: number;
  readonly sessionsUnavailable: number;
  readonly snapshotsProcessed: number;
  readonly snapshotsUnchanged: number;
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
  readonly queued?: boolean;
  readonly jobId?: string;
  readonly cost: RebuildFrontierCost;
}

type MutableRebuildFrontierReport = {
  -readonly [K in keyof RebuildFrontierReport]: RebuildFrontierReport[K];
};

interface FrontierScope {
  environmentId: string | null;
  projectId: string;
  workspaceId: string | null;
  harness: string;
  scopeChain: string | null;
}

interface AffectedSession {
  id: string;
  currentGenerationId: string;
  projectId: string;
  portfolioId: string;
  occurrenceTime: number | null;
  harness: string;
  environmentId: string | null;
  finality: string;
}

interface SnapshotInScope {
  id: string;
  sessionId: string | null;
  generationId: string | null;
  ordering: number;
  captureTime: number;
  temporalRole: string;
  createdAt: number;
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

function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(',');
}

export interface RebuildFrontierEngineOptions {
  readonly executor: SqliteExecutor;
  readonly budget?: RebuildFrontierBudget;
}

export class RebuildFrontierEngine {
  private readonly budget: RebuildFrontierBudget;
  private tablesEnsured = false;

  constructor(private readonly options: RebuildFrontierEngineOptions) {
    this.budget = options.budget ?? DEFAULT_BUDGET;
  }

  async ensureTables(): Promise<void> {
    if (this.tablesEnsured) return;
    await this.options.executor.exec(REBUILD_MAINTENANCE_JOBS_DDL);
    this.tablesEnsured = true;
  }

  private get executor(): SqliteExecutor {
    return this.options.executor;
  }

  private coalesceProject(projectId: string): string {
    return projectId ?? '';
  }

  private coalesceEnv(environmentId: string | null): string {
    return environmentId ?? '';
  }

  async computeFrontier(
    sessionId: string,
    trigger: ReprocessingTrigger,
    params?: { correctedTime?: number; eventTime?: number },
  ): Promise<RebuildFrontier | undefined> {
    const { rows } = await this.executor.exec(
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

    const scope: FrontierScope = {
      environmentId: toOptionalString(row.environment_id),
      projectId,
      workspaceId: toOptionalString(row.workspace_id),
      harness: asString(row.harness),
      scopeChain: toOptionalString(row.scope_chain),
    };

    const earliestSnapshot = await this.findEarliestSnapshot(this.executor, scope, start);
    const startTime = earliestSnapshot?.captureTime ?? start;

    return {
      environmentId: scope.environmentId,
      projectId,
      workspaceId: scope.workspaceId,
      harness: scope.harness,
      scopeChain: scope.scopeChain,
      startTime,
      endTime: Date.now(),
      trigger,
      triggerSessionId: sessionId,
      affectedProjectIds: [projectId],
    };
  }

  private async findEarliestSnapshot(
    queryable: Queryable,
    scope: FrontierScope,
    startTime: number,
  ): Promise<SnapshotInScope | undefined> {
    const { rows } = await queryable.exec(
      `SELECT id, session_id, generation_id, ordering, capture_time, temporal_role, created_at
       FROM configuration_snapshots
       WHERE COALESCE(environment_id, '') = ?
         AND COALESCE(project_id, '') = ?
         AND COALESCE(workspace_id, '') = ?
         AND (? = '' OR harness = ?)
         AND COALESCE(scope_chain, '') = ?
         AND capture_time >= ?
       ORDER BY ordering, capture_time, created_at, id
       LIMIT 1`,
      [
        this.coalesceEnv(scope.environmentId),
        this.coalesceProject(scope.projectId),
        scope.workspaceId ?? '',
        scope.harness,
        scope.harness,
        scope.scopeChain ?? '',
        startTime,
      ],
    );
    if (rows.length === 0) return undefined;
    const row = rows[0] as SqliteRow;
    return {
      id: asString(row.id),
      sessionId: toOptionalString(row.session_id),
      generationId: toOptionalString(row.generation_id),
      ordering: toNumber(row.ordering),
      captureTime: toNumber(row.capture_time),
      temporalRole: asString(row.temporal_role),
      createdAt: toNumber(row.created_at),
    };
  }

  async rebuildFrontier(
    frontier: RebuildFrontier,
    analysisReleaseId: string,
  ): Promise<RebuildFrontierReport> {
    await this.ensureTables();
    const start = Date.now();
    const cost = await this.estimateCost(this.executor, frontier);

    if (this.exceedsBudget(cost)) {
      const jobId = await this.queueMaintenanceJob(frontier, analysisReleaseId, cost);
      return {
        trigger: frontier.trigger as ReprocessingTrigger,
        analysisReleaseId,
        sessionsProcessed: 0,
        sessionsSkipped: 0,
        sessionsUnavailable: 0,
        snapshotsProcessed: 0,
        snapshotsUnchanged: 0,
        frontierStart: new Date(frontier.startTime).toISOString(),
        frontierEnd: new Date(frontier.endTime).toISOString(),
        contributionsSubtracted: 0,
        contributionsApplied: 0,
        distributionsRebuilt: 0,
        cohortsRebuilt: 0,
        insightsRebuilt: 0,
        rollupsReconciled: false,
        failures: [],
        duration: Date.now() - start,
        queued: true,
        jobId,
        cost,
      };
    }

    return this.executor.transaction(async (tx) => {
      return this.rebuildFrontierInTx(tx, frontier, analysisReleaseId);
    });
  }

  async rebuildFrontierInTx(
    tx: SqliteTransaction,
    frontier: RebuildFrontier,
    analysisReleaseId: string,
  ): Promise<RebuildFrontierReport> {
    const start = Date.now();
    const cost = await this.estimateCost(tx, frontier);
    const affected = await this.findAffectedSessions(tx, frontier);
    const snapshots = await this.findAffectedSnapshots(tx, frontier);

    const report: MutableRebuildFrontierReport = {
      trigger: frontier.trigger as ReprocessingTrigger,
      analysisReleaseId,
      sessionsProcessed: affected.length,
      sessionsSkipped: 0,
      sessionsUnavailable: 0,
      snapshotsProcessed: snapshots.length,
      snapshotsUnchanged: 0,
      frontierStart: new Date(frontier.startTime).toISOString(),
      frontierEnd: new Date(frontier.endTime).toISOString(),
      contributionsSubtracted: 0,
      contributionsApplied: 0,
      distributionsRebuilt: 0,
      cohortsRebuilt: 0,
      insightsRebuilt: 0,
      rollupsReconciled: false,
      failures: [],
      duration: 0,
      cost,
    };

    try {
      report.contributionsSubtracted = await this.subtractAffectedContributions(
        tx,
        frontier,
        affected,
      );

      let unavailable = 0;
      for (const session of affected) {
        if (await this.sessionExists(tx, session.id)) {
          await this.rebuildSessionContributions(tx, session, analysisReleaseId);
          report.contributionsApplied += 1;
        } else {
          unavailable += 1;
        }
      }
      report.sessionsUnavailable = unavailable;

      await this.rebuildLifecycleExposuresCohortsAndInsights(
        tx,
        frontier,
        snapshots,
        affected,
        analysisReleaseId,
      );
      await this.rebuildRollupsAndDistributions(tx, frontier, analysisReleaseId, affected);

      report.distributionsRebuilt = await this.countDistributions(tx, affected, analysisReleaseId);
      report.cohortsRebuilt = await this.countCohorts(tx, affected);
      report.insightsRebuilt = await this.countInsights(tx, affected, analysisReleaseId);
      report.rollupsReconciled = await this.reconcileRollups(tx, affected, analysisReleaseId);
      report.duration = Date.now() - start;
      return report as RebuildFrontierReport;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      report.failures = [
        {
          sessionId: frontier.triggerSessionId,
          failureType: 'integrity_error',
          message,
          preservedGenerationId: undefined,
        },
      ];
      throw error;
    }
  }

  async reassignProject(
    portfolioId: string,
    sourceProjectId: string,
    toProjectId: string,
    analysisReleaseId: string,
    reason = 'rebuild-frontier-reassign',
  ): Promise<readonly RebuildFrontierReport[]> {
    const { rows } = await this.executor.exec(
      `SELECT sp.project_id, p.portfolio_id
       FROM source_projects sp
       JOIN projects p ON p.id = sp.project_id
       WHERE sp.id = ?`,
      [sourceProjectId],
    );
    if (rows.length === 0) {
      throw new Error(`Source project not found: ${sourceProjectId}`);
    }

    const hooks: ReassignmentHooks = {
      rebuildContributions: async (tx, _spid, from, to) => {
        await tx.exec('UPDATE sessions SET project_id = ?, updated_at = ? WHERE project_id = ?', [
          to,
          Date.now(),
          from,
        ]);
        await tx.exec(
          'UPDATE rollup_contributions SET project_id = ?, updated_at = ? WHERE project_id = ?',
          [to, Date.now(), from],
        );
        for (const pid of [from, to]) {
          await tx.exec('DELETE FROM project_daily_rollups WHERE project_id = ?', [pid]);
          await tx.exec('DELETE FROM project_dimension_rollups WHERE project_id = ?', [pid]);
          await tx.exec('DELETE FROM project_distributions WHERE project_id = ?', [pid]);
        }
      },
      rebuildLifecycle: async (tx, _spid, from, to) => {
        const { rows: sessionRows } = await tx.exec(
          'SELECT id FROM sessions WHERE project_id IN (?, ?)',
          [from, to],
        );
        const sessionIds = sessionRows.map((r) => asString(r.id));
        if (sessionIds.length > 0) {
          await this.clearLifecycleForSessions(tx, sessionIds);
        }
      },
      rebuildExposure: async () => undefined,
      rebuildCohorts: async () => undefined,
    };

    await ProjectMappingStore.reassignProject(
      this.executor,
      portfolioId,
      sourceProjectId,
      toProjectId,
      { reason, hooks },
    );

    const fromProjectId = asString(rows[0].project_id);
    const fromFrontier = await this.projectFrontier(fromProjectId, 'reclassification');
    const toFrontier = await this.projectFrontier(toProjectId, 'reclassification');

    const fromReport = await this.rebuildFrontier(fromFrontier, analysisReleaseId);
    const toReport = await this.rebuildFrontier(toFrontier, analysisReleaseId);
    return [fromReport, toReport];
  }

  private async projectFrontier(
    projectId: string,
    trigger: ReprocessingTrigger,
  ): Promise<RebuildFrontier> {
    const { rows } = await this.executor.exec(
      'SELECT MIN(occurrence_time) AS min_time, MAX(occurrence_time) AS max_time FROM sessions WHERE project_id = ?',
      [projectId],
    );
    const start = toOptionalNumber(rows[0]?.min_time) ?? 0;
    const end = toOptionalNumber(rows[0]?.max_time) ?? Date.now();
    return {
      environmentId: null,
      projectId,
      workspaceId: null,
      harness: '',
      scopeChain: null,
      startTime: start,
      endTime: end,
      trigger,
      triggerSessionId: projectId,
      affectedProjectIds: [projectId],
    };
  }

  private exceedsBudget(cost: RebuildFrontierCost): boolean {
    return (
      cost.affectedSessions > this.budget.maxAffectedSessions ||
      cost.affectedSnapshots > this.budget.maxAffectedSnapshots ||
      cost.estimatedMillis > this.budget.maxDurationMillis
    );
  }

  private async queueMaintenanceJob(
    frontier: RebuildFrontier,
    analysisReleaseId: string,
    cost: RebuildFrontierCost,
  ): Promise<string> {
    await this.ensureTables();
    const now = Date.now();
    const id = `rfj-${deterministicId(
      'rebuild-job',
      frontier.projectId,
      frontier.trigger,
      String(frontier.startTime),
      String(now),
    )}`;
    await this.executor.exec(
      `INSERT INTO rebuild_maintenance_jobs (
        id, frontier_json, analysis_release_id, status, created_at, updated_at, total_cost_json
      ) VALUES (?, ?, ?, 'queued', ?, ?, ?)`,
      [id, JSON.stringify(frontier), analysisReleaseId, now, now, JSON.stringify(cost)],
    );
    return id;
  }

  private async estimateCost(
    queryable: Queryable,
    frontier: RebuildFrontier,
  ): Promise<RebuildFrontierCost> {
    const scope = this.frontierToScope(frontier);
    const { rows: sessionRows } = await queryable.exec(
      `SELECT COUNT(*) AS n
       FROM sessions s
       LEFT JOIN source_manifests sm ON sm.session_id = s.id
       WHERE s.project_id = ? AND (? = '' OR s.harness = ?)
         AND (s.occurrence_time IS NULL OR s.occurrence_time >= ?)
         AND (s.occurrence_time IS NULL OR s.occurrence_time <= ?)
         AND (? IS NULL OR s.environment_id = ? OR s.environment_id IS NULL)
         AND (? IS NULL OR sm.workspace_id = ? OR sm.workspace_id IS NULL)
         AND (? IS NULL OR sm.scope_chain = ? OR sm.scope_chain IS NULL)`,
      [
        scope.projectId,
        scope.harness,
        scope.harness,
        frontier.startTime,
        frontier.endTime,
        scope.environmentId,
        scope.environmentId,
        scope.workspaceId,
        scope.workspaceId,
        scope.scopeChain,
        scope.scopeChain,
      ],
    );
    const { rows: snapshotRows } = await queryable.exec(
      `SELECT COUNT(*) AS n
       FROM configuration_snapshots
       WHERE COALESCE(environment_id, '') = ?
         AND COALESCE(project_id, '') = ?
         AND COALESCE(workspace_id, '') = ?
         AND (? = '' OR harness = ?)
         AND COALESCE(scope_chain, '') = ?
         AND capture_time >= ? AND capture_time <= ?`,
      [
        this.coalesceEnv(scope.environmentId),
        this.coalesceProject(scope.projectId),
        scope.workspaceId ?? '',
        scope.harness,
        scope.harness,
        scope.scopeChain ?? '',
        frontier.startTime,
        frontier.endTime,
      ],
    );
    const affectedSessionIds = await this.findAffectedSessionIds(queryable, frontier);
    const { rows: metricRows } = await queryable.exec(
      `SELECT COUNT(*) AS n FROM metric_values
       WHERE session_id IN (${placeholders(affectedSessionIds.length)})`,
      affectedSessionIds,
    );

    return {
      affectedSessions: toNumber(sessionRows[0].n),
      affectedSnapshots: toNumber(snapshotRows[0].n),
      affectedMetricValues: toNumber(metricRows[0].n),
      estimatedMillis: affectedSessionIds.length * 50 + toNumber(snapshotRows[0].n) * 10,
    };
  }

  private async findAffectedSessionIds(
    queryable: Queryable,
    frontier: RebuildFrontier,
  ): Promise<string[]> {
    const affected = await this.findAffectedSessions(queryable, frontier);
    return affected.map((s) => s.id);
  }

  private async findAffectedSessions(
    queryable: Queryable,
    frontier: RebuildFrontier,
  ): Promise<readonly AffectedSession[]> {
    const { rows } = await queryable.exec(
      `SELECT s.id, s.current_generation_id, s.project_id, p.portfolio_id,
              s.occurrence_time, s.harness, s.environment_id, s.finality
       FROM sessions s
       JOIN projects p ON p.id = s.project_id
       LEFT JOIN source_manifests sm ON sm.session_id = s.id
       WHERE s.project_id = ? AND (? = '' OR s.harness = ?)
         AND (s.occurrence_time IS NULL OR s.occurrence_time >= ?)
         AND (s.occurrence_time IS NULL OR s.occurrence_time <= ?)
         AND (? IS NULL OR s.environment_id = ? OR s.environment_id IS NULL)
         AND (? IS NULL OR sm.workspace_id = ? OR sm.workspace_id IS NULL)
         AND (? IS NULL OR sm.scope_chain = ? OR sm.scope_chain IS NULL)
       ORDER BY s.occurrence_time`,
      [
        frontier.projectId,
        frontier.harness,
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
      finality: asString(r.finality),
    }));
  }

  private async findAffectedSnapshots(
    queryable: Queryable,
    frontier: RebuildFrontier,
  ): Promise<readonly SnapshotInScope[]> {
    const scope = this.frontierToScope(frontier);
    const { rows } = await queryable.exec(
      `SELECT id, session_id, generation_id, ordering, capture_time, temporal_role, created_at
       FROM configuration_snapshots
       WHERE COALESCE(environment_id, '') = ?
         AND COALESCE(project_id, '') = ?
         AND COALESCE(workspace_id, '') = ?
         AND (? = '' OR harness = ?)
         AND COALESCE(scope_chain, '') = ?
         AND capture_time >= ? AND capture_time <= ?
       ORDER BY ordering, capture_time, created_at, id`,
      [
        this.coalesceEnv(scope.environmentId),
        this.coalesceProject(scope.projectId),
        scope.workspaceId ?? '',
        scope.harness,
        scope.harness,
        scope.scopeChain ?? '',
        frontier.startTime,
        frontier.endTime,
      ],
    );
    return rows.map((r) => ({
      id: asString(r.id),
      sessionId: toOptionalString(r.session_id),
      generationId: toOptionalString(r.generation_id),
      ordering: toNumber(r.ordering),
      captureTime: toNumber(r.capture_time),
      temporalRole: asString(r.temporal_role),
      createdAt: toNumber(r.created_at),
    }));
  }

  private frontierToScope(frontier: RebuildFrontier): FrontierScope {
    return {
      environmentId: frontier.environmentId,
      projectId: frontier.projectId,
      workspaceId: frontier.workspaceId,
      harness: frontier.harness,
      scopeChain: frontier.scopeChain,
    };
  }

  private async subtractAffectedContributions(
    tx: SqliteTransaction,
    frontier: RebuildFrontier,
    affected: readonly AffectedSession[],
  ): Promise<number> {
    const affectedIds = new Set(affected.map((s) => s.id));
    if (frontier.triggerSessionId && !affectedIds.has(frontier.triggerSessionId)) {
      await tx.exec('DELETE FROM rollup_contributions WHERE session_id = ?', [
        frontier.triggerSessionId,
      ]);
    }

    if (affected.length === 0) {
      await this.clearProjectRollups(tx, frontier.projectId);
      return 0;
    }

    const ids = affected.map((s) => s.id);
    const ph = placeholders(ids.length);
    const { changes } = await tx.exec(
      `DELETE FROM rollup_contributions WHERE session_id IN (${ph})`,
      ids,
    );

    const projectIds = [...new Set(affected.map((s) => s.projectId))];
    for (const projectId of projectIds) {
      await tx.exec('DELETE FROM project_daily_rollups WHERE project_id = ?', [projectId]);
      await tx.exec('DELETE FROM project_dimension_rollups WHERE project_id = ?', [projectId]);
      await tx.exec('DELETE FROM project_distributions WHERE project_id = ?', [projectId]);
    }

    const portfolioIds = [...new Set(affected.map((s) => s.portfolioId).filter(Boolean))];
    for (const portfolioId of portfolioIds) {
      await tx.exec('DELETE FROM portfolio_daily_rollups WHERE portfolio_id = ?', [portfolioId]);
      await tx.exec('DELETE FROM portfolio_dimension_rollups WHERE portfolio_id = ?', [
        portfolioId,
      ]);
      await tx.exec('DELETE FROM portfolio_distributions WHERE portfolio_id = ?', [portfolioId]);
    }

    return changes;
  }

  private async clearProjectRollups(tx: SqliteTransaction, projectId: string): Promise<void> {
    await tx.exec('DELETE FROM project_daily_rollups WHERE project_id = ?', [projectId]);
    await tx.exec('DELETE FROM project_dimension_rollups WHERE project_id = ?', [projectId]);
    await tx.exec('DELETE FROM project_distributions WHERE project_id = ?', [projectId]);

    const { rows } = await tx.exec('SELECT portfolio_id FROM projects WHERE id = ?', [projectId]);
    if (rows.length > 0) {
      const portfolioId = asString(rows[0].portfolio_id);
      await tx.exec('DELETE FROM portfolio_daily_rollups WHERE portfolio_id = ?', [portfolioId]);
      await tx.exec('DELETE FROM portfolio_dimension_rollups WHERE portfolio_id = ?', [
        portfolioId,
      ]);
      await tx.exec('DELETE FROM portfolio_distributions WHERE portfolio_id = ?', [portfolioId]);
    }
  }

  private async sessionExists(tx: SqliteTransaction, sessionId: string): Promise<boolean> {
    const { rows } = await tx.exec('SELECT 1 FROM sessions WHERE id = ?', [sessionId]);
    return rows.length > 0;
  }

  private async rebuildSessionContributions(
    tx: SqliteTransaction,
    session: AffectedSession,
    analysisReleaseId: string,
  ): Promise<void> {
    await applySessionRollupContributions(tx, {
      sessionId: session.id,
      generationId: session.currentGenerationId,
      analysisReleaseId,
      isRoot: true,
      generationToken: session.currentGenerationId,
    });
    await rebuildAffectedDistributions(tx, {
      sessionId: session.id,
      generationId: session.currentGenerationId,
      analysisReleaseId,
      isRoot: true,
      generationToken: session.currentGenerationId,
    });
  }

  private async rebuildLifecycleExposuresCohortsAndInsights(
    tx: SqliteTransaction,
    frontier: RebuildFrontier,
    snapshots: readonly SnapshotInScope[],
    affected: readonly AffectedSession[],
    analysisReleaseId: string,
  ): Promise<void> {
    const sessionIds = affected.map((s) => s.id);
    if (sessionIds.length === 0) return;

    await this.clearLifecycleForSessions(tx, sessionIds);

    const sessionsById = new Map(affected.map((s) => [s.id, s]));
    for (const session of affected) {
      if (session.finality === 'censored') continue;
      const sessionSnapshots = snapshots.filter((s) => s.sessionId === session.id);
      await this.rebuildSessionLifecycleExposuresCohorts(
        tx,
        session,
        sessionSnapshots,
        sessionsById,
      );
    }

    await this.rebuildCohortsAndInsights(tx, frontier, affected, analysisReleaseId);
  }

  private async clearLifecycleForSessions(
    tx: SqliteTransaction,
    sessionIds: readonly string[],
  ): Promise<void> {
    if (sessionIds.length === 0) return;
    const ph = placeholders(sessionIds.length);
    await tx.exec(
      `DELETE FROM session_component_exposures WHERE session_id IN (${ph})`,
      sessionIds,
    );
    await tx.exec(
      `DELETE FROM component_lifecycle_events WHERE snapshot_id IN (
        SELECT id FROM configuration_snapshots WHERE session_id IN (${ph})
      )`,
      sessionIds,
    );
    await tx.exec(
      `DELETE FROM component_availability_events WHERE session_id IN (${ph})`,
      sessionIds,
    );
    await tx.exec(`DELETE FROM component_context_events WHERE session_id IN (${ph})`, sessionIds);
    await tx.exec(`DELETE FROM comparison_cohort_members WHERE session_id IN (${ph})`, sessionIds);
    await tx.exec(
      `DELETE FROM insight_evidence WHERE generation_id IN (
        SELECT id FROM transformation_generations WHERE session_id IN (${ph})
      )`,
      sessionIds,
    );
  }

  private async rebuildSessionLifecycleExposuresCohorts(
    tx: SqliteTransaction,
    session: AffectedSession,
    snapshots: readonly SnapshotInScope[],
    _sessionsById: Map<string, AffectedSession>,
  ): Promise<void> {
    let sessionSnapshots = snapshots;
    if (sessionSnapshots.length === 0) {
      const { rows } = await tx.exec(
        `SELECT id, session_id, generation_id, ordering, capture_time, temporal_role, created_at
         FROM configuration_snapshots
         WHERE session_id = ?
         ORDER BY ordering, capture_time, created_at, id`,
        [session.id],
      );
      sessionSnapshots = rows.map((r) => ({
        id: asString(r.id),
        sessionId: toOptionalString(r.session_id),
        generationId: toOptionalString(r.generation_id),
        ordering: toNumber(r.ordering),
        captureTime: toNumber(r.capture_time),
        temporalRole: asString(r.temporal_role),
        createdAt: toNumber(r.created_at),
      }));
    }
    if (sessionSnapshots.length === 0) return;

    const environmentId = this.coalesceEnv(session.environmentId);
    const previousVersions = new Map<string, string>();

    for (let i = 0; i < sessionSnapshots.length; i++) {
      const snapshot = sessionSnapshots[i];
      if (!snapshot) continue;
      const components = await this.loadSnapshotComponents(tx, snapshot.id);
      const present = new Set<string>();

      for (const component of components) {
        present.add(component.componentId);
        const previousVersion = previousVersions.get(component.componentId);
        let eventType: 'baseline' | 'added' | 'updated';
        if (previousVersion === undefined) {
          eventType = i === 0 ? 'baseline' : 'added';
        } else if (previousVersion !== component.componentVersionId) {
          eventType = 'updated';
        } else {
          continue;
        }

        await ComponentLifecycleEventStore.insert(tx, {
          componentId: component.componentId,
          environmentId,
          eventType,
          beforeVersionId: eventType === 'updated' ? previousVersion : null,
          afterVersionId: component.componentVersionId,
          snapshotId: snapshot.id,
          generationId: snapshot.generationId,
          source: 'rebuild-frontier',
          createdAt: snapshot.captureTime,
        });
        previousVersions.set(component.componentId, component.componentVersionId);

        await ComponentAvailabilityEventStore.insert(tx, {
          componentId: component.componentId,
          environmentId,
          sessionId: session.id,
          eventType: 'offered',
          snapshotId: snapshot.id,
          generationId: snapshot.generationId,
          startTime: snapshot.captureTime,
          source: 'rebuild-frontier',
          createdAt: snapshot.captureTime,
        });

        await ComponentContextEventStore.insert(tx, {
          componentId: component.componentId,
          environmentId,
          sessionId: session.id,
          eventType: eventType === 'updated' ? 'replaced' : 'listed',
          snapshotId: snapshot.id,
          generationId: snapshot.generationId,
          startTime: snapshot.captureTime,
          sourcePointer: '',
          source: 'rebuild-frontier',
          createdAt: snapshot.captureTime,
        });

        await this.closeOpenExposure(tx, session.id, component.componentId, snapshot);
        await SessionComponentExposureStore.insert(tx, {
          sessionId: session.id,
          componentId: component.componentId,
          environmentId,
          status: 'loaded',
          startSequence: snapshot.ordering,
          endSequence: null,
          startTime: snapshot.captureTime,
          endTime: null,
          snapshotId: snapshot.id,
          generationId: snapshot.generationId,
        });
      }

      for (const [componentId, previousVersion] of previousVersions) {
        if (!present.has(componentId)) {
          await ComponentLifecycleEventStore.insert(tx, {
            componentId,
            environmentId,
            eventType: 'removed',
            beforeVersionId: previousVersion,
            afterVersionId: null,
            snapshotId: snapshot.id,
            generationId: snapshot.generationId,
            source: 'rebuild-frontier',
            createdAt: snapshot.captureTime,
          });
          await ComponentAvailabilityEventStore.insert(tx, {
            componentId,
            environmentId,
            sessionId: session.id,
            eventType: 'unavailable',
            snapshotId: snapshot.id,
            generationId: snapshot.generationId,
            startTime: snapshot.captureTime,
            source: 'rebuild-frontier',
            createdAt: snapshot.captureTime,
          });
          await ComponentContextEventStore.insert(tx, {
            componentId,
            environmentId,
            sessionId: session.id,
            eventType: 'removed',
            snapshotId: snapshot.id,
            generationId: snapshot.generationId,
            startTime: snapshot.captureTime,
            sourcePointer: '',
            source: 'rebuild-frontier',
            createdAt: snapshot.captureTime,
          });
          await this.closeOpenExposure(tx, session.id, componentId, snapshot);
          previousVersions.delete(componentId);
        }
      }
    }
  }

  private async loadSnapshotComponents(
    tx: SqliteTransaction,
    snapshotId: string,
  ): Promise<readonly { componentId: string; componentVersionId: string }[]> {
    const { rows } = await tx.exec(
      `SELECT sc.component_version_id, cv.component_id
       FROM snapshot_components sc
       JOIN component_versions cv ON cv.id = sc.component_version_id
       WHERE sc.snapshot_id = ?
       ORDER BY cv.component_id`,
      [snapshotId],
    );
    return rows.map((r) => ({
      componentVersionId: asString(r.component_version_id),
      componentId: asString(r.component_id),
    }));
  }

  private async closeOpenExposure(
    tx: SqliteTransaction,
    sessionId: string,
    componentId: string,
    snapshot: SnapshotInScope,
  ): Promise<void> {
    const { rows } = await tx.exec(
      `SELECT id FROM session_component_exposures
       WHERE session_id = ? AND component_id = ? AND end_time IS NULL
         AND COALESCE(generation_id, '') = ?
       ORDER BY start_time DESC LIMIT 1`,
      [sessionId, componentId, snapshot.generationId ?? ''],
    );
    if (rows.length > 0) {
      await SessionComponentExposureStore.update(tx, sessionId, asString(rows[0].id), {
        endTime: snapshot.captureTime,
        endSequence: snapshot.ordering,
      });
    }
  }

  private async rebuildCohortsAndInsights(
    tx: SqliteTransaction,
    frontier: RebuildFrontier,
    affected: readonly AffectedSession[],
    analysisReleaseId: string,
  ): Promise<void> {
    const projects = new Map<string, string>();
    for (const session of affected) {
      if (session.finality === 'censored') continue;
      projects.set(session.projectId, session.portfolioId);
    }
    if (projects.size === 0) return;

    for (const [projectId, portfolioId] of projects) {
      const session = affected.find((s) => s.projectId === projectId && s.finality !== 'censored');
      const generationToken = session?.currentGenerationId ?? null;
      const result = await buildObservedBeforeAfterCohort(tx, {
        analysisReleaseId,
        recipeId: 'rebuild-frontier',
        recipeVersion: frontier.startTime,
        scope: 'project',
        scopeId: projectId,
        referenceTime: frontier.startTime,
        startTime: frontier.startTime,
        endTime: frontier.endTime,
        generationToken: generationToken ?? undefined,
      });

      await this.removeCensoredCohortMembers(tx, result.cohort.id);

      await recordInsightEvidence(tx, {
        analysisReleaseId,
        recipeId: 'rebuild-frontier',
        recipeVersion: frontier.startTime,
        insightKind: 'coverage',
        determinismVersion: 'deterministic:rebuild:1',
        generationId: generationToken ?? null,
        evidenceIds: result.members.map((m) => m.id),
        wordingInputs: { projectId, portfolioId, trigger: frontier.trigger },
      });
    }
  }

  private async removeCensoredCohortMembers(
    tx: SqliteTransaction,
    cohortId: string,
  ): Promise<void> {
    const { rows } = await tx.exec(
      `SELECT ccm.id, ccm.session_id
       FROM comparison_cohort_members ccm
       JOIN sessions s ON s.id = ccm.session_id
       WHERE ccm.cohort_id = ? AND s.finality = 'censored'`,
      [cohortId],
    );
    for (const row of rows) {
      await ComparisonCohortMemberStore.delete(tx, asString(row.id));
    }
  }

  private async rebuildRollupsAndDistributions(
    tx: SqliteTransaction,
    frontier: RebuildFrontier,
    analysisReleaseId: string,
    affected: readonly AffectedSession[],
  ): Promise<void> {
    if (affected.length === 0) return;
    const projects = new Map<string, string>();
    for (const session of affected) {
      projects.set(session.projectId, session.portfolioId);
    }

    for (const [projectId, portfolioId] of projects) {
      const session = affected.find((s) => s.projectId === projectId);
      const token = session?.currentGenerationId ?? frontier.triggerSessionId;
      if (!token) continue;
      await rebuildProjectPortfolioRollups(tx, projectId, portfolioId, analysisReleaseId, token);
      await rebuildProjectDistributions(tx, projectId, analysisReleaseId, token);
      await rebuildPortfolioDistributions(tx, portfolioId, analysisReleaseId, token);
    }
  }

  private async countDistributions(
    tx: SqliteTransaction,
    affected: readonly AffectedSession[],
    analysisReleaseId: string,
  ): Promise<number> {
    if (affected.length === 0) return 0;
    const projectIds = [...new Set(affected.map((s) => s.projectId))];
    const portfolioIds = [...new Set(affected.map((s) => s.portfolioId).filter(Boolean))];
    let total = 0;
    for (const projectId of projectIds) {
      const { rows } = await tx.exec(
        'SELECT COUNT(*) AS n FROM project_distributions WHERE project_id = ? AND analysis_release_id = ?',
        [projectId, analysisReleaseId],
      );
      total += toNumber(rows[0].n);
    }
    for (const portfolioId of portfolioIds) {
      const { rows } = await tx.exec(
        'SELECT COUNT(*) AS n FROM portfolio_distributions WHERE portfolio_id = ? AND analysis_release_id = ?',
        [portfolioId, analysisReleaseId],
      );
      total += toNumber(rows[0].n);
    }
    return total;
  }

  private async countCohorts(
    tx: SqliteTransaction,
    affected: readonly AffectedSession[],
  ): Promise<number> {
    if (affected.length === 0) return 0;
    const sessionIds = affected.map((s) => s.id);
    const ph = placeholders(sessionIds.length);
    const { rows } = await tx.exec(
      `SELECT COUNT(*) AS n FROM comparison_cohort_members WHERE session_id IN (${ph})`,
      sessionIds,
    );
    return toNumber(rows[0].n);
  }

  private async countInsights(
    tx: SqliteTransaction,
    affected: readonly AffectedSession[],
    analysisReleaseId: string,
  ): Promise<number> {
    if (affected.length === 0) return 0;
    const { rows } = await tx.exec(
      `SELECT COUNT(*) AS n FROM insight_evidence
       WHERE analysis_release_id = ? AND recipe_id = ?`,
      [analysisReleaseId, 'rebuild-frontier'],
    );
    return toNumber(rows[0].n);
  }

  private async reconcileRollups(
    tx: SqliteTransaction,
    affected: readonly AffectedSession[],
    analysisReleaseId: string,
  ): Promise<boolean> {
    if (affected.length === 0) return true;
    const projects = new Map<string, string>();
    for (const session of affected) {
      projects.set(session.projectId, session.portfolioId);
    }
    for (const [projectId, portfolioId] of projects) {
      const mismatches = await reconcileRollupTotals(tx, projectId, portfolioId, analysisReleaseId);
      if (!isRollupReconciled(mismatches)) return false;
    }
    return true;
  }
}
