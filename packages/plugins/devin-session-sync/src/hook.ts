import process from 'node:process';

import {
  devinEventToSyncTrigger,
  parseDevinHookInput,
  readStdin,
  toHarnessSession,
} from './devin.js';
import { type RunDevinHookSyncOptions, runDevinHookSync } from './hook-common.js';
import { isMainModule } from './is-main-module.js';

export type RunHookOptions = Partial<
  Omit<RunDevinHookSyncOptions, 'sessionId' | 'cwd' | 'trigger'>
> & {
  cwd?: string;
};

/**
 * Generic hook entry point wired to `Stop` and `PostCompaction` in
 * `hooks.json`. `Stop` fires every turn in both Devin Cloud and local CLI
 * sessions (verified, Part A3) — the primary mitigation for Cloud sessions,
 * which never fire `SessionStart`/`SessionEnd` command hooks at all.
 */
export async function runHook(raw: unknown, options: RunHookOptions = {}): Promise<number> {
  const parsed = parseDevinHookInput(raw);
  if (!parsed.ok) {
    return 0;
  }

  const cwd = options.cwd ?? process.cwd();
  const session = toHarnessSession(parsed.input, cwd);
  const trigger = devinEventToSyncTrigger(parsed.input.hook_event_name);

  await runDevinHookSync('hook', {
    ...options,
    sessionId: session.sessionId,
    cwd: session.cwd,
    trigger,
  });
  return 0;
}

async function main(): Promise<number> {
  try {
    const raw = await readStdin();
    return await runHook(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`devin-session-sync hook error: ${message}\n`);
    return 0;
  }
}

if (isMainModule(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    () => process.exit(0),
  );
}
