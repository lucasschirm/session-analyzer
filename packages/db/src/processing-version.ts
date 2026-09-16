import type { RollupPolicy, SqliteExecutor, SqliteTransaction } from '@lucasschirm/sal-db-core';
import {
  listNormalizedTimingEventRows,
  SessionComponentExposureStore,
  SessionContextSeriesStore,
} from '@lucasschirm/sal-db-core';
import {
  collectSeriesModels,
  computeRawTimingPoints,
  encodeContextSeries,
  timingRecordFromNormalizedRow,
} from './context-timing.js';
import {
  applySessionRollupContributions,
  loadOrDefaultRollupPolicy,
  rebuildProjectPortfolioRollups,
} from './rollup-reconciliation.js';

declare const console:
  | {
      warn?: (...args: unknown[]) => void;
      error?: (...args: unknown[]) => void;
    }
  | undefined;

/**
 * Analytics-derived-data processing version. Bump this whenever the logic
 * that builds rollups, dimension buckets, or component display names changes
 * in a way that requires existing databases to be rebuilt. The analytics
 * worker compares the stored version against this constant on boot and, when
 * the stored version is older, runs {@link rebuildAnalyticsDerivedData}
 * before serving queries.
 *
 * v15: `computeRawTimingPoints` now falls back to a message's
 * `numTokensPreceding` checkpoint when no resolved model request carries
 * context fields (transcript-only Devin sessions previously encoded all-null
 * context series). Existing all-null series rows cannot be recomputed from
 * skeleton normalized_events — the rebuild regenerates those sessions from
 * their retained artifacts instead.
 */
export const ANALYTICS_PROCESSING_VERSION = 15;

/**
 * `schema_metadata` row key used to persist the analytics processing version.
 * Kept distinct from {@link ANALYTICS_SCHEMA_NAME} (which tracks DDL
 * migrations) so processing-version bumps do not interfere with migration
 * bookkeeping.
 */
export const ANALYTICS_PROCESSING_METADATA_KEY = 'sal-analytics-processing';

/**
 * Progress callback used by {@link rebuildAnalyticsDerivedData} to report
 * per-step progress to the UI. `completed` and `total` are session counts for
 * the current step; `step` is a short human-readable label.
 */
export interface RebuildProgress {
  readonly step: string;
  readonly completed: number;
  readonly total: number;
  readonly phase?: number;
  readonly totalPhases?: number;
  readonly unit?: string;
}

export type RebuildProgressCallback = (progress: RebuildProgress) => void;

export interface AnalyticsRebuildDeps {
  /**
   * Re-ingests one session from its retained artifacts so the whole
   * per-session analytics — evidence, metrics, snapshot, exposures, stats —
   * is regenerated through the normal commit path. Returns true when a new
   * generation was committed. Optional: when absent (or when a session's
   * artifacts are no longer resolvable) the rebuild still backfills
   * session_component_exposures from persisted snapshot_components.
   */
  readonly regenerateSession?: (sessionId: string) => Promise<boolean>;
}

const REBUILD_PHASES = 6;

/**
 * Reads the stored analytics processing version, or `0` when no row exists
 * yet (fresh database or pre-versioning database).
 */
export async function getStoredProcessingVersion(executor: SqliteExecutor): Promise<number> {
  const { rows } = await executor.exec(
    'SELECT schema_version FROM schema_metadata WHERE schema_name = ?',
    [ANALYTICS_PROCESSING_METADATA_KEY],
  );
  return rows.length ? Number(rows[0].schema_version) : 0;
}

/**
 * Persists the analytics processing version. Creates the
 * `schema_metadata` row if absent, updates it otherwise.
 */
export async function setStoredProcessingVersion(
  executor: SqliteExecutor | SqliteTransaction,
  version: number,
): Promise<void> {
  const now = Date.now();
  const { rows } = await executor.exec(
    'SELECT schema_name FROM schema_metadata WHERE schema_name = ?',
    [ANALYTICS_PROCESSING_METADATA_KEY],
  );
  if (rows.length === 0) {
    await executor.exec(
      'INSERT INTO schema_metadata (schema_name, schema_version, initialized_at, updated_at) VALUES (?, ?, ?, ?)',
      [ANALYTICS_PROCESSING_METADATA_KEY, version, now, now],
    );
  } else {
    await executor.exec(
      'UPDATE schema_metadata SET schema_version = ?, updated_at = ? WHERE schema_name = ?',
      [version, now, ANALYTICS_PROCESSING_METADATA_KEY],
    );
  }
}

