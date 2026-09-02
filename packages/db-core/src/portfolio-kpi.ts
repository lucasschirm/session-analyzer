import type { SqliteExecutor, SqliteTransaction, SqliteValue } from './contract.js';

type Queryable = SqliteExecutor | SqliteTransaction;

function toNumber(value: SqliteValue): number {
  return value === null || value === undefined ? 0 : Number(value);
}

function toStringValue(value: SqliteValue): string {
  return value === null || value === undefined ? '' : String(value);
}

const COUNT_SESSIONS_IN_WINDOW_SQL = `
  SELECT COUNT(*) AS c
  FROM sessions s
  JOIN projects p ON p.id = s.project_id
  WHERE p.portfolio_id = ?
    AND s.start_time IS NOT NULL
    AND s.start_time >= ? AND s.start_time < ?
`;

/** Raw token totals for a portfolio window (issue #169). Sums exclude requests
 * with a null `input_tokens`/`output_tokens`; each side tracks its own known
 * count so a missing token count never lowers the sum silently. */
export interface TokenWindowTotals {
  readonly inputTokensSum: number;
  readonly inputKnownN: number;
  readonly outputTokensSum: number;
  readonly outputKnownN: number;
  readonly eligibleN: number;
}

const SUM_TOKENS_IN_WINDOW_SQL = `
  SELECT
    COALESCE(SUM(mr.input_tokens), 0) AS input_sum,
    SUM(CASE WHEN mr.input_tokens IS NOT NULL THEN 1 ELSE 0 END) AS input_known,
    COALESCE(SUM(mr.output_tokens), 0) AS output_sum,
    SUM(CASE WHEN mr.output_tokens IS NOT NULL THEN 1 ELSE 0 END) AS output_known,
    COUNT(*) AS eligible
  FROM model_requests mr
  JOIN sessions s ON s.id = mr.session_id
  JOIN projects p ON p.id = s.project_id
  WHERE p.portfolio_id = ?
    AND s.start_time IS NOT NULL
    AND s.start_time >= ? AND s.start_time < ?
`;

/** Cost coverage for a portfolio window (issue #169). `costSum` only sums
 * `model_usage.cost` rows that are non-null; a harness with zero non-null
 * cost rows in the window is a coverage gap, not a $0 cost. */
export interface CostWindowTotals {
  readonly costSum: number;
  readonly reportedHarnesses: number;
  readonly totalHarnesses: number;
}

const SUM_COST_IN_WINDOW_SQL = `
  SELECT COALESCE(SUM(mu.cost), 0) AS cost_sum
  FROM model_usage mu
  JOIN sessions s ON s.id = mu.session_id
  JOIN projects p ON p.id = s.project_id
  WHERE p.portfolio_id = ? AND mu.cost IS NOT NULL
    AND s.start_time IS NOT NULL
    AND s.start_time >= ? AND s.start_time < ?
`;

const COUNT_REPORTED_HARNESSES_SQL = `
  SELECT COUNT(DISTINCT s.harness) AS c
  FROM model_usage mu
  JOIN sessions s ON s.id = mu.session_id
  JOIN projects p ON p.id = s.project_id
  WHERE p.portfolio_id = ? AND mu.cost IS NOT NULL
    AND s.start_time IS NOT NULL
    AND s.start_time >= ? AND s.start_time < ?
`;

const COUNT_TOTAL_HARNESSES_SQL = `
  SELECT COUNT(DISTINCT s.harness) AS c
  FROM sessions s
  JOIN projects p ON p.id = s.project_id
  WHERE p.portfolio_id = ?
    AND s.start_time IS NOT NULL
    AND s.start_time >= ? AND s.start_time < ?
`;

/** Clean-completion counts for a portfolio window (issue #169), scoped to
 * `finality = 'final'` sessions per `SESSION_OUTCOME_METRIC_DEFINITION`
 * (`packages/db/src/metric-registry.ts`). `knownN` is the subset with a
 * classified (non-null) outcome; `cleanN` is the `'clean'` subset of that. */
export interface CleanCompletionWindowTotals {
  readonly cleanN: number;
  readonly knownN: number;
  readonly eligibleN: number;
}

