import {
  type DownloadCommandOptions,
  runDownloadCommand as sharedRunDownloadCommand,
} from '@lucasschirm/sal-sync';

import { ClaudeCliAdapter } from '../claude-cli-adapter.js';

export type { DownloadArgs, DownloadCommandOptions } from '@lucasschirm/sal-sync';
export { parseDownloadArgs } from '@lucasschirm/sal-sync';

/**
 * Download session(s) from S3 storage to a local directory.
 *
 * - `download --session-id=<id> --output=<dir>` — download a specific session
 * - `download all --output=<dir>` — download all sessions for the project
 *
 * Hoisted (#354) to `@lucasschirm/sal-sync`'s harness-parameterized
 * `runDownloadCommand(adapter, argv, options)` — this wrapper binds it to
 * `ClaudeCliAdapter` and preserves the exact `runDownloadCommand(argv, options?)`
 * signature this plugin's tests assert on directly.
 */
export async function runDownloadCommand(
  argv: string[],
  options: DownloadCommandOptions = {},
): Promise<number> {
  return sharedRunDownloadCommand(ClaudeCliAdapter, argv, options);
}
