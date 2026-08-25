import type { SqliteExecutor, SqliteRow, SqliteTransaction, SqliteValue } from './contract.js';
import { deterministicId } from './identity.js';
import type { Migration } from './migrations.js';

type Queryable = SqliteExecutor | SqliteTransaction;

/**
 * Pure-JS FNV-1a 64-bit checksum used for migration integrity. It does not
 * import a runtime crypto implementation, so it keeps `db-core` free of
 * forbidden Node/DOM/Worker dependencies.
 */
function fnv1a64(input: string): bigint {
  let hash = 14695981039346656037n;
  const prime = 1099511628211n;
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = (hash * prime) & 0xffffffffffffffffn;
  }
  return hash;
}

function checksumOf(sql: string): string {
  return fnv1a64(sql).toString(16).padStart(16, '0');
}

interface ForeignKey {
  readonly table: string;
  readonly column: string;
  readonly onDelete: string;
}

interface Column {
  readonly name: string;
  readonly field: string;
  readonly type: 'TEXT' | 'INTEGER' | 'REAL' | 'BLOB';
  readonly pkey?: boolean;
  readonly notNull?: boolean;
  readonly default?: SqliteValue;
  readonly fk?: ForeignKey;
  readonly check?: string;
  readonly isBoolean?: boolean;
}

interface IndexSpec {
  readonly name: string;
  readonly columns: readonly string[];
  readonly unique?: boolean;
}

function formatDefault(value: SqliteValue): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'string') return `'${value.replace(/'/g, "''")}'`;
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return 'NULL';
}

function buildColumnDef(column: Column): string {
  let sql = `${column.name} ${column.type}`;
  if (column.pkey) sql += ' PRIMARY KEY';
  if (column.notNull) sql += ' NOT NULL';
  if (column.default !== undefined) sql += ` DEFAULT ${formatDefault(column.default)}`;
  if (column.fk) {
    sql += ` REFERENCES ${column.fk.table}(${column.fk.column}) ON DELETE ${column.fk.onDelete}`;
  }
  if (column.check) sql += ` CHECK(${column.check})`;
  return sql;
}

function buildCreateTable(
  name: string,
  columns: readonly Column[],
  indexes: readonly IndexSpec[],
  extraChecks: readonly string[] = [],
): string {
  const defs = columns.map(buildColumnDef);
  const checks = [...extraChecks];
  let sql = `CREATE TABLE IF NOT EXISTS ${name} (\n${defs.map((d) => `  ${d}`).join(',\n')}`;
  if (checks.length > 0) {
    sql += `,\n${checks.map((c) => `  CHECK (${c})`).join(',\n')}`;
  }
  sql += '\n) STRICT;\n';
  for (const index of indexes) {
    const unique = index.unique ? 'UNIQUE ' : '';
    sql += `CREATE ${unique}INDEX IF NOT EXISTS ${index.name} ON ${name}(${index.columns.join(', ')});\n`;
  }
  return sql;
}

function buildInsertSql(table: string, columns: readonly Column[]): string {
  const insertColumns = columns.map((c) => c.name);
  const placeholders = insertColumns.map(() => '?').join(', ');
  return `INSERT INTO ${table} (${insertColumns.join(', ')}) VALUES (${placeholders})`;
}

function valueToSql(value: unknown, column: Column): SqliteValue {
  if (value === null || value === undefined) return null;
  if (column.isBoolean) return value ? 1 : 0;
  if (column.type === 'INTEGER' || column.type === 'REAL') return Number(value);
  if (column.type === 'BLOB') return value instanceof Uint8Array ? value : null;
  return String(value);
}

type InsertInput<T> = Omit<T, 'id' | 'createdAt' | 'updatedAt'> & {
  id?: string;
  createdAt?: number;
  updatedAt?: number;
};

type UpdateInput<T> = Partial<Omit<T, 'id' | 'createdAt'>>;

function toInsertParams<Insert>(
  columns: readonly Column[],
  input: Insert,
  id: string,
  now: number,
): SqliteValue[] {
  const record = input as unknown as Record<string, unknown>;
  const params: SqliteValue[] = [];
  for (const column of columns) {
    if (column.pkey) {
      params.push(id);
      continue;
    }
    if (column.name === 'created_at' || column.name === 'updated_at') {
      params.push(record[column.field] === undefined ? now : (record[column.field] as number));
      continue;
    }
    const value = record[column.field];
    if (value === undefined) {
      params.push(column.default === undefined ? null : column.default);
    } else {
      params.push(valueToSql(value, column));
    }
  }
  return params;
}

interface UpdateSql {
  readonly sql: string;
  readonly params: SqliteValue[];
}

