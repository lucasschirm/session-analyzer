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

interface SensitivePair {
  readonly retainColumn: string;
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
  readonly sensitive?: SensitivePair;
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
  const checks: string[] = [];
  for (const column of columns) {
    if (column.sensitive) {
      checks.push(`${column.name} IS NULL OR ${column.sensitive.retainColumn} = 1`);
    }
  }
  checks.push(...extraChecks);
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

function buildAlterSessions(columns: readonly Column[], indexes: readonly IndexSpec[]): string {
  let sql = '';
  for (const column of columns) {
    sql += `ALTER TABLE sessions ADD COLUMN ${buildColumnDef(column)};\n`;
  }
  for (const index of indexes) {
    const unique = index.unique ? 'UNIQUE ' : '';
    sql += `CREATE ${unique}INDEX IF NOT EXISTS ${index.name} ON sessions(${index.columns.join(', ')});\n`;
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

function convertValue(column: Column, value: SqliteValue): SqliteValue {
  if (value === null || value === undefined) {
    if (column.isBoolean) return false;
    if (column.type === 'INTEGER' || column.type === 'REAL') return column.notNull ? 0 : null;
    if (column.type === 'BLOB') return null;
    return column.notNull ? '' : null;
  }
  if (column.isBoolean) return value === 1 || value === true;
  if (column.type === 'INTEGER' || column.type === 'REAL') return Number(value);
  if (column.type === 'BLOB') return value instanceof Uint8Array ? value : null;
  return String(value);
}

function rowTo<Row>(columns: readonly Column[], row: SqliteRow): Row {
  const result: Record<string, SqliteValue> = {};
  for (const column of columns) {
    result[column.field] = convertValue(column, row[column.name]);
  }
  return result as unknown as Row;
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

export interface ParentedStore<Row, Insert, Update> {
  readonly insert: (queryable: Queryable, input: Insert) => Promise<string>;
  readonly getById: (
    queryable: Queryable,
    parentId: string,
    id: string,
  ) => Promise<Row | undefined>;
  readonly listByParent: (queryable: Queryable, parentId: string) => Promise<readonly Row[]>;
  readonly update: (
    queryable: Queryable,
    parentId: string,
    id: string,
    input: Update,
  ) => Promise<void>;
  readonly delete: (queryable: Queryable, parentId: string, id: string) => Promise<void>;
}

type SessionScopedStore<Row, Insert, Update> = ParentedStore<Row, Insert, Update> & {
  readonly listBySession: (queryable: Queryable, sessionId: string) => Promise<readonly Row[]>;
};

interface ParentedStoreConfig<Insert> {
  readonly table: string;
  readonly columns: readonly Column[];
  readonly parentColumn: string;
  readonly idFrom: readonly (keyof Insert)[];
  readonly listOrderBy?: string;
}

function createParentedStore<Row, Insert, Update>(
  config: ParentedStoreConfig<Insert>,
): ParentedStore<Row, Insert, Update> {
  const insertSql = buildInsertSql(config.table, config.columns);
  const selectColumns = config.columns.map((c) => c.name).join(', ');
  const orderBy = config.listOrderBy ?? 'created_at';
  return {
    insert: async (queryable: Queryable, input: Insert): Promise<string> => {
      const now = Date.now();
      const record = input as unknown as Record<string, unknown>;
      const idParts: string[] = config.idFrom.map((field) => String(record[field as string] ?? ''));
      idParts.push(String(now));
      const id =
        (record.id as string | undefined) ?? `se-${deterministicId(config.table, ...idParts)}`;
      const params = toInsertParams<Insert>(config.columns, input, id, now);
      await queryable.exec(insertSql, params);
      return id;
    },
    getById: async (
      queryable: Queryable,
      parentId: string,
      id: string,
    ): Promise<Row | undefined> => {
      const { rows } = await queryable.exec(
        `SELECT ${selectColumns} FROM ${config.table} WHERE id = ? AND ${config.parentColumn} = ?`,
        [id, parentId],
      );
      if (rows.length === 0) return undefined;
      return rowTo<Row>(config.columns, rows[0]);
    },
    listByParent: async (queryable: Queryable, parentId: string): Promise<readonly Row[]> => {
      const { rows } = await queryable.exec(
        `SELECT ${selectColumns} FROM ${config.table} WHERE ${config.parentColumn} = ? ORDER BY ${orderBy}`,
        [parentId],
      );
      return rows.map((r) => rowTo<Row>(config.columns, r));
    },
    update: async (
      queryable: Queryable,
      parentId: string,
      id: string,
      input: Update,
    ): Promise<void> => {
      const now = Date.now();
      const { sql, params } = buildUpdate<Update>(
        config.table,
        config.columns,
        input,
        id,
        now,
        config.parentColumn,
        parentId,
      );
      await queryable.exec(sql, params);
    },
    delete: async (queryable: Queryable, parentId: string, id: string): Promise<void> => {
      await queryable.exec(
        `DELETE FROM ${config.table} WHERE id = ? AND ${config.parentColumn} = ?`,
        [id, parentId],
      );
    },
  };
}

function createSessionScopedStore<Row, Insert, Update>(
  config: Omit<ParentedStoreConfig<Insert>, 'parentColumn'>,
): SessionScopedStore<Row, Insert, Update> {
  const parented = createParentedStore<Row, Insert, Update>({
    ...config,
    parentColumn: 'session_id',
  });
  return {
    ...parented,
    listBySession: parented.listByParent,
  };
}

export interface GlobalStore<Row, Insert, Update> {
  readonly insert: (queryable: Queryable, input: Insert) => Promise<string>;
  readonly getById: (queryable: Queryable, id: string) => Promise<Row | undefined>;
  readonly listAll: (queryable: Queryable) => Promise<readonly Row[]>;
  readonly update: (queryable: Queryable, id: string, input: Update) => Promise<void>;
  readonly delete: (queryable: Queryable, id: string) => Promise<void>;
}

interface GlobalStoreConfig<Insert> {
  readonly table: string;
  readonly columns: readonly Column[];
  readonly idFrom: readonly (keyof Insert)[];
  readonly listOrderBy?: string;
}

function createGlobalStore<Row, Insert, Update>(
  config: GlobalStoreConfig<Insert>,
): GlobalStore<Row, Insert, Update> {
  const insertSql = buildInsertSql(config.table, config.columns);
  const selectColumns = config.columns.map((c) => c.name).join(', ');
  const orderBy = config.listOrderBy ?? 'created_at';
  return {
    insert: async (queryable: Queryable, input: Insert): Promise<string> => {
      const now = Date.now();
      const record = input as unknown as Record<string, unknown>;
      const idParts: string[] = config.idFrom.map((field) => String(record[field as string] ?? ''));
      idParts.push(String(now));
      const id =
        (record.id as string | undefined) ?? `se-${deterministicId(config.table, ...idParts)}`;
      const params = toInsertParams<Insert>(config.columns, input, id, now);
      await queryable.exec(insertSql, params);
      return id;
    },
    getById: async (queryable: Queryable, id: string): Promise<Row | undefined> => {
      const { rows } = await queryable.exec(
        `SELECT ${selectColumns} FROM ${config.table} WHERE id = ?`,
        [id],
      );
      if (rows.length === 0) return undefined;
      return rowTo<Row>(config.columns, rows[0]);
    },
    listAll: async (queryable: Queryable): Promise<readonly Row[]> => {
      const { rows } = await queryable.exec(
        `SELECT ${selectColumns} FROM ${config.table} ORDER BY ${orderBy}`,
      );
      return rows.map((r) => rowTo<Row>(config.columns, r));
    },
    update: async (queryable: Queryable, id: string, input: Update): Promise<void> => {
      const now = Date.now();
      const { sql, params } = buildUpdate<Update>(config.table, config.columns, input, id, now);
      await queryable.exec(sql, params);
    },
    delete: async (queryable: Queryable, id: string): Promise<void> => {
      await queryable.exec(`DELETE FROM ${config.table} WHERE id = ?`, [id]);
    },
  };
}

export type InsertInput<T> = Omit<T, 'id' | 'createdAt' | 'updatedAt'> & {
  id?: string;
  createdAt?: number;
  updatedAt?: number;
};

export type UpdateInput<T> = Partial<Omit<T, 'id' | 'createdAt'>>;

// Enums

export const TURN_ROLES = ['human', 'assistant', 'system'] as const;
export type TurnRole = (typeof TURN_ROLES)[number];

export const MESSAGE_ROLES = [
  'user',
  'assistant',
  'system',
  'tool',
  'developer',
  'error',
  'annotation',
  'other',
] as const;
export type MessageRole = (typeof MESSAGE_ROLES)[number];

export const MESSAGE_TYPES = [
  'text',
  'tool_use',
  'tool_result',
  'image',
  'cache',
  'compaction',
  'other',
] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

export const REQUEST_STATUSES = ['pending', 'success', 'error', 'cancelled', 'timeout'] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export const MODEL_TOKEN_CLASSES = [
  'input',
  'output',
  'cache_creation',
  'cache_read',
  'reasoning',
  'total',
] as const;
export type ModelTokenClass = (typeof MODEL_TOKEN_CLASSES)[number];

export const PAYLOAD_TYPES = [
  'input',
  'result',
  'injection',
  'context',
  'transcript',
  'tool',
] as const;
export type PayloadType = (typeof PAYLOAD_TYPES)[number];

export const INVOCATION_KINDS = ['tool', 'skill', 'agent', 'sub_agent'] as const;
export type InvocationKind = (typeof INVOCATION_KINDS)[number];

export const INVOCATION_STATUSES = [
  'started',
  'completed',
  'failed',
  'cancelled',
  'timeout',
] as const;
export type InvocationStatus = (typeof INVOCATION_STATUSES)[number];

export const INVOCATION_ORIGINS = ['root', 'sub_agent', 'sidechain', 'inline'] as const;
export type InvocationOrigin = (typeof INVOCATION_ORIGINS)[number];

export const ATTRIBUTION_TYPES = [
  'exact',
  'estimated',
  'allocated',
  'proportional',
  'inherited',
  'unavailable',
] as const;
export type AttributionType = (typeof ATTRIBUTION_TYPES)[number];

export const PERMISSION_DECISIONS = ['approved', 'denied', 'cancelled', 'pending'] as const;
export type PermissionDecision = (typeof PERMISSION_DECISIONS)[number];

export const HOOK_STATUSES = ['started', 'completed', 'failed', 'skipped', 'timeout'] as const;
export type HookStatus = (typeof HOOK_STATUSES)[number];

export const MODE_TRIGGERS = ['manual', 'automatic', 'policy', 'override', 'system'] as const;
export type ModeTrigger = (typeof MODE_TRIGGERS)[number];

export const TASK_STATUSES = [
  'open',
  'in_progress',
  'completed',
  'failed',
  'cancelled',
  'blocked',
  'unknown',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const VALIDATION_RESULTS = ['pass', 'fail', 'error', 'skip', 'unknown'] as const;
export type ValidationResult = (typeof VALIDATION_RESULTS)[number];

export const FILE_OPERATIONS = [
  'read',
  'write',
  'edit',
  'create',
  'delete',
  'rename',
  'revert',
] as const;
export type FileOperationType = (typeof FILE_OPERATIONS)[number];

export const FILE_OPERATION_STATUSES = [
  'started',
  'completed',
  'failed',
  'reverted',
  'skipped',
] as const;
export type FileOperationStatus = (typeof FILE_OPERATION_STATUSES)[number];

export const COMMAND_STATUSES = [
  'started',
  'completed',
  'interrupted',
  'failed',
  'timeout',
  'killed',
  'unknown',
] as const;
export type CommandStatus = (typeof COMMAND_STATUSES)[number];

export const EVIDENCE_TYPES = [
  'turn',
  'message',
  'invocation',
  'payload',
  'task',
  'validation',
  'file_operation',
  'command_execution',
] as const;
export type EvidenceType = (typeof EVIDENCE_TYPES)[number];

export const COMPONENT_EVIDENCE_LINK_TYPES = [
  'primary',
  'supporting',
  'related',
  'caused',
  'contains',
] as const;
export type ComponentEvidenceLinkType = (typeof COMPONENT_EVIDENCE_LINK_TYPES)[number];

export const INCLUSION_SEMANTICS = ['native', 'explicit', 'inferred', 'manual'] as const;
export type InclusionSemantics = (typeof INCLUSION_SEMANTICS)[number];

// Session extension columns

const SESSION_EVIDENCE_EXTENSION_COLUMNS: readonly Column[] = [
  { name: 'start_time', field: 'startTime', type: 'INTEGER' },
  { name: 'end_time', field: 'endTime', type: 'INTEGER' },
  { name: 'ai_title', field: 'aiTitle', type: 'TEXT' },
  { name: 'slug', field: 'slug', type: 'TEXT' },
  { name: 'agent_name', field: 'agentName', type: 'TEXT' },
  { name: 'cwd', field: 'cwd', type: 'TEXT' },
  { name: 'git_branch', field: 'gitBranch', type: 'TEXT' },
  { name: 'cli_versions', field: 'cliVersions', type: 'TEXT' },
  {
    name: 'is_sidechain',
    field: 'isSidechain',
    type: 'INTEGER',
    notNull: true,
    default: 0,
    isBoolean: true,
  },
  {
    name: 'agent_id',
    field: 'agentId',
    type: 'TEXT',
    fk: { table: 'component_identities', column: 'id', onDelete: 'SET NULL' },
  },
];

const SESSION_EVIDENCE_EXTENSION_INDEXES: readonly IndexSpec[] = [
  { name: 'idx_sessions_start_time', columns: ['start_time'] },
  { name: 'idx_sessions_end_time', columns: ['end_time'] },
  { name: 'idx_sessions_agent', columns: ['agent_id'] },
  { name: 'idx_sessions_sidechain', columns: ['is_sidechain'] },
];

export const ALTER_SESSIONS_EVIDENCE_COLUMNS = buildAlterSessions(
  SESSION_EVIDENCE_EXTENSION_COLUMNS,
  SESSION_EVIDENCE_EXTENSION_INDEXES,
);

// Session columns for the store

const SESSION_COLUMNS: readonly Column[] = [
  { name: 'id', field: 'id', type: 'TEXT', pkey: true, notNull: true },
  { name: 'project_id', field: 'projectId', type: 'TEXT', notNull: true },
  { name: 'ingestion_source_id', field: 'ingestionSourceId', type: 'TEXT', notNull: true },
  { name: 'environment_id', field: 'environmentId', type: 'TEXT' },
  { name: 'harness', field: 'harness', type: 'TEXT', notNull: true },
  { name: 'native_session_id', field: 'nativeSessionId', type: 'TEXT', notNull: true },
  {
    name: 'current_generation_id',
    field: 'currentGenerationId',
    type: 'TEXT',
    fk: { table: 'transformation_generations', column: 'id', onDelete: 'SET NULL' },
  },
  { name: 'occurrence_time', field: 'occurrenceTime', type: 'INTEGER' },
  {
    name: 'finality',
    field: 'finality',
    type: 'TEXT',
    notNull: true,
    default: 'open',
    check: `finality IN ('open', 'final', 'censored')`,
  },
  { name: 'mode', field: 'mode', type: 'TEXT' },
  { name: 'task_cohort', field: 'taskCohort', type: 'TEXT' },
  ...SESSION_EVIDENCE_EXTENSION_COLUMNS,
  { name: 'created_at', field: 'createdAt', type: 'INTEGER', notNull: true },
  { name: 'updated_at', field: 'updatedAt', type: 'INTEGER', notNull: true },
];

export interface Session {
  readonly id: string;
  readonly projectId: string;
  readonly ingestionSourceId: string;
  readonly environmentId: string | null;
  readonly harness: string;
  readonly nativeSessionId: string;
  readonly currentGenerationId: string | null;
  readonly occurrenceTime: number | null;
  readonly finality: string;
  readonly mode: string | null;
  readonly taskCohort: string | null;
  readonly startTime: number | null;
  readonly endTime: number | null;
  readonly aiTitle: string | null;
  readonly slug: string | null;
  readonly agentName: string | null;
  readonly cwd: string | null;
  readonly gitBranch: string | null;
  readonly cliVersions: string | null;
  readonly isSidechain: boolean;
  readonly agentId: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type InsertSessionInput = InsertInput<Session>;
export type UpdateSessionInput = Partial<
  Omit<
    Session,
    'id' | 'createdAt' | 'projectId' | 'ingestionSourceId' | 'nativeSessionId' | 'harness'
  >
>;

// biome-ignore lint/complexity/noStaticOnlyClass: typed session store
export class SessionStore {
  static async insert(queryable: Queryable, input: InsertSessionInput): Promise<string> {
    const now = Date.now();
    const record = input as unknown as Record<string, unknown>;
    const id =
      (record.id as string | undefined) ??
      `se-${deterministicId(
        'session',
        String(record.projectId ?? ''),
        String(record.ingestionSourceId ?? ''),
        String(record.nativeSessionId ?? ''),
        String(now),
      )}`;
    const sql = buildInsertSql('sessions', SESSION_COLUMNS);
    const params = toInsertParams<InsertSessionInput>(SESSION_COLUMNS, input, id, now);
    await queryable.exec(sql, params);
    return id;
  }

  static async getById(
    queryable: Queryable,
    projectId: string,
    id: string,
  ): Promise<Session | undefined> {
    const selectColumns = SESSION_COLUMNS.map((c) => c.name).join(', ');
    const { rows } = await queryable.exec(
      `SELECT ${selectColumns} FROM sessions WHERE id = ? AND project_id = ?`,
      [id, projectId],
    );
    if (rows.length === 0) return undefined;
    return rowTo<Session>(SESSION_COLUMNS, rows[0]);
  }

  static async listByProject(queryable: Queryable, projectId: string): Promise<readonly Session[]> {
    const selectColumns = SESSION_COLUMNS.map((c) => c.name).join(', ');
    const { rows } = await queryable.exec(
      `SELECT ${selectColumns} FROM sessions WHERE project_id = ? ORDER BY created_at DESC`,
      [projectId],
    );
    return rows.map((r) => rowTo<Session>(SESSION_COLUMNS, r));
  }

  static async update(
    queryable: Queryable,
    projectId: string,
    id: string,
    input: UpdateSessionInput,
  ): Promise<void> {
    const now = Date.now();
    const { sql, params } = buildUpdate<UpdateSessionInput>(
      'sessions',
      SESSION_COLUMNS,
      input,
      id,
      now,
      'project_id',
      projectId,
    );
    await queryable.exec(sql, params);
  }

  static async delete(queryable: Queryable, projectId: string, id: string): Promise<void> {
    await queryable.exec('DELETE FROM sessions WHERE id = ? AND project_id = ?', [id, projectId]);
  }
}

// Turns

const TURN_COLUMNS: readonly Column[] = [
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
    fk: { table: 'transformation_generations', column: 'id', onDelete: 'SET NULL' },
  },
  { name: 'ordering', field: 'ordering', type: 'INTEGER', notNull: true },
  {
    name: 'role',
    field: 'role',
    type: 'TEXT',
    notNull: true,
    check: `role IN (${TURN_ROLES.map((r) => `'${r}'`).join(', ')})`,
  },
  {
    name: 'source_identity_id',
    field: 'sourceIdentityId',
    type: 'TEXT',
    fk: { table: 'component_identities', column: 'id', onDelete: 'SET NULL' },
  },
  { name: 'start_time', field: 'startTime', type: 'INTEGER' },
  { name: 'end_time', field: 'endTime', type: 'INTEGER' },
  { name: 'created_at', field: 'createdAt', type: 'INTEGER', notNull: true },
  { name: 'updated_at', field: 'updatedAt', type: 'INTEGER', notNull: true },
];

const TURN_INDEXES: readonly IndexSpec[] = [
  { name: 'idx_turns_session_ordering', columns: ['session_id', 'ordering'], unique: true },
  { name: 'idx_turns_session', columns: ['session_id'] },
  { name: 'idx_turns_role', columns: ['session_id', 'role'] },
];

export const CREATE_TURNS_TABLE = buildCreateTable('turns', TURN_COLUMNS, TURN_INDEXES);

export interface Turn {
  readonly id: string;
  readonly sessionId: string;
  readonly generationId: string;
  readonly ordering: number;
  readonly role: TurnRole;
  readonly sourceIdentityId: string | null;
  readonly startTime: number | null;
  readonly endTime: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type InsertTurnInput = InsertInput<Turn>;
export type UpdateTurnInput = UpdateInput<Turn>;

export const TurnStore = createSessionScopedStore<Turn, InsertTurnInput, UpdateTurnInput>({
  table: 'turns',
  columns: TURN_COLUMNS,
  idFrom: ['sessionId', 'ordering'],
  listOrderBy: 'ordering',
});

// Messages

const MESSAGE_COLUMNS: readonly Column[] = [
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
    fk: { table: 'transformation_generations', column: 'id', onDelete: 'SET NULL' },
  },
  {
    name: 'turn_id',
    field: 'turnId',
    type: 'TEXT',
    notNull: true,
    fk: { table: 'turns', column: 'id', onDelete: 'CASCADE' },
  },
  {
    name: 'parent_message_id',
    field: 'parentMessageId',
    type: 'TEXT',
    fk: { table: 'messages', column: 'id', onDelete: 'SET NULL' },
  },
  { name: 'ordering', field: 'ordering', type: 'INTEGER', notNull: true },
  {
    name: 'role',
    field: 'role',
    type: 'TEXT',
    notNull: true,
    check: `role IN (${MESSAGE_ROLES.map((r) => `'${r}'`).join(', ')})`,
  },
  {
    name: 'message_type',
    field: 'messageType',
    type: 'TEXT',
    check: `message_type IS NULL OR message_type IN (${MESSAGE_TYPES.map((t) => `'${t}'`).join(', ')})`,
  },
  {
    name: 'source_identity_id',
    field: 'sourceIdentityId',
    type: 'TEXT',
    fk: { table: 'component_identities', column: 'id', onDelete: 'SET NULL' },
  },
  { name: 'timestamp', field: 'timestamp', type: 'INTEGER' },
  {
    name: 'retained_content',
    field: 'retainedContent',
    type: 'TEXT',
    sensitive: { retainColumn: 'retain_content' },
  },
  {
    name: 'retain_content',
    field: 'retainContent',
    type: 'INTEGER',
    notNull: true,
    default: 0,
    isBoolean: true,
  },
  { name: 'created_at', field: 'createdAt', type: 'INTEGER', notNull: true },
  { name: 'updated_at', field: 'updatedAt', type: 'INTEGER', notNull: true },
];

const MESSAGE_INDEXES: readonly IndexSpec[] = [
  { name: 'idx_messages_session', columns: ['session_id'] },
  { name: 'idx_messages_turn', columns: ['turn_id'] },
  { name: 'idx_messages_parent', columns: ['parent_message_id'] },
  { name: 'idx_messages_role', columns: ['session_id', 'role'] },
  { name: 'idx_messages_timestamp', columns: ['session_id', 'timestamp'] },
];

export const CREATE_MESSAGES_TABLE = buildCreateTable('messages', MESSAGE_COLUMNS, MESSAGE_INDEXES);

export interface Message {
  readonly id: string;
  readonly sessionId: string;
  readonly generationId: string;
  readonly turnId: string;
  readonly parentMessageId: string | null;
  readonly ordering: number;
  readonly role: MessageRole;
  readonly messageType: MessageType | null;
  readonly sourceIdentityId: string | null;
  readonly timestamp: number | null;
  readonly retainedContent: string | null;
  readonly retainContent: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type InsertMessageInput = InsertInput<Message>;
export type UpdateMessageInput = UpdateInput<Message>;

export const MessageStore = createSessionScopedStore<
  Message,
  InsertMessageInput,
  UpdateMessageInput
>({
  table: 'messages',
  columns: MESSAGE_COLUMNS,
  idFrom: ['sessionId', 'ordering'],
  listOrderBy: 'ordering',
});

// Model capabilities

const MODEL_CAPABILITY_COLUMNS: readonly Column[] = [
  { name: 'id', field: 'id', type: 'TEXT', pkey: true, notNull: true },
  { name: 'model', field: 'model', type: 'TEXT', notNull: true },
  { name: 'provider', field: 'provider', type: 'TEXT', notNull: true },
  { name: 'version', field: 'version', type: 'TEXT', notNull: true },
  { name: 'context_limit_tokens', field: 'contextLimitTokens', type: 'INTEGER' },
  { name: 'max_output_tokens', field: 'maxOutputTokens', type: 'INTEGER' },
  { name: 'provider_metadata', field: 'providerMetadata', type: 'TEXT' },
  {
    name: 'generation_id',
    field: 'generationId',
    type: 'TEXT',
    fk: { table: 'transformation_generations', column: 'id', onDelete: 'SET NULL' },
  },
  { name: 'created_at', field: 'createdAt', type: 'INTEGER', notNull: true },
  { name: 'updated_at', field: 'updatedAt', type: 'INTEGER', notNull: true },
];

const MODEL_CAPABILITY_INDEXES: readonly IndexSpec[] = [
  {
    name: 'idx_model_capabilities_unique',
    columns: ['model', 'provider', 'version'],
    unique: true,
  },
  { name: 'idx_model_capabilities_model', columns: ['model'] },
  { name: 'idx_model_capabilities_provider', columns: ['provider'] },
];

export const CREATE_MODEL_CAPABILITIES_TABLE = buildCreateTable(
  'model_capabilities',
  MODEL_CAPABILITY_COLUMNS,
  MODEL_CAPABILITY_INDEXES,
);

export interface ModelCapability {
  readonly id: string;
  readonly model: string;
  readonly provider: string;
  readonly version: string;
  readonly contextLimitTokens: number | null;
  readonly maxOutputTokens: number | null;
  readonly providerMetadata: string | null;
  readonly generationId: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type InsertModelCapabilityInput = InsertInput<ModelCapability>;
export type UpdateModelCapabilityInput = UpdateInput<ModelCapability>;

const modelCapabilityBase = createGlobalStore<
  ModelCapability,
  InsertModelCapabilityInput,
  UpdateModelCapabilityInput
>({
  table: 'model_capabilities',
  columns: MODEL_CAPABILITY_COLUMNS,
  idFrom: ['model', 'provider', 'version'],
});

export const ModelCapabilityStore: GlobalStore<
  ModelCapability,
  InsertModelCapabilityInput,
  UpdateModelCapabilityInput
> & {
  listByModel: (queryable: Queryable, model: string) => Promise<readonly ModelCapability[]>;
  listByProvider: (queryable: Queryable, provider: string) => Promise<readonly ModelCapability[]>;
} = {
  ...modelCapabilityBase,
  listByModel: async (queryable, model) => {
    const { rows } = await queryable.exec(
      'SELECT id, model, provider, version, context_limit_tokens, max_output_tokens, provider_metadata, generation_id, created_at, updated_at FROM model_capabilities WHERE model = ? ORDER BY created_at',
      [model],
    );
    return rows.map((r) => rowTo<ModelCapability>(MODEL_CAPABILITY_COLUMNS, r));
  },
  listByProvider: async (queryable, provider) => {
    const { rows } = await queryable.exec(
      'SELECT id, model, provider, version, context_limit_tokens, max_output_tokens, provider_metadata, generation_id, created_at, updated_at FROM model_capabilities WHERE provider = ? ORDER BY created_at',
      [provider],
    );
    return rows.map((r) => rowTo<ModelCapability>(MODEL_CAPABILITY_COLUMNS, r));
  },
};

// Pricing versions

const PRICING_VERSION_COLUMNS: readonly Column[] = [
  { name: 'id', field: 'id', type: 'TEXT', pkey: true, notNull: true },
  { name: 'provider', field: 'provider', type: 'TEXT', notNull: true },
  { name: 'model', field: 'model', type: 'TEXT', notNull: true },
  { name: 'currency', field: 'currency', type: 'TEXT', notNull: true, default: 'USD' },
  { name: 'effective_date', field: 'effectiveDate', type: 'TEXT', notNull: true },
  { name: 'input_price_per_token', field: 'inputPricePerToken', type: 'REAL' },
  { name: 'output_price_per_token', field: 'outputPricePerToken', type: 'REAL' },
  { name: 'cache_creation_price_per_token', field: 'cacheCreationPricePerToken', type: 'REAL' },
  { name: 'cache_read_price_per_token', field: 'cacheReadPricePerToken', type: 'REAL' },
  {
    name: 'generation_id',
    field: 'generationId',
    type: 'TEXT',
    fk: { table: 'transformation_generations', column: 'id', onDelete: 'SET NULL' },
  },
  { name: 'created_at', field: 'createdAt', type: 'INTEGER', notNull: true },
  { name: 'updated_at', field: 'updatedAt', type: 'INTEGER', notNull: true },
];

const PRICING_VERSION_INDEXES: readonly IndexSpec[] = [
  {
    name: 'idx_pricing_versions_unique',
    columns: ['provider', 'model', 'currency', 'effective_date'],
    unique: true,
  },
  { name: 'idx_pricing_versions_provider', columns: ['provider'] },
  { name: 'idx_pricing_versions_model', columns: ['model'] },
];

export const CREATE_PRICING_VERSIONS_TABLE = buildCreateTable(
  'pricing_versions',
  PRICING_VERSION_COLUMNS,
  PRICING_VERSION_INDEXES,
);

export interface PricingVersion {
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  readonly currency: string;
  readonly effectiveDate: string;
  readonly inputPricePerToken: number | null;
  readonly outputPricePerToken: number | null;
  readonly cacheCreationPricePerToken: number | null;
  readonly cacheReadPricePerToken: number | null;
  readonly generationId: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type InsertPricingVersionInput = InsertInput<PricingVersion>;
export type UpdatePricingVersionInput = UpdateInput<PricingVersion>;

const pricingVersionBase = createGlobalStore<
  PricingVersion,
  InsertPricingVersionInput,
  UpdatePricingVersionInput
>({
  table: 'pricing_versions',
  columns: PRICING_VERSION_COLUMNS,
  idFrom: ['provider', 'model', 'currency', 'effectiveDate'],
});

export const PricingVersionStore: GlobalStore<
  PricingVersion,
  InsertPricingVersionInput,
  UpdatePricingVersionInput
> & {
  listByProvider: (queryable: Queryable, provider: string) => Promise<readonly PricingVersion[]>;
  listByModel: (queryable: Queryable, model: string) => Promise<readonly PricingVersion[]>;
  listByProviderModel: (
    queryable: Queryable,
    provider: string,
    model: string,
  ) => Promise<readonly PricingVersion[]>;
} = {
  ...pricingVersionBase,
  listByProvider: async (queryable, provider) => {
    const { rows } = await queryable.exec(
      'SELECT id, provider, model, currency, effective_date, input_price_per_token, output_price_per_token, cache_creation_price_per_token, cache_read_price_per_token, generation_id, created_at, updated_at FROM pricing_versions WHERE provider = ? ORDER BY created_at',
      [provider],
    );
    return rows.map((r) => rowTo<PricingVersion>(PRICING_VERSION_COLUMNS, r));
  },
  listByModel: async (queryable, model) => {
    const { rows } = await queryable.exec(
      'SELECT id, provider, model, currency, effective_date, input_price_per_token, output_price_per_token, cache_creation_price_per_token, cache_read_price_per_token, generation_id, created_at, updated_at FROM pricing_versions WHERE model = ? ORDER BY created_at',
      [model],
    );
    return rows.map((r) => rowTo<PricingVersion>(PRICING_VERSION_COLUMNS, r));
  },
  listByProviderModel: async (queryable, provider, model) => {
    const { rows } = await queryable.exec(
      'SELECT id, provider, model, currency, effective_date, input_price_per_token, output_price_per_token, cache_creation_price_per_token, cache_read_price_per_token, generation_id, created_at, updated_at FROM pricing_versions WHERE provider = ? AND model = ? ORDER BY created_at',
      [provider, model],
    );
    return rows.map((r) => rowTo<PricingVersion>(PRICING_VERSION_COLUMNS, r));
  },
};

// Model requests

const MODEL_REQUEST_COLUMNS: readonly Column[] = [
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
    fk: { table: 'transformation_generations', column: 'id', onDelete: 'SET NULL' },
  },
  { name: 'request_order', field: 'requestOrder', type: 'INTEGER', notNull: true },
  { name: 'model', field: 'model', type: 'TEXT', notNull: true },
  { name: 'provider', field: 'provider', type: 'TEXT' },
  { name: 'context_volume_tokens', field: 'contextVolumeTokens', type: 'INTEGER' },
  { name: 'input_tokens', field: 'inputTokens', type: 'INTEGER' },
  { name: 'output_tokens', field: 'outputTokens', type: 'INTEGER' },
  { name: 'start_time', field: 'startTime', type: 'INTEGER' },
  { name: 'end_time', field: 'endTime', type: 'INTEGER' },
  { name: 'correlation_id', field: 'correlationId', type: 'TEXT' },
  {
    name: 'parent_request_id',
    field: 'parentRequestId',
    type: 'TEXT',
    fk: { table: 'model_requests', column: 'id', onDelete: 'SET NULL' },
  },
  {
    name: 'model_capability_id',
    field: 'modelCapabilityId',
    type: 'TEXT',
    fk: { table: 'model_capabilities', column: 'id', onDelete: 'SET NULL' },
  },
  {
    name: 'status',
    field: 'status',
    type: 'TEXT',
    notNull: true,
    default: 'success',
    check: `status IN (${REQUEST_STATUSES.map((s) => `'${s}'`).join(', ')})`,
  },
  { name: 'created_at', field: 'createdAt', type: 'INTEGER', notNull: true },
  { name: 'updated_at', field: 'updatedAt', type: 'INTEGER', notNull: true },
];

const MODEL_REQUEST_INDEXES: readonly IndexSpec[] = [
  {
    name: 'idx_model_requests_session_order',
    columns: ['session_id', 'request_order'],
    unique: true,
  },
  { name: 'idx_model_requests_session', columns: ['session_id'] },
  { name: 'idx_model_requests_parent', columns: ['parent_request_id'] },
  { name: 'idx_model_requests_capability', columns: ['model_capability_id'] },
  { name: 'idx_model_requests_correlation', columns: ['correlation_id'] },
];

export const CREATE_MODEL_REQUESTS_TABLE = buildCreateTable(
  'model_requests',
  MODEL_REQUEST_COLUMNS,
  MODEL_REQUEST_INDEXES,
);

export interface ModelRequest {
  readonly id: string;
  readonly sessionId: string;
  readonly generationId: string;
  readonly requestOrder: number;
  readonly model: string;
  readonly provider: string | null;
  readonly contextVolumeTokens: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly startTime: number | null;
  readonly endTime: number | null;
  readonly correlationId: string | null;
  readonly parentRequestId: string | null;
  readonly modelCapabilityId: string | null;
  readonly status: RequestStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type InsertModelRequestInput = InsertInput<ModelRequest>;
export type UpdateModelRequestInput = UpdateInput<ModelRequest>;

export const ModelRequestStore = createSessionScopedStore<
  ModelRequest,
  InsertModelRequestInput,
  UpdateModelRequestInput
>({
  table: 'model_requests',
  columns: MODEL_REQUEST_COLUMNS,
  idFrom: ['sessionId', 'requestOrder'],
  listOrderBy: 'request_order',
});

// Model usage

const MODEL_USAGE_COLUMNS: readonly Column[] = [
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
    fk: { table: 'transformation_generations', column: 'id', onDelete: 'SET NULL' },
  },
  {
    name: 'request_id',
    field: 'requestId',
    type: 'TEXT',
    notNull: true,
    fk: { table: 'model_requests', column: 'id', onDelete: 'CASCADE' },
  },
  {
    name: 'token_class',
    field: 'tokenClass',
    type: 'TEXT',
    notNull: true,
    check: `token_class IN (${MODEL_TOKEN_CLASSES.map((t) => `'${t}'`).join(', ')})`,
  },
  { name: 'token_count', field: 'tokenCount', type: 'INTEGER' },
  {
    name: 'is_estimated',
    field: 'isEstimated',
    type: 'INTEGER',
    notNull: true,
    default: 0,
    isBoolean: true,
  },
  { name: 'cost', field: 'cost', type: 'REAL' },
  {
    name: 'pricing_version_id',
    field: 'pricingVersionId',
    type: 'TEXT',
    fk: { table: 'pricing_versions', column: 'id', onDelete: 'SET NULL' },
  },
  { name: 'created_at', field: 'createdAt', type: 'INTEGER', notNull: true },
  { name: 'updated_at', field: 'updatedAt', type: 'INTEGER', notNull: true },
];

const MODEL_USAGE_INDEXES: readonly IndexSpec[] = [
  { name: 'idx_model_usage_request', columns: ['request_id'] },
  { name: 'idx_model_usage_session', columns: ['session_id'] },
  { name: 'idx_model_usage_token_class', columns: ['session_id', 'token_class'] },
];

export const CREATE_MODEL_USAGE_TABLE = buildCreateTable(
  'model_usage',
  MODEL_USAGE_COLUMNS,
  MODEL_USAGE_INDEXES,
);

export interface ModelUsage {
  readonly id: string;
  readonly sessionId: string;
  readonly generationId: string;
  readonly requestId: string;
  readonly tokenClass: ModelTokenClass;
  readonly tokenCount: number | null;
  readonly isEstimated: boolean;
  readonly cost: number | null;
  readonly pricingVersionId: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type InsertModelUsageInput = InsertInput<ModelUsage>;
export type UpdateModelUsageInput = UpdateInput<ModelUsage>;

export const ModelUsageStore = createSessionScopedStore<
  ModelUsage,
  InsertModelUsageInput,
  UpdateModelUsageInput
>({
  table: 'model_usage',
  columns: MODEL_USAGE_COLUMNS,
  idFrom: ['sessionId', 'requestId', 'tokenClass'],
});

// Message effort
//
// Per-message reasoning-effort trail (#289). Sourced from `model_request` /
// `model_usage` evidence records at the same `(session_id, request_order)`
// grain those tables use, but owned and written independently of them (see
// #183 for the still-unimplemented `model_requests`/`model_usage` writers).
// `raw_effort` and `normalized_effort` are nullable independently; a row is
// only ever written when at least one is non-null — absence of a row *is*
// the "no effort signal for this message" signal, mirroring the
// `session_relations` convention (never backfilled with a synthetic row).
//
// `NORMALIZED_EFFORT_LEVELS` is deliberately re-stated verbatim here rather
// than imported from `@lucasschirm/sal-transformer-shared`: db-core must
// never depend on a transformer package (`sql-only-in-db-core.md` /
// `transformers-never-write-sqlite.md`). Any change to the shared
// vocabulary in `transformer-shared/src/effort.ts` must be mirrored here.
const NORMALIZED_EFFORT_LEVELS = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

const MESSAGE_EFFORT_COLUMNS: readonly Column[] = [
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
    fk: { table: 'transformation_generations', column: 'id', onDelete: 'SET NULL' },
  },
  { name: 'request_order', field: 'requestOrder', type: 'INTEGER', notNull: true },
  { name: 'raw_effort', field: 'rawEffort', type: 'TEXT' },
  {
    name: 'normalized_effort',
    field: 'normalizedEffort',
    type: 'TEXT',
    check: `normalized_effort IS NULL OR normalized_effort IN (${NORMALIZED_EFFORT_LEVELS.map((l) => `'${l}'`).join(', ')})`,
  },
  { name: 'created_at', field: 'createdAt', type: 'INTEGER', notNull: true },
  { name: 'updated_at', field: 'updatedAt', type: 'INTEGER', notNull: true },
];

const MESSAGE_EFFORT_INDEXES: readonly IndexSpec[] = [
  {
    name: 'idx_message_effort_session_order',
    columns: ['session_id', 'request_order'],
    unique: true,
  },
  { name: 'idx_message_effort_session', columns: ['session_id'] },
];

export const CREATE_MESSAGE_EFFORT_TABLE = buildCreateTable(
  'message_effort',
  MESSAGE_EFFORT_COLUMNS,
  MESSAGE_EFFORT_INDEXES,
);

export interface MessageEffort {
  readonly id: string;
  readonly sessionId: string;
  readonly generationId: string;
  readonly requestOrder: number;
  readonly rawEffort: string | null;
  readonly normalizedEffort: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type InsertMessageEffortInput = InsertInput<MessageEffort>;
export type UpdateMessageEffortInput = UpdateInput<MessageEffort>;

export const MessageEffortStore = createSessionScopedStore<
  MessageEffort,
  InsertMessageEffortInput,
  UpdateMessageEffortInput
>({
  table: 'message_effort',
  columns: MESSAGE_EFFORT_COLUMNS,
  idFrom: ['sessionId', 'requestOrder'],
  listOrderBy: 'request_order',
});

// Invocations

const INVOCATION_COLUMNS: readonly Column[] = [
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
    fk: { table: 'transformation_generations', column: 'id', onDelete: 'SET NULL' },
  },
  {
    name: 'kind',
    field: 'kind',
    type: 'TEXT',
    notNull: true,
    check: `kind IN (${INVOCATION_KINDS.map((k) => `'${k}'`).join(', ')})`,
  },
  {
    name: 'component_id',
    field: 'componentId',
    type: 'TEXT',
    fk: { table: 'component_identities', column: 'id', onDelete: 'SET NULL' },
  },
  {
    name: 'component_version_id',
    field: 'componentVersionId',
    type: 'TEXT',
    fk: { table: 'component_versions', column: 'id', onDelete: 'CASCADE' },
  },
  { name: 'start_id', field: 'startId', type: 'TEXT' },
  { name: 'result_id', field: 'resultId', type: 'TEXT' },
  {
    name: 'status',
    field: 'status',
    type: 'TEXT',
    notNull: true,
    default: 'started',
    check: `status IN (${INVOCATION_STATUSES.map((s) => `'${s}'`).join(', ')})`,
  },
  { name: 'latency_ms', field: 'latencyMs', type: 'INTEGER' },
  {
    name: 'root_session_id',
    field: 'rootSessionId',
    type: 'TEXT',
    notNull: true,
    fk: { table: 'sessions', column: 'id', onDelete: 'CASCADE' },
  },
  {
    name: 'parent_invocation_id',
    field: 'parentInvocationId',
    type: 'TEXT',
    fk: { table: 'invocations', column: 'id', onDelete: 'SET NULL' },
  },
  {
    name: 'origin',
    field: 'origin',
    type: 'TEXT',
    notNull: true,
    default: 'root',
    check: `origin IN (${INVOCATION_ORIGINS.map((o) => `'${o}'`).join(', ')})`,
  },
  { name: 'created_at', field: 'createdAt', type: 'INTEGER', notNull: true },
  { name: 'updated_at', field: 'updatedAt', type: 'INTEGER', notNull: true },
];

const INVOCATION_INDEXES: readonly IndexSpec[] = [
  { name: 'idx_invocations_session', columns: ['session_id'] },
  { name: 'idx_invocations_root', columns: ['root_session_id'] },
  { name: 'idx_invocations_parent', columns: ['parent_invocation_id'] },
  { name: 'idx_invocations_component', columns: ['component_id'] },
  { name: 'idx_invocations_kind', columns: ['session_id', 'kind'] },
];

export const CREATE_INVOCATIONS_TABLE = buildCreateTable(
  'invocations',
  INVOCATION_COLUMNS,
  INVOCATION_INDEXES,
);

export interface Invocation {
  readonly id: string;
  readonly sessionId: string;
  readonly generationId: string;
  readonly kind: InvocationKind;
  readonly componentId: string | null;
  readonly componentVersionId: string | null;
  readonly startId: string | null;
  readonly resultId: string | null;
  readonly status: InvocationStatus;
  readonly latencyMs: number | null;
  readonly rootSessionId: string;
  readonly parentInvocationId: string | null;
  readonly origin: InvocationOrigin;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type InsertInvocationInput = InsertInput<Invocation>;
export type UpdateInvocationInput = UpdateInput<Invocation>;

export const InvocationStore = createSessionScopedStore<
  Invocation,
  InsertInvocationInput,
  UpdateInvocationInput
>({
  table: 'invocations',
  columns: INVOCATION_COLUMNS,
  idFrom: ['sessionId', 'kind', 'startId'],
});

// Payloads

const PAYLOAD_COLUMNS: readonly Column[] = [
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
    fk: { table: 'transformation_generations', column: 'id', onDelete: 'SET NULL' },
  },
  {
    name: 'payload_type',
    field: 'payloadType',
    type: 'TEXT',
    notNull: true,
    check: `payload_type IN (${PAYLOAD_TYPES.map((t) => `'${t}'`).join(', ')})`,
  },
  { name: 'exact_tokens', field: 'exactTokens', type: 'INTEGER' },
  { name: 'estimated_tokens', field: 'estimatedTokens', type: 'INTEGER' },
  { name: 'size_bytes', field: 'sizeBytes', type: 'INTEGER' },
  {
    name: 'truncated',
    field: 'truncated',
    type: 'INTEGER',
    notNull: true,
    default: 0,
    isBoolean: true,
  },
  { name: 'media_count', field: 'mediaCount', type: 'INTEGER' },
  { name: 'structure_count', field: 'structureCount', type: 'INTEGER' },
  {
    name: 'raw_content',
    field: 'rawContent',
    type: 'BLOB',
    sensitive: { retainColumn: 'retain_raw' },
  },
  {
    name: 'retain_raw',
    field: 'retainRaw',
    type: 'INTEGER',
    notNull: true,
    default: 0,
    isBoolean: true,
  },
  { name: 'created_at', field: 'createdAt', type: 'INTEGER', notNull: true },
  { name: 'updated_at', field: 'updatedAt', type: 'INTEGER', notNull: true },
];

const PAYLOAD_INDEXES: readonly IndexSpec[] = [
  { name: 'idx_payloads_session', columns: ['session_id'] },
  { name: 'idx_payloads_type', columns: ['session_id', 'payload_type'] },
];

export const CREATE_PAYLOADS_TABLE = buildCreateTable('payloads', PAYLOAD_COLUMNS, PAYLOAD_INDEXES);

export interface Payload {
  readonly id: string;
  readonly sessionId: string;
  readonly generationId: string;
  readonly payloadType: PayloadType;
  readonly exactTokens: number | null;
  readonly estimatedTokens: number | null;
  readonly sizeBytes: number | null;
  readonly truncated: boolean;
  readonly mediaCount: number | null;
  readonly structureCount: number | null;
  readonly rawContent: Uint8Array | null;
  readonly retainRaw: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type InsertPayloadInput = InsertInput<Payload>;
export type UpdatePayloadInput = UpdateInput<Payload>;

export const PayloadStore = createSessionScopedStore<
  Payload,
  InsertPayloadInput,
  UpdatePayloadInput
>({
  table: 'payloads',
  columns: PAYLOAD_COLUMNS,
  idFrom: ['sessionId', 'payloadType'],
});

// Invocation payloads

const INVOCATION_PAYLOAD_COLUMNS: readonly Column[] = [
  { name: 'id', field: 'id', type: 'TEXT', pkey: true, notNull: true },
  {
    name: 'invocation_id',
    field: 'invocationId',
    type: 'TEXT',
    notNull: true,
    fk: { table: 'invocations', column: 'id', onDelete: 'CASCADE' },
  },
  {
    name: 'payload_id',
    field: 'payloadId',
    type: 'TEXT',
    notNull: true,
    fk: { table: 'payloads', column: 'id', onDelete: 'CASCADE' },
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
    fk: { table: 'transformation_generations', column: 'id', onDelete: 'SET NULL' },
  },
  {
    name: 'attribution_type',
    field: 'attributionType',
    type: 'TEXT',
    notNull: true,
    check: `attribution_type IN (${ATTRIBUTION_TYPES.map((a) => `'${a}'`).join(', ')})`,
  },
  {
    name: 'is_input',
    field: 'isInput',
    type: 'INTEGER',
    notNull: true,
    default: 0,
    isBoolean: true,
  },
  {
    name: 'is_result',
    field: 'isResult',
    type: 'INTEGER',
    notNull: true,
    default: 0,
    isBoolean: true,
  },
  {
    name: 'is_context',
    field: 'isContext',
    type: 'INTEGER',
    notNull: true,
    default: 0,
    isBoolean: true,
  },
  { name: 'attribution_share', field: 'attributionShare', type: 'REAL' },
  { name: 'created_at', field: 'createdAt', type: 'INTEGER', notNull: true },
  { name: 'updated_at', field: 'updatedAt', type: 'INTEGER', notNull: true },
];

const INVOCATION_PAYLOAD_INDEXES: readonly IndexSpec[] = [
  {
    name: 'idx_invocation_payloads_unique',
    columns: ['invocation_id', 'payload_id', 'attribution_type', 'generation_id'],
    unique: true,
  },
  { name: 'idx_invocation_payloads_invocation', columns: ['invocation_id'] },
  { name: 'idx_invocation_payloads_payload', columns: ['payload_id'] },
  { name: 'idx_invocation_payloads_session', columns: ['session_id'] },
];

export const CREATE_INVOCATION_PAYLOADS_TABLE = buildCreateTable(
  'invocation_payloads',
  INVOCATION_PAYLOAD_COLUMNS,
  INVOCATION_PAYLOAD_INDEXES,
);

export interface InvocationPayload {
  readonly id: string;
  readonly invocationId: string;
  readonly payloadId: string;
  readonly sessionId: string;
  readonly generationId: string;
  readonly attributionType: AttributionType;
  readonly isInput: boolean;
  readonly isResult: boolean;
  readonly isContext: boolean;
  readonly attributionShare: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type InsertInvocationPayloadInput = InsertInput<InvocationPayload>;
export type UpdateInvocationPayloadInput = UpdateInput<InvocationPayload>;

type InvocationPayloadStoreType = ParentedStore<
  InvocationPayload,
  InsertInvocationPayloadInput,
  UpdateInvocationPayloadInput
> & {
  listBySession: (queryable: Queryable, sessionId: string) => Promise<readonly InvocationPayload[]>;
};

const invocationPayloadBase = createParentedStore<
  InvocationPayload,
  InsertInvocationPayloadInput,
  UpdateInvocationPayloadInput
>({
  table: 'invocation_payloads',
  columns: INVOCATION_PAYLOAD_COLUMNS,
  parentColumn: 'invocation_id',
  idFrom: ['invocationId', 'payloadId', 'attributionType'],
});

export const InvocationPayloadStore: InvocationPayloadStoreType = {
  ...invocationPayloadBase,
  listBySession: async (queryable, sessionId) => {
    const selectColumns = INVOCATION_PAYLOAD_COLUMNS.map((c) => c.name).join(', ');
    const { rows } = await queryable.exec(
      `SELECT ${selectColumns} FROM invocation_payloads WHERE session_id = ? ORDER BY created_at`,
      [sessionId],
    );
    return rows.map((r) => rowTo<InvocationPayload>(INVOCATION_PAYLOAD_COLUMNS, r));
  },
};

// Session relations

const SESSION_RELATION_COLUMNS: readonly Column[] = [
  { name: 'id', field: 'id', type: 'TEXT', pkey: true, notNull: true },
  {
    name: 'session_id',
    field: 'sessionId',
    type: 'TEXT',
    notNull: true,
    fk: { table: 'sessions', column: 'id', onDelete: 'CASCADE' },
  },
  {
    name: 'parent_session_id',
    field: 'parentSessionId',
    type: 'TEXT',
    fk: { table: 'sessions', column: 'id', onDelete: 'SET NULL' },
  },
  {
    name: 'root_session_id',
    field: 'rootSessionId',
    type: 'TEXT',
    notNull: true,
    fk: { table: 'sessions', column: 'id', onDelete: 'CASCADE' },
  },
  {
    name: 'spawn_invocation_id',
    field: 'spawnInvocationId',
    type: 'TEXT',
    fk: { table: 'invocations', column: 'id', onDelete: 'SET NULL' },
  },
  { name: 'depth', field: 'depth', type: 'INTEGER', notNull: true, default: 0 },
  {
    name: 'inclusion_semantics',
    field: 'inclusionSemantics',
    type: 'TEXT',
    notNull: true,
    default: 'native',
    check: `inclusion_semantics IN (${INCLUSION_SEMANTICS.map((i) => `'${i}'`).join(', ')})`,
  },
  {
    name: 'generation_id',
    field: 'generationId',
    type: 'TEXT',
    notNull: true,
    fk: { table: 'transformation_generations', column: 'id', onDelete: 'SET NULL' },
  },
  { name: 'created_at', field: 'createdAt', type: 'INTEGER', notNull: true },
  { name: 'updated_at', field: 'updatedAt', type: 'INTEGER', notNull: true },
];

const SESSION_RELATION_INDEXES: readonly IndexSpec[] = [
  { name: 'idx_session_relations_session', columns: ['session_id'], unique: true },
  { name: 'idx_session_relations_parent', columns: ['parent_session_id'] },
  { name: 'idx_session_relations_root', columns: ['root_session_id'] },
  { name: 'idx_session_relations_spawn', columns: ['spawn_invocation_id'] },
];

export const CREATE_SESSION_RELATIONS_TABLE = buildCreateTable(
  'session_relations',
  SESSION_RELATION_COLUMNS,
  SESSION_RELATION_INDEXES,
);

export interface SessionRelation {
  readonly id: string;
  readonly sessionId: string;
  readonly parentSessionId: string | null;
  readonly rootSessionId: string;
  readonly spawnInvocationId: string | null;
  readonly depth: number;
  readonly inclusionSemantics: InclusionSemantics;
  readonly generationId: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type InsertSessionRelationInput = InsertInput<SessionRelation>;
export type UpdateSessionRelationInput = UpdateInput<SessionRelation>;

export const SessionRelationStore = createSessionScopedStore<
  SessionRelation,
  InsertSessionRelationInput,
  UpdateSessionRelationInput
>({
  table: 'session_relations',
  columns: SESSION_RELATION_COLUMNS,
  idFrom: ['sessionId', 'parentSessionId'],
});

// Permission events

const PERMISSION_EVENT_COLUMNS: readonly Column[] = [
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
    fk: { table: 'transformation_generations', column: 'id', onDelete: 'SET NULL' },
  },
  {
    name: 'prompt_text',
    field: 'promptText',
    type: 'TEXT',
    sensitive: { retainColumn: 'retain_prompt' },
  },
  {
    name: 'retain_prompt',
    field: 'retainPrompt',
    type: 'INTEGER',
    notNull: true,
    default: 0,
    isBoolean: true,
  },
  {
    name: 'decision',
    field: 'decision',
    type: 'TEXT',
    notNull: true,
    check: `decision IN (${PERMISSION_DECISIONS.map((d) => `'${d}'`).join(', ')})`,
  },
  { name: 'mode', field: 'mode', type: 'TEXT' },
  { name: 'wait_interval_ms', field: 'waitIntervalMs', type: 'INTEGER' },
  { name: 'created_at', field: 'createdAt', type: 'INTEGER', notNull: true },
  { name: 'updated_at', field: 'updatedAt', type: 'INTEGER', notNull: true },
];

const PERMISSION_EVENT_INDEXES: readonly IndexSpec[] = [
  { name: 'idx_permission_events_session', columns: ['session_id'] },
  { name: 'idx_permission_events_decision', columns: ['session_id', 'decision'] },
];

export const CREATE_PERMISSION_EVENTS_TABLE = buildCreateTable(
  'permission_events',
  PERMISSION_EVENT_COLUMNS,
  PERMISSION_EVENT_INDEXES,
);

export interface PermissionEvent {
  readonly id: string;
  readonly sessionId: string;
  readonly generationId: string;
  readonly promptText: string | null;
  readonly retainPrompt: boolean;
  readonly decision: PermissionDecision;
  readonly mode: string | null;
  readonly waitIntervalMs: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type InsertPermissionEventInput = InsertInput<PermissionEvent>;
export type UpdatePermissionEventInput = UpdateInput<PermissionEvent>;

export const PermissionEventStore = createSessionScopedStore<
  PermissionEvent,
  InsertPermissionEventInput,
  UpdatePermissionEventInput
>({
  table: 'permission_events',
  columns: PERMISSION_EVENT_COLUMNS,
  idFrom: ['sessionId', 'decision'],
});

// Mode events

const MODE_EVENT_COLUMNS: readonly Column[] = [
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
    fk: { table: 'transformation_generations', column: 'id', onDelete: 'SET NULL' },
  },
  { name: 'prior_mode', field: 'priorMode', type: 'TEXT' },
  { name: 'new_mode', field: 'newMode', type: 'TEXT', notNull: true },
  {
    name: 'trigger',
    field: 'trigger',
    type: 'TEXT',
    notNull: true,
    check: `trigger IN (${MODE_TRIGGERS.map((t) => `'${t}'`).join(', ')})`,
  },
  { name: 'start_time', field: 'startTime', type: 'INTEGER', notNull: true },
  { name: 'end_time', field: 'endTime', type: 'INTEGER' },
  { name: 'created_at', field: 'createdAt', type: 'INTEGER', notNull: true },
  { name: 'updated_at', field: 'updatedAt', type: 'INTEGER', notNull: true },
];

const MODE_EVENT_INDEXES: readonly IndexSpec[] = [
  { name: 'idx_mode_events_session', columns: ['session_id'] },
  { name: 'idx_mode_events_start', columns: ['session_id', 'start_time'] },
];

export const CREATE_MODE_EVENTS_TABLE = buildCreateTable(
  'mode_events',
  MODE_EVENT_COLUMNS,
  MODE_EVENT_INDEXES,
);

export interface ModeEvent {
  readonly id: string;
  readonly sessionId: string;
  readonly generationId: string;
  readonly priorMode: string | null;
  readonly newMode: string;
  readonly trigger: ModeTrigger;
  readonly startTime: number;
  readonly endTime: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type InsertModeEventInput = InsertInput<ModeEvent>;
export type UpdateModeEventInput = UpdateInput<ModeEvent>;

export const ModeEventStore = createSessionScopedStore<
  ModeEvent,
  InsertModeEventInput,
  UpdateModeEventInput
>({
  table: 'mode_events',
  columns: MODE_EVENT_COLUMNS,
  idFrom: ['sessionId', 'newMode', 'trigger'],
  listOrderBy: 'start_time',
});

// Hook executions

const HOOK_EXECUTION_COLUMNS: readonly Column[] = [
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
    fk: { table: 'transformation_generations', column: 'id', onDelete: 'SET NULL' },
  },
  {
    name: 'hook_component_id',
    field: 'hookComponentId',
    type: 'TEXT',
    fk: { table: 'component_identities', column: 'id', onDelete: 'SET NULL' },
  },
  {
    name: 'status',
    field: 'status',
    type: 'TEXT',
    notNull: true,
    check: `status IN (${HOOK_STATUSES.map((s) => `'${s}'`).join(', ')})`,
  },
  { name: 'duration_ms', field: 'durationMs', type: 'INTEGER' },
  { name: 'result_metadata', field: 'resultMetadata', type: 'TEXT' },
  { name: 'created_at', field: 'createdAt', type: 'INTEGER', notNull: true },
  { name: 'updated_at', field: 'updatedAt', type: 'INTEGER', notNull: true },
];

const HOOK_EXECUTION_INDEXES: readonly IndexSpec[] = [
  { name: 'idx_hook_executions_session', columns: ['session_id'] },
  { name: 'idx_hook_executions_hook', columns: ['hook_component_id'] },
  { name: 'idx_hook_executions_status', columns: ['session_id', 'status'] },
];

export const CREATE_HOOK_EXECUTIONS_TABLE = buildCreateTable(
  'hook_executions',
  HOOK_EXECUTION_COLUMNS,
  HOOK_EXECUTION_INDEXES,
);

export interface HookExecution {
  readonly id: string;
  readonly sessionId: string;
  readonly generationId: string;
  readonly hookComponentId: string | null;
  readonly status: HookStatus;
  readonly durationMs: number | null;
  readonly resultMetadata: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type InsertHookExecutionInput = InsertInput<HookExecution>;
export type UpdateHookExecutionInput = UpdateInput<HookExecution>;

export const HookExecutionStore = createSessionScopedStore<
  HookExecution,
  InsertHookExecutionInput,
  UpdateHookExecutionInput
>({
  table: 'hook_executions',
  columns: HOOK_EXECUTION_COLUMNS,
  idFrom: ['sessionId', 'hookComponentId', 'status'],
});

// Normalized events

const NORMALIZED_EVENT_COLUMNS: readonly Column[] = [
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
    fk: { table: 'transformation_generations', column: 'id', onDelete: 'SET NULL' },
  },
  { name: 'event_type', field: 'eventType', type: 'TEXT', notNull: true },
  { name: 'event_version', field: 'eventVersion', type: 'INTEGER', notNull: true, default: 1 },
  {
    name: 'raw_details',
    field: 'rawDetails',
    type: 'TEXT',
    sensitive: { retainColumn: 'retain_raw' },
  },
  {
    name: 'retain_raw',
    field: 'retainRaw',
    type: 'INTEGER',
    notNull: true,
    default: 0,
    isBoolean: true,
  },
  { name: 'created_at', field: 'createdAt', type: 'INTEGER', notNull: true },
  { name: 'updated_at', field: 'updatedAt', type: 'INTEGER', notNull: true },
];

const NORMALIZED_EVENT_INDEXES: readonly IndexSpec[] = [
  { name: 'idx_normalized_events_session', columns: ['session_id'] },
  { name: 'idx_normalized_events_type', columns: ['session_id', 'event_type'] },
];

export const CREATE_NORMALIZED_EVENTS_TABLE = buildCreateTable(
  'normalized_events',
  NORMALIZED_EVENT_COLUMNS,
  NORMALIZED_EVENT_INDEXES,
);

export interface NormalizedEvent {
  readonly id: string;
  readonly sessionId: string;
  readonly generationId: string;
  readonly eventType: string;
  readonly eventVersion: number;
  readonly rawDetails: string | null;
  readonly retainRaw: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type InsertNormalizedEventInput = InsertInput<NormalizedEvent>;
export type UpdateNormalizedEventInput = UpdateInput<NormalizedEvent>;

export const NormalizedEventStore = createSessionScopedStore<
  NormalizedEvent,
  InsertNormalizedEventInput,
  UpdateNormalizedEventInput
>({
  table: 'normalized_events',
  columns: NORMALIZED_EVENT_COLUMNS,
  idFrom: ['sessionId', 'eventType'],
});

// Tasks

const TASK_COLUMNS: readonly Column[] = [
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
    fk: { table: 'transformation_generations', column: 'id', onDelete: 'SET NULL' },
  },
  {
    name: 'component_id',
    field: 'componentId',
    type: 'TEXT',
    fk: { table: 'component_identities', column: 'id', onDelete: 'SET NULL' },
  },
  { name: 'task_identity', field: 'taskIdentity', type: 'TEXT', notNull: true },
  { name: 'created_at', field: 'createdAt', type: 'INTEGER', notNull: true },
  { name: 'updated_at', field: 'updatedAt', type: 'INTEGER', notNull: true },
];

const TASK_INDEXES: readonly IndexSpec[] = [
  { name: 'idx_tasks_session_identity', columns: ['session_id', 'task_identity'], unique: true },
  { name: 'idx_tasks_session', columns: ['session_id'] },
  { name: 'idx_tasks_component', columns: ['component_id'] },
];

export const CREATE_TASKS_TABLE = buildCreateTable('tasks', TASK_COLUMNS, TASK_INDEXES);

export interface Task {
  readonly id: string;
  readonly sessionId: string;
  readonly generationId: string;
  readonly componentId: string | null;
  readonly taskIdentity: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type InsertTaskInput = InsertInput<Task>;
export type UpdateTaskInput = UpdateInput<Task>;

export const TaskStore = createSessionScopedStore<Task, InsertTaskInput, UpdateTaskInput>({
  table: 'tasks',
  columns: TASK_COLUMNS,
  idFrom: ['sessionId', 'taskIdentity'],
});

// Task events

const TASK_EVENT_COLUMNS: readonly Column[] = [
  { name: 'id', field: 'id', type: 'TEXT', pkey: true, notNull: true },
  {
    name: 'task_id',
    field: 'taskId',
    type: 'TEXT',
    notNull: true,
    fk: { table: 'tasks', column: 'id', onDelete: 'CASCADE' },
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
    fk: { table: 'transformation_generations', column: 'id', onDelete: 'SET NULL' },
  },
  {
    name: 'status',
    field: 'status',
    type: 'TEXT',
    notNull: true,
    check: `status IN (${TASK_STATUSES.map((s) => `'${s}'`).join(', ')})`,
  },
  { name: 'previous_status', field: 'previousStatus', type: 'TEXT' },
  { name: 'changed_at', field: 'changedAt', type: 'INTEGER' },
  { name: 'created_at', field: 'createdAt', type: 'INTEGER', notNull: true },
  { name: 'updated_at', field: 'updatedAt', type: 'INTEGER', notNull: true },
];

const TASK_EVENT_INDEXES: readonly IndexSpec[] = [
  { name: 'idx_task_events_task', columns: ['task_id'] },
  { name: 'idx_task_events_session', columns: ['session_id'] },
  { name: 'idx_task_events_status', columns: ['task_id', 'status'] },
];

export const CREATE_TASK_EVENTS_TABLE = buildCreateTable(
  'task_events',
  TASK_EVENT_COLUMNS,
  TASK_EVENT_INDEXES,
);

export interface TaskEvent {
  readonly id: string;
  readonly taskId: string;
  readonly sessionId: string;
  readonly generationId: string;
  readonly status: TaskStatus;
  readonly previousStatus: string | null;
  readonly changedAt: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type InsertTaskEventInput = InsertInput<TaskEvent>;
export type UpdateTaskEventInput = UpdateInput<TaskEvent>;

type TaskEventStoreType = ParentedStore<TaskEvent, InsertTaskEventInput, UpdateTaskEventInput> & {
  listBySession: (queryable: Queryable, sessionId: string) => Promise<readonly TaskEvent[]>;
};

const taskEventBase = createParentedStore<TaskEvent, InsertTaskEventInput, UpdateTaskEventInput>({
  table: 'task_events',
  columns: TASK_EVENT_COLUMNS,
  parentColumn: 'task_id',
  idFrom: ['taskId', 'status'],
});

export const TaskEventStore: TaskEventStoreType = {
  ...taskEventBase,
  listBySession: async (queryable, sessionId) => {
    const selectColumns = TASK_EVENT_COLUMNS.map((c) => c.name).join(', ');
    const { rows } = await queryable.exec(
      `SELECT ${selectColumns} FROM task_events WHERE session_id = ? ORDER BY created_at`,
      [sessionId],
    );
    return rows.map((r) => rowTo<TaskEvent>(TASK_EVENT_COLUMNS, r));
  },
};

// Validations

const VALIDATION_COLUMNS: readonly Column[] = [
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
    fk: { table: 'transformation_generations', column: 'id', onDelete: 'SET NULL' },
  },
  { name: 'validation_type', field: 'validationType', type: 'TEXT', notNull: true },
  { name: 'command', field: 'command', type: 'TEXT' },
  {
    name: 'result',
    field: 'result',
    type: 'TEXT',
    notNull: true,
    check: `result IN (${VALIDATION_RESULTS.map((r) => `'${r}'`).join(', ')})`,
  },
  { name: 'start_time', field: 'startTime', type: 'INTEGER' },
  { name: 'end_time', field: 'endTime', type: 'INTEGER' },
  { name: 'edit_cycle_id', field: 'editCycleId', type: 'TEXT' },
  { name: 'created_at', field: 'createdAt', type: 'INTEGER', notNull: true },
  { name: 'updated_at', field: 'updatedAt', type: 'INTEGER', notNull: true },
];

const VALIDATION_INDEXES: readonly IndexSpec[] = [
  { name: 'idx_validations_session', columns: ['session_id'] },
  { name: 'idx_validations_result', columns: ['session_id', 'result'] },
  { name: 'idx_validations_edit_cycle', columns: ['edit_cycle_id'] },
];

export const CREATE_VALIDATIONS_TABLE = buildCreateTable(
  'validations',
  VALIDATION_COLUMNS,
  VALIDATION_INDEXES,
);

export interface Validation {
  readonly id: string;
  readonly sessionId: string;
  readonly generationId: string;
  readonly validationType: string;
  readonly command: string | null;
  readonly result: ValidationResult;
  readonly startTime: number | null;
  readonly endTime: number | null;
  readonly editCycleId: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type InsertValidationInput = InsertInput<Validation>;
export type UpdateValidationInput = UpdateInput<Validation>;

export const ValidationStore = createSessionScopedStore<
  Validation,
  InsertValidationInput,
  UpdateValidationInput
>({
  table: 'validations',
  columns: VALIDATION_COLUMNS,
  idFrom: ['sessionId', 'validationType', 'startTime'],
});

// File operations

const FILE_OPERATION_COLUMNS: readonly Column[] = [
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
    fk: { table: 'transformation_generations', column: 'id', onDelete: 'SET NULL' },
  },
  {
    name: 'operation',
    field: 'operation',
    type: 'TEXT',
    notNull: true,
    check: `operation IN (${FILE_OPERATIONS.map((o) => `'${o}'`).join(', ')})`,
  },
  { name: 'normalized_path', field: 'normalizedPath', type: 'TEXT' },
  { name: 'path_category', field: 'pathCategory', type: 'TEXT' },
  { name: 'raw_path', field: 'rawPath', type: 'TEXT', sensitive: { retainColumn: 'retain_raw' } },
  {
    name: 'retain_raw',
    field: 'retainRaw',
    type: 'INTEGER',
    notNull: true,
    default: 0,
    isBoolean: true,
  },
  {
    name: 'status',
    field: 'status',
    type: 'TEXT',
    check: `status IS NULL OR status IN (${FILE_OPERATION_STATUSES.map((s) => `'${s}'`).join(', ')})`,
  },
  { name: 'start_time', field: 'startTime', type: 'INTEGER' },
  { name: 'end_time', field: 'endTime', type: 'INTEGER' },
  { name: 'created_at', field: 'createdAt', type: 'INTEGER', notNull: true },
  { name: 'updated_at', field: 'updatedAt', type: 'INTEGER', notNull: true },
];

const FILE_OPERATION_INDEXES: readonly IndexSpec[] = [
  { name: 'idx_file_operations_session', columns: ['session_id'] },
  { name: 'idx_file_operations_operation', columns: ['session_id', 'operation'] },
  { name: 'idx_file_operations_path', columns: ['session_id', 'normalized_path'] },
];

export const CREATE_FILE_OPERATIONS_TABLE = buildCreateTable(
  'file_operations',
  FILE_OPERATION_COLUMNS,
  FILE_OPERATION_INDEXES,
);

export interface FileOperation {
  readonly id: string;
  readonly sessionId: string;
  readonly generationId: string;
  readonly operation: FileOperationType;
  readonly normalizedPath: string | null;
  readonly pathCategory: string | null;
  readonly rawPath: string | null;
  readonly retainRaw: boolean;
  readonly status: FileOperationStatus | null;
  readonly startTime: number | null;
  readonly endTime: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type InsertFileOperationInput = InsertInput<FileOperation>;
export type UpdateFileOperationInput = UpdateInput<FileOperation>;

export const FileOperationStore = createSessionScopedStore<
  FileOperation,
  InsertFileOperationInput,
  UpdateFileOperationInput
>({
  table: 'file_operations',
  columns: FILE_OPERATION_COLUMNS,
  idFrom: ['sessionId', 'operation', 'startTime'],
});

// Command executions

const COMMAND_EXECUTION_COLUMNS: readonly Column[] = [
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
    fk: { table: 'transformation_generations', column: 'id', onDelete: 'SET NULL' },
  },
  { name: 'command_category', field: 'commandCategory', type: 'TEXT', notNull: true },
  {
    name: 'raw_command',
    field: 'rawCommand',
    type: 'TEXT',
    sensitive: { retainColumn: 'retain_raw' },
  },
  {
    name: 'retain_raw',
    field: 'retainRaw',
    type: 'INTEGER',
    notNull: true,
    default: 0,
    isBoolean: true,
  },
  { name: 'exit_code', field: 'exitCode', type: 'INTEGER' },
  { name: 'signal', field: 'signal', type: 'TEXT' },
  {
    name: 'status',
    field: 'status',
    type: 'TEXT',
    notNull: true,
    check: `status IN (${COMMAND_STATUSES.map((s) => `'${s}'`).join(', ')})`,
  },
  { name: 'start_time', field: 'startTime', type: 'INTEGER' },
  { name: 'end_time', field: 'endTime', type: 'INTEGER' },
  { name: 'created_at', field: 'createdAt', type: 'INTEGER', notNull: true },
  { name: 'updated_at', field: 'updatedAt', type: 'INTEGER', notNull: true },
];

const COMMAND_EXECUTION_INDEXES: readonly IndexSpec[] = [
  { name: 'idx_command_executions_session', columns: ['session_id'] },
  { name: 'idx_command_executions_status', columns: ['session_id', 'status'] },
  { name: 'idx_command_executions_category', columns: ['session_id', 'command_category'] },
];

export const CREATE_COMMAND_EXECUTIONS_TABLE = buildCreateTable(
  'command_executions',
  COMMAND_EXECUTION_COLUMNS,
  COMMAND_EXECUTION_INDEXES,
);

export interface CommandExecution {
  readonly id: string;
  readonly sessionId: string;
  readonly generationId: string;
  readonly commandCategory: string;
  readonly rawCommand: string | null;
  readonly retainRaw: boolean;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly status: CommandStatus;
  readonly startTime: number | null;
  readonly endTime: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type InsertCommandExecutionInput = InsertInput<CommandExecution>;
export type UpdateCommandExecutionInput = UpdateInput<CommandExecution>;

export const CommandExecutionStore = createSessionScopedStore<
  CommandExecution,
  InsertCommandExecutionInput,
  UpdateCommandExecutionInput
>({
  table: 'command_executions',
  columns: COMMAND_EXECUTION_COLUMNS,
  idFrom: ['sessionId', 'commandCategory', 'startTime'],
});

// Component evidence links

const EVIDENCE_GRAIN_COLUMNS: Readonly<Record<EvidenceType, string>> = {
  turn: 'turn_id',
  message: 'message_id',
  invocation: 'invocation_id',
  payload: 'payload_id',
  task: 'task_id',
  validation: 'validation_id',
  file_operation: 'file_operation_id',
  command_execution: 'command_execution_id',
};

const componentEvidenceLinkGrainCheck = EVIDENCE_TYPES.map((t) => {
  const target = EVIDENCE_GRAIN_COLUMNS[t];
  const others = Object.values(EVIDENCE_GRAIN_COLUMNS)
    .filter((c) => c !== target)
    .map((c) => `${c} IS NULL`)
    .join(' AND ');
  return `(evidence_type = '${t}' AND ${target} IS NOT NULL AND ${others})`;
}).join(' OR ');

const COMPONENT_EVIDENCE_LINK_COLUMNS: readonly Column[] = [
  { name: 'id', field: 'id', type: 'TEXT', pkey: true, notNull: true },
  {
    name: 'component_id',
    field: 'componentId',
    type: 'TEXT',
    notNull: true,
    fk: { table: 'component_identities', column: 'id', onDelete: 'CASCADE' },
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
    fk: { table: 'transformation_generations', column: 'id', onDelete: 'SET NULL' },
  },
  {
    name: 'evidence_type',
    field: 'evidenceType',
    type: 'TEXT',
    notNull: true,
    check: `evidence_type IN (${EVIDENCE_TYPES.map((t) => `'${t}'`).join(', ')})`,
  },
  {
    name: 'link_type',
    field: 'linkType',
    type: 'TEXT',
    notNull: true,
    check: `link_type IN (${COMPONENT_EVIDENCE_LINK_TYPES.map((t) => `'${t}'`).join(', ')})`,
  },
  {
    name: 'turn_id',
    field: 'turnId',
    type: 'TEXT',
    fk: { table: 'turns', column: 'id', onDelete: 'CASCADE' },
  },
  {
    name: 'message_id',
    field: 'messageId',
    type: 'TEXT',
    fk: { table: 'messages', column: 'id', onDelete: 'CASCADE' },
  },
  {
    name: 'invocation_id',
    field: 'invocationId',
    type: 'TEXT',
    fk: { table: 'invocations', column: 'id', onDelete: 'CASCADE' },
  },
  {
    name: 'payload_id',
    field: 'payloadId',
    type: 'TEXT',
    fk: { table: 'payloads', column: 'id', onDelete: 'CASCADE' },
  },
  {
    name: 'task_id',
    field: 'taskId',
    type: 'TEXT',
    fk: { table: 'tasks', column: 'id', onDelete: 'CASCADE' },
  },
  {
    name: 'validation_id',
    field: 'validationId',
    type: 'TEXT',
    fk: { table: 'validations', column: 'id', onDelete: 'CASCADE' },
  },
  {
    name: 'file_operation_id',
    field: 'fileOperationId',
    type: 'TEXT',
    fk: { table: 'file_operations', column: 'id', onDelete: 'CASCADE' },
  },
  {
    name: 'command_execution_id',
    field: 'commandExecutionId',
    type: 'TEXT',
    fk: { table: 'command_executions', column: 'id', onDelete: 'CASCADE' },
  },
  { name: 'created_at', field: 'createdAt', type: 'INTEGER', notNull: true },
  { name: 'updated_at', field: 'updatedAt', type: 'INTEGER', notNull: true },
];

const COMPONENT_EVIDENCE_LINK_INDEXES: readonly IndexSpec[] = [
  { name: 'idx_component_evidence_links_component', columns: ['component_id'] },
  { name: 'idx_component_evidence_links_session', columns: ['session_id'] },
  { name: 'idx_component_evidence_links_turn', columns: ['turn_id'] },
  { name: 'idx_component_evidence_links_message', columns: ['message_id'] },
  { name: 'idx_component_evidence_links_invocation', columns: ['invocation_id'] },
  { name: 'idx_component_evidence_links_payload', columns: ['payload_id'] },
  { name: 'idx_component_evidence_links_task', columns: ['task_id'] },
  { name: 'idx_component_evidence_links_validation', columns: ['validation_id'] },
  { name: 'idx_component_evidence_links_file', columns: ['file_operation_id'] },
  { name: 'idx_component_evidence_links_command', columns: ['command_execution_id'] },
];

export const CREATE_COMPONENT_EVIDENCE_LINKS_TABLE = buildCreateTable(
  'component_evidence_links',
  COMPONENT_EVIDENCE_LINK_COLUMNS,
  COMPONENT_EVIDENCE_LINK_INDEXES,
  [componentEvidenceLinkGrainCheck],
);

export interface ComponentEvidenceLink {
  readonly id: string;
  readonly componentId: string;
  readonly sessionId: string;
  readonly generationId: string;
  readonly evidenceType: EvidenceType;
  readonly linkType: ComponentEvidenceLinkType;
  readonly turnId: string | null;
  readonly messageId: string | null;
  readonly invocationId: string | null;
  readonly payloadId: string | null;
  readonly taskId: string | null;
  readonly validationId: string | null;
  readonly fileOperationId: string | null;
  readonly commandExecutionId: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type InsertComponentEvidenceLinkInput = InsertInput<ComponentEvidenceLink>;
export type UpdateComponentEvidenceLinkInput = UpdateInput<ComponentEvidenceLink>;

type ComponentEvidenceLinkStoreType = ParentedStore<
  ComponentEvidenceLink,
  InsertComponentEvidenceLinkInput,
  UpdateComponentEvidenceLinkInput
> & {
  listByComponent: (
    queryable: Queryable,
    componentId: string,
  ) => Promise<readonly ComponentEvidenceLink[]>;
  listBySession: (
    queryable: Queryable,
    sessionId: string,
  ) => Promise<readonly ComponentEvidenceLink[]>;
};

const componentEvidenceLinkBase = createParentedStore<
  ComponentEvidenceLink,
  InsertComponentEvidenceLinkInput,
  UpdateComponentEvidenceLinkInput
>({
  table: 'component_evidence_links',
  columns: COMPONENT_EVIDENCE_LINK_COLUMNS,
  parentColumn: 'component_id',
  idFrom: ['componentId', 'sessionId', 'evidenceType'],
});

export const ComponentEvidenceLinkStore: ComponentEvidenceLinkStoreType = {
  ...componentEvidenceLinkBase,
  listByComponent: componentEvidenceLinkBase.listByParent,
  listBySession: async (queryable, sessionId) => {
    const selectColumns = COMPONENT_EVIDENCE_LINK_COLUMNS.map((c) => c.name).join(', ');
    const { rows } = await queryable.exec(
      `SELECT ${selectColumns} FROM component_evidence_links WHERE session_id = ? ORDER BY created_at`,
      [sessionId],
    );
    return rows.map((r) => rowTo<ComponentEvidenceLink>(COMPONENT_EVIDENCE_LINK_COLUMNS, r));
  },
};

// Full DDL and migration fragment

export const SESSION_EVIDENCE_DDL = `
${ALTER_SESSIONS_EVIDENCE_COLUMNS}
${CREATE_TURNS_TABLE}
${CREATE_MESSAGES_TABLE}
${CREATE_MODEL_CAPABILITIES_TABLE}
${CREATE_PRICING_VERSIONS_TABLE}
${CREATE_MODEL_REQUESTS_TABLE}
${CREATE_MODEL_USAGE_TABLE}
${CREATE_MESSAGE_EFFORT_TABLE}
${CREATE_INVOCATIONS_TABLE}
${CREATE_PAYLOADS_TABLE}
${CREATE_INVOCATION_PAYLOADS_TABLE}
${CREATE_SESSION_RELATIONS_TABLE}
${CREATE_PERMISSION_EVENTS_TABLE}
${CREATE_MODE_EVENTS_TABLE}
${CREATE_HOOK_EXECUTIONS_TABLE}
${CREATE_NORMALIZED_EVENTS_TABLE}
${CREATE_TASKS_TABLE}
${CREATE_TASK_EVENTS_TABLE}
${CREATE_VALIDATIONS_TABLE}
${CREATE_FILE_OPERATIONS_TABLE}
${CREATE_COMMAND_EXECUTIONS_TABLE}
${CREATE_COMPONENT_EVIDENCE_LINKS_TABLE}
`.trim();

export const SESSION_EVIDENCE_MIGRATIONS_FRAGMENT: readonly Migration[] = [
  {
    id: 35,
    name: 'alter-sessions-evidence-columns',
    sql: ALTER_SESSIONS_EVIDENCE_COLUMNS,
    checksum: checksumOf(ALTER_SESSIONS_EVIDENCE_COLUMNS),
  },
  {
    id: 36,
    name: 'create-turns',
    sql: CREATE_TURNS_TABLE,
    checksum: checksumOf(CREATE_TURNS_TABLE),
  },
  {
    id: 37,
    name: 'create-messages',
    sql: CREATE_MESSAGES_TABLE,
    checksum: checksumOf(CREATE_MESSAGES_TABLE),
  },
  {
    id: 38,
    name: 'create-model-capabilities',
    sql: CREATE_MODEL_CAPABILITIES_TABLE,
    checksum: checksumOf(CREATE_MODEL_CAPABILITIES_TABLE),
  },
  {
    id: 39,
    name: 'create-pricing-versions',
    sql: CREATE_PRICING_VERSIONS_TABLE,
    checksum: checksumOf(CREATE_PRICING_VERSIONS_TABLE),
  },
  {
    id: 40,
    name: 'create-model-requests',
    sql: CREATE_MODEL_REQUESTS_TABLE,
    checksum: checksumOf(CREATE_MODEL_REQUESTS_TABLE),
  },
  {
    id: 41,
    name: 'create-model-usage',
    sql: CREATE_MODEL_USAGE_TABLE,
    checksum: checksumOf(CREATE_MODEL_USAGE_TABLE),
  },
  {
    id: 42,
    name: 'create-invocations',
    sql: CREATE_INVOCATIONS_TABLE,
    checksum: checksumOf(CREATE_INVOCATIONS_TABLE),
  },
  {
    id: 43,
    name: 'create-payloads',
    sql: CREATE_PAYLOADS_TABLE,
    checksum: checksumOf(CREATE_PAYLOADS_TABLE),
  },
  {
    id: 44,
    name: 'create-invocation-payloads',
    sql: CREATE_INVOCATION_PAYLOADS_TABLE,
    checksum: checksumOf(CREATE_INVOCATION_PAYLOADS_TABLE),
  },
  {
    id: 45,
    name: 'create-session-relations',
    sql: CREATE_SESSION_RELATIONS_TABLE,
    checksum: checksumOf(CREATE_SESSION_RELATIONS_TABLE),
  },
  {
    id: 46,
    name: 'create-permission-events',
    sql: CREATE_PERMISSION_EVENTS_TABLE,
    checksum: checksumOf(CREATE_PERMISSION_EVENTS_TABLE),
  },
  {
    id: 47,
    name: 'create-mode-events',
    sql: CREATE_MODE_EVENTS_TABLE,
    checksum: checksumOf(CREATE_MODE_EVENTS_TABLE),
  },
  {
    id: 48,
    name: 'create-hook-executions',
    sql: CREATE_HOOK_EXECUTIONS_TABLE,
    checksum: checksumOf(CREATE_HOOK_EXECUTIONS_TABLE),
  },
  {
    id: 49,
    name: 'create-normalized-events',
    sql: CREATE_NORMALIZED_EVENTS_TABLE,
    checksum: checksumOf(CREATE_NORMALIZED_EVENTS_TABLE),
  },
  {
    id: 50,
    name: 'create-tasks',
    sql: CREATE_TASKS_TABLE,
    checksum: checksumOf(CREATE_TASKS_TABLE),
  },
  {
    id: 51,
    name: 'create-task-events',
    sql: CREATE_TASK_EVENTS_TABLE,
    checksum: checksumOf(CREATE_TASK_EVENTS_TABLE),
  },
  {
    id: 52,
    name: 'create-validations',
    sql: CREATE_VALIDATIONS_TABLE,
    checksum: checksumOf(CREATE_VALIDATIONS_TABLE),
  },
  {
    id: 53,
    name: 'create-file-operations',
    sql: CREATE_FILE_OPERATIONS_TABLE,
    checksum: checksumOf(CREATE_FILE_OPERATIONS_TABLE),
  },
  {
    id: 54,
    name: 'create-command-executions',
    sql: CREATE_COMMAND_EXECUTIONS_TABLE,
    checksum: checksumOf(CREATE_COMMAND_EXECUTIONS_TABLE),
  },
  {
    id: 55,
    name: 'create-component-evidence-links',
    sql: CREATE_COMPONENT_EVIDENCE_LINKS_TABLE,
    checksum: checksumOf(CREATE_COMPONENT_EVIDENCE_LINKS_TABLE),
  },
  {
    id: 81,
    name: 'create-message-effort',
    sql: CREATE_MESSAGE_EFFORT_TABLE,
    checksum: checksumOf(CREATE_MESSAGE_EFFORT_TABLE),
  },
];
