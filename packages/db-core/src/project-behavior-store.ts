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

function toOptionalString(value: SqliteValue): string | null {
  return value === null || value === undefined ? null : String(value);
}

const COUNT_SESSIONS_IN_WINDOW_SQL = `
  SELECT COUNT(*) AS c
  FROM sessions s
  WHERE s.project_id = ?
    AND s.start_time IS NOT NULL
    AND s.start_time >= ? AND s.start_time < ?
`;

/** One session's wall-clock duration (issue #169). Only sessions with both
 * `start_time` and `end_time` recorded are included — a session missing
 * either bound is excluded (never coerced to a 0ms duration). */
export interface SessionDurationRow {
  readonly sessionId: string;
  readonly durationMs: number;
}

const SESSION_DURATIONS_IN_WINDOW_SQL = `
  SELECT s.id AS session_id, (s.end_time - s.start_time) AS duration_ms
  FROM sessions s
  WHERE s.project_id = ? AND s.start_time IS NOT NULL AND s.end_time IS NOT NULL
    AND s.start_time >= ? AND s.start_time < ?
`;

/**
 * Per-session turn count (issue #169). Only sessions with at least one
 * `turns` row are included — a session with zero rows is treated as
 * "turns not captured" (missing), not a measured 0, because a harness that
 * emits no turn boundaries cannot be distinguished from one that recorded a
 * genuinely turn-less session (`.agents/rules/missing-is-never-zero.md`).
 */
export interface SessionTurnCountRow {
  readonly sessionId: string;
  readonly turnCount: number;
}

const SESSION_TURN_COUNTS_IN_WINDOW_SQL = `
  SELECT s.id AS session_id, COUNT(t.id) AS turn_count
  FROM sessions s
  JOIN turns t ON t.session_id = s.id
  WHERE s.project_id = ? AND s.start_time IS NOT NULL
    AND s.start_time >= ? AND s.start_time < ?
  GROUP BY s.id
`;

/** Per-session token total (issue #169). `tokensSum` is `null` when the
 * session has no `model_requests` row with a known `input_tokens`/
 * `output_tokens` — a coverage gap, never a fabricated 0. */
export interface SessionTokensRow {
  readonly sessionId: string;
  readonly tokensSum: number | null;
}

/** A `model_requests` row only contributes to `tokens_sum` when BOTH
 * `input_tokens` and `output_tokens` are known — a row with only one side
 * recorded is excluded entirely rather than treating its missing side as 0
 * (`.agents/rules/missing-is-never-zero.md`). This mirrors the separate
 * `input_known`/`output_known` tracking in `portfolio-kpi.ts`'s
 * `SUM_TOKENS_IN_WINDOW_SQL`, collapsed to a single known/unknown flag per
 * row since this query reports one combined total per session. */
const SESSION_TOKENS_IN_WINDOW_SQL = `
  SELECT s.id AS session_id,
    SUM(CASE WHEN mr.input_tokens IS NOT NULL AND mr.output_tokens IS NOT NULL
      THEN mr.input_tokens + mr.output_tokens ELSE 0 END) AS tokens_sum,
    SUM(CASE WHEN mr.input_tokens IS NOT NULL AND mr.output_tokens IS NOT NULL
      THEN 1 ELSE 0 END) AS known_n
  FROM sessions s
  JOIN model_requests mr ON mr.session_id = s.id
  WHERE s.project_id = ? AND s.start_time IS NOT NULL
    AND s.start_time >= ? AND s.start_time < ?
  GROUP BY s.id
`;

/** Per-session cost total (issue #169). `costSum` is `null` when the session
 * has no `model_usage` row with a non-null `cost` — a coverage gap. */
export interface SessionCostRow {
  readonly sessionId: string;
  readonly costSum: number | null;
}

const SESSION_COST_IN_WINDOW_SQL = `
  SELECT s.id AS session_id, SUM(mu.cost) AS cost_sum
  FROM sessions s
  JOIN model_usage mu ON mu.session_id = s.id
  WHERE s.project_id = ? AND s.start_time IS NOT NULL
    AND s.start_time >= ? AND s.start_time < ?
    AND mu.cost IS NOT NULL
  GROUP BY s.id
`;

