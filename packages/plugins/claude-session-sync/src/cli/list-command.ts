import {
  type ListCommandOptions,
  runListCommand as sharedRunListCommand,
} from '@lucasschirm/sal-sync';

import { ClaudeCliAdapter } from '../claude-cli-adapter.js';

export type { ListArgs, ListCommandOptions, ListMode } from '@lucasschirm/sal-sync';
export { parseListArgs } from '@lucasschirm/sal-sync';

/**
 * List objects in configured storage.
 *
 * Modes:
 *   list                              List all projects in storage.
 *   list --current                    List sessions for the current project (SAL_PROJECT_ID).
 *   list <project-id>                 List sessions for a project.
 *   list <project-id> --session=<id>  List files in a session.
 *   list <project-id> --session=<id> --path=<p>  List files under a session sub-path.
 *
 * Hoisted (#354) to `@lucasschirm/sal-sync`'s harness-parameterized
 * `runListCommand(adapter, argv, options)` — this wrapper binds it to
 * `ClaudeCliAdapter` and preserves the exact `runListCommand(argv?, options?)`
 * signature this plugin's tests assert on directly.
 */
export async function runListCommand(
  argv: string[] = [],
  options: ListCommandOptions = {},
): Promise<number> {
  return sharedRunListCommand(ClaudeCliAdapter, argv, options);
}