/**
 * Returns true when the stored processing version is older than the current
 * {@link ANALYTICS_PROCESSING_VERSION} and a rebuild is required.
 */
export async function needsRebuild(executor: SqliteExecutor): Promise<boolean> {
  const stored = await getStoredProcessingVersion(executor);
  return stored < ANALYTICS_PROCESSING_VERSION;
}

interface SessionRow {
  readonly id: string;
  readonly projectId: string;
  readonly portfolioId: string;
  readonly currentGenerationId: string;
  readonly analysisReleaseId: string;
}

const SESSION_REBUILD_SELECT = `
  SELECT s.id, s.project_id, p.portfolio_id, s.current_generation_id,
         g.analysis_release_id
  FROM sessions s
  JOIN projects p ON p.id = s.project_id
  JOIN transformation_generations g ON g.id = s.current_generation_id
  WHERE s.current_generation_id IS NOT NULL
  ORDER BY p.portfolio_id, s.project_id, s.id
`;

async function listSessionsForRebuild(executor: SqliteExecutor): Promise<readonly SessionRow[]> {
  const { rows } = await executor.exec(SESSION_REBUILD_SELECT, []);
  return rows.map((row) => ({
    id: String(row.id),
    projectId: String(row.project_id),
    portfolioId: String(row.portfolio_id),
    currentGenerationId: String(row.current_generation_id),
    analysisReleaseId: String(row.analysis_release_id),
  }));
}

/**
 * Sessions ingested before session_component_exposures /
 * session_component_stats were persisted carry a current generation but no
 * component-utilization data. Returns ids of sessions whose current
 * generation has snapshot_components yet no exposures or no stats.
 */
async function listSessionsMissingComponentData(
  executor: SqliteExecutor,
): Promise<readonly string[]> {
  const { rows } = await executor.exec(
    `SELECT DISTINCT s.id
     FROM sessions s
     JOIN configuration_snapshots cs
       ON cs.session_id = s.id
      AND COALESCE(cs.generation_id, '') = COALESCE(s.current_generation_id, '')
     JOIN snapshot_components sc ON sc.snapshot_id = cs.id
     WHERE s.current_generation_id IS NOT NULL
       AND (
         NOT EXISTS (SELECT 1 FROM session_component_exposures e WHERE e.session_id = s.id)
         OR NOT EXISTS (SELECT 1 FROM session_component_stats st WHERE st.session_id = s.id)
       )`,
  );
  return rows.map((row) => String(row.id));
}

/**
 * SQL-only fallback that recreates session_component_exposures from the
 * persisted snapshot_components of each session's current generation — the
 * same component set the ingest path would have exposed. Only fills
 * (session, component, generation) triples that are still missing; matching
 * the ingest path, post_session snapshots never produce exposures.
 */
async function backfillSessionComponentExposures(executor: SqliteExecutor): Promise<void> {
  const { rows } = await executor.exec(
    `SELECT cs.session_id, cs.id AS snapshot_id, cs.generation_id, cs.ordering,
            cs.capture_time, cs.environment_id, cv.component_id
     FROM configuration_snapshots cs
     JOIN sessions s
       ON s.id = cs.session_id
      AND COALESCE(s.current_generation_id, '') = COALESCE(cs.generation_id, '')
     JOIN snapshot_components sc ON sc.snapshot_id = cs.id
     JOIN component_versions cv ON cv.id = sc.component_version_id
     WHERE cs.session_id IS NOT NULL
       AND cs.temporal_role <> 'post_session'
       AND NOT EXISTS (
         SELECT 1 FROM session_component_exposures e
         WHERE e.session_id = cs.session_id
           AND e.component_id = cv.component_id
           AND COALESCE(e.generation_id, '') = COALESCE(cs.generation_id, '')
       )
     ORDER BY cs.capture_time, cs.ordering`,
  );
  if (rows.length === 0) return;

  await executor.transaction(async (tx) => {
    for (const row of rows) {
      try {
        await SessionComponentExposureStore.insert(tx, {
          sessionId: String(row.session_id),
          componentId: String(row.component_id),
          environmentId: String(row.environment_id ?? ''),
          status: 'available_not_loaded',
          startSequence: Number(row.ordering ?? 0),
          endSequence: null,
          startTime: Number(row.capture_time ?? 0),
          endTime: null,
          snapshotId: String(row.snapshot_id),
          generationId: row.generation_id === null ? null : String(row.generation_id),
        });
      } catch (err) {
        console?.warn?.(
          `[rebuildAnalyticsDerivedData] Failed to backfill exposure for session ${String(row.session_id)}:`,
          err,
        );
      }
    }
  });
}