function buildUpdate<Update>(
  table: string,
  columns: readonly Column[],
  input: Update,
  id: string,
  now: number,
  parentColumn?: string,
  parentId?: string,
): UpdateSql {
  const record = input as unknown as Record<string, unknown>;
  const sets: string[] = [];
  const params: SqliteValue[] = [];
  for (const column of columns) {
    if (column.pkey || column.name === 'created_at' || column.name === 'updated_at') continue;
    if (!(column.field in record)) continue;
    const value = record[column.field];
    if (value === undefined) continue;
    sets.push(`${column.name} = ?`);
    params.push(valueToSql(value, column));
  }
  if (sets.length === 0) {
    throw new Error('Update input has no fields');
  }
  sets.push('updated_at = ?');
  params.push(now, id);
  let where = 'id = ?';
  if (parentColumn !== undefined && parentId !== undefined) {
    where += ` AND ${parentColumn} = ?`;
    params.push(parentId);
  }
  const sql = `UPDATE ${table} SET ${sets.join(', ')} WHERE ${where}`;
  return { sql, params };
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

function toBoolean(value: SqliteValue): boolean {
  return value === 1 || value === true;
}

export const ROLLUP_ROOT_INCLUSIONS = ['root_only', 'inclusive', 'both', 'not_applicable'] as const;
export type RollupRootInclusion = (typeof ROLLUP_ROOT_INCLUSIONS)[number];

export const CONTRIBUTION_SCOPES = ['root_only', 'inclusive'] as const;
export type ContributionScope = (typeof CONTRIBUTION_SCOPES)[number];

export const COHORT_TYPES = ['before_after', 'matched', 'concurrent'] as const;
export type CohortType = (typeof COHORT_TYPES)[number];

export const COHORT_GROUP_LABELS = ['before', 'after', 'control', 'treatment', 'matched'] as const;
export type CohortGroupLabel = (typeof COHORT_GROUP_LABELS)[number];

export const INSIGHT_KINDS = ['trend', 'anomaly', 'comparison', 'coverage', 'performance'] as const;
export type InsightKind = (typeof INSIGHT_KINDS)[number];

export const ROLLUP_COMPONENT_KINDS = [
  'tool',
  'skill',
  'agent',
  'sub_agent',
  'rule',
  'mcp_server',
  'plugin',
  'setting',
  'model',
] as const;
export type RollupComponentKind = (typeof ROLLUP_COMPONENT_KINDS)[number];

// rollup_policies

const ROLLUP_POLICY_COLUMNS: readonly Column[] = [
  { name: 'id', field: 'id', type: 'TEXT', pkey: true, notNull: true },
  { name: 'policy_id', field: 'policyId', type: 'TEXT', notNull: true },
  { name: 'version', field: 'version', type: 'INTEGER', notNull: true },
  { name: 'name', field: 'name', type: 'TEXT', notNull: true },
  { name: 'description', field: 'description', type: 'TEXT' },
  {
    name: 'supported_dimensions',
    field: 'supportedDimensions',
    type: 'TEXT',
    notNull: true,
    default: '[]',
  },
  {
    name: 'cardinality_caps',
    field: 'cardinalityCaps',
    type: 'TEXT',
    notNull: true,
    default: '{}',
  },
  { name: 'top_n_behavior', field: 'topNBehavior', type: 'TEXT', notNull: true },
  {
    name: 'other_bucket_label',
    field: 'otherBucketLabel',
    type: 'TEXT',
    notNull: true,
    default: 'Other',
  },
  {
    name: 'unknown_bucket_label',
    field: 'unknownBucketLabel',
    type: 'TEXT',
    notNull: true,
    default: 'Unknown',
  },
  { name: 'bucket_timezone', field: 'bucketTimezone', type: 'TEXT', notNull: true, default: 'UTC' },
  {
    name: 'analysis_release_id',
    field: 'analysisReleaseId',
    type: 'TEXT',
    notNull: true,
    fk: { table: 'analysis_releases', column: 'id', onDelete: 'CASCADE' },
  },
  { name: 'created_at', field: 'createdAt', type: 'INTEGER', notNull: true },
  { name: 'updated_at', field: 'updatedAt', type: 'INTEGER', notNull: true },
];

const ROLLUP_POLICY_INDEXES: readonly IndexSpec[] = [
  { name: 'idx_rollup_policies_analysis_release', columns: ['analysis_release_id'] },
  { name: 'idx_rollup_policies_name', columns: ['name'] },
  { name: 'idx_rollup_policies_unique', columns: ['policy_id', 'version'], unique: true },
];

export const CREATE_ROLLUP_POLICIES_TABLE = buildCreateTable(
  'rollup_policies',
  ROLLUP_POLICY_COLUMNS,
  ROLLUP_POLICY_INDEXES,
);

export interface RollupPolicy {
  readonly id: string;
  readonly policyId: string;
  readonly version: number;
  readonly name: string;
  readonly description: string | null;
  readonly supportedDimensions: string;
  readonly cardinalityCaps: string;
  readonly topNBehavior: string;
  readonly otherBucketLabel: string;
  readonly unknownBucketLabel: string;
  readonly bucketTimezone: string;
  readonly analysisReleaseId: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type InsertRollupPolicyInput = InsertInput<RollupPolicy>;
export type UpdateRollupPolicyInput = UpdateInput<RollupPolicy>;

// biome-ignore lint/complexity/noStaticOnlyClass: typed rollup store
export class RollupPolicyStore {
  private static rowToRollupPolicy(row: SqliteRow): RollupPolicy {
    return {
      id: asString(row.id),
      policyId: asString(row.policy_id),
      version: toNumber(row.version),
      name: asString(row.name),
      description: toOptionalString(row.description),
      supportedDimensions: asString(row.supported_dimensions),
      cardinalityCaps: asString(row.cardinality_caps),
      topNBehavior: asString(row.top_n_behavior),
      otherBucketLabel: asString(row.other_bucket_label),
      unknownBucketLabel: asString(row.unknown_bucket_label),
      bucketTimezone: asString(row.bucket_timezone),
      analysisReleaseId: asString(row.analysis_release_id),
      createdAt: toNumber(row.created_at),
      updatedAt: toNumber(row.updated_at),
    };
  }

  static async insert(queryable: Queryable, input: InsertRollupPolicyInput): Promise<string> {
    const now = Date.now();
    const record = input as unknown as Record<string, unknown>;
    const id =
      (record.id as string | undefined) ??
      `rp-${deterministicId('rollup-policy', input.policyId, String(input.version))}`;
    await queryable.exec(
      buildInsertSql('rollup_policies', ROLLUP_POLICY_COLUMNS),
      toInsertParams<InsertRollupPolicyInput>(ROLLUP_POLICY_COLUMNS, input, id, now),
    );
    return id;
  }

  static async getById(queryable: Queryable, id: string): Promise<RollupPolicy | undefined> {
    const { rows } = await queryable.exec('SELECT * FROM rollup_policies WHERE id = ?', [id]);
    if (rows.length === 0) return undefined;
    return RollupPolicyStore.rowToRollupPolicy(rows[0]);
  }

  static async getByPolicyIdAndVersion(
    queryable: Queryable,
    policyId: string,
    version: number,
  ): Promise<RollupPolicy | undefined> {
    const { rows } = await queryable.exec(
      'SELECT * FROM rollup_policies WHERE policy_id = ? AND version = ?',
      [policyId, version],
    );
    if (rows.length === 0) return undefined;
    return RollupPolicyStore.rowToRollupPolicy(rows[0]);
  }

  static async listByAnalysisRelease(
    queryable: Queryable,
    analysisReleaseId: string,
  ): Promise<readonly RollupPolicy[]> {
    const { rows } = await queryable.exec(
      'SELECT * FROM rollup_policies WHERE analysis_release_id = ? ORDER BY version',
      [analysisReleaseId],
    );
    return rows.map(RollupPolicyStore.rowToRollupPolicy);
  }

  static async listAll(queryable: Queryable): Promise<readonly RollupPolicy[]> {
    const { rows } = await queryable.exec('SELECT * FROM rollup_policies ORDER BY name, version');
    return rows.map(RollupPolicyStore.rowToRollupPolicy);
  }

  static async update(
    queryable: Queryable,
    id: string,
    input: UpdateRollupPolicyInput,
  ): Promise<void> {
    const now = Date.now();
    const { sql, params } = buildUpdate<UpdateRollupPolicyInput>(
      'rollup_policies',
      ROLLUP_POLICY_COLUMNS,
      input,
      id,
      now,
    );
    await queryable.exec(sql, params);
  }

  static async delete(queryable: Queryable, id: string): Promise<void> {
    await queryable.exec('DELETE FROM rollup_policies WHERE id = ?', [id]);
  }
}

// session_summaries

const SESSION_SUMMARY_COLUMNS: readonly Column[] = [
  { name: 'id', field: 'id', type: 'TEXT', pkey: true, notNull: true },
  {
    name: 'session_id',
    field: 'sessionId',
    type: 'TEXT',
    notNull: true,
    fk: { table: 'sessions', column: 'id', onDelete: 'CASCADE' },
  },
  {
    name: 'generation_id',
    field: 'generationId',
    type: 'TEXT',
    notNull: true,
    fk: { table: 'transformation_generations', column: 'id', onDelete: 'CASCADE' },
  },
  {
    name: 'analysis_release_id',
    field: 'analysisReleaseId',
    type: 'TEXT',
    notNull: true,
    fk: { table: 'analysis_releases', column: 'id', onDelete: 'RESTRICT' },
  },
  {
    name: 'root_inclusion',
    field: 'rootInclusion',
    type: 'TEXT',
    notNull: true,
    default: 'root_only',
    check: `root_inclusion IN ('root_only', 'inclusive', 'both', 'not_applicable')`,
  },
  {
    name: 'headline_metrics',
    field: 'headlineMetrics',
    type: 'TEXT',
    notNull: true,
    default: '[]',
  },
  {
    name: 'capability_coverage',
    field: 'capabilityCoverage',
    type: 'TEXT',
    notNull: true,
    default: '[]',
  },
  { name: 'observed_outcome_state', field: 'observedOutcomeState', type: 'TEXT' },
  {
    name: 'source_completeness',
    field: 'sourceCompleteness',
    type: 'TEXT',
    notNull: true,
    default: '{}',
  },
  { name: 'created_at', field: 'createdAt', type: 'INTEGER', notNull: true },
  { name: 'updated_at', field: 'updatedAt', type: 'INTEGER', notNull: true },
];

const SESSION_SUMMARY_INDEXES: readonly IndexSpec[] = [
  {
    name: 'idx_session_summaries_unique',
    columns: ['session_id', 'generation_id', 'analysis_release_id', 'root_inclusion'],
    unique: true,
  },
  { name: 'idx_session_summaries_session', columns: ['session_id'] },
  { name: 'idx_session_summaries_generation', columns: ['generation_id'] },
  { name: 'idx_session_summaries_release', columns: ['analysis_release_id'] },
];

export const CREATE_SESSION_SUMMARIES_TABLE = buildCreateTable(
  'session_summaries',
  SESSION_SUMMARY_COLUMNS,
  SESSION_SUMMARY_INDEXES,
);

export interface SessionSummary {
  readonly id: string;
  readonly sessionId: string;
  readonly generationId: string;
  readonly analysisReleaseId: string;
  readonly rootInclusion: RollupRootInclusion;
  readonly headlineMetrics: string;
  readonly capabilityCoverage: string;
  readonly observedOutcomeState: string | null;
  readonly sourceCompleteness: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type InsertSessionSummaryInput = InsertInput<SessionSummary>;
export type UpdateSessionSummaryInput = UpdateInput<SessionSummary>;

// biome-ignore lint/complexity/noStaticOnlyClass: typed rollup store
export class SessionSummaryStore {
  private static rowToSessionSummary(row: SqliteRow): SessionSummary {
    return {
      id: asString(row.id),
      sessionId: asString(row.session_id),
      generationId: asString(row.generation_id),
      analysisReleaseId: asString(row.analysis_release_id),
      rootInclusion: asString(row.root_inclusion) as RollupRootInclusion,
      headlineMetrics: asString(row.headline_metrics),
      capabilityCoverage: asString(row.capability_coverage),
      observedOutcomeState: toOptionalString(row.observed_outcome_state),
      sourceCompleteness: asString(row.source_completeness),
      createdAt: toNumber(row.created_at),
      updatedAt: toNumber(row.updated_at),
    };
  }

  private static selectColumns(): string {
    return SESSION_SUMMARY_COLUMNS.map((c) => c.name).join(', ');
  }

  static async insert(queryable: Queryable, input: InsertSessionSummaryInput): Promise<string> {
    const now = Date.now();
    const record = input as unknown as Record<string, unknown>;
    const id =
      (record.id as string | undefined) ??
      `ssu-${deterministicId(
        'session-summary',
        input.sessionId,
        input.generationId,
        input.rootInclusion,
        String(now),
      )}`;
    await queryable.exec(
      buildInsertSql('session_summaries', SESSION_SUMMARY_COLUMNS),
      toInsertParams<InsertSessionSummaryInput>(SESSION_SUMMARY_COLUMNS, input, id, now),
    );
    return id;
  }

  static async getById(queryable: Queryable, id: string): Promise<SessionSummary | undefined> {
    const { rows } = await queryable.exec(
      `SELECT ${SessionSummaryStore.selectColumns()} FROM session_summaries WHERE id = ?`,
      [id],
    );
    if (rows.length === 0) return undefined;
    return SessionSummaryStore.rowToSessionSummary(rows[0]);
  }

  static async getBySessionAndInclusion(
    queryable: Queryable,
    sessionId: string,
    rootInclusion: RollupRootInclusion,
  ): Promise<SessionSummary | undefined> {
    const { rows } = await queryable.exec(
      `SELECT ${SessionSummaryStore.selectColumns()}
       FROM session_summaries
       WHERE session_id = ? AND root_inclusion = ?
       ORDER BY updated_at DESC
       LIMIT 1`,
      [sessionId, rootInclusion],
    );
    if (rows.length === 0) return undefined;
    return SessionSummaryStore.rowToSessionSummary(rows[0]);
  }

  static async listBySession(
    queryable: Queryable,
    sessionId: string,
  ): Promise<readonly SessionSummary[]> {
    const { rows } = await queryable.exec(
      `SELECT ${SessionSummaryStore.selectColumns()}
       FROM session_summaries
       WHERE session_id = ?
       ORDER BY created_at`,
      [sessionId],
    );
    return rows.map(SessionSummaryStore.rowToSessionSummary);
  }

  static async listByGeneration(
    queryable: Queryable,
    generationId: string,
  ): Promise<readonly SessionSummary[]> {
    const { rows } = await queryable.exec(
      `SELECT ${SessionSummaryStore.selectColumns()}
       FROM session_summaries
       WHERE generation_id = ?
       ORDER BY created_at`,
      [generationId],
    );
    return rows.map(SessionSummaryStore.rowToSessionSummary);
  }

  static async update(
    queryable: Queryable,
    id: string,
    input: UpdateSessionSummaryInput,
  ): Promise<void> {
    const now = Date.now();
    const { sql, params } = buildUpdate<UpdateSessionSummaryInput>(
      'session_summaries',
      SESSION_SUMMARY_COLUMNS,
      input,
      id,
      now,
    );
    await queryable.exec(sql, params);
  }

  static async delete(queryable: Queryable, id: string): Promise<void> {
    await queryable.exec('DELETE FROM session_summaries WHERE id = ?', [id]);
  }
}

// session_component_stats

const SESSION_COMPONENT_STAT_COLUMNS: readonly Column[] = [
  { name: 'id', field: 'id', type: 'TEXT', pkey: true, notNull: true },
  {
    name: 'session_id',
    field: 'sessionId',
    type: 'TEXT',
    notNull: true,
    fk: { table: 'sessions', column: 'id', onDelete: 'CASCADE' },
  },
  {
    name: 'generation_id',
    field: 'generationId',
    type: 'TEXT',
    notNull: true,
    fk: { table: 'transformation_generations', column: 'id', onDelete: 'CASCADE' },
  },
  {
    name: 'component_id',
    field: 'componentId',
    type: 'TEXT',
    notNull: true,
    fk: { table: 'component_identities', column: 'id', onDelete: 'CASCADE' },
  },
  {
    name: 'component_version_id',
    field: 'componentVersionId',
    type: 'TEXT',
    fk: { table: 'component_versions', column: 'id', onDelete: 'SET NULL' },
  },
  {
    name: 'kind',
    field: 'kind',
    type: 'TEXT',
    check: `kind IS NULL OR kind IN (${ROLLUP_COMPONENT_KINDS.map((k) => `'${k}'`).join(', ')})`,
  },
  { name: 'availability', field: 'availability', type: 'TEXT', notNull: true, default: '{}' },
  { name: 'context', field: 'context', type: 'TEXT', notNull: true, default: '{}' },
  {
    name: 'invocation_count',
    field: 'invocationCount',
    type: 'INTEGER',
    notNull: true,
    default: 0,
  },
  { name: 'payload_count', field: 'payloadCount', type: 'INTEGER', notNull: true, default: 0 },
  { name: 'payload_bytes', field: 'payloadBytes', type: 'INTEGER', notNull: true, default: 0 },
  { name: 'status_counts', field: 'statusCounts', type: 'TEXT', notNull: true, default: '{}' },
  { name: 'outcome_state', field: 'outcomeState', type: 'TEXT' },
  { name: 'created_at', field: 'createdAt', type: 'INTEGER', notNull: true },
  { name: 'updated_at', field: 'updatedAt', type: 'INTEGER', notNull: true },
];

const SESSION_COMPONENT_STAT_INDEXES: readonly IndexSpec[] = [
  {
    name: 'idx_session_component_stats_unique',
    columns: ['session_id', 'generation_id', 'component_id', "COALESCE(component_version_id, '')"],
    unique: true,
  },
  { name: 'idx_session_component_stats_session', columns: ['session_id'] },
  { name: 'idx_session_component_stats_component', columns: ['component_id'] },
];

export const CREATE_SESSION_COMPONENT_STATS_TABLE = buildCreateTable(
  'session_component_stats',
  SESSION_COMPONENT_STAT_COLUMNS,
  SESSION_COMPONENT_STAT_INDEXES,
);

export interface SessionComponentStat {
  readonly id: string;
  readonly sessionId: string;
  readonly generationId: string;
  readonly componentId: string;
  readonly componentVersionId: string | null;
  readonly kind: RollupComponentKind | null;
  readonly availability: string;
  readonly context: string;
  readonly invocationCount: number;
  readonly payloadCount: number;
  readonly payloadBytes: number;
  readonly statusCounts: string;
  readonly outcomeState: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type InsertSessionComponentStatInput = InsertInput<SessionComponentStat>;
export type UpdateSessionComponentStatInput = UpdateInput<SessionComponentStat>;

// biome-ignore lint/complexity/noStaticOnlyClass: typed rollup store
export class SessionComponentStatStore {
  private static rowToSessionComponentStat(row: SqliteRow): SessionComponentStat {
    return {
      id: asString(row.id),
      sessionId: asString(row.session_id),
      generationId: asString(row.generation_id),
      componentId: asString(row.component_id),
      componentVersionId: toOptionalString(row.component_version_id),
      kind: toOptionalString(row.kind) as RollupComponentKind | null,
      availability: asString(row.availability),
      context: asString(row.context),
      invocationCount: toNumber(row.invocation_count),
      payloadCount: toNumber(row.payload_count),
      payloadBytes: toNumber(row.payload_bytes),
      statusCounts: asString(row.status_counts),
      outcomeState: toOptionalString(row.outcome_state),
      createdAt: toNumber(row.created_at),
      updatedAt: toNumber(row.updated_at),
    };
  }

  private static selectColumns(): string {
    return SESSION_COMPONENT_STAT_COLUMNS.map((c) => c.name).join(', ');
  }

  static async insert(
    queryable: Queryable,
    input: InsertSessionComponentStatInput,
  ): Promise<string> {
    const now = Date.now();
    const record = input as unknown as Record<string, unknown>;
    const id =
      (record.id as string | undefined) ??
      `scs-${deterministicId(
        'session-component-stat',
        input.sessionId,
        input.componentId,
        String(now),
      )}`;
    await queryable.exec(
      buildInsertSql('session_component_stats', SESSION_COMPONENT_STAT_COLUMNS),
      toInsertParams<InsertSessionComponentStatInput>(
        SESSION_COMPONENT_STAT_COLUMNS,
        input,
        id,
        now,
      ),
    );
    return id;
  }

  static async getById(
    queryable: Queryable,
    id: string,
  ): Promise<SessionComponentStat | undefined> {
    const { rows } = await queryable.exec(
      `SELECT ${SessionComponentStatStore.selectColumns()} FROM session_component_stats WHERE id = ?`,
      [id],
    );
    if (rows.length === 0) return undefined;
    return SessionComponentStatStore.rowToSessionComponentStat(rows[0]);
  }

  static async listBySession(
    queryable: Queryable,
    sessionId: string,
  ): Promise<readonly SessionComponentStat[]> {
    const { rows } = await queryable.exec(
      `SELECT ${SessionComponentStatStore.selectColumns()}
       FROM session_component_stats
       WHERE session_id = ?
       ORDER BY component_id`,
      [sessionId],
    );
    return rows.map(SessionComponentStatStore.rowToSessionComponentStat);
  }

  static async listByComponent(
    queryable: Queryable,
    componentId: string,
  ): Promise<readonly SessionComponentStat[]> {
    const { rows } = await queryable.exec(
      `SELECT ${SessionComponentStatStore.selectColumns()}
       FROM session_component_stats
       WHERE component_id = ?
       ORDER BY created_at`,
      [componentId],
    );
    return rows.map(SessionComponentStatStore.rowToSessionComponentStat);
  }

  static async update(
    queryable: Queryable,
    id: string,
    input: UpdateSessionComponentStatInput,
  ): Promise<void> {
    const now = Date.now();
    const { sql, params } = buildUpdate<UpdateSessionComponentStatInput>(
      'session_component_stats',
      SESSION_COMPONENT_STAT_COLUMNS,
      input,
      id,
      now,
    );
    await queryable.exec(sql, params);
  }

  static async delete(queryable: Queryable, id: string): Promise<void> {
    await queryable.exec('DELETE FROM session_component_stats WHERE id = ?', [id]);
  }
}

// session_chart_series

const SESSION_CHART_SERIES_COLUMNS: readonly Column[] = [
  { name: 'id', field: 'id', type: 'TEXT', pkey: true, notNull: true },
  {
    name: 'session_id',
    field: 'sessionId',
    type: 'TEXT',
    notNull: true,
    fk: { table: 'sessions', column: 'id', onDelete: 'CASCADE' },
  },
  {
    name: 'generation_id',
    field: 'generationId',
    type: 'TEXT',
    notNull: true,
    fk: { table: 'transformation_generations', column: 'id', onDelete: 'CASCADE' },
  },
  { name: 'series_type', field: 'seriesType', type: 'TEXT', notNull: true },
  { name: 'bucket_index', field: 'bucketIndex', type: 'INTEGER', notNull: true },
  { name: 'turn_index', field: 'turnIndex', type: 'INTEGER' },
  { name: 'bucket_start', field: 'bucketStart', type: 'INTEGER' },
  { name: 'bucket_end', field: 'bucketEnd', type: 'INTEGER' },
  { name: 'annotation', field: 'annotation', type: 'TEXT' },
  {
    name: 'metric_definition_id',
    field: 'metricDefinitionId',
    type: 'TEXT',
    fk: { table: 'metric_definitions', column: 'id', onDelete: 'SET NULL' },
  },
  { name: 'comparability_group_id', field: 'comparabilityGroupId', type: 'TEXT' },
  { name: 'metric_value', field: 'metricValue', type: 'REAL' },
  { name: 'created_at', field: 'createdAt', type: 'INTEGER', notNull: true },
  { name: 'updated_at', field: 'updatedAt', type: 'INTEGER', notNull: true },
];

const SESSION_CHART_SERIES_INDEXES: readonly IndexSpec[] = [
  {
    name: 'idx_session_chart_series_unique',
    columns: [
      'session_id',
      'generation_id',
      'series_type',
      'bucket_index',
      'COALESCE(turn_index, -1)',
      "COALESCE(comparability_group_id, '')",
    ],
    unique: true,
  },
  { name: 'idx_session_chart_series_session', columns: ['session_id'] },
  { name: 'idx_session_chart_series_type', columns: ['session_id', 'series_type'] },
];

export const CREATE_SESSION_CHART_SERIES_TABLE = buildCreateTable(
  'session_chart_series',
  SESSION_CHART_SERIES_COLUMNS,
  SESSION_CHART_SERIES_INDEXES,
);

export interface SessionChartSeries {
  readonly id: string;
  readonly sessionId: string;
  readonly generationId: string;
  readonly seriesType: string;
  readonly bucketIndex: number;
  readonly turnIndex: number | null;
  readonly bucketStart: number | null;
  readonly bucketEnd: number | null;
  readonly annotation: string | null;
  readonly metricDefinitionId: string | null;
  readonly comparabilityGroupId: string | null;
  readonly metricValue: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type InsertSessionChartSeriesInput = InsertInput<SessionChartSeries>;
export type UpdateSessionChartSeriesInput = UpdateInput<SessionChartSeries>;

// biome-ignore lint/complexity/noStaticOnlyClass: typed rollup store
export class SessionChartSeriesStore {
  private static rowToSessionChartSeries(row: SqliteRow): SessionChartSeries {
    return {
      id: asString(row.id),
      sessionId: asString(row.session_id),
      generationId: asString(row.generation_id),
      seriesType: asString(row.series_type),
      bucketIndex: toNumber(row.bucket_index),
      turnIndex: toOptionalNumber(row.turn_index),
      bucketStart: toOptionalNumber(row.bucket_start),
      bucketEnd: toOptionalNumber(row.bucket_end),
      annotation: toOptionalString(row.annotation),
      metricDefinitionId: toOptionalString(row.metric_definition_id),
      comparabilityGroupId: toOptionalString(row.comparability_group_id),
      metricValue: toOptionalNumber(row.metric_value),
      createdAt: toNumber(row.created_at),
      updatedAt: toNumber(row.updated_at),
    };
  }

  private static selectColumns(): string {
    return SESSION_CHART_SERIES_COLUMNS.map((c) => c.name).join(', ');
  }

  static async insert(queryable: Queryable, input: InsertSessionChartSeriesInput): Promise<string> {
    const now = Date.now();
    const record = input as unknown as Record<string, unknown>;
    const id =
      (record.id as string | undefined) ??
      `sch-${deterministicId(
        'session-chart-series',
        input.sessionId,
        input.seriesType,
        String(input.bucketIndex),
        String(now),
      )}`;
    await queryable.exec(
      buildInsertSql('session_chart_series', SESSION_CHART_SERIES_COLUMNS),
      toInsertParams<InsertSessionChartSeriesInput>(SESSION_CHART_SERIES_COLUMNS, input, id, now),
    );
    return id;
  }

  static async getById(queryable: Queryable, id: string): Promise<SessionChartSeries | undefined> {
    const { rows } = await queryable.exec(
      `SELECT ${SessionChartSeriesStore.selectColumns()} FROM session_chart_series WHERE id = ?`,
      [id],
    );
    if (rows.length === 0) return undefined;
    return SessionChartSeriesStore.rowToSessionChartSeries(rows[0]);
  }

  static async listBySession(
    queryable: Queryable,
    sessionId: string,
  ): Promise<readonly SessionChartSeries[]> {
    const { rows } = await queryable.exec(
      `SELECT ${SessionChartSeriesStore.selectColumns()}
       FROM session_chart_series
       WHERE session_id = ?
       ORDER BY bucket_index, turn_index`,
      [sessionId],
    );
    return rows.map(SessionChartSeriesStore.rowToSessionChartSeries);
  }

  static async listBySessionAndType(
    queryable: Queryable,
    sessionId: string,
    seriesType: string,
  ): Promise<readonly SessionChartSeries[]> {
    const { rows } = await queryable.exec(
      `SELECT ${SessionChartSeriesStore.selectColumns()}
       FROM session_chart_series
       WHERE session_id = ? AND series_type = ?
       ORDER BY bucket_index, turn_index`,
      [sessionId, seriesType],
    );
    return rows.map(SessionChartSeriesStore.rowToSessionChartSeries);
  }

  static async update(
    queryable: Queryable,
    id: string,
    input: UpdateSessionChartSeriesInput,
  ): Promise<void> {
    const now = Date.now();
    const { sql, params } = buildUpdate<UpdateSessionChartSeriesInput>(
      'session_chart_series',
      SESSION_CHART_SERIES_COLUMNS,
      input,
      id,
      now,
    );
    await queryable.exec(sql, params);
  }

  static async delete(queryable: Queryable, id: string): Promise<void> {
    await queryable.exec('DELETE FROM session_chart_series WHERE id = ?', [id]);
  }
}

// rollup_contributions

const ROLLUP_CONTRIBUTION_COLUMNS: readonly Column[] = [
  { name: 'id', field: 'id', type: 'TEXT', pkey: true, notNull: true },
  {
    name: 'session_id',
    field: 'sessionId',
    type: 'TEXT',
    notNull: true,
    fk: { table: 'sessions', column: 'id', onDelete: 'CASCADE' },
  },
  {
    name: 'generation_id',
    field: 'generationId',
    type: 'TEXT',
    notNull: true,
    fk: { table: 'transformation_generations', column: 'id', onDelete: 'CASCADE' },
  },
  {
    name: 'project_id',
    field: 'projectId',
    type: 'TEXT',
    fk: { table: 'projects', column: 'id', onDelete: 'CASCADE' },
  },
  {
    name: 'portfolio_id',
    field: 'portfolioId',
    type: 'TEXT',
    fk: { table: 'portfolios', column: 'id', onDelete: 'CASCADE' },
  },
  {
    name: 'analysis_release_id',
    field: 'analysisReleaseId',
    type: 'TEXT',
    notNull: true,
    fk: { table: 'analysis_releases', column: 'id', onDelete: 'RESTRICT' },
  },
  { name: 'comparability_group_id', field: 'comparabilityGroupId', type: 'TEXT', notNull: true },
  {
    name: 'metric_definition_id',
    field: 'metricDefinitionId',
    type: 'TEXT',
    notNull: true,
    fk: { table: 'metric_definitions', column: 'id', onDelete: 'CASCADE' },
  },
  {
    name: 'contribution_scope',
    field: 'contributionScope',
    type: 'TEXT',
    notNull: true,
    check: `contribution_scope IN ('root_only', 'inclusive')`,
  },
  { name: 'bucket_type', field: 'bucketType', type: 'TEXT', notNull: true },
  { name: 'bucket_name', field: 'bucketName', type: 'TEXT' },
  { name: 'bucket_value', field: 'bucketValue', type: 'TEXT' },
  { name: 'additive_value', field: 'additiveValue', type: 'REAL', notNull: true, default: 0 },
  { name: 'value_count', field: 'valueCount', type: 'INTEGER', notNull: true, default: 0 },
  { name: 'created_at', field: 'createdAt', type: 'INTEGER', notNull: true },
  { name: 'updated_at', field: 'updatedAt', type: 'INTEGER', notNull: true },
];

const ROLLUP_CONTRIBUTION_INDEXES: readonly IndexSpec[] = [
  {
    name: 'idx_rollup_contributions_unique',
    columns: [
      'session_id',
      'generation_id',
      "COALESCE(project_id, '')",
      "COALESCE(portfolio_id, '')",
      'analysis_release_id',
      'comparability_group_id',
      'metric_definition_id',
      'contribution_scope',
      'bucket_type',
      "COALESCE(bucket_name, '')",
      "COALESCE(bucket_value, '')",
    ],
    unique: true,
  },
  { name: 'idx_rollup_contributions_session', columns: ['session_id'] },
  { name: 'idx_rollup_contributions_project', columns: ['project_id'] },
  { name: 'idx_rollup_contributions_portfolio', columns: ['portfolio_id'] },
  {
    name: 'idx_rollup_contributions_partition',
    columns: [
      'project_id',
      'portfolio_id',
      'analysis_release_id',
      'comparability_group_id',
      'contribution_scope',
    ],
  },
];

export const CREATE_ROLLUP_CONTRIBUTIONS_TABLE = buildCreateTable(
  'rollup_contributions',
  ROLLUP_CONTRIBUTION_COLUMNS,
  ROLLUP_CONTRIBUTION_INDEXES,
  ['project_id IS NOT NULL OR portfolio_id IS NOT NULL'],
);

export interface RollupContribution {
  readonly id: string;
  readonly sessionId: string;
  readonly generationId: string;
  readonly projectId: string | null;
  readonly portfolioId: string | null;
  readonly analysisReleaseId: string;
  readonly comparabilityGroupId: string;
  readonly metricDefinitionId: string;
  readonly contributionScope: ContributionScope;
  readonly bucketType: string;
  readonly bucketName: string | null;
  readonly bucketValue: string | null;
  readonly additiveValue: number;
  readonly valueCount: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type InsertRollupContributionInput = InsertInput<RollupContribution>;
export type UpdateRollupContributionInput = UpdateInput<RollupContribution>;

// biome-ignore lint/complexity/noStaticOnlyClass: typed rollup store
export class RollupContributionStore {
  private static rowToRollupContribution(row: SqliteRow): RollupContribution {
    return {
      id: asString(row.id),
      sessionId: asString(row.session_id),
      generationId: asString(row.generation_id),
      projectId: toOptionalString(row.project_id),
      portfolioId: toOptionalString(row.portfolio_id),
      analysisReleaseId: asString(row.analysis_release_id),
      comparabilityGroupId: asString(row.comparability_group_id),
      metricDefinitionId: asString(row.metric_definition_id),
      contributionScope: asString(row.contribution_scope) as ContributionScope,
      bucketType: asString(row.bucket_type),
      bucketName: toOptionalString(row.bucket_name),
      bucketValue: toOptionalString(row.bucket_value),
      additiveValue: toNumber(row.additive_value),
      valueCount: toNumber(row.value_count),
      createdAt: toNumber(row.created_at),
      updatedAt: toNumber(row.updated_at),
    };
  }

  private static selectColumns(): string {
    return ROLLUP_CONTRIBUTION_COLUMNS.map((c) => c.name).join(', ');
  }

  static async insert(queryable: Queryable, input: InsertRollupContributionInput): Promise<string> {
    const now = Date.now();
    const record = input as unknown as Record<string, unknown>;
    const id =
      (record.id as string | undefined) ??
      `ru-${deterministicId(
        'rollup-contribution',
        input.sessionId,
        input.analysisReleaseId,
        input.comparabilityGroupId,
        input.contributionScope,
        String(now),
      )}`;
    await queryable.exec(
      buildInsertSql('rollup_contributions', ROLLUP_CONTRIBUTION_COLUMNS),
      toInsertParams<InsertRollupContributionInput>(ROLLUP_CONTRIBUTION_COLUMNS, input, id, now),
    );
    return id;
  }

  static async getById(queryable: Queryable, id: string): Promise<RollupContribution | undefined> {
    const { rows } = await queryable.exec(
      `SELECT ${RollupContributionStore.selectColumns()} FROM rollup_contributions WHERE id = ?`,
      [id],
    );
    if (rows.length === 0) return undefined;
    return RollupContributionStore.rowToRollupContribution(rows[0]);
  }

  static async listBySession(
    queryable: Queryable,
    sessionId: string,
  ): Promise<readonly RollupContribution[]> {
    const { rows } = await queryable.exec(
      `SELECT ${RollupContributionStore.selectColumns()}
       FROM rollup_contributions
       WHERE session_id = ?
       ORDER BY bucket_type, bucket_name, bucket_value`,
      [sessionId],
    );
    return rows.map(RollupContributionStore.rowToRollupContribution);
  }

  static async listByProject(
    queryable: Queryable,
    projectId: string,
  ): Promise<readonly RollupContribution[]> {
    const { rows } = await queryable.exec(
      `SELECT ${RollupContributionStore.selectColumns()}
       FROM rollup_contributions
       WHERE project_id = ?
       ORDER BY bucket_type, bucket_name, bucket_value`,
      [projectId],
    );
    return rows.map(RollupContributionStore.rowToRollupContribution);
  }

  static async listByPortfolio(
    queryable: Queryable,
    portfolioId: string,
  ): Promise<readonly RollupContribution[]> {
    const { rows } = await queryable.exec(
      `SELECT ${RollupContributionStore.selectColumns()}
       FROM rollup_contributions
       WHERE portfolio_id = ?
       ORDER BY bucket_type, bucket_name, bucket_value`,
      [portfolioId],
    );
    return rows.map(RollupContributionStore.rowToRollupContribution);
  }

  static async update(
    queryable: Queryable,
    id: string,
    input: UpdateRollupContributionInput,
  ): Promise<void> {
    const now = Date.now();
    const { sql, params } = buildUpdate<UpdateRollupContributionInput>(
      'rollup_contributions',
      ROLLUP_CONTRIBUTION_COLUMNS,
      input,
      id,
      now,
    );
    await queryable.exec(sql, params);
  }

  static async delete(queryable: Queryable, id: string): Promise<void> {
    await queryable.exec('DELETE FROM rollup_contributions WHERE id = ?', [id]);
  }
}

// project_daily_rollups

const PROJECT_DAILY_ROLLUP_COLUMNS: readonly Column[] = [
  { name: 'id', field: 'id', type: 'TEXT', pkey: true, notNull: true },
  {
    name: 'project_id',
    field: 'projectId',
    type: 'TEXT',
    notNull: true,
    fk: { table: 'projects', column: 'id', onDelete: 'CASCADE' },
  },
  {
    name: 'analysis_release_id',
    field: 'analysisReleaseId',
    type: 'TEXT',
    notNull: true,
    fk: { table: 'analysis_releases', column: 'id', onDelete: 'RESTRICT' },
  },
  { name: 'comparability_group_id', field: 'comparabilityGroupId', type: 'TEXT', notNull: true },
  {
    name: 'metric_definition_id',
    field: 'metricDefinitionId',
    type: 'TEXT',
    notNull: true,
    fk: { table: 'metric_definitions', column: 'id', onDelete: 'CASCADE' },
  },
  { name: 'day_bucket', field: 'dayBucket', type: 'TEXT', notNull: true },
  { name: 'value_count', field: 'valueCount', type: 'INTEGER', notNull: true, default: 0 },
  { name: 'value_sum', field: 'valueSum', type: 'REAL' },
  { name: 'value_min', field: 'valueMin', type: 'REAL' },
  { name: 'value_max', field: 'valueMax', type: 'REAL' },
  { name: 'value_mean', field: 'valueMean', type: 'REAL' },
  {
    name: 'generation_id',
    field: 'generationId',
    type: 'TEXT',
    notNull: true,
    fk: { table: 'transformation_generations', column: 'id', onDelete: 'CASCADE' },
  },
  { name: 'created_at', field: 'createdAt', type: 'INTEGER', notNull: true },
  { name: 'updated_at', field: 'updatedAt', type: 'INTEGER', notNull: true },
];

const PROJECT_DAILY_ROLLUP_INDEXES: readonly IndexSpec[] = [
  {
    name: 'idx_project_daily_rollups_unique',
    columns: ['project_id', 'analysis_release_id', 'comparability_group_id', 'day_bucket'],
    unique: true,
  },
  {
    name: 'idx_project_daily_rollups_release_group',
    columns: ['analysis_release_id', 'comparability_group_id'],
  },
  { name: 'idx_project_daily_rollups_day', columns: ['project_id', 'day_bucket'] },
];

export const CREATE_PROJECT_DAILY_ROLLUPS_TABLE = buildCreateTable(
  'project_daily_rollups',
  PROJECT_DAILY_ROLLUP_COLUMNS,
  PROJECT_DAILY_ROLLUP_INDEXES,
);

export interface ProjectDailyRollup {
  readonly id: string;
  readonly projectId: string;
  readonly analysisReleaseId: string;
  readonly comparabilityGroupId: string;
  readonly metricDefinitionId: string;
  readonly dayBucket: string;
  readonly valueCount: number;
  readonly valueSum: number | null;
  readonly valueMin: number | null;
  readonly valueMax: number | null;
  readonly valueMean: number | null;
  readonly generationId: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type InsertProjectDailyRollupInput = InsertInput<ProjectDailyRollup>;
export type UpdateProjectDailyRollupInput = UpdateInput<ProjectDailyRollup>;

// biome-ignore lint/complexity/noStaticOnlyClass: typed rollup store
export class ProjectDailyRollupStore {
  private static rowToProjectDailyRollup(row: SqliteRow): ProjectDailyRollup {
    return {
      id: asString(row.id),
      projectId: asString(row.project_id),
      analysisReleaseId: asString(row.analysis_release_id),
      comparabilityGroupId: asString(row.comparability_group_id),
      metricDefinitionId: asString(row.metric_definition_id),
      dayBucket: asString(row.day_bucket),
      valueCount: toNumber(row.value_count),
      valueSum: toOptionalNumber(row.value_sum),
      valueMin: toOptionalNumber(row.value_min),
      valueMax: toOptionalNumber(row.value_max),
      valueMean: toOptionalNumber(row.value_mean),
      generationId: asString(row.generation_id),
      createdAt: toNumber(row.created_at),
      updatedAt: toNumber(row.updated_at),
    };
  }

  private static selectColumns(): string {
    return PROJECT_DAILY_ROLLUP_COLUMNS.map((c) => c.name).join(', ');
  }

  static async insert(queryable: Queryable, input: InsertProjectDailyRollupInput): Promise<string> {
    const now = Date.now();
    const record = input as unknown as Record<string, unknown>;
    const id =
      (record.id as string | undefined) ??
      `pdr-${deterministicId(
        'project-daily-rollup',
        input.projectId,
        input.analysisReleaseId,
        input.comparabilityGroupId,
        input.dayBucket,
      )}`;
    await queryable.exec(
      buildInsertSql('project_daily_rollups', PROJECT_DAILY_ROLLUP_COLUMNS),
      toInsertParams<InsertProjectDailyRollupInput>(PROJECT_DAILY_ROLLUP_COLUMNS, input, id, now),
    );
    return id;
  }

  static async getById(queryable: Queryable, id: string): Promise<ProjectDailyRollup | undefined> {
    const { rows } = await queryable.exec(
      `SELECT ${ProjectDailyRollupStore.selectColumns()} FROM project_daily_rollups WHERE id = ?`,
      [id],
    );
    if (rows.length === 0) return undefined;
    return ProjectDailyRollupStore.rowToProjectDailyRollup(rows[0]);
  }

  static async getByProjectDayAndGroup(
    queryable: Queryable,
    projectId: string,
    analysisReleaseId: string,
    comparabilityGroupId: string,
    dayBucket: string,
  ): Promise<ProjectDailyRollup | undefined> {
    const { rows } = await queryable.exec(
      `SELECT ${ProjectDailyRollupStore.selectColumns()}
       FROM project_daily_rollups
       WHERE project_id = ? AND analysis_release_id = ? AND comparability_group_id = ? AND day_bucket = ?`,
      [projectId, analysisReleaseId, comparabilityGroupId, dayBucket],
    );
    if (rows.length === 0) return undefined;
    return ProjectDailyRollupStore.rowToProjectDailyRollup(rows[0]);
  }

  static async listByProject(
    queryable: Queryable,
    projectId: string,
  ): Promise<readonly ProjectDailyRollup[]> {
    const { rows } = await queryable.exec(
      `SELECT ${ProjectDailyRollupStore.selectColumns()}
       FROM project_daily_rollups
       WHERE project_id = ?
       ORDER BY day_bucket`,
      [projectId],
    );
    return rows.map(ProjectDailyRollupStore.rowToProjectDailyRollup);
  }

  static async listByProjectAndMetric(
    queryable: Queryable,
    projectId: string,
    metricDefinitionId: string,
  ): Promise<readonly ProjectDailyRollup[]> {
    const { rows } = await queryable.exec(
      `SELECT ${ProjectDailyRollupStore.selectColumns()}
       FROM project_daily_rollups
       WHERE project_id = ? AND metric_definition_id = ?
       ORDER BY day_bucket`,
      [projectId, metricDefinitionId],
    );
    return rows.map(ProjectDailyRollupStore.rowToProjectDailyRollup);
  }

  static async update(
    queryable: Queryable,
    id: string,
    input: UpdateProjectDailyRollupInput,
  ): Promise<void> {
    const now = Date.now();
    const { sql, params } = buildUpdate<UpdateProjectDailyRollupInput>(
      'project_daily_rollups',
      PROJECT_DAILY_ROLLUP_COLUMNS,
      input,
      id,
      now,
    );
    await queryable.exec(sql, params);
  }

  static async delete(queryable: Queryable, id: string): Promise<void> {
    await queryable.exec('DELETE FROM project_daily_rollups WHERE id = ?', [id]);
  }
}

// portfolio_daily_rollups

const PORTFOLIO_DAILY_ROLLUP_COLUMNS: readonly Column[] = [
  { name: 'id', field: 'id', type: 'TEXT', pkey: true, notNull: true },
  {
    name: 'portfolio_id',
    field: 'portfolioId',
    type: 'TEXT',
    notNull: true,
    fk: { table: 'portfolios', column: 'id', onDelete: 'CASCADE' },
  },
  {
    name: 'analysis_release_id',
    field: 'analysisReleaseId',
    type: 'TEXT',
    notNull: true,
    fk: { table: 'analysis_releases', column: 'id', onDelete: 'RESTRICT' },
  },
  { name: 'comparability_group_id', field: 'comparabilityGroupId', type: 'TEXT', notNull: true },
  {
    name: 'metric_definition_id',
    field: 'metricDefinitionId',
    type: 'TEXT',
    notNull: true,
    fk: { table: 'metric_definitions', column: 'id', onDelete: 'CASCADE' },
  },
  { name: 'day_bucket', field: 'dayBucket', type: 'TEXT', notNull: true },
  { name: 'value_count', field: 'valueCount', type: 'INTEGER', notNull: true, default: 0 },
  { name: 'value_sum', field: 'valueSum', type: 'REAL' },
  { name: 'value_min', field: 'valueMin', type: 'REAL' },
  { name: 'value_max', field: 'valueMax', type: 'REAL' },
  { name: 'value_mean', field: 'valueMean', type: 'REAL' },
  {
    name: 'generation_id',
    field: 'generationId',
    type: 'TEXT',
    notNull: true,
    fk: { table: 'transformation_generations', column: 'id', onDelete: 'CASCADE' },
  },
  { name: 'created_at', field: 'createdAt', type: 'INTEGER', notNull: true },
  { name: 'updated_at', field: 'updatedAt', type: 'INTEGER', notNull: true },
];

const PORTFOLIO_DAILY_ROLLUP_INDEXES: readonly IndexSpec[] = [
  {
    name: 'idx_portfolio_daily_rollups_unique',
    columns: ['portfolio_id', 'analysis_release_id', 'comparability_group_id', 'day_bucket'],
    unique: true,
  },
  {
    name: 'idx_portfolio_daily_rollups_release_group',
    columns: ['analysis_release_id', 'comparability_group_id'],
  },
  { name: 'idx_portfolio_daily_rollups_day', columns: ['portfolio_id', 'day_bucket'] },
];

export const CREATE_PORTFOLIO_DAILY_ROLLUPS_TABLE = buildCreateTable(
  'portfolio_daily_rollups',
  PORTFOLIO_DAILY_ROLLUP_COLUMNS,
  PORTFOLIO_DAILY_ROLLUP_INDEXES,
);

export interface PortfolioDailyRollup {
  readonly id: string;
  readonly portfolioId: string;
  readonly analysisReleaseId: string;
  readonly comparabilityGroupId: string;
  readonly metricDefinitionId: string;
  readonly dayBucket: string;
  readonly valueCount: number;
  readonly valueSum: number | null;
  readonly valueMin: number | null;
  readonly valueMax: number | null;
  readonly valueMean: number | null;
  readonly generationId: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type InsertPortfolioDailyRollupInput = InsertInput<PortfolioDailyRollup>;
export type UpdatePortfolioDailyRollupInput = UpdateInput<PortfolioDailyRollup>;

// biome-ignore lint/complexity/noStaticOnlyClass: typed rollup store
export class PortfolioDailyRollupStore {
  private static rowToPortfolioDailyRollup(row: SqliteRow): PortfolioDailyRollup {
    return {
      id: asString(row.id),
      portfolioId: asString(row.portfolio_id),
      analysisReleaseId: asString(row.analysis_release_id),
      comparabilityGroupId: asString(row.comparability_group_id),
      metricDefinitionId: asString(row.metric_definition_id),
      dayBucket: asString(row.day_bucket),
      valueCount: toNumber(row.value_count),
      valueSum: toOptionalNumber(row.value_sum),
      valueMin: toOptionalNumber(row.value_min),
      valueMax: toOptionalNumber(row.value_max),
      valueMean: toOptionalNumber(row.value_mean),
      generationId: asString(row.generation_id),
      createdAt: toNumber(row.created_at),
      updatedAt: toNumber(row.updated_at),
    };
  }

  private static selectColumns(): string {
    return PORTFOLIO_DAILY_ROLLUP_COLUMNS.map((c) => c.name).join(', ');
  }

  static async insert(
    queryable: Queryable,
    input: InsertPortfolioDailyRollupInput,
  ): Promise<string> {
    const now = Date.now();
    const record = input as unknown as Record<string, unknown>;
    const id =
      (record.id as string | undefined) ??
      `podr-${deterministicId(
        'portfolio-daily-rollup',
        input.portfolioId,
        input.analysisReleaseId,
        input.comparabilityGroupId,
        input.dayBucket,
      )}`;
    await queryable.exec(
      buildInsertSql('portfolio_daily_rollups', PORTFOLIO_DAILY_ROLLUP_COLUMNS),
      toInsertParams<InsertPortfolioDailyRollupInput>(
        PORTFOLIO_DAILY_ROLLUP_COLUMNS,
        input,
        id,
        now,
      ),
    );
    return id;
  }

  static async getById(
    queryable: Queryable,
    id: string,
  ): Promise<PortfolioDailyRollup | undefined> {
    const { rows } = await queryable.exec(
      `SELECT ${PortfolioDailyRollupStore.selectColumns()} FROM portfolio_daily_rollups WHERE id = ?`,
      [id],
    );
    if (rows.length === 0) return undefined;
    return PortfolioDailyRollupStore.rowToPortfolioDailyRollup(rows[0]);
  }

  static async getByPortfolioDayAndGroup(
    queryable: Queryable,
    portfolioId: string,
    analysisReleaseId: string,
    comparabilityGroupId: string,
    dayBucket: string,
  ): Promise<PortfolioDailyRollup | undefined> {
    const { rows } = await queryable.exec(
      `SELECT ${PortfolioDailyRollupStore.selectColumns()}
       FROM portfolio_daily_rollups
       WHERE portfolio_id = ? AND analysis_release_id = ? AND comparability_group_id = ? AND day_bucket = ?`,
      [portfolioId, analysisReleaseId, comparabilityGroupId, dayBucket],
    );
    if (rows.length === 0) return undefined;
    return PortfolioDailyRollupStore.rowToPortfolioDailyRollup(rows[0]);
  }

  static async listByPortfolio(
    queryable: Queryable,
    portfolioId: string,
  ): Promise<readonly PortfolioDailyRollup[]> {
    const { rows } = await queryable.exec(
      `SELECT ${PortfolioDailyRollupStore.selectColumns()}
       FROM portfolio_daily_rollups
       WHERE portfolio_id = ?
       ORDER BY day_bucket`,
      [portfolioId],
    );
    return rows.map(PortfolioDailyRollupStore.rowToPortfolioDailyRollup);
  }

  static async listByPortfolioAndMetric(
    queryable: Queryable,
    portfolioId: string,
    metricDefinitionId: string,
  ): Promise<readonly PortfolioDailyRollup[]> {
    const { rows } = await queryable.exec(
      `SELECT ${PortfolioDailyRollupStore.selectColumns()}
       FROM portfolio_daily_rollups
       WHERE portfolio_id = ? AND metric_definition_id = ?
       ORDER BY day_bucket`,
      [portfolioId, metricDefinitionId],
    );
    return rows.map(PortfolioDailyRollupStore.rowToPortfolioDailyRollup);
  }

  static async update(
    queryable: Queryable,
    id: string,
    input: UpdatePortfolioDailyRollupInput,
  ): Promise<void> {
    const now = Date.now();
    const { sql, params } = buildUpdate<UpdatePortfolioDailyRollupInput>(
      'portfolio_daily_rollups',
      PORTFOLIO_DAILY_ROLLUP_COLUMNS,
      input,
      id,
      now,
    );
    await queryable.exec(sql, params);
  }

  static async delete(queryable: Queryable, id: string): Promise<void> {
    await queryable.exec('DELETE FROM portfolio_daily_rollups WHERE id = ?', [id]);
  }
}

// project_dimension_rollups

const PROJECT_DIMENSION_ROLLUP_COLUMNS: readonly Column[] = [
  { name: 'id', field: 'id', type: 'TEXT', pkey: true, notNull: true },
  {
    name: 'project_id',
    field: 'projectId',
    type: 'TEXT',
    notNull: true,
    fk: { table: 'projects', column: 'id', onDelete: 'CASCADE' },
  },
  {
    name: 'analysis_release_id',
    field: 'analysisReleaseId',
    type: 'TEXT',
    notNull: true,
    fk: { table: 'analysis_releases', column: 'id', onDelete: 'RESTRICT' },
  },
  { name: 'comparability_group_id', field: 'comparabilityGroupId', type: 'TEXT', notNull: true },
  {
    name: 'metric_definition_id',
    field: 'metricDefinitionId',
    type: 'TEXT',
    notNull: true,
    fk: { table: 'metric_definitions', column: 'id', onDelete: 'CASCADE' },
  },
  { name: 'dimension_name', field: 'dimensionName', type: 'TEXT', notNull: true },
  { name: 'dimension_value', field: 'dimensionValue', type: 'TEXT', notNull: true },
  {
    name: 'is_other',
    field: 'isOther',
    type: 'INTEGER',
    notNull: true,
    default: 0,
    isBoolean: true,
  },
  {
    name: 'is_unknown',
    field: 'isUnknown',
    type: 'INTEGER',
    notNull: true,
    default: 0,
    isBoolean: true,
  },
  { name: 'value_count', field: 'valueCount', type: 'INTEGER', notNull: true, default: 0 },
  { name: 'value_sum', field: 'valueSum', type: 'REAL' },
  { name: 'value_min', field: 'valueMin', type: 'REAL' },
  { name: 'value_max', field: 'valueMax', type: 'REAL' },
  { name: 'value_mean', field: 'valueMean', type: 'REAL' },
  { name: 'top_n_rank', field: 'topNRank', type: 'INTEGER' },
  {
    name: 'generation_id',
    field: 'generationId',
    type: 'TEXT',
    notNull: true,
    fk: { table: 'transformation_generations', column: 'id', onDelete: 'CASCADE' },
  },
  { name: 'created_at', field: 'createdAt', type: 'INTEGER', notNull: true },
  { name: 'updated_at', field: 'updatedAt', type: 'INTEGER', notNull: true },
];

const PROJECT_DIMENSION_ROLLUP_INDEXES: readonly IndexSpec[] = [
  {
    name: 'idx_project_dimension_rollups_unique',
    columns: [
      'project_id',
      'analysis_release_id',
      'comparability_group_id',
      'dimension_name',
      'dimension_value',
    ],
    unique: true,
  },
  { name: 'idx_project_dimension_rollups_project', columns: ['project_id'] },
  { name: 'idx_project_dimension_rollups_dimension', columns: ['project_id', 'dimension_name'] },
  {
    name: 'idx_project_dimension_rollups_rank',
    columns: ['project_id', 'dimension_name', 'top_n_rank'],
  },
];

export const CREATE_PROJECT_DIMENSION_ROLLUPS_TABLE = buildCreateTable(
  'project_dimension_rollups',
  PROJECT_DIMENSION_ROLLUP_COLUMNS,
  PROJECT_DIMENSION_ROLLUP_INDEXES,
);

export interface ProjectDimensionRollup {
  readonly id: string;
  readonly projectId: string;
  readonly analysisReleaseId: string;
  readonly comparabilityGroupId: string;
  readonly metricDefinitionId: string;
  readonly dimensionName: string;
  readonly dimensionValue: string;
  readonly isOther: boolean;
  readonly isUnknown: boolean;
  readonly valueCount: number;
  readonly valueSum: number | null;
  readonly valueMin: number | null;
  readonly valueMax: number | null;
  readonly valueMean: number | null;
  readonly topNRank: number | null;
  readonly generationId: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type InsertProjectDimensionRollupInput = InsertInput<ProjectDimensionRollup>;
export type UpdateProjectDimensionRollupInput = UpdateInput<ProjectDimensionRollup>;

// biome-ignore lint/complexity/noStaticOnlyClass: typed rollup store
export class ProjectDimensionRollupStore {
  private static rowToProjectDimensionRollup(row: SqliteRow): ProjectDimensionRollup {
    return {
      id: asString(row.id),
      projectId: asString(row.project_id),
      analysisReleaseId: asString(row.analysis_release_id),
      comparabilityGroupId: asString(row.comparability_group_id),
      metricDefinitionId: asString(row.metric_definition_id),
      dimensionName: asString(row.dimension_name),
      dimensionValue: asString(row.dimension_value),
      isOther: toBoolean(row.is_other),
      isUnknown: toBoolean(row.is_unknown),
      valueCount: toNumber(row.value_count),
      valueSum: toOptionalNumber(row.value_sum),
      valueMin: toOptionalNumber(row.value_min),
      valueMax: toOptionalNumber(row.value_max),
      valueMean: toOptionalNumber(row.value_mean),
      topNRank: toOptionalNumber(row.top_n_rank),
      generationId: asString(row.generation_id),
      createdAt: toNumber(row.created_at),
      updatedAt: toNumber(row.updated_at),
    };
  }

  private static selectColumns(): string {
    return PROJECT_DIMENSION_ROLLUP_COLUMNS.map((c) => c.name).join(', ');
  }

  static async insert(
    queryable: Queryable,
    input: InsertProjectDimensionRollupInput,
  ): Promise<string> {
    const now = Date.now();
    const record = input as unknown as Record<string, unknown>;
    const id =
      (record.id as string | undefined) ??
      `pdm-${deterministicId(
        'project-dimension-rollup',
        input.projectId,
        input.analysisReleaseId,
        input.comparabilityGroupId,
        input.dimensionName,
        input.dimensionValue,
      )}`;
    await queryable.exec(
      buildInsertSql('project_dimension_rollups', PROJECT_DIMENSION_ROLLUP_COLUMNS),
      toInsertParams<InsertProjectDimensionRollupInput>(
        PROJECT_DIMENSION_ROLLUP_COLUMNS,
        input,
        id,
        now,
      ),
    );
    return id;
  }

  static async getById(
    queryable: Queryable,
    id: string,
  ): Promise<ProjectDimensionRollup | undefined> {
    const { rows } = await queryable.exec(
      `SELECT ${ProjectDimensionRollupStore.selectColumns()} FROM project_dimension_rollups WHERE id = ?`,
      [id],
    );
    if (rows.length === 0) return undefined;
    return ProjectDimensionRollupStore.rowToProjectDimensionRollup(rows[0]);
  }

  static async getByProjectDimensionAndGroup(
    queryable: Queryable,
    projectId: string,
    analysisReleaseId: string,
    comparabilityGroupId: string,
    dimensionName: string,
    dimensionValue: string,
  ): Promise<ProjectDimensionRollup | undefined> {
    const { rows } = await queryable.exec(
      `SELECT ${ProjectDimensionRollupStore.selectColumns()}
       FROM project_dimension_rollups
       WHERE project_id = ? AND analysis_release_id = ? AND comparability_group_id = ?
         AND dimension_name = ? AND dimension_value = ?`,
      [projectId, analysisReleaseId, comparabilityGroupId, dimensionName, dimensionValue],
    );
    if (rows.length === 0) return undefined;
    return ProjectDimensionRollupStore.rowToProjectDimensionRollup(rows[0]);
  }

  static async listByProject(
    queryable: Queryable,
    projectId: string,
  ): Promise<readonly ProjectDimensionRollup[]> {
    const { rows } = await queryable.exec(
      `SELECT ${ProjectDimensionRollupStore.selectColumns()}
       FROM project_dimension_rollups
       WHERE project_id = ?
       ORDER BY dimension_name, top_n_rank, dimension_value`,
      [projectId],
    );
    return rows.map(ProjectDimensionRollupStore.rowToProjectDimensionRollup);
  }

  static async listByProjectAndDimension(
    queryable: Queryable,
    projectId: string,
    dimensionName: string,
  ): Promise<readonly ProjectDimensionRollup[]> {
    const { rows } = await queryable.exec(
      `SELECT ${ProjectDimensionRollupStore.selectColumns()}
       FROM project_dimension_rollups
       WHERE project_id = ? AND dimension_name = ?
       ORDER BY top_n_rank, dimension_value`,
      [projectId, dimensionName],
    );
    return rows.map(ProjectDimensionRollupStore.rowToProjectDimensionRollup);
  }

  static async update(
    queryable: Queryable,
    id: string,
    input: UpdateProjectDimensionRollupInput,
  ): Promise<void> {
    const now = Date.now();
    const { sql, params } = buildUpdate<UpdateProjectDimensionRollupInput>(
      'project_dimension_rollups',
      PROJECT_DIMENSION_ROLLUP_COLUMNS,
      input,
      id,
      now,
    );
    await queryable.exec(sql, params);
  }

  static async delete(queryable: Queryable, id: string): Promise<void> {
    await queryable.exec('DELETE FROM project_dimension_rollups WHERE id = ?', [id]);
  }
}

// portfolio_dimension_rollups

const PORTFOLIO_DIMENSION_ROLLUP_COLUMNS: readonly Column[] = [
  { name: 'id', field: 'id', type: 'TEXT', pkey: true, notNull: true },
  {
    name: 'portfolio_id',
    field: 'portfolioId',
    type: 'TEXT',
    notNull: true,
    fk: { table: 'portfolios', column: 'id', onDelete: 'CASCADE' },
  },
  {
    name: 'analysis_release_id',
    field: 'analysisReleaseId',
    type: 'TEXT',
    notNull: true,
    fk: { table: 'analysis_releases', column: 'id', onDelete: 'RESTRICT' },
  },
  { name: 'comparability_group_id', field: 'comparabilityGroupId', type: 'TEXT', notNull: true },
  {
    name: 'metric_definition_id',
    field: 'metricDefinitionId',
    type: 'TEXT',
    notNull: true,
    fk: { table: 'metric_definitions', column: 'id', onDelete: 'CASCADE' },
  },
  { name: 'dimension_name', field: 'dimensionName', type: 'TEXT', notNull: true },
  { name: 'dimension_value', field: 'dimensionValue', type: 'TEXT', notNull: true },
  {
    name: 'is_other',
    field: 'isOther',
    type: 'INTEGER',
    notNull: true,
    default: 0,
    isBoolean: true,
  },
  {
    name: 'is_unknown',
    field: 'isUnknown',
    type: 'INTEGER',
    notNull: true,
    default: 0,
    isBoolean: true,
  },
  { name: 'value_count', field: 'valueCount', type: 'INTEGER', notNull: true, default: 0 },
  { name: 'value_sum', field: 'valueSum', type: 'REAL' },
  { name: 'value_min', field: 'valueMin', type: 'REAL' },
  { name: 'value_max', field: 'valueMax', type: 'REAL' },
  { name: 'value_mean', field: 'valueMean', type: 'REAL' },
  { name: 'top_n_rank', field: 'topNRank', type: 'INTEGER' },
  {
    name: 'generation_id',
    field: 'generationId',
    type: 'TEXT',
    notNull: true,
    fk: { table: 'transformation_generations', column: 'id', onDelete: 'CASCADE' },
  },
  { name: 'created_at', field: 'createdAt', type: 'INTEGER', notNull: true },
  { name: 'updated_at', field: 'updatedAt', type: 'INTEGER', notNull: true },
];

const PORTFOLIO_DIMENSION_ROLLUP_INDEXES: readonly IndexSpec[] = [
  {
    name: 'idx_portfolio_dimension_rollups_unique',
    columns: [
      'portfolio_id',
      'analysis_release_id',
      'comparability_group_id',
      'dimension_name',
      'dimension_value',
    ],
    unique: true,
  },
  { name: 'idx_portfolio_dimension_rollups_portfolio', columns: ['portfolio_id'] },
  {
    name: 'idx_portfolio_dimension_rollups_dimension',
    columns: ['portfolio_id', 'dimension_name'],
  },
  {
    name: 'idx_portfolio_dimension_rollups_rank',
    columns: ['portfolio_id', 'dimension_name', 'top_n_rank'],
  },
];

export const CREATE_PORTFOLIO_DIMENSION_ROLLUPS_TABLE = buildCreateTable(
  'portfolio_dimension_rollups',
  PORTFOLIO_DIMENSION_ROLLUP_COLUMNS,
  PORTFOLIO_DIMENSION_ROLLUP_INDEXES,
);

export interface PortfolioDimensionRollup {
  readonly id: string;
  readonly portfolioId: string;
  readonly analysisReleaseId: string;
  readonly comparabilityGroupId: string;
  readonly metricDefinitionId: string;
  readonly dimensionName: string;
  readonly dimensionValue: string;
  readonly isOther: boolean;
  readonly isUnknown: boolean;
  readonly valueCount: number;
  readonly valueSum: number | null;
  readonly valueMin: number | null;
  readonly valueMax: number | null;
  readonly valueMean: number | null;
  readonly topNRank: number | null;
  readonly generationId: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type InsertPortfolioDimensionRollupInput = InsertInput<PortfolioDimensionRollup>;
export type UpdatePortfolioDimensionRollupInput = UpdateInput<PortfolioDimensionRollup>;

// biome-ignore lint/complexity/noStaticOnlyClass: typed rollup store
export class PortfolioDimensionRollupStore {
  private static rowToPortfolioDimensionRollup(row: SqliteRow): PortfolioDimensionRollup {
    return {
      id: asString(row.id),
      portfolioId: asString(row.portfolio_id),
      analysisReleaseId: asString(row.analysis_release_id),
      comparabilityGroupId: asString(row.comparability_group_id),
      metricDefinitionId: asString(row.metric_definition_id),
      dimensionName: asString(row.dimension_name),
      dimensionValue: asString(row.dimension_value),
      isOther: toBoolean(row.is_other),
      isUnknown: toBoolean(row.is_unknown),
      valueCount: toNumber(row.value_count),
      valueSum: toOptionalNumber(row.value_sum),
      valueMin: toOptionalNumber(row.value_min),
      valueMax: toOptionalNumber(row.value_max),
      valueMean: toOptionalNumber(row.value_mean),
      topNRank: toOptionalNumber(row.top_n_rank),
      generationId: asString(row.generation_id),
      createdAt: toNumber(row.created_at),
      updatedAt: toNumber(row.updated_at),
    };
  }

  private static selectColumns(): string {
    return PORTFOLIO_DIMENSION_ROLLUP_COLUMNS.map((c) => c.name).join(', ');
  }

  static async insert(
    queryable: Queryable,
    input: InsertPortfolioDimensionRollupInput,
  ): Promise<string> {
    const now = Date.now();
    const record = input as unknown as Record<string, unknown>;
    const id =
      (record.id as string | undefined) ??
      `pfm-${deterministicId(
        'portfolio-dimension-rollup',
        input.portfolioId,
        input.analysisReleaseId,
        input.comparabilityGroupId,
        input.dimensionName,
        input.dimensionValue,
      )}`;
    await queryable.exec(
      buildInsertSql('portfolio_dimension_rollups', PORTFOLIO_DIMENSION_ROLLUP_COLUMNS),
      toInsertParams<InsertPortfolioDimensionRollupInput>(
        PORTFOLIO_DIMENSION_ROLLUP_COLUMNS,
        input,
        id,
        now,
      ),
    );
    return id;
  }

  static async getById(
    queryable: Queryable,
    id: string,
  ): Promise<PortfolioDimensionRollup | undefined> {
    const { rows } = await queryable.exec(
      `SELECT ${PortfolioDimensionRollupStore.selectColumns()} FROM portfolio_dimension_rollups WHERE id = ?`,
      [id],
    );
    if (rows.length === 0) return undefined;
    return PortfolioDimensionRollupStore.rowToPortfolioDimensionRollup(rows[0]);
  }

  static async getByPortfolioDimensionAndGroup(
    queryable: Queryable,
    portfolioId: string,
    analysisReleaseId: string,
    comparabilityGroupId: string,
    dimensionName: string,
    dimensionValue: string,
  ): Promise<PortfolioDimensionRollup | undefined> {
    const { rows } = await queryable.exec(
      `SELECT ${PortfolioDimensionRollupStore.selectColumns()}
       FROM portfolio_dimension_rollups
       WHERE portfolio_id = ? AND analysis_release_id = ? AND comparability_group_id = ?
         AND dimension_name = ? AND dimension_value = ?`,
      [portfolioId, analysisReleaseId, comparabilityGroupId, dimensionName, dimensionValue],
    );
    if (rows.length === 0) return undefined;
    return PortfolioDimensionRollupStore.rowToPortfolioDimensionRollup(rows[0]);
  }

  static async listByPortfolio(
    queryable: Queryable,
    portfolioId: string,
  ): Promise<readonly PortfolioDimensionRollup[]> {
    const { rows } = await queryable.exec(
      `SELECT ${PortfolioDimensionRollupStore.selectColumns()}
       FROM portfolio_dimension_rollups
       WHERE portfolio_id = ?
       ORDER BY dimension_name, top_n_rank, dimension_value`,
      [portfolioId],
    );
    return rows.map(PortfolioDimensionRollupStore.rowToPortfolioDimensionRollup);
  }

  static async listByPortfolioAndDimension(
    queryable: Queryable,
    portfolioId: string,
    dimensionName: string,
  ): Promise<readonly PortfolioDimensionRollup[]> {
    const { rows } = await queryable.exec(
      `SELECT ${PortfolioDimensionRollupStore.selectColumns()}
       FROM portfolio_dimension_rollups
       WHERE portfolio_id = ? AND dimension_name = ?
       ORDER BY top_n_rank, dimension_value`,
      [portfolioId, dimensionName],
    );
    return rows.map(PortfolioDimensionRollupStore.rowToPortfolioDimensionRollup);
  }

  static async update(
    queryable: Queryable,
    id: string,
    input: UpdatePortfolioDimensionRollupInput,
  ): Promise<void> {
    const now = Date.now();
    const { sql, params } = buildUpdate<UpdatePortfolioDimensionRollupInput>(
      'portfolio_dimension_rollups',
      PORTFOLIO_DIMENSION_ROLLUP_COLUMNS,
      input,
      id,
      now,
    );
    await queryable.exec(sql, params);
  }

  static async delete(queryable: Queryable, id: string): Promise<void> {
    await queryable.exec('DELETE FROM portfolio_dimension_rollups WHERE id = ?', [id]);
  }
}

// project_distributions

const PROJECT_DISTRIBUTION_COLUMNS: readonly Column[] = [
  { name: 'id', field: 'id', type: 'TEXT', pkey: true, notNull: true },
  {
    name: 'project_id',
    field: 'projectId',
    type: 'TEXT',
    notNull: true,
    fk: { table: 'projects', column: 'id', onDelete: 'CASCADE' },
  },
  {
    name: 'analysis_release_id',
    field: 'analysisReleaseId',
    type: 'TEXT',
    notNull: true,
    fk: { table: 'analysis_releases', column: 'id', onDelete: 'RESTRICT' },
  },
  { name: 'comparability_group_id', field: 'comparabilityGroupId', type: 'TEXT', notNull: true },
  {
    name: 'metric_definition_id',
    field: 'metricDefinitionId',
    type: 'TEXT',
    notNull: true,
    fk: { table: 'metric_definitions', column: 'id', onDelete: 'CASCADE' },
  },
  { name: 'dimensions_key', field: 'dimensionsKey', type: 'TEXT' },
  { name: 'eligible_n', field: 'eligibleN', type: 'INTEGER', notNull: true, default: 0 },
  { name: 'known_n', field: 'knownN', type: 'INTEGER', notNull: true, default: 0 },
  { name: 'unknown_count', field: 'unknownCount', type: 'INTEGER', notNull: true, default: 0 },
  { name: 'sum', field: 'sum', type: 'REAL' },
  { name: 'min', field: 'min', type: 'REAL' },
  { name: 'max', field: 'max', type: 'REAL' },
  { name: 'mean', field: 'mean', type: 'REAL' },
  { name: 'p50', field: 'p50', type: 'REAL' },
  { name: 'p75', field: 'p75', type: 'REAL' },
  { name: 'p90', field: 'p90', type: 'REAL' },
  { name: 'p95', field: 'p95', type: 'REAL' },
  { name: 'dispersion', field: 'dispersion', type: 'REAL' },
  { name: 'outlier_rule', field: 'outlierRule', type: 'TEXT' },
  { name: 'coverage', field: 'coverage', type: 'REAL' },
  {
    name: 'generation_id',
    field: 'generationId',
    type: 'TEXT',
    notNull: true,
    fk: { table: 'transformation_generations', column: 'id', onDelete: 'CASCADE' },
  },
  { name: 'created_at', field: 'createdAt', type: 'INTEGER', notNull: true },
  { name: 'updated_at', field: 'updatedAt', type: 'INTEGER', notNull: true },
];

const PROJECT_DISTRIBUTION_INDEXES: readonly IndexSpec[] = [
  {
    name: 'idx_project_distributions_unique',
    columns: [
      'project_id',
      'analysis_release_id',
      'comparability_group_id',
      "COALESCE(dimensions_key, '')",
    ],
    unique: true,
  },
  {
    name: 'idx_project_distributions_release_group',
    columns: ['analysis_release_id', 'comparability_group_id'],
  },
  { name: 'idx_project_distributions_project', columns: ['project_id'] },
];

export const CREATE_PROJECT_DISTRIBUTIONS_TABLE = buildCreateTable(
  'project_distributions',
  PROJECT_DISTRIBUTION_COLUMNS,
  PROJECT_DISTRIBUTION_INDEXES,
  [
    'eligible_n >= 0',
    'known_n >= 0',
    'unknown_count >= 0',
    'known_n + unknown_count <= eligible_n',
    'coverage IS NULL OR (coverage >= 0 AND coverage <= 1)',
  ],
);

export interface ProjectDistribution {
  readonly id: string;
  readonly projectId: string;
  readonly analysisReleaseId: string;
  readonly comparabilityGroupId: string;
  readonly metricDefinitionId: string;
  readonly dimensionsKey: string | null;
  readonly eligibleN: number;
  readonly knownN: number;
  readonly unknownCount: number;
  readonly sum: number | null;
  readonly min: number | null;
  readonly max: number | null;
  readonly mean: number | null;
  readonly p50: number | null;
  readonly p75: number | null;
  readonly p90: number | null;
  readonly p95: number | null;
  readonly dispersion: number | null;
  readonly outlierRule: string | null;
  readonly coverage: number | null;
  readonly generationId: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type InsertProjectDistributionInput = InsertInput<ProjectDistribution>;
export type UpdateProjectDistributionInput = UpdateInput<ProjectDistribution>;

// biome-ignore lint/complexity/noStaticOnlyClass: typed rollup store
export class ProjectDistributionStore {
  private static rowToProjectDistribution(row: SqliteRow): ProjectDistribution {
    return {
      id: asString(row.id),
      projectId: asString(row.project_id),
      analysisReleaseId: asString(row.analysis_release_id),
      comparabilityGroupId: asString(row.comparability_group_id),
      metricDefinitionId: asString(row.metric_definition_id),
      dimensionsKey: toOptionalString(row.dimensions_key),
      eligibleN: toNumber(row.eligible_n),
      knownN: toNumber(row.known_n),
      unknownCount: toNumber(row.unknown_count),
      sum: toOptionalNumber(row.sum),
      min: toOptionalNumber(row.min),
      max: toOptionalNumber(row.max),
      mean: toOptionalNumber(row.mean),
      p50: toOptionalNumber(row.p50),
      p75: toOptionalNumber(row.p75),
      p90: toOptionalNumber(row.p90),
      p95: toOptionalNumber(row.p95),
      dispersion: toOptionalNumber(row.dispersion),
      outlierRule: toOptionalString(row.outlier_rule),
      coverage: toOptionalNumber(row.coverage),
      generationId: asString(row.generation_id),
      createdAt: toNumber(row.created_at),
      updatedAt: toNumber(row.updated_at),
    };
  }

  private static selectColumns(): string {
    return PROJECT_DISTRIBUTION_COLUMNS.map((c) => c.name).join(', ');
  }

  static async insert(
    queryable: Queryable,
    input: InsertProjectDistributionInput,
  ): Promise<string> {
    const now = Date.now();
    const record = input as unknown as Record<string, unknown>;
    const id =
      (record.id as string | undefined) ??
      `pds-${deterministicId(
        'project-distribution',
        input.projectId,
        input.analysisReleaseId,
        input.comparabilityGroupId,
        input.dimensionsKey ?? '',
      )}`;
    await queryable.exec(
      buildInsertSql('project_distributions', PROJECT_DISTRIBUTION_COLUMNS),
      toInsertParams<InsertProjectDistributionInput>(PROJECT_DISTRIBUTION_COLUMNS, input, id, now),
    );
    return id;
  }

  static async getById(queryable: Queryable, id: string): Promise<ProjectDistribution | undefined> {
    const { rows } = await queryable.exec(
      `SELECT ${ProjectDistributionStore.selectColumns()} FROM project_distributions WHERE id = ?`,
      [id],
    );
    if (rows.length === 0) return undefined;
    return ProjectDistributionStore.rowToProjectDistribution(rows[0]);
  }

  static async getByProjectGroupAndKey(
    queryable: Queryable,
    projectId: string,
    analysisReleaseId: string,
    comparabilityGroupId: string,
    dimensionsKey: string | null,
  ): Promise<ProjectDistribution | undefined> {
    const { rows } = await queryable.exec(
      `SELECT ${ProjectDistributionStore.selectColumns()}
       FROM project_distributions
       WHERE project_id = ? AND analysis_release_id = ? AND comparability_group_id = ?
         AND COALESCE(dimensions_key, '') = COALESCE(?, '')`,
      [projectId, analysisReleaseId, comparabilityGroupId, dimensionsKey ?? ''],
    );
    if (rows.length === 0) return undefined;
    return ProjectDistributionStore.rowToProjectDistribution(rows[0]);
  }

  static async listByProject(
    queryable: Queryable,
    projectId: string,
  ): Promise<readonly ProjectDistribution[]> {
    const { rows } = await queryable.exec(
      `SELECT ${ProjectDistributionStore.selectColumns()}
       FROM project_distributions
       WHERE project_id = ?
       ORDER BY comparability_group_id, dimensions_key`,
      [projectId],
    );
    return rows.map(ProjectDistributionStore.rowToProjectDistribution);
  }

  static async update(
    queryable: Queryable,
    id: string,
    input: UpdateProjectDistributionInput,
  ): Promise<void> {
    const now = Date.now();
    const { sql, params } = buildUpdate<UpdateProjectDistributionInput>(
      'project_distributions',
      PROJECT_DISTRIBUTION_COLUMNS,
      input,
      id,
      now,
    );
    await queryable.exec(sql, params);
  }

  static async delete(queryable: Queryable, id: string): Promise<void> {
    await queryable.exec('DELETE FROM project_distributions WHERE id = ?', [id]);
  }
}

// portfolio_distributions

const PORTFOLIO_DISTRIBUTION_COLUMNS: readonly Column[] = [
  { name: 'id', field: 'id', type: 'TEXT', pkey: true, notNull: true },
  {
    name: 'portfolio_id',
    field: 'portfolioId',
    type: 'TEXT',
    notNull: true,
    fk: { table: 'portfolios', column: 'id', onDelete: 'CASCADE' },
  },
  {
    name: 'analysis_release_id',
    field: 'analysisReleaseId',
    type: 'TEXT',
    notNull: true,
    fk: { table: 'analysis_releases', column: 'id', onDelete: 'RESTRICT' },
  },
  { name: 'comparability_group_id', field: 'comparabilityGroupId', type: 'TEXT', notNull: true },
  {
    name: 'metric_definition_id',
    field: 'metricDefinitionId',
    type: 'TEXT',
    notNull: true,
    fk: { table: 'metric_definitions', column: 'id', onDelete: 'CASCADE' },
  },
  { name: 'dimensions_key', field: 'dimensionsKey', type: 'TEXT' },
  { name: 'eligible_n', field: 'eligibleN', type: 'INTEGER', notNull: true, default: 0 },
  { name: 'known_n', field: 'knownN', type: 'INTEGER', notNull: true, default: 0 },
  { name: 'unknown_count', field: 'unknownCount', type: 'INTEGER', notNull: true, default: 0 },
  { name: 'sum', field: 'sum', type: 'REAL' },
  { name: 'min', field: 'min', type: 'REAL' },
  { name: 'max', field: 'max', type: 'REAL' },
  { name: 'mean', field: 'mean', type: 'REAL' },
  { name: 'p50', field: 'p50', type: 'REAL' },
  { name: 'p75', field: 'p75', type: 'REAL' },
  { name: 'p90', field: 'p90', type: 'REAL' },
  { name: 'p95', field: 'p95', type: 'REAL' },
  { name: 'dispersion', field: 'dispersion', type: 'REAL' },
  { name: 'outlier_rule', field: 'outlierRule', type: 'TEXT' },
  { name: 'coverage', field: 'coverage', type: 'REAL' },
  {
    name: 'generation_id',
    field: 'generationId',
    type: 'TEXT',
    notNull: true,
    fk: { table: 'transformation_generations', column: 'id', onDelete: 'CASCADE' },
  },
  { name: 'created_at', field: 'createdAt', type: 'INTEGER', notNull: true },
  { name: 'updated_at', field: 'updatedAt', type: 'INTEGER', notNull: true },
];

const PORTFOLIO_DISTRIBUTION_INDEXES: readonly IndexSpec[] = [
  {
    name: 'idx_portfolio_distributions_unique',
    columns: [
      'portfolio_id',
      'analysis_release_id',
      'comparability_group_id',
      "COALESCE(dimensions_key, '')",
    ],
    unique: true,
  },
  {
    name: 'idx_portfolio_distributions_release_group',
    columns: ['analysis_release_id', 'comparability_group_id'],
  },
  { name: 'idx_portfolio_distributions_portfolio', columns: ['portfolio_id'] },
];

export const CREATE_PORTFOLIO_DISTRIBUTIONS_TABLE = buildCreateTable(
  'portfolio_distributions',
  PORTFOLIO_DISTRIBUTION_COLUMNS,
  PORTFOLIO_DISTRIBUTION_INDEXES,
  [
    'eligible_n >= 0',
    'known_n >= 0',
    'unknown_count >= 0',
    'known_n + unknown_count <= eligible_n',
    'coverage IS NULL OR (coverage >= 0 AND coverage <= 1)',
  ],
);

export interface PortfolioDistribution {
  readonly id: string;
  readonly portfolioId: string;
  readonly analysisReleaseId: string;
  readonly comparabilityGroupId: string;
  readonly metricDefinitionId: string;
  readonly dimensionsKey: string | null;
  readonly eligibleN: number;
  readonly knownN: number;
  readonly unknownCount: number;
  readonly sum: number | null;
  readonly min: number | null;
  readonly max: number | null;
  readonly mean: number | null;
  readonly p50: number | null;
  readonly p75: number | null;
  readonly p90: number | null;
  readonly p95: number | null;
  readonly dispersion: number | null;
  readonly outlierRule: string | null;
  readonly coverage: number | null;
  readonly generationId: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type InsertPortfolioDistributionInput = InsertInput<PortfolioDistribution>;
export type UpdatePortfolioDistributionInput = UpdateInput<PortfolioDistribution>;

// biome-ignore lint/complexity/noStaticOnlyClass: typed rollup store
export class PortfolioDistributionStore {
  private static rowToPortfolioDistribution(row: SqliteRow): PortfolioDistribution {
    return {
      id: asString(row.id),
      portfolioId: asString(row.portfolio_id),
      analysisReleaseId: asString(row.analysis_release_id),
      comparabilityGroupId: asString(row.comparability_group_id),
      metricDefinitionId: asString(row.metric_definition_id),
      dimensionsKey: toOptionalString(row.dimensions_key),
      eligibleN: toNumber(row.eligible_n),
      knownN: toNumber(row.known_n),
      unknownCount: toNumber(row.unknown_count),
      sum: toOptionalNumber(row.sum),
      min: toOptionalNumber(row.min),
      max: toOptionalNumber(row.max),
      mean: toOptionalNumber(row.mean),
      p50: toOptionalNumber(row.p50),
      p75: toOptionalNumber(row.p75),
      p90: toOptionalNumber(row.p90),
      p95: toOptionalNumber(row.p95),
      dispersion: toOptionalNumber(row.dispersion),
      outlierRule: toOptionalString(row.outlier_rule),
      coverage: toOptionalNumber(row.coverage),
      generationId: asString(row.generation_id),
      createdAt: toNumber(row.created_at),
      updatedAt: toNumber(row.updated_at),
    };
  }

  private static selectColumns(): string {
    return PORTFOLIO_DISTRIBUTION_COLUMNS.map((c) => c.name).join(', ');
  }

  static async insert(
    queryable: Queryable,
    input: InsertPortfolioDistributionInput,
  ): Promise<string> {
    const now = Date.now();
    const record = input as unknown as Record<string, unknown>;
    const id =
      (record.id as string | undefined) ??
      `pfs-${deterministicId(
        'portfolio-distribution',
        input.portfolioId,
        input.analysisReleaseId,
        input.comparabilityGroupId,
        input.dimensionsKey ?? '',
      )}`;
    await queryable.exec(
      buildInsertSql('portfolio_distributions', PORTFOLIO_DISTRIBUTION_COLUMNS),
      toInsertParams<InsertPortfolioDistributionInput>(
        PORTFOLIO_DISTRIBUTION_COLUMNS,
        input,
        id,
        now,
      ),
    );
    return id;
  }

  static async getById(
    queryable: Queryable,
    id: string,
  ): Promise<PortfolioDistribution | undefined> {
    const { rows } = await queryable.exec(
      `SELECT ${PortfolioDistributionStore.selectColumns()} FROM portfolio_distributions WHERE id = ?`,
      [id],
    );
    if (rows.length === 0) return undefined;
    return PortfolioDistributionStore.rowToPortfolioDistribution(rows[0]);
  }

  static async getByPortfolioGroupAndKey(
    queryable: Queryable,
    portfolioId: string,
    analysisReleaseId: string,
    comparabilityGroupId: string,
    dimensionsKey: string | null,
  ): Promise<PortfolioDistribution | undefined> {
    const { rows } = await queryable.exec(
      `SELECT ${PortfolioDistributionStore.selectColumns()}
       FROM portfolio_distributions
       WHERE portfolio_id = ? AND analysis_release_id = ? AND comparability_group_id = ?
         AND COALESCE(dimensions_key, '') = COALESCE(?, '')`,
      [portfolioId, analysisReleaseId, comparabilityGroupId, dimensionsKey ?? ''],
    );
    if (rows.length === 0) return undefined;
    return PortfolioDistributionStore.rowToPortfolioDistribution(rows[0]);
  }

  static async listByPortfolio(
    queryable: Queryable,
    portfolioId: string,
  ): Promise<readonly PortfolioDistribution[]> {
    const { rows } = await queryable.exec(
      `SELECT ${PortfolioDistributionStore.selectColumns()}
       FROM portfolio_distributions
       WHERE portfolio_id = ?
       ORDER BY comparability_group_id, dimensions_key`,
      [portfolioId],
    );
    return rows.map(PortfolioDistributionStore.rowToPortfolioDistribution);
  }

  static async update(
    queryable: Queryable,
    id: string,
    input: UpdatePortfolioDistributionInput,
  ): Promise<void> {
    const now = Date.now();
    const { sql, params } = buildUpdate<UpdatePortfolioDistributionInput>(
      'portfolio_distributions',
      PORTFOLIO_DISTRIBUTION_COLUMNS,
      input,
      id,
      now,
    );
    await queryable.exec(sql, params);
  }

  static async delete(queryable: Queryable, id: string): Promise<void> {
    await queryable.exec('DELETE FROM portfolio_distributions WHERE id = ?', [id]);
  }
}

// component_rollups

const COMPONENT_ROLLUP_COLUMNS: readonly Column[] = [
  { name: 'id', field: 'id', type: 'TEXT', pkey: true, notNull: true },
  {
    name: 'portfolio_id',
    field: 'portfolioId',
    type: 'TEXT',
    fk: { table: 'portfolios', column: 'id', onDelete: 'CASCADE' },
  },
  {
    name: 'project_id',
    field: 'projectId',
    type: 'TEXT',
    fk: { table: 'projects', column: 'id', onDelete: 'CASCADE' },
  },
  {
    name: 'component_id',
    field: 'componentId',
    type: 'TEXT',
    notNull: true,
    fk: { table: 'component_identities', column: 'id', onDelete: 'CASCADE' },
  },
  {
    name: 'component_version_id',
    field: 'componentVersionId',
    type: 'TEXT',
    fk: { table: 'component_versions', column: 'id', onDelete: 'SET NULL' },
  },
  {
    name: 'analysis_release_id',
    field: 'analysisReleaseId',
    type: 'TEXT',
    notNull: true,
    fk: { table: 'analysis_releases', column: 'id', onDelete: 'RESTRICT' },
  },
  { name: 'comparability_group_id', field: 'comparabilityGroupId', type: 'TEXT', notNull: true },
  {
    name: 'metric_definition_id',
    field: 'metricDefinitionId',
    type: 'TEXT',
    notNull: true,
    fk: { table: 'metric_definitions', column: 'id', onDelete: 'CASCADE' },
  },
  {
    name: 'invocation_count',
    field: 'invocationCount',
    type: 'INTEGER',
    notNull: true,
    default: 0,
  },
  { name: 'success_count', field: 'successCount', type: 'INTEGER', notNull: true, default: 0 },
  { name: 'failure_count', field: 'failureCount', type: 'INTEGER', notNull: true, default: 0 },
  {
    name: 'cancellation_count',
    field: 'cancellationCount',
    type: 'INTEGER',
    notNull: true,
    default: 0,
  },
  { name: 'total_latency_ms', field: 'totalLatencyMs', type: 'REAL' },
  { name: 'overhead_ms', field: 'overheadMs', type: 'REAL' },
  { name: 'reliability_ratio', field: 'reliabilityRatio', type: 'REAL' },
  { name: 'timing_p50', field: 'timingP50', type: 'REAL' },
  { name: 'timing_p90', field: 'timingP90', type: 'REAL' },
  {
    name: 'outcome_distribution',
    field: 'outcomeDistribution',
    type: 'TEXT',
    notNull: true,
    default: '{}',
  },
  {
    name: 'generation_id',
    field: 'generationId',
    type: 'TEXT',
    notNull: true,
    fk: { table: 'transformation_generations', column: 'id', onDelete: 'CASCADE' },
  },
  { name: 'created_at', field: 'createdAt', type: 'INTEGER', notNull: true },
  { name: 'updated_at', field: 'updatedAt', type: 'INTEGER', notNull: true },
];

const COMPONENT_ROLLUP_INDEXES: readonly IndexSpec[] = [
  {
    name: 'idx_component_rollups_unique',
    columns: [
      "COALESCE(portfolio_id, '')",
      "COALESCE(project_id, '')",
      'component_id',
      "COALESCE(component_version_id, '')",
      'analysis_release_id',
      'comparability_group_id',
      'metric_definition_id',
    ],
    unique: true,
  },
  { name: 'idx_component_rollups_component', columns: ['component_id'] },
  { name: 'idx_component_rollups_project', columns: ['project_id'] },
  { name: 'idx_component_rollups_portfolio', columns: ['portfolio_id'] },
  {
    name: 'idx_component_rollups_release_group',
    columns: ['analysis_release_id', 'comparability_group_id'],
  },
];

export const CREATE_COMPONENT_ROLLUPS_TABLE = buildCreateTable(
  'component_rollups',
  COMPONENT_ROLLUP_COLUMNS,
  COMPONENT_ROLLUP_INDEXES,
  ['portfolio_id IS NOT NULL OR project_id IS NOT NULL'],
);

export interface ComponentRollup {
  readonly id: string;
  readonly portfolioId: string | null;
  readonly projectId: string | null;
  readonly componentId: string;
  readonly componentVersionId: string | null;
  readonly analysisReleaseId: string;
  readonly comparabilityGroupId: string;
  readonly metricDefinitionId: string;
  readonly invocationCount: number;
  readonly successCount: number;
  readonly failureCount: number;
  readonly cancellationCount: number;
  readonly totalLatencyMs: number | null;
  readonly overheadMs: number | null;
  readonly reliabilityRatio: number | null;
  readonly timingP50: number | null;
  readonly timingP90: number | null;
  readonly outcomeDistribution: string;
  readonly generationId: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type InsertComponentRollupInput = InsertInput<ComponentRollup>;
export type UpdateComponentRollupInput = UpdateInput<ComponentRollup>;

// biome-ignore lint/complexity/noStaticOnlyClass: typed rollup store
export class ComponentRollupStore {
  private static rowToComponentRollup(row: SqliteRow): ComponentRollup {
    return {
      id: asString(row.id),
      portfolioId: toOptionalString(row.portfolio_id),
      projectId: toOptionalString(row.project_id),
      componentId: asString(row.component_id),
      componentVersionId: toOptionalString(row.component_version_id),
      analysisReleaseId: asString(row.analysis_release_id),
      comparabilityGroupId: asString(row.comparability_group_id),
      metricDefinitionId: asString(row.metric_definition_id),
      invocationCount: toNumber(row.invocation_count),
      successCount: toNumber(row.success_count),
      failureCount: toNumber(row.failure_count),
      cancellationCount: toNumber(row.cancellation_count),
      totalLatencyMs: toOptionalNumber(row.total_latency_ms),
      overheadMs: toOptionalNumber(row.overhead_ms),
      reliabilityRatio: toOptionalNumber(row.reliability_ratio),
      timingP50: toOptionalNumber(row.timing_p50),
      timingP90: toOptionalNumber(row.timing_p90),
      outcomeDistribution: asString(row.outcome_distribution),
      generationId: asString(row.generation_id),
      createdAt: toNumber(row.created_at),
      updatedAt: toNumber(row.updated_at),
    };
  }

  private static selectColumns(): string {
    return COMPONENT_ROLLUP_COLUMNS.map((c) => c.name).join(', ');
  }

  static async insert(queryable: Queryable, input: InsertComponentRollupInput): Promise<string> {
    const now = Date.now();
    const record = input as unknown as Record<string, unknown>;
    const id =
      (record.id as string | undefined) ??
      `crl-${deterministicId(
        'component-rollup',
        input.componentId,
        input.analysisReleaseId,
        input.comparabilityGroupId,
        String(now),
      )}`;
    await queryable.exec(
      buildInsertSql('component_rollups', COMPONENT_ROLLUP_COLUMNS),
      toInsertParams<InsertComponentRollupInput>(COMPONENT_ROLLUP_COLUMNS, input, id, now),
    );
    return id;
  }

  static async getById(queryable: Queryable, id: string): Promise<ComponentRollup | undefined> {
    const { rows } = await queryable.exec(
      `SELECT ${ComponentRollupStore.selectColumns()} FROM component_rollups WHERE id = ?`,
      [id],
    );
    if (rows.length === 0) return undefined;
    return ComponentRollupStore.rowToComponentRollup(rows[0]);
  }

  static async getByComponentAndGroup(
    queryable: Queryable,
    componentId: string,
    componentVersionId: string | null,
    analysisReleaseId: string,
    comparabilityGroupId: string,
    metricDefinitionId: string,
    portfolioId: string | null,
    projectId: string | null,
  ): Promise<ComponentRollup | undefined> {
    const { rows } = await queryable.exec(
      `SELECT ${ComponentRollupStore.selectColumns()}
       FROM component_rollups
       WHERE component_id = ?
         AND COALESCE(component_version_id, '') = COALESCE(?, '')
         AND analysis_release_id = ?
         AND comparability_group_id = ?
         AND metric_definition_id = ?
         AND COALESCE(portfolio_id, '') = COALESCE(?, '')
         AND COALESCE(project_id, '') = COALESCE(?, '')`,
      [
        componentId,
        componentVersionId ?? '',
        analysisReleaseId,
        comparabilityGroupId,
        metricDefinitionId,
        portfolioId ?? '',
        projectId ?? '',
      ],
    );
    if (rows.length === 0) return undefined;
    return ComponentRollupStore.rowToComponentRollup(rows[0]);
  }

  static async listByComponent(
    queryable: Queryable,
    componentId: string,
  ): Promise<readonly ComponentRollup[]> {
    const { rows } = await queryable.exec(
      `SELECT ${ComponentRollupStore.selectColumns()}
       FROM component_rollups
       WHERE component_id = ?
       ORDER BY created_at`,
      [componentId],
    );
    return rows.map(ComponentRollupStore.rowToComponentRollup);
  }

  static async listByProject(
    queryable: Queryable,
    projectId: string,
  ): Promise<readonly ComponentRollup[]> {
    const { rows } = await queryable.exec(
      `SELECT ${ComponentRollupStore.selectColumns()}
       FROM component_rollups
       WHERE project_id = ?
       ORDER BY component_id`,
      [projectId],
    );
    return rows.map(ComponentRollupStore.rowToComponentRollup);
  }

  static async listByPortfolio(
    queryable: Queryable,
    portfolioId: string,
  ): Promise<readonly ComponentRollup[]> {
    const { rows } = await queryable.exec(
      `SELECT ${ComponentRollupStore.selectColumns()}
       FROM component_rollups
       WHERE portfolio_id = ?
       ORDER BY component_id`,
      [portfolioId],
    );
    return rows.map(ComponentRollupStore.rowToComponentRollup);
  }

  static async update(
    queryable: Queryable,
    id: string,
    input: UpdateComponentRollupInput,
  ): Promise<void> {
    const now = Date.now();
    const { sql, params } = buildUpdate<UpdateComponentRollupInput>(
      'component_rollups',
      COMPONENT_ROLLUP_COLUMNS,
      input,
      id,
      now,
    );
    await queryable.exec(sql, params);
  }

  static async delete(queryable: Queryable, id: string): Promise<void> {
    await queryable.exec('DELETE FROM component_rollups WHERE id = ?', [id]);
  }
}

// comparison_cohorts

const COMPARISON_COHORT_COLUMNS: readonly Column[] = [
  { name: 'id', field: 'id', type: 'TEXT', pkey: true, notNull: true },
  {
    name: 'analysis_release_id',
    field: 'analysisReleaseId',
    type: 'TEXT',
    notNull: true,
    fk: { table: 'analysis_releases', column: 'id', onDelete: 'RESTRICT' },
  },
  {
    name: 'cohort_type',
    field: 'cohortType',
    type: 'TEXT',
    notNull: true,
    check: `cohort_type IN (${COHORT_TYPES.map((t) => `'${t}'`).join(', ')})`,
  },
  { name: 'recipe_id', field: 'recipeId', type: 'TEXT', notNull: true },
  { name: 'recipe_version', field: 'recipeVersion', type: 'INTEGER', notNull: true },
  { name: 'dimension_name', field: 'dimensionName', type: 'TEXT' },
  { name: 'dimension_value', field: 'dimensionValue', type: 'TEXT' },
  { name: 'reference_time', field: 'referenceTime', type: 'INTEGER' },
  { name: 'start_time', field: 'startTime', type: 'INTEGER' },
  { name: 'end_time', field: 'endTime', type: 'INTEGER' },
  { name: 'metadata', field: 'metadata', type: 'TEXT', notNull: true, default: '{}' },
  { name: 'created_at', field: 'createdAt', type: 'INTEGER', notNull: true },
  { name: 'updated_at', field: 'updatedAt', type: 'INTEGER', notNull: true },
];

const COMPARISON_COHORT_INDEXES: readonly IndexSpec[] = [
  {
    name: 'idx_comparison_cohorts_unique',
    columns: [
      'analysis_release_id',
      'recipe_id',
      'recipe_version',
      'cohort_type',
      "COALESCE(dimension_name, '')",
      "COALESCE(dimension_value, '')",
    ],
    unique: true,
  },
  { name: 'idx_comparison_cohorts_recipe', columns: ['recipe_id', 'recipe_version'] },
  { name: 'idx_comparison_cohorts_release', columns: ['analysis_release_id'] },
];

export const CREATE_COMPARISON_COHORTS_TABLE = buildCreateTable(
  'comparison_cohorts',
  COMPARISON_COHORT_COLUMNS,
  COMPARISON_COHORT_INDEXES,
);

export interface ComparisonCohort {
  readonly id: string;
  readonly analysisReleaseId: string;
  readonly cohortType: CohortType;
  readonly recipeId: string;
  readonly recipeVersion: number;
  readonly dimensionName: string | null;
  readonly dimensionValue: string | null;
  readonly referenceTime: number | null;
  readonly startTime: number | null;
  readonly endTime: number | null;
  readonly metadata: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type InsertComparisonCohortInput = InsertInput<ComparisonCohort>;
export type UpdateComparisonCohortInput = UpdateInput<ComparisonCohort>;

// biome-ignore lint/complexity/noStaticOnlyClass: typed rollup store
export class ComparisonCohortStore {
  private static rowToComparisonCohort(row: SqliteRow): ComparisonCohort {
    return {
      id: asString(row.id),
      analysisReleaseId: asString(row.analysis_release_id),
      cohortType: asString(row.cohort_type) as CohortType,
      recipeId: asString(row.recipe_id),
      recipeVersion: toNumber(row.recipe_version),
      dimensionName: toOptionalString(row.dimension_name),
      dimensionValue: toOptionalString(row.dimension_value),
      referenceTime: toOptionalNumber(row.reference_time),
      startTime: toOptionalNumber(row.start_time),
      endTime: toOptionalNumber(row.end_time),
      metadata: asString(row.metadata),
      createdAt: toNumber(row.created_at),
      updatedAt: toNumber(row.updated_at),
    };
  }

  private static selectColumns(): string {
    return COMPARISON_COHORT_COLUMNS.map((c) => c.name).join(', ');
  }

  static async insert(queryable: Queryable, input: InsertComparisonCohortInput): Promise<string> {
    const now = Date.now();
    const record = input as unknown as Record<string, unknown>;
    const id =
      (record.id as string | undefined) ??
      `cco-${deterministicId(
        'comparison-cohort',
        input.recipeId,
        String(input.recipeVersion),
        input.cohortType,
        String(now),
      )}`;
    await queryable.exec(
      buildInsertSql('comparison_cohorts', COMPARISON_COHORT_COLUMNS),
      toInsertParams<InsertComparisonCohortInput>(COMPARISON_COHORT_COLUMNS, input, id, now),
    );
    return id;
  }

  static async getById(queryable: Queryable, id: string): Promise<ComparisonCohort | undefined> {
    const { rows } = await queryable.exec(
      `SELECT ${ComparisonCohortStore.selectColumns()} FROM comparison_cohorts WHERE id = ?`,
      [id],
    );
    if (rows.length === 0) return undefined;
    return ComparisonCohortStore.rowToComparisonCohort(rows[0]);
  }

  static async getByRecipeAndType(
    queryable: Queryable,
    analysisReleaseId: string,
    recipeId: string,
    recipeVersion: number,
    cohortType: CohortType,
    dimensionName: string | null,
    dimensionValue: string | null,
  ): Promise<ComparisonCohort | undefined> {
    const { rows } = await queryable.exec(
      `SELECT ${ComparisonCohortStore.selectColumns()}
       FROM comparison_cohorts
       WHERE analysis_release_id = ? AND recipe_id = ? AND recipe_version = ?
         AND cohort_type = ?
         AND COALESCE(dimension_name, '') = COALESCE(?, '')
         AND COALESCE(dimension_value, '') = COALESCE(?, '')`,
      [
        analysisReleaseId,
        recipeId,
        recipeVersion,
        cohortType,
        dimensionName ?? '',
        dimensionValue ?? '',
      ],
    );
    if (rows.length === 0) return undefined;
    return ComparisonCohortStore.rowToComparisonCohort(rows[0]);
  }

  static async listByAnalysisRelease(
    queryable: Queryable,
    analysisReleaseId: string,
  ): Promise<readonly ComparisonCohort[]> {
    const { rows } = await queryable.exec(
      `SELECT ${ComparisonCohortStore.selectColumns()}
       FROM comparison_cohorts
       WHERE analysis_release_id = ?
       ORDER BY recipe_id, recipe_version`,
      [analysisReleaseId],
    );
    return rows.map(ComparisonCohortStore.rowToComparisonCohort);
  }

  static async update(
    queryable: Queryable,
    id: string,
    input: UpdateComparisonCohortInput,
  ): Promise<void> {
    const now = Date.now();
    const { sql, params } = buildUpdate<UpdateComparisonCohortInput>(
      'comparison_cohorts',
      COMPARISON_COHORT_COLUMNS,
      input,
      id,
      now,
    );
    await queryable.exec(sql, params);
  }

  static async delete(queryable: Queryable, id: string): Promise<void> {
    await queryable.exec('DELETE FROM comparison_cohorts WHERE id = ?', [id]);
  }
}

// comparison_cohort_members

const COMPARISON_COHORT_MEMBER_COLUMNS: readonly Column[] = [
  { name: 'id', field: 'id', type: 'TEXT', pkey: true, notNull: true },
  {
    name: 'cohort_id',
    field: 'cohortId',
    type: 'TEXT',
    notNull: true,
    fk: { table: 'comparison_cohorts', column: 'id', onDelete: 'CASCADE' },
  },
  {
    name: 'session_id',
    field: 'sessionId',
    type: 'TEXT',
    notNull: true,
    fk: { table: 'sessions', column: 'id', onDelete: 'CASCADE' },
  },
  {
    name: 'generation_id',
    field: 'generationId',
    type: 'TEXT',
    notNull: true,
    fk: { table: 'transformation_generations', column: 'id', onDelete: 'CASCADE' },
  },
  {
    name: 'group_label',
    field: 'groupLabel',
    type: 'TEXT',
    notNull: true,
    check: `group_label IN (${COHORT_GROUP_LABELS.map((l) => `'${l}'`).join(', ')})`,
  },
  { name: 'concurrent_event_id', field: 'concurrentEventId', type: 'TEXT' },
  { name: 'created_at', field: 'createdAt', type: 'INTEGER', notNull: true },
  { name: 'updated_at', field: 'updatedAt', type: 'INTEGER', notNull: true },
];

const COMPARISON_COHORT_MEMBER_INDEXES: readonly IndexSpec[] = [
  {
    name: 'idx_comparison_cohort_members_unique',
    columns: ['cohort_id', 'session_id', 'generation_id', 'group_label'],
    unique: true,
  },
  { name: 'idx_comparison_cohort_members_cohort', columns: ['cohort_id'] },
  { name: 'idx_comparison_cohort_members_session', columns: ['session_id'] },
  { name: 'idx_comparison_cohort_members_group', columns: ['cohort_id', 'group_label'] },
];

export const CREATE_COMPARISON_COHORT_MEMBERS_TABLE = buildCreateTable(
  'comparison_cohort_members',
  COMPARISON_COHORT_MEMBER_COLUMNS,
  COMPARISON_COHORT_MEMBER_INDEXES,
);

export interface ComparisonCohortMember {
  readonly id: string;
  readonly cohortId: string;
  readonly sessionId: string;
  readonly generationId: string;
  readonly groupLabel: CohortGroupLabel;
  readonly concurrentEventId: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type InsertComparisonCohortMemberInput = InsertInput<ComparisonCohortMember>;
export type UpdateComparisonCohortMemberInput = UpdateInput<ComparisonCohortMember>;

// biome-ignore lint/complexity/noStaticOnlyClass: typed rollup store
export class ComparisonCohortMemberStore {
  private static rowToComparisonCohortMember(row: SqliteRow): ComparisonCohortMember {
    return {
      id: asString(row.id),
      cohortId: asString(row.cohort_id),
      sessionId: asString(row.session_id),
      generationId: asString(row.generation_id),
      groupLabel: asString(row.group_label) as CohortGroupLabel,
      concurrentEventId: toOptionalString(row.concurrent_event_id),
      createdAt: toNumber(row.created_at),
      updatedAt: toNumber(row.updated_at),
    };
  }

  private static selectColumns(): string {
    return COMPARISON_COHORT_MEMBER_COLUMNS.map((c) => c.name).join(', ');
  }

  static async insert(
    queryable: Queryable,
    input: InsertComparisonCohortMemberInput,
  ): Promise<string> {
    const now = Date.now();
    const record = input as unknown as Record<string, unknown>;
    const id =
      (record.id as string | undefined) ??
      `ccm-${deterministicId(
        'comparison-cohort-member',
        input.cohortId,
        input.sessionId,
        input.groupLabel,
        String(now),
      )}`;
    await queryable.exec(
      buildInsertSql('comparison_cohort_members', COMPARISON_COHORT_MEMBER_COLUMNS),
      toInsertParams<InsertComparisonCohortMemberInput>(
        COMPARISON_COHORT_MEMBER_COLUMNS,
        input,
        id,
        now,
      ),
    );
    return id;
  }

  static async getById(
    queryable: Queryable,
    id: string,
  ): Promise<ComparisonCohortMember | undefined> {
    const { rows } = await queryable.exec(
      `SELECT ${ComparisonCohortMemberStore.selectColumns()} FROM comparison_cohort_members WHERE id = ?`,
      [id],
    );
    if (rows.length === 0) return undefined;
    return ComparisonCohortMemberStore.rowToComparisonCohortMember(rows[0]);
  }

  static async listByCohort(
    queryable: Queryable,
    cohortId: string,
  ): Promise<readonly ComparisonCohortMember[]> {
    const { rows } = await queryable.exec(
      `SELECT ${ComparisonCohortMemberStore.selectColumns()}
       FROM comparison_cohort_members
       WHERE cohort_id = ?
       ORDER BY group_label, created_at`,
      [cohortId],
    );
    return rows.map(ComparisonCohortMemberStore.rowToComparisonCohortMember);
  }

  static async listBySession(
    queryable: Queryable,
    sessionId: string,
  ): Promise<readonly ComparisonCohortMember[]> {
    const { rows } = await queryable.exec(
      `SELECT ${ComparisonCohortMemberStore.selectColumns()}
       FROM comparison_cohort_members
       WHERE session_id = ?
       ORDER BY created_at`,
      [sessionId],
    );
    return rows.map(ComparisonCohortMemberStore.rowToComparisonCohortMember);
  }

  static async update(
    queryable: Queryable,
    id: string,
    input: UpdateComparisonCohortMemberInput,
  ): Promise<void> {
    const now = Date.now();
    const { sql, params } = buildUpdate<UpdateComparisonCohortMemberInput>(
      'comparison_cohort_members',
      COMPARISON_COHORT_MEMBER_COLUMNS,
      input,
      id,
      now,
    );
    await queryable.exec(sql, params);
  }

  static async delete(queryable: Queryable, id: string): Promise<void> {
    await queryable.exec('DELETE FROM comparison_cohort_members WHERE id = ?', [id]);
  }
}

// insight_evidence

const INSIGHT_EVIDENCE_COLUMNS: readonly Column[] = [
  { name: 'id', field: 'id', type: 'TEXT', pkey: true, notNull: true },
  {
    name: 'analysis_release_id',
    field: 'analysisReleaseId',
    type: 'TEXT',
    notNull: true,
    fk: { table: 'analysis_releases', column: 'id', onDelete: 'RESTRICT' },
  },
  { name: 'recipe_id', field: 'recipeId', type: 'TEXT', notNull: true },
  { name: 'recipe_version', field: 'recipeVersion', type: 'INTEGER', notNull: true },
  {
    name: 'insight_kind',
    field: 'insightKind',
    type: 'TEXT',
    notNull: true,
    check: `insight_kind IN (${INSIGHT_KINDS.map((k) => `'${k}'`).join(', ')})`,
  },
  { name: 'wording_inputs', field: 'wordingInputs', type: 'TEXT', notNull: true, default: '{}' },
  { name: 'evidence_ids', field: 'evidenceIds', type: 'TEXT', notNull: true, default: '[]' },
  { name: 'confidence', field: 'confidence', type: 'REAL' },
  { name: 'confidence_reason', field: 'confidenceReason', type: 'TEXT' },
  { name: 'determinism_version', field: 'determinismVersion', type: 'TEXT', notNull: true },
  {
    name: 'generation_id',
    field: 'generationId',
    type: 'TEXT',
    fk: { table: 'transformation_generations', column: 'id', onDelete: 'SET NULL' },
  },
  { name: 'created_at', field: 'createdAt', type: 'INTEGER', notNull: true },
  { name: 'updated_at', field: 'updatedAt', type: 'INTEGER', notNull: true },
];

const INSIGHT_EVIDENCE_INDEXES: readonly IndexSpec[] = [
  {
    name: 'idx_insight_evidence_unique',
    columns: [
      'analysis_release_id',
      'recipe_id',
      'recipe_version',
      'insight_kind',
      "COALESCE(generation_id, '')",
    ],
    unique: true,
  },
  { name: 'idx_insight_evidence_recipe', columns: ['recipe_id', 'recipe_version'] },
  { name: 'idx_insight_evidence_release', columns: ['analysis_release_id'] },
];

export const CREATE_INSIGHT_EVIDENCE_TABLE = buildCreateTable(
  'insight_evidence',
  INSIGHT_EVIDENCE_COLUMNS,
  INSIGHT_EVIDENCE_INDEXES,
);

export interface InsightEvidence {
  readonly id: string;
  readonly analysisReleaseId: string;
  readonly recipeId: string;
  readonly recipeVersion: number;
  readonly insightKind: InsightKind;
  readonly wordingInputs: string;
  readonly evidenceIds: string;
  readonly confidence: number | null;
  readonly confidenceReason: string | null;
  readonly determinismVersion: string;
  readonly generationId: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type InsertInsightEvidenceInput = InsertInput<InsightEvidence>;
export type UpdateInsightEvidenceInput = UpdateInput<InsightEvidence>;

// biome-ignore lint/complexity/noStaticOnlyClass: typed rollup store
export class InsightEvidenceStore {
  private static rowToInsightEvidence(row: SqliteRow): InsightEvidence {
    return {
      id: asString(row.id),
      analysisReleaseId: asString(row.analysis_release_id),
      recipeId: asString(row.recipe_id),
      recipeVersion: toNumber(row.recipe_version),
      insightKind: asString(row.insight_kind) as InsightKind,
      wordingInputs: asString(row.wording_inputs),
      evidenceIds: asString(row.evidence_ids),
      confidence: toOptionalNumber(row.confidence),
      confidenceReason: toOptionalString(row.confidence_reason),
      determinismVersion: asString(row.determinism_version),
      generationId: toOptionalString(row.generation_id),
      createdAt: toNumber(row.created_at),
      updatedAt: toNumber(row.updated_at),
    };
  }

  private static selectColumns(): string {
    return INSIGHT_EVIDENCE_COLUMNS.map((c) => c.name).join(', ');
  }

  static async insert(queryable: Queryable, input: InsertInsightEvidenceInput): Promise<string> {
    const now = Date.now();
    const record = input as unknown as Record<string, unknown>;
    const id =
      (record.id as string | undefined) ??
      `iev-${deterministicId(
        'insight-evidence',
        input.recipeId,
        String(input.recipeVersion),
        input.insightKind,
        String(now),
      )}`;
    await queryable.exec(
      buildInsertSql('insight_evidence', INSIGHT_EVIDENCE_COLUMNS),
      toInsertParams<InsertInsightEvidenceInput>(INSIGHT_EVIDENCE_COLUMNS, input, id, now),
    );
    return id;
  }

  static async getById(queryable: Queryable, id: string): Promise<InsightEvidence | undefined> {
    const { rows } = await queryable.exec(
      `SELECT ${InsightEvidenceStore.selectColumns()} FROM insight_evidence WHERE id = ?`,
      [id],
    );
    if (rows.length === 0) return undefined;
    return InsightEvidenceStore.rowToInsightEvidence(rows[0]);
  }

  static async getByRecipeAndKind(
    queryable: Queryable,
    analysisReleaseId: string,
    recipeId: string,
    recipeVersion: number,
    insightKind: InsightKind,
    generationId: string | null,
  ): Promise<InsightEvidence | undefined> {
    const { rows } = await queryable.exec(
      `SELECT ${InsightEvidenceStore.selectColumns()}
       FROM insight_evidence
       WHERE analysis_release_id = ? AND recipe_id = ? AND recipe_version = ?
         AND insight_kind = ?
         AND COALESCE(generation_id, '') = COALESCE(?, '')`,
      [analysisReleaseId, recipeId, recipeVersion, insightKind, generationId ?? ''],
    );
    if (rows.length === 0) return undefined;
    return InsightEvidenceStore.rowToInsightEvidence(rows[0]);
  }

  static async listByAnalysisRelease(
    queryable: Queryable,
    analysisReleaseId: string,
  ): Promise<readonly InsightEvidence[]> {
    const { rows } = await queryable.exec(
      `SELECT ${InsightEvidenceStore.selectColumns()}
       FROM insight_evidence
       WHERE analysis_release_id = ?
       ORDER BY recipe_id, recipe_version`,
      [analysisReleaseId],
    );
    return rows.map(InsightEvidenceStore.rowToInsightEvidence);
  }

  static async update(
    queryable: Queryable,
    id: string,
    input: UpdateInsightEvidenceInput,
  ): Promise<void> {
    const now = Date.now();
    const { sql, params } = buildUpdate<UpdateInsightEvidenceInput>(
      'insight_evidence',
      INSIGHT_EVIDENCE_COLUMNS,
      input,
      id,
      now,
    );
    await queryable.exec(sql, params);
  }

  static async delete(queryable: Queryable, id: string): Promise<void> {
    await queryable.exec('DELETE FROM insight_evidence WHERE id = ?', [id]);
  }
}

/**
 * Combined DDL for all rollup, summary, distribution, cohort, and insight
 * tables. Tests can execute this after `FRESH_SCHEMA_SQL` to set up the rollup
 * schema before the orchestrator merges the migration fragment.
 */
export const ROLLUPS_DDL = `
${CREATE_ROLLUP_POLICIES_TABLE}
${CREATE_SESSION_SUMMARIES_TABLE}
${CREATE_SESSION_COMPONENT_STATS_TABLE}
${CREATE_SESSION_CHART_SERIES_TABLE}
${CREATE_ROLLUP_CONTRIBUTIONS_TABLE}
${CREATE_PROJECT_DAILY_ROLLUPS_TABLE}
${CREATE_PORTFOLIO_DAILY_ROLLUPS_TABLE}
${CREATE_PROJECT_DIMENSION_ROLLUPS_TABLE}
${CREATE_PORTFOLIO_DIMENSION_ROLLUPS_TABLE}
${CREATE_PROJECT_DISTRIBUTIONS_TABLE}
${CREATE_PORTFOLIO_DISTRIBUTIONS_TABLE}
${CREATE_COMPONENT_ROLLUPS_TABLE}
${CREATE_COMPARISON_COHORTS_TABLE}
${CREATE_COMPARISON_COHORT_MEMBERS_TABLE}
${CREATE_INSIGHT_EVIDENCE_TABLE}
`.trim();

/**
 * Forward migration fragment for the rollup schema. The orchestrator will merge
 * this with the existing migrations (ids 1-64) to produce the final migration
 * history.
 */
export const ROLLUPS_MIGRATIONS_FRAGMENT: readonly Migration[] = [
  {
    id: 65,
    name: 'create-rollup-policies',
    sql: CREATE_ROLLUP_POLICIES_TABLE,
    checksum: checksumOf(CREATE_ROLLUP_POLICIES_TABLE),
  },
  {
    id: 66,
    name: 'create-session-summaries',
    sql: CREATE_SESSION_SUMMARIES_TABLE,
    checksum: checksumOf(CREATE_SESSION_SUMMARIES_TABLE),
  },
  {
    id: 67,
    name: 'create-session-component-stats',
    sql: CREATE_SESSION_COMPONENT_STATS_TABLE,
    checksum: checksumOf(CREATE_SESSION_COMPONENT_STATS_TABLE),
  },
  {
    id: 68,
    name: 'create-session-chart-series',
    sql: CREATE_SESSION_CHART_SERIES_TABLE,
    checksum: checksumOf(CREATE_SESSION_CHART_SERIES_TABLE),
  },
  {
    id: 69,
    name: 'create-rollup-contributions',
    sql: CREATE_ROLLUP_CONTRIBUTIONS_TABLE,
    checksum: checksumOf(CREATE_ROLLUP_CONTRIBUTIONS_TABLE),
  },
  {
    id: 70,
    name: 'create-project-daily-rollups',
    sql: CREATE_PROJECT_DAILY_ROLLUPS_TABLE,
    checksum: checksumOf(CREATE_PROJECT_DAILY_ROLLUPS_TABLE),
  },
  {
    id: 71,
    name: 'create-portfolio-daily-rollups',
    sql: CREATE_PORTFOLIO_DAILY_ROLLUPS_TABLE,
    checksum: checksumOf(CREATE_PORTFOLIO_DAILY_ROLLUPS_TABLE),
  },
  {
    id: 72,
    name: 'create-project-dimension-rollups',
    sql: CREATE_PROJECT_DIMENSION_ROLLUPS_TABLE,
    checksum: checksumOf(CREATE_PROJECT_DIMENSION_ROLLUPS_TABLE),
  },
  {
    id: 73,
    name: 'create-portfolio-dimension-rollups',
    sql: CREATE_PORTFOLIO_DIMENSION_ROLLUPS_TABLE,
    checksum: checksumOf(CREATE_PORTFOLIO_DIMENSION_ROLLUPS_TABLE),
  },
  {
    id: 74,
    name: 'create-project-distributions',
    sql: CREATE_PROJECT_DISTRIBUTIONS_TABLE,
    checksum: checksumOf(CREATE_PROJECT_DISTRIBUTIONS_TABLE),
  },
  {
    id: 75,
    name: 'create-portfolio-distributions',
    sql: CREATE_PORTFOLIO_DISTRIBUTIONS_TABLE,
    checksum: checksumOf(CREATE_PORTFOLIO_DISTRIBUTIONS_TABLE),
  },
  {
    id: 76,
    name: 'create-component-rollups',
    sql: CREATE_COMPONENT_ROLLUPS_TABLE,
    checksum: checksumOf(CREATE_COMPONENT_ROLLUPS_TABLE),
  },
  {
    id: 77,
    name: 'create-comparison-cohorts',
    sql: CREATE_COMPARISON_COHORTS_TABLE,
    checksum: checksumOf(CREATE_COMPARISON_COHORTS_TABLE),
  },
  {
    id: 78,
    name: 'create-comparison-cohort-members',
    sql: CREATE_COMPARISON_COHORT_MEMBERS_TABLE,
    checksum: checksumOf(CREATE_COMPARISON_COHORT_MEMBERS_TABLE),
  },
  {
    id: 79,
    name: 'create-insight-evidence',
    sql: CREATE_INSIGHT_EVIDENCE_TABLE,
    checksum: checksumOf(CREATE_INSIGHT_EVIDENCE_TABLE),
  },
];