/** One ISO-week bucket's tool-invocation totals (issue #169). Weeks with no
 * tool-kind invocation are simply absent from the result — this store never
 * fabricates a zero-row for an unobserved week. `packages/db/src/
 * project-behavior.ts`'s `getWeeklyToolErrorRate` currently renders only the
 * weeks present in this result (a sparse series), rather than back-filling
 * gaps as explicit `n = 0, rate = null` points; a consumer must treat an
 * absent week bucket as "no data", not "zero error rate". */
export interface WeeklyToolInvocationRow {
  readonly weekBucket: string;
  readonly totalToolCalls: number;
  readonly failedToolCalls: number;
}

const WEEKLY_TOOL_INVOCATIONS_SQL = `
  SELECT strftime('%Y-%W', i.created_at / 1000, 'unixepoch') AS week_bucket,
    COUNT(*) AS total,
    SUM(CASE WHEN i.status = 'failed' THEN 1 ELSE 0 END) AS failed
  FROM invocations i
  JOIN sessions s ON s.id = i.session_id
  WHERE s.project_id = ? AND i.kind = 'tool'
  GROUP BY week_bucket
  ORDER BY week_bucket
`;

/** One tool's invocation count (issue #169), scoped to `kind = 'tool'` only
 * — Skill/Agent/Sub Agent invocations are separate domains and are never
 * folded into this ranking (`.agents/rules/analytics-domain-distinctions.md`). */
export interface TopToolRow {
  readonly componentId: string;
  readonly displayName: string | null;
  readonly invocationCount: number;
}

const TOP_TOOLS_BY_INVOCATIONS_SQL = `
  SELECT ci.id AS component_id, ci.display_name AS display_name, COUNT(*) AS c
  FROM invocations i
  JOIN sessions s ON s.id = i.session_id
  JOIN component_identities ci ON ci.id = i.component_id
  WHERE s.project_id = ? AND i.kind = 'tool'
    AND i.created_at >= ? AND i.created_at < ?
  GROUP BY ci.id, ci.display_name
  ORDER BY c DESC
  LIMIT ?
`;

/** One session's model×harness cohort membership row (issue #169). Raw
 * per-session facts — the db-package layer aggregates these into per-cohort
 * n / median tokens / median cost / clean rate. */
export interface ModelHarnessCohortRawRow {
  readonly model: string;
  readonly harness: string;
  readonly sessionId: string;
  readonly tokensSum: number | null;
  readonly costSum: number | null;
  readonly outcome: string | null;
}

const MODEL_HARNESS_COHORT_ROWS_SQL = `
  SELECT mr.model AS model, s.harness AS harness, s.id AS session_id, s.outcome AS outcome,
    (SELECT SUM(x.input_tokens + x.output_tokens)
       FROM model_requests x WHERE x.session_id = s.id AND x.model = mr.model
         AND x.input_tokens IS NOT NULL AND x.output_tokens IS NOT NULL) AS tokens_sum,
    (SELECT SUM(mu.cost) FROM model_usage mu
       JOIN model_requests r ON r.id = mu.request_id
       WHERE r.session_id = s.id AND r.model = mr.model AND mu.cost IS NOT NULL) AS cost_sum
  FROM sessions s
  JOIN model_requests mr ON mr.session_id = s.id AND mr.model IS NOT NULL
  WHERE s.project_id = ? AND s.start_time IS NOT NULL
    AND s.start_time >= ? AND s.start_time < ?
  GROUP BY mr.model, s.harness, s.id
`;

/**
 * Read-only queries backing the Project Behavior stat strip, duration
 * histogram, weekly tool error rate, top-tools list, and model×harness
 * cohort rows (issue #169). All SQL lives here per
 * `.agents/rules/sql-only-in-db-core.md`; `packages/db/src/project-behavior.ts`
 * only shapes/aggregates these rows.
 */