/**
 * Re-ingests sessions whose persisted component data predates the current
 * derivation contract, then backfills exposures for any still missing.
 * Per-session failures are isolated — the rebuild always completes.
 */
async function regenerateStaleSessionComponentData(
  executor: SqliteExecutor,
  onProgress: RebuildProgressCallback | undefined,
  deps?: AnalyticsRebuildDeps,
): Promise<void> {
  const stale = await listSessionsMissingComponentData(executor);
  const total = stale.length;
  if (total > 0) {
    onProgress?.({
      step: 'Regenerating session analytics',
      completed: 0,
      total,
      phase: 1,
      totalPhases: REBUILD_PHASES,
      unit: 'sessions',
    });
    let completed = 0;
    for (const sessionId of stale) {
      try {
        await deps?.regenerateSession?.(sessionId);
      } catch (err) {
        console?.warn?.(
          `[rebuildAnalyticsDerivedData] Failed to regenerate session ${sessionId}:`,
          err,
        );
      }
      completed += 1;
      onProgress?.({
        step: 'Regenerating session analytics',
        completed,
        total,
        phase: 1,
        totalPhases: REBUILD_PHASES,
        unit: 'sessions',
      });
    }
  }

  await backfillSessionComponentExposures(executor);
}

/**
 * Sessions ingested before transformers emitted a first-prompt
 * `fallbackTitle` carry no `ai_title`. Re-ingesting them fills `ai_title`
 * only while it is still empty, so user-set titles are never touched.
 */
async function listUntitledSessions(executor: SqliteExecutor): Promise<readonly string[]> {
  const { rows } = await executor.exec(
    `SELECT id FROM sessions
     WHERE current_generation_id IS NOT NULL
       AND (ai_title IS NULL OR TRIM(ai_title) = '')
     ORDER BY id`,
    [],
  );
  return rows.map((row) => String(row.id));
}

async function regenerateUntitledSessionTitles(
  executor: SqliteExecutor,
  onProgress: RebuildProgressCallback | undefined,
  deps?: AnalyticsRebuildDeps,
): Promise<void> {
  const untitled = await listUntitledSessions(executor);
  const total = untitled.length;
  let completed = 0;
  for (const sessionId of untitled) {
    try {
      await deps?.regenerateSession?.(sessionId);
    } catch (err) {
      console?.warn?.(
        `[rebuildAnalyticsDerivedData] Failed to regenerate title for session ${sessionId}:`,
        err,
      );
    }
    completed += 1;
    onProgress?.({
      step: 'Backfilling session titles',
      completed,
      total,
      phase: 2,
      totalPhases: REBUILD_PHASES,
      unit: 'sessions',
    });
  }
}

async function rebuildSingleSession(
  executor: SqliteExecutor,
  session: SessionRow,
  policy: RollupPolicy,
): Promise<void> {
  await executor.transaction(async (tx) => {
    await applySessionRollupContributions(tx, {
      sessionId: session.id,
      generationId: session.currentGenerationId,
      analysisReleaseId: session.analysisReleaseId,
      skipBucketRecompute: true,
      rollupPolicy: policy,
    });
  });
}

