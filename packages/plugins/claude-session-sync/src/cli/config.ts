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
 * Validate the merged environment and produce a `SyncConfig` or a human-readable
 * error message with examples for each missing variable.
 *
 * @param env - the merged environment (process.env + settings.local.json)
 * @param cwd - the project working directory, used to suggest a default project id
 */
export function validateCliConfig(
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
    const suggestedProjectId = path.basename(cwd);
    const lines: string[] = [];
    lines.push('Error: required configuration is missing or incomplete.');
    lines.push('');
    lines.push('The following environment variables must be set:');

    for (const v of missing) {
      lines.push(`  ${v.name} — ${v.description}`);
    }

    lines.push('');
    lines.push('Set them via environment variables before running the CLI:');
    lines.push('');

    const exportLines = missing.map((v) => {
      const example = v.name === 'SAL_PROJECT_ID' ? suggestedProjectId : v.example;
      return `  export ${v.name}=${example}`;
    });
    exportLines.push('  npx @lucasschirm/claude-session-sync sync');
    lines.push(exportLines.join('\n'));

    lines.push('');
    lines.push('Or add them to .claude/settings.local.json:');
    lines.push('');
    const envEntries = missing.map((v) => {
      const example = v.name === 'SAL_PROJECT_ID' ? suggestedProjectId : v.example;
      return `    "${v.name}": "${example}"`;
    });
    lines.push('{');
    lines.push('  "env": {');
    lines.push(envEntries.join(',\n'));
    lines.push('  }');
    lines.push('}');

    return {
      ok: false,
      missing,
      errorMessage: lines.join('\n'),
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

function buildMissingStorageError(missing: MissingVar[]): string {
  const lines: string[] = [];
  lines.push('Error: required storage configuration is missing or incomplete.');
  lines.push('');
  lines.push('The following environment variables must be set:');

  for (const v of missing) {
    lines.push(`  ${v.name} — ${v.description}`);
  }

  lines.push('');
  lines.push('Set them via environment variables before running the CLI:');
  lines.push('');

  const exportLines = missing.map((v) => {
    return `  export ${v.name}=${v.example}`;
  });
  exportLines.push('  npx @lucasschirm/claude-session-sync list');
  lines.push(exportLines.join('\n'));

  lines.push('');
  lines.push('Or add them to .claude/settings.local.json:');
  lines.push('');
  const envEntries = missing.map((v) => {
    return `    "${v.name}": "${v.example}"`;
  });
  lines.push('{');
  lines.push('  "env": {');
  lines.push(envEntries.join(',\n'));
  lines.push('  }');
  lines.push('}');

  return lines.join('\n');
}

/**
 * Validate the merged environment for storage-only commands (e.g. `list` against
 * a specific project or session). Does not require `SAL_PROJECT_ID`.
 *
 * @param env - the merged environment (process.env + settings.local.json)
 */
export function validateStorageConfig(
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
      errorMessage: buildMissingStorageError(missing),
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