export const ProjectBehaviorStore = {
  async countSessionsInWindow(
    queryable: Queryable,
    projectId: string,
    startMs: number,
    endMs: number,
  ): Promise<number> {
    const { rows } = await queryable.exec(COUNT_SESSIONS_IN_WINDOW_SQL, [
      projectId,
      startMs,
      endMs,
    ]);
    return toNumber(rows[0]?.c);
  },

  async getSessionDurationsInWindow(
    queryable: Queryable,
    projectId: string,
    startMs: number,
    endMs: number,
  ): Promise<readonly SessionDurationRow[]> {
    const { rows } = await queryable.exec(SESSION_DURATIONS_IN_WINDOW_SQL, [
      projectId,
      startMs,
      endMs,
    ]);
    return rows.map((r) => ({
      sessionId: toStringValue(r.session_id),
      durationMs: toNumber(r.duration_ms),
    }));
  },

  async getSessionTurnCountsInWindow(
    queryable: Queryable,
    projectId: string,
    startMs: number,
    endMs: number,
  ): Promise<readonly SessionTurnCountRow[]> {
    const { rows } = await queryable.exec(SESSION_TURN_COUNTS_IN_WINDOW_SQL, [
      projectId,
      startMs,
      endMs,
    ]);
    return rows.map((r) => ({
      sessionId: toStringValue(r.session_id),
      turnCount: toNumber(r.turn_count),
    }));
  },

  async getSessionTokensInWindow(
    queryable: Queryable,
    projectId: string,
    startMs: number,
    endMs: number,
  ): Promise<readonly SessionTokensRow[]> {
    const { rows } = await queryable.exec(SESSION_TOKENS_IN_WINDOW_SQL, [
      projectId,
      startMs,
      endMs,
    ]);
    return rows.map((r) => ({
      sessionId: toStringValue(r.session_id),
      tokensSum: toNumber(r.known_n) > 0 ? toNumber(r.tokens_sum) : null,
    }));
  },

  async getSessionCostInWindow(
    queryable: Queryable,
    projectId: string,
    startMs: number,
    endMs: number,
  ): Promise<readonly SessionCostRow[]> {
    const { rows } = await queryable.exec(SESSION_COST_IN_WINDOW_SQL, [projectId, startMs, endMs]);
    return rows.map((r) => ({
      sessionId: toStringValue(r.session_id),
      costSum: toOptionalNumber(r.cost_sum),
    }));
  },

  async getWeeklyToolInvocations(
    queryable: Queryable,
    projectId: string,
  ): Promise<readonly WeeklyToolInvocationRow[]> {
    const { rows } = await queryable.exec(WEEKLY_TOOL_INVOCATIONS_SQL, [projectId]);
    return rows.map((r) => ({
      weekBucket: toStringValue(r.week_bucket),
      totalToolCalls: toNumber(r.total),
      failedToolCalls: toNumber(r.failed),
    }));
  },

  async getTopToolsByInvocations(
    queryable: Queryable,
    projectId: string,
    startMs: number,
    endMs: number,
    limit: number,
  ): Promise<readonly TopToolRow[]> {
    const { rows } = await queryable.exec(TOP_TOOLS_BY_INVOCATIONS_SQL, [
      projectId,
      startMs,
      endMs,
      limit,
    ]);
    return rows.map((r) => ({
      componentId: toStringValue(r.component_id),
      displayName: toOptionalString(r.display_name),
      invocationCount: toNumber(r.c),
    }));
  },

  async getModelHarnessCohortRows(
    queryable: Queryable,
    projectId: string,
    startMs: number,
    endMs: number,
  ): Promise<readonly ModelHarnessCohortRawRow[]> {
    const { rows } = await queryable.exec(MODEL_HARNESS_COHORT_ROWS_SQL, [
      projectId,
      startMs,
      endMs,
    ]);
    return rows.map((r) => ({
      model: toStringValue(r.model),
      harness: toStringValue(r.harness),
      sessionId: toStringValue(r.session_id),
      tokensSum: toOptionalNumber(r.tokens_sum),
      costSum: toOptionalNumber(r.cost_sum),
      outcome: toOptionalString(r.outcome),
    }));
  },
};