async function rebuildSessionBatchWithFallback(
  executor: SqliteExecutor,
  chunk: readonly SessionRow[],
  getPolicy: (releaseId: string) => Promise<RollupPolicy>,
): Promise<void> {
  try {
    await executor.transaction(async (tx) => {
      for (const session of chunk) {
        const policy = await getPolicy(session.analysisReleaseId);
        await applySessionRollupContributions(tx, {
          sessionId: session.id,
          generationId: session.currentGenerationId,
          analysisReleaseId: session.analysisReleaseId,
          skipBucketRecompute: true,
          rollupPolicy: policy,
        });
      }
    });
  } catch (chunkErr) {
    // Invariant: Session Failure Isolation. If a batched transaction fails,
    // fall back to processing that chunk session-by-session so bad sessions
    // are isolated and valid sessions in the batch are still committed.
    console?.warn?.(
      '[rebuildAnalyticsDerivedData] Batched chunk failed, falling back to session-by-session:',
      chunkErr,
    );
    for (const session of chunk) {
      try {
        const policy = await getPolicy(session.analysisReleaseId);
        await rebuildSingleSession(executor, session, policy);
      } catch (err) {
        console?.warn?.(
          `[rebuildAnalyticsDerivedData] Failed to rebuild contributions for session ${session.id}:`,
          err,
        );
      }
    }
  }
}

/**
 * Materializes `session_context_series` rows for sessions whose current
 * generation predates the series table. Computes from the existing
 * `normalized_events` rows (which still carry full timing payloads for
 * pre-skeleton generations). Failures are isolated per session — a session
 * that cannot be backfilled simply has no series row and falls back to the
 * legacy normalized-events read path.
 */
async function backfillContextSeries(
  executor: SqliteExecutor,
  onProgress?: RebuildProgressCallback,
): Promise<void> {
  const missing = await SessionContextSeriesStore.listMissingCurrentGeneration(executor);
  const total = missing.length;
  onProgress?.({
    step: 'Backfilling context series',
    completed: 0,
    total,
    phase: 4,
    totalPhases: REBUILD_PHASES,
    unit: 'sessions processed',
  });
  let completed = 0;
  for (const target of missing) {
    try {
      const rows = await listNormalizedTimingEventRows(
        executor,
        target.sessionId,
        target.generationId,
      );
      const records = rows.map(timingRecordFromNormalizedRow);
      const rawPoints = computeRawTimingPoints(records);
      if (rawPoints.length > 0) {
        const encoded = encodeContextSeries(rawPoints);
        await SessionContextSeriesStore.upsert(executor, {
          sessionId: target.sessionId,
          generationId: target.generationId,
          messageCount: encoded.messageCount,
          contextTokens: encoded.contextTokensJson,
          generationTokens: encoded.generationTokensJson,
          pointMeta: encoded.pointMetaJson,
          models: JSON.stringify(collectSeriesModels(records)),
        });
      }
    } catch (err) {
      console?.warn?.(
        `[rebuildAnalyticsDerivedData] Failed to backfill context series for session ${target.sessionId}:`,
        err,
      );
    }
    completed += 1;
    if (completed % 50 === 0 || completed === total) {
      onProgress?.({
        step: 'Backfilling context series',
        completed,
        total,
        phase: 4,
        totalPhases: REBUILD_PHASES,
        unit: 'sessions processed',
      });
    }
  }
}

/**
 * The Devin transformer version that first emits `numTokensPreceding` on
 * message evidence (see `DEVIN_TRANSFORMER_VERSION` 0.14.0). Series written
 * by an older generation can gain a context signal on re-ingest; series
 * written by 0.14.0+ that are still all-null genuinely have no signal.
 */
const CONTEXT_CHECKPOINT_TRANSFORMER_VERSION = '0.14.0';

function semverBelow(version: string, floor: string): boolean {
  const parse = (v: string) => v.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(version);
  const b = parse(floor);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
  }
  return false;
}

/**
 * Sessions whose current-generation `session_context_series` row carries no
 * context signal at all (every `context_tokens[i]` null) AND whose generation
 * predates the `numTokensPreceding` checkpoint fallback. These predate v15
 * and cannot be backfilled from skeleton `normalized_events` — they re-ingest
 * from retained artifacts instead. Scoped to `devin` sessions on pre-0.14.0
 * generations so sessions that legitimately have no context signal (and
 * non-devin sessions, which never emit the checkpoint) are not re-ingested
 * pointlessly on every future version bump.
 */
