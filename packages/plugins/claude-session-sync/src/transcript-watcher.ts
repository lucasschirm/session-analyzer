import process from 'node:process';
import { type CliOptions, watch, watchTranscripts } from '@lucasschirm/sal-sync';
import { isMainModule } from './is-main-module.js';

export async function runTranscriptWatcher(options: CliOptions = {}): Promise<number> {
  const result = await watch({
    ...options,
    watcher: watchTranscripts,
  });
  return result.exitCode;
}

async function main(): Promise<number> {
  try {
    return await runTranscriptWatcher({ argv: process.argv.slice(2) });
  } catch {
    return 1;
  }
}

if (isMainModule(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    () => process.exit(1),
  );
}