const CLEAN_COMPLETION_IN_WINDOW_SQL = `
  SELECT
    SUM(CASE WHEN s.outcome = 'clean' THEN 1 ELSE 0 END) AS clean_n,
    SUM(CASE WHEN s.outcome IS NOT NULL THEN 1 ELSE 0 END) AS known_n,
    COUNT(*) AS eligible_n
  FROM sessions s
  JOIN projects p ON p.id = s.project_id
  WHERE p.portfolio_id = ? AND s.finality = 'final'
    AND s.start_time IS NOT NULL
    AND s.start_time >= ? AND s.start_time < ?
`;

/** One row of the sessions-by-model bar list (issue #169). Sessions with no
 * `model_requests` row are grouped under `model = 'unknown'`, a real
 * observed bucket, not a dropped/missing one. */
export interface ModelSessionCountRow {
  readonly model: string;
  readonly sessionCount: number;
}

const SESSIONS_BY_MODEL_IN_WINDOW_SQL = `
  SELECT COALESCE(mr.model, 'unknown') AS model, COUNT(DISTINCT s.id) AS session_count
  FROM sessions s
  JOIN projects p ON p.id = s.project_id
  LEFT JOIN model_requests mr ON mr.session_id = s.id
  WHERE p.portfolio_id = ?
    AND s.start_time IS NOT NULL
    AND s.start_time >= ? AND s.start_time < ?
  GROUP BY COALESCE(mr.model, 'unknown')
  ORDER BY session_count DESC, model ASC
`;

/** One (model, harness) pair's session count within a window (issue #169). */
export interface ModelHarnessPairCountRow {
  readonly model: string;
  readonly harness: string;
  readonly sessionCount: number;
}

const MODEL_HARNESS_COUNTS_IN_WINDOW_SQL = `
  SELECT mr.model AS model, s.harness AS harness, COUNT(DISTINCT s.id) AS session_count
  FROM sessions s
  JOIN projects p ON p.id = s.project_id
  JOIN model_requests mr ON mr.session_id = s.id
  WHERE p.portfolio_id = ? AND mr.model IS NOT NULL
    AND s.start_time IS NOT NULL
    AND s.start_time >= ? AND s.start_time < ?
  GROUP BY mr.model, s.harness
`;

/** A (model, harness) pair, keyed identically to
 * {@link ModelHarnessPairCountRow}, that has ever been observed in the
 * portfolio (no time window) — used to distinguish "never runs this
 * combination" (missing) from "ran it, zero sessions this window" (0). */
export interface ModelHarnessPairKey {
  readonly model: string;
  readonly harness: string;
}

const MODEL_HARNESS_PAIRS_EVER_OBSERVED_SQL = `
  SELECT DISTINCT mr.model AS model, s.harness AS harness
  FROM sessions s
  JOIN projects p ON p.id = s.project_id
  JOIN model_requests mr ON mr.session_id = s.id
  WHERE p.portfolio_id = ? AND mr.model IS NOT NULL
`;

/** One invocation-domain bucket's count within a window (issue #169). `kind`
 * is always one of the four canonical `INVOCATION_KINDS`
 * (`packages/db-core/src/session-evidence.ts`); MCP-server calls are stored
 * with `kind = 'tool'` and are counted inside the `tool` bucket, never as a
 * fifth domain (`.agents/rules/analytics-domain-distinctions.md`). */
export interface InvocationDomainCountRow {
  readonly kind: string;
  readonly count: number;
}

const INVOCATIONS_BY_DOMAIN_IN_WINDOW_SQL = `
  SELECT i.kind AS kind, COUNT(*) AS c
  FROM invocations i
  JOIN sessions s ON s.id = i.session_id
  JOIN projects p ON p.id = s.project_id
  WHERE p.portfolio_id = ?
    AND i.created_at >= ? AND i.created_at < ?
  GROUP BY i.kind
`;