async function listSessionsWithEmptyContextSeries(
  executor: SqliteExecutor,
): Promise<readonly string[]> {
  const { rows } = await executor.exec(
    `SELECT scs.session_id, scs.context_tokens, g.transformer_version
     FROM session_context_series scs
     JOIN sessions s ON s.id = scs.session_id
       AND COALESCE(s.current_generation_id, '') = COALESCE(scs.generation_id, '')
       AND s.harness = 'devin'
     JOIN transformation_generations g ON g.id = scs.generation_id
     ORDER BY scs.session_id`,
    [],
  );
  const stale: string[] = [];
  for (const row of rows) {
    if (!semverBelow(String(row.transformer_version), CONTEXT_CHECKPOINT_TRANSFORMER_VERSION)) {
      continue;
    }
    let values: unknown;
    try {
      values = JSON.parse(String(row.context_tokens));
    } catch {
      values = null;
    }
    if (!Array.isArray(values) || values.every((v) => v === null)) {
      stale.push(String(row.session_id));
    }
  }
  return stale;
}

/**
 * Re-ingests sessions whose context-growth series is entirely null so the
 * per-node checkpoint fallback (Devin `numTokensPreceding`, v15) materializes
 * real context values. Per-session failures are isolated — a session that
 * cannot be regenerated keeps its existing (empty) series.
 *
 * Runs BEFORE {@link listSessionsForRebuild}, alongside the other
 * regeneration steps, so the rebuild snapshot picks up the fresh
 * `current_generation_id` produced by re-ingest — regenerating after the
 * snapshot would make the rollup pass re-apply contributions under the
 * superseded generation and double-count those sessions.
 */
async function regenerateEmptyContextSeries(
  executor: SqliteExecutor,
  onProgress: RebuildProgressCallback | undefined,
  deps?: AnalyticsRebuildDeps,
): Promise<void> {
  const stale = await listSessionsWithEmptyContextSeries(executor);
  const total = stale.length;
  let completed = 0;
  for (const sessionId of stale) {
    try {
      await deps?.regenerateSession?.(sessionId);
    } catch (err) {
      console?.warn?.(
        `[rebuildAnalyticsDerivedData] Failed to regenerate context series for session ${sessionId}:`,
        err,
      );
    }
    completed += 1;
    onProgress?.({
      step: 'Regenerating context series',
      completed,
      total,
      phase: 3,
      totalPhases: REBUILD_PHASES,
      unit: 'sessions',
    });
  }
}

/**
 * Rebuilds all analytics-derived data (rollup contributions, daily/dimension
 * rollups) for every committed session in the database. Idempotent: deleting
 * and re-applying contributions for the current generation yields the same
 * state. Intended to run once on worker boot when
 * {@link needsRebuild} returns true.
 *
 * The optional `onProgress` callback receives per-step progress so the UI can
 * surface "Updating analytics data…" with a percentage.
 */
