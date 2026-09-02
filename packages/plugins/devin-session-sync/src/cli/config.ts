import path from 'node:path';
import process from 'node:process';

import {
  type LoadConfigResult,
  type LoadStorageConfigResult,
  loadConfig,
  loadStorageConfig,
  type StorageConfig,
  type SyncConfig,
} from '@lucasschirm/sal-sync';

/** A required environment variable that is missing or invalid. */
export interface MissingVar {
  name: string;
  description: string;
  example: string;
}

const REQUIRED_VARS: MissingVar[] = [
  {
    name: 'SAL_PROJECT_ID',
    description: 'Unique identifier for the project.',
    example: 'session-analyzer',
  },
  {
    name: 'SAL_STORAGE_TYPE',
    description: 'Storage backend. Currently only "s3" is supported.',
    example: 's3',
  },
  {
    name: 'SAL_STORAGE_BUCKET',
    description: 'S3 bucket name.',
    example: 'my-session-bucket',
  },
  {
    name: 'SAL_STORAGE_REGION',
    description: 'AWS region (e.g. us-east-1).',
    example: 'us-east-1',
  },
  {
    name: 'SAL_STORAGE_ACCESS_KEY_ID',
    description: 'AWS access key ID.',
    example: 'AKIAIOSFODNN7EXAMPLE',
  },
  {
    name: 'SAL_STORAGE_SECRET_ACCESS_KEY',
    description: 'AWS secret access key.',
    example: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  },
];

const STORAGE_REQUIRED_VARS: MissingVar[] = REQUIRED_VARS.filter(
  (v) => v.name !== 'SAL_PROJECT_ID',
);

export interface ValidateConfigResult {
  ok: boolean;
  config?: SyncConfig;
  missing?: MissingVar[];
  errorMessage?: string;
}

function buildMissingConfigError(missing: MissingVar[], cwd: string, command: string): string {
  const suggestedProjectId = path.basename(cwd);
  const lines: string[] = [
    'Error: required configuration is missing or incomplete.',
    '',
    'The following environment variables must be set:',
  ];
  for (const v of missing) {
    lines.push(`  ${v.name} — ${v.description}`);
  }
  lines.push('', 'Set them via environment variables before running the CLI:', '');
  const exportLines = missing.map((v) => {
    const example = v.name === 'SAL_PROJECT_ID' ? suggestedProjectId : v.example;
    return `  export ${v.name}=${example}`;
  });
  exportLines.push(`  npx @lucasschirm/devin-session-sync ${command}`);
  lines.push(exportLines.join('\n'), '', 'Or add them to .devin/config.local.json:', '');
  const envEntries = missing.map((v) => {
    const example = v.name === 'SAL_PROJECT_ID' ? suggestedProjectId : v.example;
    return `    "${v.name}": "${example}"`;
  });
  lines.push('{', '  "env": {', envEntries.join(',\n'), '  }', '}');
  return lines.join('\n');
}

/**
 * Validate the merged environment and produce a `SyncConfig` or a
 * human-readable error message with examples for each missing variable.
 *
 * @param env - the merged environment (process.env + .devin/config.local.json + .devin/config.json)
 * @param cwd - the project working directory, used to suggest a default project id
 */
export function validateCliConfig(
  env: Record<string, string | undefined>,
  cwd: string = process.cwd(),
): ValidateConfigResult {
  const missing = REQUIRED_VARS.filter((v) => {
    const value = env[v.name];
    return value === undefined || value.trim() === '';
  });

  if (missing.length > 0) {
    return { ok: false, missing, errorMessage: buildMissingConfigError(missing, cwd, 'sync') };
  }

  const result: LoadConfigResult = loadConfig(env);
  if (result.ok) {
    return { ok: true, config: result.config };
  }
  if (result.error) {
    return { ok: false, errorMessage: result.error.message };
  }
  return {
    ok: false,
    errorMessage: 'Configuration is invalid. Check your SAL_* environment variables.',
  };
}

export type ValidateStorageConfigResult =
  | { ok: true; storage: StorageConfig; retries: number }
  | { ok: false; missing?: MissingVar[]; errorMessage?: string };

function buildMissingStorageError(missing: MissingVar[]): string {
  const lines: string[] = [
    'Error: required storage configuration is missing or incomplete.',
    '',
    'The following environment variables must be set:',
  ];
  for (const v of missing) {
    lines.push(`  ${v.name} — ${v.description}`);
  }
  lines.push('', 'Set them via environment variables before running the CLI:', '');
  const exportLines = missing.map((v) => `  export ${v.name}=${v.example}`);
  exportLines.push('  npx @lucasschirm/devin-session-sync list');
  lines.push(exportLines.join('\n'), '', 'Or add them to .devin/config.local.json:', '');
  const envEntries = missing.map((v) => `    "${v.name}": "${v.example}"`);
  lines.push('{', '  "env": {', envEntries.join(',\n'), '  }', '}');
  return lines.join('\n');
}

/**
 * Validate the merged environment for storage-only commands (e.g. `list`
 * against a specific project or session). Does not require `SAL_PROJECT_ID`.
 */
export function validateStorageConfig(
  env: Record<string, string | undefined>,
): ValidateStorageConfigResult {
  const missing = STORAGE_REQUIRED_VARS.filter((v) => {
    const value = env[v.name];
    return value === undefined || value.trim() === '';
  });

  if (missing.length > 0) {
    return { ok: false, missing, errorMessage: buildMissingStorageError(missing) };
  }

  const result: LoadStorageConfigResult = loadStorageConfig(env);
  if (result.ok) {
    return { ok: true, storage: result.config.storage, retries: result.config.retries };
  }
  return { ok: false, errorMessage: result.error.message };
}
