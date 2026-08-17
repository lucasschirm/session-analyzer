import process from 'node:process';
import { fileURLToPath } from 'node:url';
import type { CliOptions } from '@lucasschirm/sal-sync';
import { capture } from '@lucasschirm/sal-sync';
import {
  claudeEventToSyncTrigger,
  parseClaudeHookInput,
  readStdin,
  toHarnessSession,
  toSyncInput,
} from './claude.js';

export async function runHook(raw: unknown, options: CliOptions = {}): Promise<number> {
  const parsed = parseClaudeHookInput(raw);
  if (!parsed.ok) {
    return 0;
  }

  const session = toHarnessSession(parsed.input);
  const trigger = claudeEventToSyncTrigger(parsed.input.hook_event_name);
  const syncInput = toSyncInput(session, trigger);

  const result = await capture({
    ...options,
    input: syncInput,
  });

  return result.exitCode;
}

async function main(): Promise<number> {
  try {
    const raw = await readStdin();
    return await runHook(raw, { env: process.env });
  } catch {
    return 0;
  }
}

if (import.meta.url.startsWith('file:') && process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    () => process.exit(0),
  );
}
