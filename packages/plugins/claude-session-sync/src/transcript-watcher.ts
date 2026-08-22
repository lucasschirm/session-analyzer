import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { type CliOptions, watch, watchTranscripts } from '@lucasschirm/sal-sync';
import { resolveCliEnv } from './cli/env.js';

export async function runTranscriptWatcher(options: CliOptions = {}): Promise<number> {
  const result = await watch({
    ...options,
    watcher: watchTranscripts,
  });
  return result.exitCode;
}

async function main(): Promise<number> {
  try {
    const env = await resolveCliEnv(process.cwd());
    return await runTranscriptWatcher({ argv: process.argv.slice(2), env });
  } catch {
    return 1;
  }
}

if (import.meta.url.startsWith('file:') && process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    () => process.exit(1),
  );
}
