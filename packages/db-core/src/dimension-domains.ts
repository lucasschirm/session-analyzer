import type { SqliteExecutor, SqliteTransaction, SqliteValue } from './contract.js';

type Queryable = SqliteExecutor | SqliteTransaction;

function asString(value: SqliteValue): string {
  return value === null || value === undefined ? '' : String(value);
}

async function distinctColumn(
  queryable: Queryable,
  sql: string,
  portfolioId: string,
): Promise<readonly string[]> {
  const { rows } = await queryable.exec(sql, [portfolioId]);
  return rows.map((row) => asString(row.value)).filter((value) => value.length > 0);
}

const PROJECT_DOMAIN_SQL = `
  SELECT DISTINCT p.name AS value
  FROM projects p
  WHERE p.portfolio_id = ?
  ORDER BY value
`;

const HARNESS_DOMAIN_SQL = `
  SELECT DISTINCT s.harness AS value
  FROM sessions s
  JOIN projects p ON p.id = s.project_id
  WHERE p.portfolio_id = ?
  ORDER BY value
`;

const MODEL_DOMAIN_SQL = `
  SELECT DISTINCT mr.model AS value
  FROM model_requests mr
  JOIN sessions s ON s.id = mr.session_id
  JOIN projects p ON p.id = s.project_id
  WHERE p.portfolio_id = ? AND mr.model IS NOT NULL
  ORDER BY value
`;

/**
 * Distinct dimension-value lists (project / harness / model) computed over
 * the *unfiltered* store for a portfolio (issue #169) — backs the filter-bar
 * chips (sub-issue 4). Unlike `MetadataView.getFilterMetadata`, which only
 * returns field *names*, this returns actual observed *values*. A value
 * list can legitimately be empty (no sessions yet); that is reported as an
 * empty array, never as a missing/errored domain.
 */
export const DimensionDomainStore = {
  async getProjectDomain(queryable: Queryable, portfolioId: string): Promise<readonly string[]> {
    return distinctColumn(queryable, PROJECT_DOMAIN_SQL, portfolioId);
  },

  async getHarnessDomain(queryable: Queryable, portfolioId: string): Promise<readonly string[]> {
    return distinctColumn(queryable, HARNESS_DOMAIN_SQL, portfolioId);
  },

  async getModelDomain(queryable: Queryable, portfolioId: string): Promise<readonly string[]> {
    return distinctColumn(queryable, MODEL_DOMAIN_SQL, portfolioId);
  },
};
