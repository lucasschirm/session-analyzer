import type {
  SqliteExecResult,
  SqliteExecutor,
  SqliteRow,
  SqliteTransaction,
  SqliteValue,
} from './contract.js';

export const GENERATION_STATUSES = ['pending', 'committed', 'failed', 'superseded'] as const;
export type GenerationStatus = (typeof GENERATION_STATUSES)[number];

export const SOURCE_AVAILABILITIES = ['local', 'remote_reacquirable', 'unavailable'] as const;
export type SourceAvailability = (typeof SOURCE_AVAILABILITIES)[number];

export const ISSUE_SEVERITIES = ['fatal', 'recoverable'] as const;
export type IssueSeverity = (typeof ISSUE_SEVERITIES)[number];

/**
 * Input required to register a new transformation generation. The generation
 * starts in `pending` status; it becomes visible only after an explicit commit.
 */
export interface BeginGenerationInput {
  readonly sessionId: string;
  readonly analysisReleaseId: string;
  readonly parserVersion: string;
  readonly transformerVersion: string;
  readonly ontologyVersion: string;
  readonly metricVersion: string;
  readonly schemaVersion: string;
  readonly sourceAvailability?: SourceAvailability;
}

export interface GenerationScopedTableColumn {
  readonly name: string;
  readonly type: string;
  readonly notNull?: boolean;
  readonly defaultValue?: SqliteValue;
}

export interface GenerationScopedTableSpec {
  readonly tableName: string;
  readonly baseColumns: readonly GenerationScopedTableColumn[];
  readonly businessKeyColumns: readonly string[];
}

/**
 * Validates and quotes a SQLite identifier. Rejects anything that is not a
 * plain `A-Za-z0-9_` name so dynamic DDL cannot be used for injection.
 */
function quoteIdentifier(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Invalid SQLite identifier: ${name}`);
  }
  return `"${name.replace(/"/g, '""')}"`;
}

function quoteTableName(name: string): string {
  return quoteIdentifier(name);
}

/**
 * Builds DDL for a generation-scoped evidence table.
 *
 * Every replaceable evidence, summary, provenance, contribution, chart,
 * lifecycle, and cohort table carries a `generation_id` foreign key. The
 * composite unique index on the business keys plus `generation_id` is what
 * allows candidate and current rows to coexist: two generations can hold
 * rows with the same business key as long as their `generation_id` differs.
 *
 * Actual evidence tables are created in later tasks; this helper encodes the
 * convention and gives callers a type-safe way to produce the same pattern.
 */
export function buildGenerationScopedTableSql(spec: GenerationScopedTableSpec): string {
  const table = quoteTableName(spec.tableName);
  const columns: string[] = [];

  for (const column of spec.baseColumns) {
    let def = `${quoteIdentifier(column.name)} ${column.type}`;
    if (column.notNull) {
      def += ' NOT NULL';
    }
    if (column.defaultValue !== undefined) {
      def += ` DEFAULT ${formatDefault(column.defaultValue)}`;
    }
    columns.push(def);
  }

  columns.push('generation_id TEXT NOT NULL');
  columns.push(`FOREIGN KEY (generation_id) REFERENCES transformation_generations(id)`);

  const uniqueColumns = spec.businessKeyColumns
    .map(quoteIdentifier)
    .concat(['generation_id'])
    .join(', ');

  return `
CREATE TABLE IF NOT EXISTS ${table} (
  ${columns.join(',\n  ')}
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`idx_${spec.tableName}_generation_scope`)}
  ON ${table} (${uniqueColumns});
`.trim();
}

function formatDefault(value: SqliteValue): string {
  if (value === null) return 'NULL';
  if (value === true) return '1';
  if (value === false) return '0';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'bigint') return String(value);
  if (value instanceof Uint8Array) {
    return (
      "X'" +
      Array.from(value)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('') +
      "'"
    );
  }
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * Builds the SQL and parameters for inserting one or more candidate rows into
 * a generation-scoped table. The helper appends `generation_id` to the column
 * list and to every row so that candidate rows satisfy the composite
 * uniqueness constraint and coexist with current rows.
 */
export function buildInsertCandidateSql(
  tableName: string,
  columnNames: readonly string[],
  rows: readonly (readonly SqliteValue[])[],
  generationId: string,
): { sql: string; params: SqliteValue[] } {
  const table = quoteTableName(tableName);
  const names = columnNames.map(quoteIdentifier).concat(['"generation_id"']);

  const placeholders: string[] = [];
  const params: SqliteValue[] = [];

  for (const row of rows) {
    if (row.length !== columnNames.length) {
      throw new Error(`Row length ${row.length} does not match column count ${columnNames.length}`);
    }
    const rowPlaceholders: string[] = [];
    for (const value of row) {
      rowPlaceholders.push('?');
      params.push(value);
    }
    rowPlaceholders.push('?');
    params.push(generationId);
    placeholders.push(`(${rowPlaceholders.join(', ')})`);
  }

  const sql = `INSERT INTO ${table} (${names.join(', ')}) VALUES ${placeholders.join(', ')};`;
  return { sql, params };
}

