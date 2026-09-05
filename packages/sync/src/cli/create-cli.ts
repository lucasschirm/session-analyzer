import process from 'node:process';

import type { CliHarnessAdapter } from './harness-adapter.js';

/**
 * The five command runners a harness plugin's `cli.ts` dispatches to. Each
 * is already bound to that plugin's own `CliHarnessAdapter` (see e.g.
 * `packages/plugins/claude-session-sync/src/cli/*.ts`'s thin wrappers), so
 * this dispatcher itself never needs to know about the adapter beyond
 * `helpText`/`binName` (used for the help/abort text, threaded via the
 * `adapter` parameter to {@link createCliMain} below).
 */
export interface CliCommands {
  runSyncCommand: (options: { force: boolean }) => Promise<number>;
  runListCommand: (argv: string[]) => Promise<number>;
  runDownloadCommand: (argv: string[]) => Promise<number>;
  runRemoveCommand: (argv: string[]) => Promise<number>;
  runMigrateCommand: (argv: string[]) => Promise<number>;
}

function dispatchCommand(
  command: string,
  rest: string[],
  commands: CliCommands,
  adapter: CliHarnessAdapter,
): Promise<number> {
  switch (command) {
    case 'sync':
      return commands.runSyncCommand({ force: rest.includes('--force') || rest.includes('-f') });
    case 'list':
      return commands.runListCommand(rest);
    case 'download':
      return commands.runDownloadCommand(rest);
    case 'remove':
      return commands.runRemoveCommand(rest);
    case 'migrate':
      return commands.runMigrateCommand(rest);
    default:
      process.stderr.write(`Unknown command: ${command}\n\n`);
      process.stderr.write(adapter.helpText);
      return Promise.resolve(1);
  }
}

/**
 * Build a harness plugin's `main(argv)` entry function: prints help/version
 * and dispatches `sync`/`list`/`download`/`remove`/`migrate` to the supplied
 * (already adapter-bound) command runners.
 *
 * Hoisted (#354) from `claude-session-sync`/`devin-session-sync`'s
 * near-identical `cli.ts` — each plugin's own `cli.ts` calls this once at
 * module scope to produce its exported `main`, then keeps its own top-level
 * `isMainModule(import.meta.url)` guard (this function is a pure dispatcher
 * with no process-exit side effect, so it is safe to export through the
 * package barrel — see `packages/sync/src/cli/AGENTS.md`'s `run.ts`/`watch.ts`
 * precedent for why a process-invoking entry point must NOT be barrel-exported).
 *
 * @param adapter - the calling harness's `CliHarnessAdapter` (supplies help text)
 * @param commands - the five already adapter-bound command runners
 * @param readVersion - resolves the plugin's own package version (reads a
 *   `package.json` relative to the CALLING plugin's `cli.ts`, so this must
 *   stay a plugin-supplied function rather than something hoisted here)
 */
export function createCliMain(
  adapter: CliHarnessAdapter,
  commands: CliCommands,
  readVersion: () => string,
): (argv?: string[]) => Promise<number> {
  return async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
    const [command, ...rest] = argv;

    if (command === undefined || command === '-h' || command === '--help') {
      process.stdout.write(adapter.helpText);
      return 0;
    }

    if (command === '-v' || command === '--version') {
      process.stdout.write(`${readVersion()}\n`);
      return 0;
    }

    return dispatchCommand(command, rest, commands, adapter);
  };
}