export async function rebuildAnalyticsDerivedData(
  executor: SqliteExecutor,
  onProgress?: RebuildProgressCallback,
  deps?: AnalyticsRebuildDeps,
): Promise<void> {
  // Drop component_evidence_link rows written before version 8: the skeleton
  // persistence stripped every link field, so those rows are empty-payload
  // bloat that no read path queries. New generations no longer write them.
  await executor.exec(`DELETE FROM normalized_events WHERE event_type = 'component_evidence_link'`);

  // Step 1: regenerate sessions whose persisted component data predates the
  // exposure/stats contract — full re-ingest from retained artifacts where
  // possible, exposure backfill from snapshot_components otherwise.
  await regenerateStaleSessionComponentData(executor, onProgress, deps);

  // Step 2: regenerate untitled sessions so the first-prompt fallbackTitle
  // derivation backfills ai_title. Renames and real ai-titles are never
  // touched — ingestion only fills empty title fields.
  await regenerateUntitledSessionTitles(executor, onProgress, deps);

  // Step 3: regenerate sessions whose context series carries no context
  // signal at all (predates the numTokensPreceding fallback, v15) — skeleton
  // normalized_events cannot recover it, so they re-ingest from artifacts.
  // Like steps 1-2 this runs before the rebuild snapshot below so the
  // rollup pass sees the fresh current_generation_id.
  await regenerateEmptyContextSeries(executor, onProgress, deps);

  const sessions = await listSessionsForRebuild(executor);
  if (sessions.length === 0) {
    await setStoredProcessingVersion(executor, ANALYTICS_PROCESSING_VERSION);
    return;
  }

  // Step 4: materialize context-growth series for sessions whose current
  // generation predates the table, so the context chart reads
  // session_context_series instead of normalized_events.
  await backfillContextSeries(executor, onProgress);

  // Group sessions by (portfolioId, projectId, analysisReleaseId) so we can
  // rebuild rollups once per project+release after re-applying all session
  // contributions.
  const projectGroups = new Map<string, SessionRow[]>();
  for (const session of sessions) {
    const key = `${session.portfolioId}:${session.projectId}:${session.analysisReleaseId}`;
    const existing = projectGroups.get(key);
    if (existing) existing.push(session);
    else projectGroups.set(key, [session]);
  }

  // Cache rollup policies by analysisReleaseId to avoid redundant policy lookups
  // for every session and project group.
  const policyCache = new Map<string, RollupPolicy>();
  async function getPolicy(releaseId: string): Promise<RollupPolicy> {
    let policy = policyCache.get(releaseId);
    if (!policy) {
      policy = await loadOrDefaultRollupPolicy(executor, releaseId);
      policyCache.set(releaseId, policy);
    }
    return policy;
  }

  // Step 5: re-apply rollup contributions per session. This repopulates the
  // model dimension from model_requests and is the bulk of the work.
  // We pass skipBucketRecompute: true because Step 3 recomputes all project and
  // portfolio rollups in bulk in a single efficient pass.
  // Sessions are processed in batches per transaction to eliminate thousands of
  // intermediate OPFS disk sync flushes while preserving Session Failure Isolation.
  const totalSessions = sessions.length;
  let completed = 0;
  onProgress?.({
    step: 'Rebuilding session rollups',
    completed: 0,
    total: totalSessions,
    phase: 5,
    totalPhases: REBUILD_PHASES,
    unit: 'sessions processed',
  });

  const BATCH_SIZE = 50;
  for (let i = 0; i < sessions.length; i += BATCH_SIZE) {
    const chunk = sessions.slice(i, i + BATCH_SIZE);
    await rebuildSessionBatchWithFallback(executor, chunk, getPolicy);
    completed += chunk.length;
    onProgress?.({
      step: 'Rebuilding session rollups',
      completed,
      total: totalSessions,
      phase: 5,
      totalPhases: REBUILD_PHASES,
      unit: 'sessions processed',
    });
  }

  // Step 6: recompute daily/dimension rollup buckets per project+portfolio.
  const groupList = [...projectGroups.values()];
  const totalGroups = groupList.length;
  let groupsCompleted = 0;
  onProgress?.({
    step: 'Recomputing project rollups',
    completed: 0,
    total: totalGroups,
    phase: 6,
    totalPhases: REBUILD_PHASES,
    unit: 'analytics calculations',
  });
  for (const group of groupList) {
    try {
      const first = group[0];
      if (!first) continue;
      const policy = await getPolicy(first.analysisReleaseId);
      await rebuildProjectPortfolioRollups(
        executor,
        first.projectId,
        first.portfolioId,
        first.analysisReleaseId,
        first.currentGenerationId,
        policy,
      );
    } catch (err) {
      console?.warn?.(
        '[rebuildAnalyticsDerivedData] Failed to rebuild rollups for project group:',
        err,
      );
    }
    groupsCompleted += 1;
    onProgress?.({
      step: 'Recomputing project rollups',
      completed: groupsCompleted,
      total: totalGroups,
      phase: 6,
      totalPhases: REBUILD_PHASES,
      unit: 'analytics calculations',
    });
  }

  // Step 7: persist the new processing version so the rebuild does not run
  // again on the next boot.
  await setStoredProcessingVersion(executor, ANALYTICS_PROCESSING_VERSION);
}
