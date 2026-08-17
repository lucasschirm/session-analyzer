import process from 'node:process';
import { fileURLToPath } from 'node:url';
import type { CliOptions, CommandResult } from './common.js';
import { capture, sessionEnd, sessionStart, status, sync, watch } from './index.js';

const commands: Record<string, (options: CliOptions) => Promise<CommandResult>> = {
  capture,
  'session-start': sessionStart,
  'session-end': sessionEnd,
  sync,
  status,
  watch,
};

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || !(command in commands)) {
    process.stderr.write(`Usage: sal-sync {${Object.keys(commands).join(',')}} [options]\n`);
    return 1;
  }

  const result = await commands[command]({ argv: rest, stdin: process.stdin });

  if (command === 'status' && result.status) {
    process.stdout.write(`${JSON.stringify(result.status, null, 2)}\n`);
  }

  return result.exitCode;
}

if (import.meta.url.startsWith('file:') && process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    () => process.exit(1),
  );
}