const TOTAL_INVOCATIONS_IN_WINDOW_SQL = `
  SELECT COUNT(*) AS c
  FROM invocations i
  JOIN sessions s ON s.id = i.session_id
  JOIN projects p ON p.id = s.project_id
  WHERE p.portfolio_id = ?
    AND i.created_at >= ? AND i.created_at < ?
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

  async sumTokensInWindow(
    queryable: Queryable,
    portfolioId: string,
    startMs: number,
    endMs: number,
  ): Promise<TokenWindowTotals> {
    const { rows } = await queryable.exec(SUM_TOKENS_IN_WINDOW_SQL, [portfolioId, startMs, endMs]);
    const row = rows[0];
    return {
      inputTokensSum: toNumber(row?.input_sum),
      inputKnownN: toNumber(row?.input_known),
      outputTokensSum: toNumber(row?.output_sum),
      outputKnownN: toNumber(row?.output_known),
      eligibleN: toNumber(row?.eligible),
    };
  },

  async sumCostInWindow(
    queryable: Queryable,
    portfolioId: string,
    startMs: number,
    endMs: number,
  ): Promise<CostWindowTotals> {
    const params = [portfolioId, startMs, endMs];
    const [{ rows: costRows }, { rows: reportedRows }, { rows: totalRows }] = await Promise.all([
      queryable.exec(SUM_COST_IN_WINDOW_SQL, params),
      queryable.exec(COUNT_REPORTED_HARNESSES_SQL, params),
      queryable.exec(COUNT_TOTAL_HARNESSES_SQL, params),
    ]);
    return {
      costSum: toNumber(costRows[0]?.cost_sum),
      reportedHarnesses: toNumber(reportedRows[0]?.c),
      totalHarnesses: toNumber(totalRows[0]?.c),
    };
  },

  async getCleanCompletionInWindow(
    queryable: Queryable,
    portfolioId: string,
    startMs: number,
    endMs: number,
  ): Promise<CleanCompletionWindowTotals> {
    const { rows } = await queryable.exec(CLEAN_COMPLETION_IN_WINDOW_SQL, [
      portfolioId,
      startMs,
      endMs,
    ]);
    const row = rows[0];
    return {
      cleanN: toNumber(row?.clean_n),
      knownN: toNumber(row?.known_n),
      eligibleN: toNumber(row?.eligible_n),
    };
  },

  async getSessionsByModelInWindow(
    queryable: Queryable,
    portfolioId: string,
    startMs: number,
    endMs: number,
  ): Promise<readonly ModelSessionCountRow[]> {
    const { rows } = await queryable.exec(SESSIONS_BY_MODEL_IN_WINDOW_SQL, [
      portfolioId,
      startMs,
      endMs,
    ]);
    return rows.map((r) => ({
      model: toStringValue(r.model),
      sessionCount: toNumber(r.session_count),
    }));
  },

  async getModelHarnessCountsInWindow(
    queryable: Queryable,
    portfolioId: string,
    startMs: number,
    endMs: number,
  ): Promise<readonly ModelHarnessPairCountRow[]> {
    const { rows } = await queryable.exec(MODEL_HARNESS_COUNTS_IN_WINDOW_SQL, [
      portfolioId,
      startMs,
      endMs,
    ]);
    return rows.map((r) => ({
      model: toStringValue(r.model),
      harness: toStringValue(r.harness),
      sessionCount: toNumber(r.session_count),
    }));
  },

  async getModelHarnessPairsEverObserved(
    queryable: Queryable,
    portfolioId: string,
  ): Promise<readonly ModelHarnessPairKey[]> {
    const { rows } = await queryable.exec(MODEL_HARNESS_PAIRS_EVER_OBSERVED_SQL, [portfolioId]);
    return rows.map((r) => ({ model: toStringValue(r.model), harness: toStringValue(r.harness) }));
  },

  async getInvocationsByDomainInWindow(
    queryable: Queryable,
    portfolioId: string,
    startMs: number,
    endMs: number,
  ): Promise<readonly InvocationDomainCountRow[]> {
    const { rows } = await queryable.exec(INVOCATIONS_BY_DOMAIN_IN_WINDOW_SQL, [
      portfolioId,
      startMs,
      endMs,
    ]);
    return rows.map((r) => ({ kind: toStringValue(r.kind), count: toNumber(r.c) }));
  },

  async countTotalInvocationsInWindow(
    queryable: Queryable,
    portfolioId: string,
    startMs: number,
    endMs: number,
  ): Promise<number> {
    const { rows } = await queryable.exec(TOTAL_INVOCATIONS_IN_WINDOW_SQL, [
      portfolioId,
      startMs,
      endMs,
    ]);
    return toNumber(rows[0]?.c);
  },
};
