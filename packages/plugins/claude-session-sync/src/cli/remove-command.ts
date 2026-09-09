import {
  type RemoveCommandOptions,
  runRemoveCommand as sharedRunRemoveCommand,
} from '@lucasschirm/sal-sync';

import { ClaudeCliAdapter } from '../claude-cli-adapter.js';

export type { RemoveArgs, RemoveArgsResult, RemoveCommandOptions } from '@lucasschirm/sal-sync';
export { parseRemoveArgs } from '@lucasschirm/sal-sync';

/**
 * Remove every object stored for a project (or a single session within it)
 * from S3. Never deletes content-addressed `global/cas/<hash>` objects,
 * since those may be shared with other projects/sessions.
 *
 * Without `--yes`, performs a dry run: lists what would be deleted and exits
 * 0 without deleting anything.
 *
 * Hoisted (#354) to `@lucasschirm/sal-sync`'s harness-parameterized
 * `runRemoveCommand(adapter, argv, options)` — this wrapper binds it to
 * `ClaudeCliAdapter` and preserves the exact `runRemoveCommand(argv, options?)`
 * signature this plugin's tests assert on directly.
 */
export async function runRemoveCommand(
  argv: string[],
  options: RemoveCommandOptions = {},
): Promise<number> {
  return sharedRunRemoveCommand(ClaudeCliAdapter, argv, options);
}
