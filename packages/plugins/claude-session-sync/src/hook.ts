import process from 'node:process';
import {
  buildTelemetryRecord,
  type CliOptions,
  capture,
  emitTelemetry,
  getDataDir,
  zeroRun,
} from '@lucasschirm/sal-sync';
import {
  claudeEventToSyncTrigger,
  parseClaudeHookInput,
  readStdin,
  toHarnessSession,
  toSyncInput,
} from './claude.js';
import { resolveCliEnv } from './cli/env.js';
import { isMainModule } from './is-main-module.js';

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
    const parsed = parseClaudeHookInput(raw);
    const cwd = parsed.ok ? parsed.input.cwd : process.cwd();
    const env = await resolveCliEnv(cwd);
    return await runHook(raw, { env });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`claude-session-sync hook error: ${message}\n`);
    try {
      const dataDir = getDataDir(process.env);
      const record = zeroRun('manual', 'unknown', 'capture');
      record.errors = ['SYNC_INTERNAL_ERROR'];
      record.errorDetails = [{ code: 'SYNC_INTERNAL_ERROR', message }];
      await emitTelemetry(
        dataDir,
        buildTelemetryRecord({
          run: record,
          sessionId: 'unknown',
          command: 'capture',
          diagnostics: { fatalError: message },
        }),
      );
    } catch {
      // Best effort — don't mask the original error.
    }
    return 0;
  }
}

if (isMainModule(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    () => process.exit(0),
  );
}
