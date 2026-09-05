import { readFileSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { createCliMain } from '@lucasschirm/sal-sync';

import { ClaudeCliAdapter } from './claude-cli-adapter.js';
import { runDownloadCommand } from './cli/download-command.js';
import { runListCommand } from './cli/list-command.js';
import { formatAbortMessage, writeErrorLog } from './cli/logger.js';
import { runMigrateCommand } from './cli/migrate-command.js';
import { runRemoveCommand } from './cli/remove-command.js';
import { runSyncCommand } from './cli/sync-command.js';
import { isMainModule } from './is-main-module.js';

function readPackageVersion(): string {
  try {
    const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * `claude-sync` CLI entry point. Dispatch logic and help/version handling
 * are hoisted (#354) to `@lucasschirm/sal-sync`'s `createCliMain` — this
 * file supplies `ClaudeCliAdapter` (for help text), this plugin's own
 * already adapter-bound command runners, and its own package.json version
 * reader (which must stay plugin-local — it resolves a path relative to
 * *this* file).
 */
export const main = createCliMain(
  ClaudeCliAdapter,
  { runSyncCommand, runListCommand, runDownloadCommand, runRemoveCommand, runMigrateCommand },
  readPackageVersion,
);

if (isMainModule(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    async (err) => {
      // An unhandled exception aborted the command. Write a timestamped error
      // log file (with the full stack trace and any chained causes) so the
      // user can diagnose the failure, then point them at it from stderr.
      const command = process.argv.slice(2)[0];
      const result = await writeErrorLog(process.env, command, err);
      process.stderr.write(`${formatAbortMessage(err, result)}\n`);
      process.exit(1);
    },
  );
}
