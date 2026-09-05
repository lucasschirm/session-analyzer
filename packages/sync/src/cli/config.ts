import path from 'node:path';
import process from 'node:process';

import type { StorageConfig, SyncConfig } from '@lucasschirm/sal-sync-core';
import type { LoadConfigResult, LoadStorageConfigResult } from '../config/index.js';
import { loadConfig, loadStorageConfig } from '../config/index.js';
import type { CliHarnessAdapter } from './harness-adapter.js';

/** A required environment variable that is missing or invalid. */
export interface MissingVar {
  /** The environment variable name (e.g. `SAL_PROJECT_ID`). */
  name: string;
  /** Human-readable description shown in the error. */
  description: string;
  /** An example value to use in the `export` example. */
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

/**
 * Builds the "missing configuration" error message for `validateCliConfig`.
 *
 * `command` is deliberately NOT threaded through from the actual invoked CLI
 * command — every call site below passes the literal `'sync'`, exactly
 * matching both plugins' pre-hoist behavior. This is a known, dormant
 * generalization (present because `validateCliConfig` itself is also used
 * from non-`sync` commands, e.g. `download`) that is intentionally NOT
 * completed as part of this hoist: wiring the real command through would
 * change the example command shown in every OTHER command's config-error
 * output, which is a behavior change outside this refactor's scope. Do not
 * "fix" this without a deliberate, separately-reviewed decision.
 */
function buildMissingConfigError(
  adapter: CliHarnessAdapter,
  missing: MissingVar[],
  cwd: string,
  command: string,
): string {
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
  exportLines.push(`  npx ${adapter.packageName} ${command}`);
  lines.push(exportLines.join('\n'), '', `Or add them to ${adapter.localConfigDisplayPath}:`, '');
  const envEntries = missing.map((v) => {
    const example = v.name === 'SAL_PROJECT_ID' ? suggestedProjectId : v.example;
    return `    "${v.name}": "${example}"`;
  });
  lines.push('{', '  "env": {', envEntries.join(',\n'), '  }', '}');
  return lines.join('\n');
}

/**
 * Validate the merged environment and produce a `SyncConfig` or a
 * human-readable error message with `export` examples for each missing
 * variable.
 *
 * @param adapter - the calling harness's `CliHarnessAdapter`
 * @param env - the merged environment (process.env + local/project/user-global config)
 * @param cwd - the project working directory, used to suggest a default project id
 */
export function validateCliConfig(
  adapter: CliHarnessAdapter,
  env: Record<string, string | undefined>,
  cwd: string = process.cwd(),
): ValidateConfigResult {
  // First, check that all required vars are present. The sal-sync loadConfig
  // treats some storage fields (bucket, region, credentials) as optional in
  // the StorageConfig type, but the S3 adapter requires them at construction
  // time. We enforce them here to give a clear, actionable error message.
  const missing = REQUIRED_VARS.filter((v) => {
    const value = env[v.name];
    return value === undefined || value.trim() === '';
  });

  if (missing.length > 0) {
    return {
      ok: false,
      missing,
      errorMessage: buildMissingConfigError(adapter, missing, cwd, 'sync'),
    };
  }

  // All required vars are set — delegate to loadConfig for value validation
  // (e.g. invalid storage type, malformed integers).
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

function buildMissingStorageError(adapter: CliHarnessAdapter, missing: MissingVar[]): string {
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
  exportLines.push(`  npx ${adapter.packageName} list`);
  lines.push(exportLines.join('\n'), '', `Or add them to ${adapter.localConfigDisplayPath}:`, '');
  const envEntries = missing.map((v) => `    "${v.name}": "${v.example}"`);
  lines.push('{', '  "env": {', envEntries.join(',\n'), '  }', '}');
  return lines.join('\n');
}

/**
 * Validate the merged environment for storage-only commands (e.g. `list`
 * against a specific project or session). Does not require `SAL_PROJECT_ID`.
 *
 * @param adapter - the calling harness's `CliHarnessAdapter`
 * @param env - the merged environment (process.env + local/project/user-global config)
 */
export function validateStorageConfig(
  adapter: CliHarnessAdapter,
  env: Record<string, string | undefined>,
): ValidateStorageConfigResult {
  const missing = STORAGE_REQUIRED_VARS.filter((v) => {
    const value = env[v.name];
    return value === undefined || value.trim() === '';
  });

  if (missing.length > 0) {
    return {
      ok: false,
      missing,
      errorMessage: buildMissingStorageError(adapter, missing),
    };
  }

  const result: LoadStorageConfigResult = loadStorageConfig(env);

  if (result.ok) {
    return {
      ok: true,
      storage: result.config.storage,
      retries: result.config.retries,
    };
  }

  return {
    ok: false,
    errorMessage: result.error.message,
  };
}
