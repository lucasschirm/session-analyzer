import process from 'node:process';
import { fileURLToPath } from 'node:url';
import type { CliOptions } from '@lucasschirm/sal-sync';
import { sessionEnd } from '@lucasschirm/sal-sync';
import { parseClaudeHookInput, readStdin, toHarnessSession, toSyncInput } from './claude.js';

export async function runSessionEnd(raw: unknown, options: CliOptions = {}): Promise<number> {
  const parsed = parseClaudeHookInput(raw);
  if (!parsed.ok) {
    return 0;
  }

  const session = toHarnessSession(parsed.input);
  session.endedAt = session.endedAt ?? new Date().toISOString();
  session.endReason = session.endReason ?? parsed.input.reason;

  const syncInput = toSyncInput(session, 'session-end');
  syncInput.reason = session.endReason;

  const result = await sessionEnd({
    ...options,
    input: syncInput,
  });

  return result.exitCode;
}

async function main(): Promise<number> {
  try {
    const raw = await readStdin();
    return await runSessionEnd(raw, { env: process.env });
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
