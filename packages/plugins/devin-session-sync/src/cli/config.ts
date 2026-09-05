import process from 'node:process';

import {
  type SyncConfig,
  validateCliConfig as sharedValidateCliConfig,
  validateStorageConfig as sharedValidateStorageConfig,
  type ValidateConfigResult,
  type ValidateStorageConfigResult,
} from '@lucasschirm/sal-sync';

import { DevinCliAdapter } from '../devin-cli-adapter.js';

export type {
  MissingVar,
  ValidateConfigResult,
  ValidateStorageConfigResult,
} from '@lucasschirm/sal-sync';
export type { SyncConfig };

/**
 * Validate the merged environment and produce a `SyncConfig` or a
 * human-readable error message with examples for each missing variable.
 *
 * Hoisted (#354) to `@lucasschirm/sal-sync`'s harness-parameterized
 * `validateCliConfig(adapter, env, cwd)` — this wrapper binds it to
 * `DevinCliAdapter` and preserves the exact `validateCliConfig(env, cwd?)`
 * signature this plugin's tests assert on directly.
 *
 * @param env - the merged environment (process.env + .devin/config.local.json + .devin/config.json)
 * @param cwd - the project working directory, used to suggest a default project id
 */
export function validateCliConfig(
  env: Record<string, string | undefined>,
  cwd: string = process.cwd(),
): ValidateConfigResult {
  return sharedValidateCliConfig(DevinCliAdapter, env, cwd);
}

/**
 * Validate the merged environment for storage-only commands (e.g. `list`
 * against a specific project or session). Does not require `SAL_PROJECT_ID`.
 */
export function validateStorageConfig(
  env: Record<string, string | undefined>,
): ValidateStorageConfigResult {
  return sharedValidateStorageConfig(DevinCliAdapter, env);
}
