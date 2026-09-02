import type { SqliteExecutor, SqliteTransaction } from '@lucasschirm/sal-db-core';
import {
  applySessionRollupContributions,
  rebuildProjectPortfolioRollups,
} from './rollup-reconciliation.js';

/**
 * Analytics-derived-data processing version. Bump this whenever the logic
 * that builds rollups, dimension buckets, or component display names changes
 * in a way that requires existing databases to be rebuilt. The analytics
 * worker compares the stored version against this constant on boot and, when
 * the stored version is older, runs {@link rebuildAnalyticsDerivedData}
 * before serving queries.
 */
export const ANALYTICS_PROCESSING_VERSION = 2;

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
}

export type RebuildProgressCallback = (progress: RebuildProgress) => void;

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
): Promise<void> {
  const sessions = await listSessionsForRebuild(executor);
  if (sessions.length === 0) {
    await setStoredProcessingVersion(executor, ANALYTICS_PROCESSING_VERSION);
    return;
  }

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

  // Step 1: re-apply rollup contributions per session. This repopulates the
  // model dimension from model_requests and is the bulk of the work.
  const totalSessions = sessions.length;
  let completed = 0;
  for (const session of sessions) {
    await executor.transaction(async (tx) => {
      await applySessionRollupContributions(tx, {
        sessionId: session.id,
        generationId: session.currentGenerationId,
        analysisReleaseId: session.analysisReleaseId,
      });
    });
    completed += 1;
    onProgress?.({
      step: 'Rebuilding session rollups',
      completed,
      total: totalSessions,
    });
  }

  // Step 2: recompute daily/dimension rollup buckets per project+portfolio.
  const groupList = [...projectGroups.values()];
  const totalGroups = groupList.length;
  let groupsCompleted = 0;
  for (const group of groupList) {
    const first = group[0]!;
    await rebuildProjectPortfolioRollups(
      executor,
      first.projectId,
      first.portfolioId,
      first.analysisReleaseId,
      first.currentGenerationId,
    );
    groupsCompleted += 1;
    onProgress?.({
      step: 'Recomputing project rollups',
      completed: groupsCompleted,
      total: totalGroups,
    });
  }

  // Step 3: persist the new processing version so the rebuild does not run
  // again on the next boot.
  await setStoredProcessingVersion(executor, ANALYTICS_PROCESSING_VERSION);
}
