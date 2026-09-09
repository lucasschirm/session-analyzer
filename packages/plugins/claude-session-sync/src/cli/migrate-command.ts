import {
  type MigrateCommandOptions,
  runMigrateCommand as sharedRunMigrateCommand,
} from '@lucasschirm/sal-sync';

import { ClaudeCliAdapter } from '../claude-cli-adapter.js';

export type { MigrateArgs, MigrateArgsResult, MigrateCommandOptions } from '@lucasschirm/sal-sync';
export { parseMigrateArgs } from '@lucasschirm/sal-sync';

/**
 * Migrate old-format S3 keys (with `session/` segment) to the new format
 * (without `session/` segment), and generate missing manifests for sessions
 * that were uploaded by hooks before manifest upload was added.
 *
 * Hoisted (#354) to `@lucasschirm/sal-sync`'s harness-parameterized
 * `runMigrateCommand(adapter, argv, options)` — this wrapper binds it to
 * `ClaudeCliAdapter`, whose `migrateManifestHarness` is the literal
 * `'claude-code'` (NOT `ClaudeHarnessProfile.harness`, `'claude'` — see
 * `claude-cli-adapter.ts`'s doc comment for why). Preserves the exact
 * `runMigrateCommand(argv, options?)` signature this plugin's tests assert
 * on directly.
 */
export async function runMigrateCommand(
  argv: string[],
  options: MigrateCommandOptions = {},
): Promise<number> {
  return sharedRunMigrateCommand(ClaudeCliAdapter, argv, options);
}