/**
 * Inserts one or more candidate rows into a generation-scoped table inside the
 * current transaction.
 */
export async function insertCandidateRows(
  tx: SqliteTransaction,
  tableName: string,
  columnNames: readonly string[],
  rows: readonly (readonly SqliteValue[])[],
  generationId: string,
): Promise<SqliteExecResult> {
  const { sql, params } = buildInsertCandidateSql(tableName, columnNames, rows, generationId);
  return await tx.exec(sql, params);
}

/**
 * Registers a pending `transformation_generations` row. The row is not visible
 * to readers until it is committed.
 */
export async function beginGeneration(
  tx: SqliteTransaction,
  generationId: string,
  input: BeginGenerationInput,
  createdAt = Date.now(),
): Promise<void> {
  const sourceAvailability = input.sourceAvailability ?? 'local';
  await tx.exec(
    `INSERT INTO transformation_generations (
      id, session_id, analysis_release_id, parser_version, transformer_version,
      ontology_version, metric_version, schema_version, status, source_availability, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    [
      generationId,
      input.sessionId,
      input.analysisReleaseId,
      input.parserVersion,
      input.transformerVersion,
      input.ontologyVersion,
      input.metricVersion,
      input.schemaVersion,
      sourceAvailability,
      createdAt,
    ],
  );
}

/**
 * Atomically makes `generationId` the current generation for `sessionId`.
 *
 * 1. Supersede the previous committed generation for the session.
 * 2. Mark `generationId` as `committed`.
 * 3. Update `sessions.current_generation_id` to `generationId`.
 *
 * Readers see the previous complete generation until this transaction commits;
 * rollback leaves it unchanged.
 */
export async function commitGeneration(
  tx: SqliteTransaction,
  sessionId: string,
  generationId: string,
  committedAt = Date.now(),
): Promise<void> {
  const { rows } = await tx.exec(
    'SELECT session_id, status FROM transformation_generations WHERE id = ?',
    [generationId],
  );
  if (rows.length === 0) {
    throw new Error(`Generation not found: ${generationId}`);
  }
  const owner = String(rows[0].session_id);
  if (owner !== sessionId) {
    throw new Error(`Generation ${generationId} belongs to session ${owner}, not ${sessionId}`);
  }

  await tx.exec(
    `UPDATE transformation_generations
     SET status = 'superseded', superseded_by_id = ?, superseded_at = ?
     WHERE session_id = ? AND status = 'committed'`,
    [generationId, committedAt, sessionId],
  );

  await tx.exec(
    `UPDATE transformation_generations
     SET status = 'committed', committed_at = ?
     WHERE id = ? AND status = 'pending'`,
    [committedAt, generationId],
  );

  await tx.exec('UPDATE sessions SET current_generation_id = ? WHERE id = ?', [
    generationId,
    sessionId,
  ]);
}

/**
 * Marks a pending generation as `failed`. The session's current generation is
 * not touched, so readers continue to see the previous complete generation.
 */
export async function rollbackGeneration(
  tx: SqliteTransaction,
  generationId: string,
): Promise<void> {
  const { rows } = await tx.exec('SELECT status FROM transformation_generations WHERE id = ?', [
    generationId,
  ]);
  if (rows.length === 0) {
    throw new Error(`Generation not found: ${generationId}`);
  }
  const status = String(rows[0].status);
  if (status !== 'pending') {
    throw new Error(`Cannot rollback generation ${generationId}: status is ${status}`);
  }

  await tx.exec("UPDATE transformation_generations SET status = 'failed' WHERE id = ?", [
    generationId,
  ]);
}

/** Returns the currently visible generation for a session, if any. */
export async function getCurrentGenerationId(
  executor: SqliteExecutor,
  sessionId: string,
): Promise<string | undefined> {
  const { rows } = await executor.exec('SELECT current_generation_id FROM sessions WHERE id = ?', [
    sessionId,
  ]);
  const value = rows[0]?.current_generation_id;
  return value === null || value === undefined ? undefined : String(value);
}

/**
 * Reads visible rows from a generation-scoped table for a session. Visible
 * rows are those whose `generation_id` equals the session's
 * `current_generation_id`.
 */
export async function getVisibleRows(
  executor: SqliteExecutor,
  sessionId: string,
  tableName: string,
): Promise<readonly SqliteRow[]> {
  const table = quoteTableName(tableName);
  const { rows } = await executor.exec(
    `SELECT * FROM ${table}
     WHERE generation_id = (SELECT current_generation_id FROM sessions WHERE id = ?)`,
    [sessionId],
  );
  return rows;
}
