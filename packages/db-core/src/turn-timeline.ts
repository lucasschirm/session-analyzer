import type { SqliteExecutor, SqliteTransaction, SqliteValue } from './contract.js';

type Queryable = SqliteExecutor | SqliteTransaction;

function toOptionalNumber(value: SqliteValue): number | null {
  return value === null || value === undefined ? null : Number(value);
}

/** A session's recorded wall-clock bounds (issue #169). Either bound may be
 * `null` (not yet observed) — reported as missing, never coerced to `0` or
 * to the other bound. */
export interface RawSessionWindow {
  readonly startTime: number | null;
  readonly endTime: number | null;
}

const SESSION_WINDOW_SQL = `
  SELECT start_time, end_time
  FROM sessions
  WHERE id = ?
`;

/**
 * Read-only session start/end lookup backing the turn-timeline segments DTO
 * (issue #169). Separate from `SessionEventsDetailStore` because it reads
 * `sessions` directly by id, not an evidence table; every other session
 * lookup in this package joins through `project_id` (see
 * `packages/db/src/analytics-session.ts`'s `getSessionContext`), which the
 * timeline consumer does not have on hand. All SQL lives here per
 * `.agents/rules/sql-only-in-db-core.md`.
 */
export const TurnTimelineStore = {
  async getSessionWindow(
    queryable: Queryable,
    sessionId: string,
  ): Promise<RawSessionWindow | null> {
    const { rows } = await queryable.exec(SESSION_WINDOW_SQL, [sessionId]);
    const row = rows[0];
    if (!row) return null;
    return {
      startTime: toOptionalNumber(row.start_time),
      endTime: toOptionalNumber(row.end_time),
    };
  },
};
