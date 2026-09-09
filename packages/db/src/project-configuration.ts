import {
  type ConfigurationKeySpec,
  PROJECT_CONFIGURATION_SPECS,
  ProjectConfigurationStore,
  parseConfigurationValue,
  type SqliteExecutor,
  type SqliteTransaction,
} from '@lucasschirm/sal-db-core';

type Queryable = SqliteExecutor | SqliteTransaction;

export interface ProjectUtilizationConfig {
  readonly minSessionSampleSize: number;
  readonly tier1UpperBound: number;
  readonly tier2UpperBound: number;
  readonly tier3UpperBound: number;
}

export async function getProjectConfiguration<T = unknown>(
  queryable: Queryable,
  projectId: string,
  key: string,
): Promise<T> {
  const spec: ConfigurationKeySpec | undefined = PROJECT_CONFIGURATION_SPECS[key];
  const row = await ProjectConfigurationStore.getByKey(queryable, projectId, key);
  if (!row) {
    return (spec?.defaultValue as T) ?? (null as unknown as T);
  }
  return parseConfigurationValue<T>(row.value, spec?.type ?? 'string');
}

export async function getProjectConfigurations(
  queryable: Queryable,
  projectId: string,
): Promise<Record<string, unknown>> {
  const rows = await ProjectConfigurationStore.listByProject(queryable, projectId);
  const result: Record<string, unknown> = {};

  // Fill in registered defaults first
  for (const [key, spec] of Object.entries(PROJECT_CONFIGURATION_SPECS)) {
    result[key] = spec.defaultValue;
  }

  // Override with persisted project rows
  for (const row of rows) {
    const spec = PROJECT_CONFIGURATION_SPECS[row.key];
    result[row.key] = parseConfigurationValue(row.value, spec?.type ?? 'string');
  }

  return result;
}

export async function setProjectConfiguration(
  queryable: Queryable,
  projectId: string,
  key: string,
  value: unknown,
): Promise<void> {
  const serialized =
    typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value);
  await ProjectConfigurationStore.upsert(queryable, {
    projectId,
    key,
    value: serialized,
  });
}

export async function getProjectUtilizationConfig(
  queryable: Queryable,
  projectId?: string | null,
): Promise<ProjectUtilizationConfig> {
  let minSessionSampleSize = 5;
  let tier1UpperBound = 0.1;
  let tier2UpperBound = 0.25;
  let tier3UpperBound = 0.5;

  if (projectId) {
    minSessionSampleSize = await getProjectConfiguration<number>(
      queryable,
      projectId,
      'utilization_min_session_sample_size',
    );
    tier1UpperBound = await getProjectConfiguration<number>(
      queryable,
      projectId,
      'utilization_threshold_tier1',
    );
    tier2UpperBound = await getProjectConfiguration<number>(
      queryable,
      projectId,
      'utilization_threshold_tier2',
    );
    tier3UpperBound = await getProjectConfiguration<number>(
      queryable,
      projectId,
      'utilization_threshold_tier3',
    );
  }

  return {
    minSessionSampleSize: Number(minSessionSampleSize) || 5,
    tier1UpperBound: Number(tier1UpperBound) || 0.1,
    tier2UpperBound: Number(tier2UpperBound) || 0.25,
    tier3UpperBound: Number(tier3UpperBound) || 0.5,
  };
}
