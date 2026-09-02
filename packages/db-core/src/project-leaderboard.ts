import type { SqliteExecutor, SqliteTransaction, SqliteValue } from './contract.js';

type Queryable = SqliteExecutor | SqliteTransaction;

function toNumber(value: SqliteValue): number {
  return value === null || value === undefined ? 0 : Number(value);
}

function toOptionalNumber(value: SqliteValue): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function toStringValue(value: SqliteValue): string {
  return value === null || value === undefined ? '' : String(value);
}

/** One project's session count within a window (issue #169), for the
 * portfolio project-leaderboard. Projects with zero sessions in the window
 * are absent from this result set — the db facade fills them in as an
 * explicit `0` from the full project list, never omitting a project row. */
export interface ProjectSessionCountRow {
  readonly projectId: string;
  readonly sessionCount: number;
}

const SESSION_COUNTS_BY_PROJECT_IN_WINDOW_SQL = `
  SELECT s.project_id AS project_id, COUNT(*) AS c
  FROM sessions s
  JOIN projects p ON p.id = s.project_id
  WHERE p.portfolio_id = ?
    AND s.start_time IS NOT NULL
    AND s.start_time >= ? AND s.start_time < ?
  GROUP BY s.project_id
`;

/** One project's token totals within a window (issue #169). Each side
 * tracks its own known-request count, same missingness policy as
 * `PortfolioKpiStore.sumTokensInWindow`. */
export interface ProjectTokenTotalsRow {
  readonly projectId: string;
  readonly inputSum: number;
  readonly inputKnownN: number;
  readonly outputSum: number;
  readonly outputKnownN: number;
}

const TOKEN_TOTALS_BY_PROJECT_IN_WINDOW_SQL = `
  SELECT
    s.project_id AS project_id,
    COALESCE(SUM(mr.input_tokens), 0) AS input_sum,
    SUM(CASE WHEN mr.input_tokens IS NOT NULL THEN 1 ELSE 0 END) AS input_known,
    COALESCE(SUM(mr.output_tokens), 0) AS output_sum,
    SUM(CASE WHEN mr.output_tokens IS NOT NULL THEN 1 ELSE 0 END) AS output_known
  FROM model_requests mr
  JOIN sessions s ON s.id = mr.session_id
  JOIN projects p ON p.id = s.project_id
  WHERE p.portfolio_id = ?
    AND s.start_time IS NOT NULL
    AND s.start_time >= ? AND s.start_time < ?
  GROUP BY s.project_id
`;

/** One project's clean-completion counts within a window (issue #169), same
 * denominator policy as `PortfolioKpiStore.getCleanCompletionInWindow`:
 * `knownN` is the classified-outcome subset of `eligibleN`, and `cleanN` is
 * never divided by raw session count. */
export interface ProjectCleanCompletionRow {
  readonly projectId: string;
  readonly cleanN: number;
  readonly knownN: number;
  readonly eligibleN: number;
}

const CLEAN_COMPLETION_BY_PROJECT_IN_WINDOW_SQL = `
  SELECT
    s.project_id AS project_id,
    SUM(CASE WHEN s.outcome = 'clean' THEN 1 ELSE 0 END) AS clean_n,
    SUM(CASE WHEN s.outcome IS NOT NULL THEN 1 ELSE 0 END) AS known_n,
    COUNT(*) AS eligible_n
  FROM sessions s
  JOIN projects p ON p.id = s.project_id
  WHERE p.portfolio_id = ? AND s.finality = 'final'
    AND s.start_time IS NOT NULL
    AND s.start_time >= ? AND s.start_time < ?
  GROUP BY s.project_id
`;

/** A project's most recent session start/end, unwindowed (issue #169) — a
 * status indicator ("last touched"), not a metric over the query range.
 * Either bound is `null` when no session in the project has that bound
 * recorded, never coerced to `0`. */
export interface ProjectLastActiveRow {
  readonly projectId: string;
  readonly lastStart: number | null;
  readonly lastEnd: number | null;
}

const LAST_ACTIVE_BY_PROJECT_SQL = `
  SELECT s.project_id AS project_id, MAX(s.start_time) AS last_start, MAX(s.end_time) AS last_end
  FROM sessions s
  JOIN projects p ON p.id = s.project_id
  WHERE p.portfolio_id = ?
  GROUP BY s.project_id
`;

