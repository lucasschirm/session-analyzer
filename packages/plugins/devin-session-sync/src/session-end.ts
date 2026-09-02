import process from 'node:process';

import { parseDevinHookInput, readStdin, toHarnessSession } from './devin.js';
import { type RunDevinHookSyncOptions, runDevinHookSync } from './hook-common.js';
import { isMainModule } from './is-main-module.js';

export type RunSessionEndOptions = Partial<
  Omit<RunDevinHookSyncOptions, 'sessionId' | 'cwd' | 'trigger'>
> & { cwd?: string };

function reportOutcome(outcome: {
  uploaded: number;
  skipped: number;
  failed: number;
  errors: string[];
}): void {
  const parts: string[] = [];
  if (outcome.uploaded > 0) parts.push(`${outcome.uploaded} files uploaded`);
  if (outcome.skipped > 0) parts.push(`${outcome.skipped} files skipped (unchanged)`);
  if (outcome.failed > 0) parts.push(`${outcome.failed} files failed`);
  if (parts.length > 0) {
    process.stderr.write(`devin-session-sync: ${parts.join(', ')}.\n`);
  }
  if (outcome.errors.length > 0) {
    process.stderr.write(`devin-session-sync: errors: ${outcome.errors.join(', ')}.\n`);
  }
}

/**
 * `SessionEnd` hook entry point. **Verified not to fire for Devin Cloud
 * sessions** (Part A3) — only local CLI sessions trigger this, so a final
 * sync must not be assumed to have happened; the `Stop` hook (`hook.ts`) and
 * the bulk `devin-sync sync` / watcher paths cover the gap.
 */
export async function runSessionEnd(
  raw: unknown,
  options: RunSessionEndOptions = {},
): Promise<number> {
  const parsed = parseDevinHookInput(raw);
  if (!parsed.ok) {
    return 0;
  }

  const cwd = options.cwd ?? process.cwd();
  const session = toHarnessSession(parsed.input, cwd);
  session.endedAt = session.endedAt ?? new Date().toISOString();

  process.stderr.write('devin-session-sync: uploading session data...\n');
  const result = await runDevinHookSync('session-end', {
    ...options,
    sessionId: session.sessionId,
    cwd: session.cwd,
    trigger: 'session-end',
  });
  if (result.ok) {
    reportOutcome(result.outcome);
  }
  return 0;
}

async function main(): Promise<number> {
  try {
    const raw = await readStdin();
    return await runSessionEnd(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`devin-session-sync session-end error: ${message}\n`);
    return 0;
  }
}

if (isMainModule(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    () => process.exit(0),
  );
}
