import type { SqliteExecutor, SqliteTransaction, SqliteValue } from './contract.js';

type Queryable = SqliteExecutor | SqliteTransaction;

function toNumber(value: SqliteValue): number {
  return value === null || value === undefined ? 0 : Number(value);
}

const COUNT_SESSIONS_IN_WINDOW_SQL = `
  SELECT COUNT(*) AS c
  FROM sessions s
  JOIN projects p ON p.id = s.project_id
  WHERE p.portfolio_id = ?
    AND s.start_time IS NOT NULL
    AND s.start_time >= ? AND s.start_time < ?
`;

/**
 * Session-count query backing the portfolio KPI band's period-over-period
 * delta (issue #169). Reads through `idx_sessions_start_time` — verified by
 * the query-plan test in `packages/db-core/tests/unit/portfolio-kpi.test.ts`.
 * Sessions with `start_time IS NULL` (not yet observed) are excluded from
 * both the numerator and the implicit denominator, never counted as 0.
 */
export const PortfolioKpiStore = {
  async countSessionsInWindow(
    queryable: Queryable,
    portfolioId: string,
    startMs: number,
    endMs: number,
  ): Promise<number> {
    const { rows } = await queryable.exec(COUNT_SESSIONS_IN_WINDOW_SQL, [
      portfolioId,
      startMs,
      endMs,
    ]);
    return toNumber(rows[0]?.c);
  },
};