/** One session's project + start time within the trend window (issue #169)
 * — the db facade buckets these into days per project for the 30d
 * sparkline; day-bucketing (timezone-aware) stays in `packages/db` per the
 * existing `toDayBucket` convention, not duplicated here. */
export interface ProjectSessionStartRow {
  readonly projectId: string;
  readonly startTime: number;
}

const SESSION_STARTS_BY_PROJECT_IN_WINDOW_SQL = `
  SELECT s.project_id AS project_id, s.start_time AS start_time
  FROM sessions s
  JOIN projects p ON p.id = s.project_id
  WHERE p.portfolio_id = ?
    AND s.start_time IS NOT NULL
    AND s.start_time >= ? AND s.start_time < ?
`;

/**
 * Read-only, project-grouped queries backing the portfolio project
 * leaderboard (issue #169). All read through the same `sessions`/`projects`
 * join shape (and therefore the same indexes) already verified by
 * `PortfolioKpiStore`'s query-plan tests — see
 * `packages/db-core/tests/unit/project-leaderboard.test.ts` for this
 * module's own SEARCH-not-SCAN assertions. All SQL lives here per
 * `.agents/rules/sql-only-in-db-core.md`.
 */
export const ProjectLeaderboardStore = {
  async getSessionCountsByProjectInWindow(
    queryable: Queryable,
    portfolioId: string,
    startMs: number,
    endMs: number,
  ): Promise<readonly ProjectSessionCountRow[]> {
    const { rows } = await queryable.exec(SESSION_COUNTS_BY_PROJECT_IN_WINDOW_SQL, [
      portfolioId,
      startMs,
      endMs,
    ]);
    return rows.map((r) => ({
      projectId: toStringValue(r.project_id),
      sessionCount: toNumber(r.c),
    }));
  },

  async getTokenTotalsByProjectInWindow(
    queryable: Queryable,
    portfolioId: string,
    startMs: number,
    endMs: number,
  ): Promise<readonly ProjectTokenTotalsRow[]> {
    const { rows } = await queryable.exec(TOKEN_TOTALS_BY_PROJECT_IN_WINDOW_SQL, [
      portfolioId,
      startMs,
      endMs,
    ]);
    return rows.map((r) => ({
      projectId: toStringValue(r.project_id),
      inputSum: toNumber(r.input_sum),
      inputKnownN: toNumber(r.input_known),
      outputSum: toNumber(r.output_sum),
      outputKnownN: toNumber(r.output_known),
    }));
  },

  async getCleanCompletionByProjectInWindow(
    queryable: Queryable,
    portfolioId: string,
    startMs: number,
    endMs: number,
  ): Promise<readonly ProjectCleanCompletionRow[]> {
    const { rows } = await queryable.exec(CLEAN_COMPLETION_BY_PROJECT_IN_WINDOW_SQL, [
      portfolioId,
      startMs,
      endMs,
    ]);
    return rows.map((r) => ({
      projectId: toStringValue(r.project_id),
      cleanN: toNumber(r.clean_n),
      knownN: toNumber(r.known_n),
      eligibleN: toNumber(r.eligible_n),
    }));
  },

  async getLastActiveByProject(
    queryable: Queryable,
    portfolioId: string,
  ): Promise<readonly ProjectLastActiveRow[]> {
    const { rows } = await queryable.exec(LAST_ACTIVE_BY_PROJECT_SQL, [portfolioId]);
    return rows.map((r) => ({
      projectId: toStringValue(r.project_id),
      lastStart: toOptionalNumber(r.last_start),
      lastEnd: toOptionalNumber(r.last_end),
    }));
  },

  async getSessionStartsByProjectInWindow(
    queryable: Queryable,
    portfolioId: string,
    startMs: number,
    endMs: number,
  ): Promise<readonly ProjectSessionStartRow[]> {
    const { rows } = await queryable.exec(SESSION_STARTS_BY_PROJECT_IN_WINDOW_SQL, [
      portfolioId,
      startMs,
      endMs,
    ]);
    return rows.map((r) => ({
      projectId: toStringValue(r.project_id),
      startTime: toNumber(r.start_time),
    }));
  },
};
