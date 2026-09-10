import type { SqliteExecutor, SqliteRow, SqliteTransaction, SqliteValue } from './contract.js';

type Queryable = SqliteExecutor | SqliteTransaction;

function fnv1a64(input: string): bigint {
  let hash = 14695981039346656037n;
  const prime = 1099511628211n;
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = (hash * prime) & 0xffffffffffffffffn;
  }
  return hash;
}

function toHex(value: bigint): string {
  return value.toString(16).padStart(16, '0');
}

function deterministicId(...parts: readonly string[]): string {
  return toHex(fnv1a64(parts.join('\x00')));
}

function asString(value: SqliteValue): string {
  return value === null || value === undefined ? '' : String(value);
}

function asNumber(value: SqliteValue): number {
  return value === null || value === undefined ? 0 : Number(value);
}

export type ConfigurationValueType = 'number' | 'string' | 'boolean' | 'json';

export interface ConfigurationKeySpec<T = unknown> {
  readonly key: string;
  readonly label: string;
  readonly description: string;
  readonly type: ConfigurationValueType;
  readonly defaultValue: T;
}

export interface ProjectConfiguration {
  readonly id: string;
  readonly projectId: string;
  readonly key: string;
  readonly value: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface InsertProjectConfigurationInput {
  readonly id?: string;
  readonly projectId: string;
  readonly key: string;
  readonly value: string;
  readonly createdAt?: number;
  readonly updatedAt?: number;
}

export const PROJECT_CONFIGURATION_SPECS: Record<string, ConfigurationKeySpec> = {
  utilization_min_session_sample_size: {
    key: 'utilization_min_session_sample_size',
    label: 'Minimum Session Sample Size',
    description:
      'Minimum number of offered sessions required before evaluating low utilization percentage tiers',
    type: 'number',
    defaultValue: 5,
  },
  utilization_threshold_tier1: {
    key: 'utilization_threshold_tier1',
    label: 'Critical Low Utilization Tier Upper Bound',
    description: 'Upper boundary for critical low utilization (<10%)',
    type: 'number',
    defaultValue: 0.1,
  },
  utilization_threshold_tier2: {
    key: 'utilization_threshold_tier2',
    label: 'Low Utilization Tier Upper Bound',
    description: 'Upper boundary for low utilization (10% to 25%)',
    type: 'number',
    defaultValue: 0.25,
  },
  utilization_threshold_tier3: {
    key: 'utilization_threshold_tier3',
    label: 'Moderate Utilization Tier Upper Bound',
    description: 'Upper boundary for moderate utilization (25% to 50%)',
    type: 'number',
    defaultValue: 0.5,
  },
} as const;

export function parseConfigurationValue<T>(value: string, type: ConfigurationValueType): T {
  switch (type) {
    case 'number':
      return Number(value) as T;
    case 'boolean':
      return (value === 'true' || value === '1') as T;
    case 'json':
      try {
        return JSON.parse(value) as T;
      } catch {
        return value as T;
      }
    case 'string':
    default:
      return value as T;
  }
}

// biome-ignore lint/complexity/noStaticOnlyClass: typed configuration store
export class ProjectConfigurationStore {
  static async insert(
    queryable: Queryable,
    input: InsertProjectConfigurationInput,
  ): Promise<string> {
    const id = input.id ?? deterministicId('pcfg', input.projectId, input.key);
    const now = Date.now();
    await queryable.exec(
      `INSERT INTO project_configurations (id, project_id, key, value, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, input.projectId, input.key, input.value, input.createdAt ?? now, input.updatedAt ?? now],
    );
    return id;
  }

  static async insertOrIgnore(
    queryable: Queryable,
    input: InsertProjectConfigurationInput,
  ): Promise<string> {
    const id = input.id ?? deterministicId('pcfg', input.projectId, input.key);
    const now = Date.now();
    await queryable.exec(
      `INSERT OR IGNORE INTO project_configurations (id, project_id, key, value, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, input.projectId, input.key, input.value, input.createdAt ?? now, input.updatedAt ?? now],
    );
    return id;
  }

  static async upsert(
    queryable: Queryable,
    input: InsertProjectConfigurationInput,
  ): Promise<string> {
    const id = input.id ?? deterministicId('pcfg', input.projectId, input.key);
    const now = Date.now();
    await queryable.exec(
      `INSERT INTO project_configurations (id, project_id, key, value, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (project_id, key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at`,
      [id, input.projectId, input.key, input.value, input.createdAt ?? now, input.updatedAt ?? now],
    );
    return id;
  }

  static async getByKey(
    queryable: Queryable,
    projectId: string,
    key: string,
  ): Promise<ProjectConfiguration | undefined> {
    const { rows } = await queryable.exec(
      `SELECT id, project_id, key, value, created_at, updated_at
       FROM project_configurations
       WHERE project_id = ? AND key = ?`,
      [projectId, key],
    );
    if (rows.length === 0) return undefined;
    return ProjectConfigurationStore.rowToConfiguration(rows[0]);
  }

  static async listByProject(
    queryable: Queryable,
    projectId: string,
  ): Promise<readonly ProjectConfiguration[]> {
    const { rows } = await queryable.exec(
      `SELECT id, project_id, key, value, created_at, updated_at
       FROM project_configurations
       WHERE project_id = ?
       ORDER BY key`,
      [projectId],
    );
    return rows.map(ProjectConfigurationStore.rowToConfiguration);
  }

  static async delete(queryable: Queryable, projectId: string, key: string): Promise<void> {
    await queryable.exec('DELETE FROM project_configurations WHERE project_id = ? AND key = ?', [
      projectId,
      key,
    ]);
  }

  static async seedDefaults(queryable: Queryable, projectId: string): Promise<void> {
    const { rows } = await queryable.exec(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='project_configurations'",
    );
    if (rows.length === 0) return;

    const now = Date.now();
    for (const spec of Object.values(PROJECT_CONFIGURATION_SPECS)) {
      const id = deterministicId('pcfg', projectId, spec.key);
      await queryable.exec(
        `INSERT OR IGNORE INTO project_configurations (id, project_id, key, value, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [id, projectId, spec.key, String(spec.defaultValue), now, now],
      );
    }
  }

  private static rowToConfiguration(row: SqliteRow): ProjectConfiguration {
    return {
      id: asString(row.id),
      projectId: asString(row.project_id),
      key: asString(row.key),
      value: asString(row.value),
      createdAt: asNumber(row.created_at),
      updatedAt: asNumber(row.updated_at),
    };
  }
}
