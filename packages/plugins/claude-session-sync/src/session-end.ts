import process from 'node:process';
import {
  buildTelemetryRecord,
  type CliOptions,
  emitTelemetry,
  getDataDir,
  sessionEnd,
  zeroRun,
} from '@lucasschirm/sal-sync';
import { parseClaudeHookInput, readStdin, toHarnessSession, toSyncInput } from './claude.js';
import { resolveCliEnv } from './cli/env.js';
import { isMainModule } from './is-main-module.js';

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

  // Write a start message so the user sees activity before the upload completes.
  // If the hook times out, at least this will have been written.
  process.stderr.write('claude-session-sync: uploading session data...\n');

  const result = await sessionEnd({
    ...options,
    input: syncInput,
  });

  // Surface a summary to stderr so the user sees it in Claude Code.
  // SessionEnd hooks show stderr to the user.
  const run = result.run;
  if (run) {
    const parts: string[] = [];
    if (run.filesUploaded > 0) parts.push(`${run.filesUploaded} files uploaded`);
    if (run.filesSkipped > 0) parts.push(`${run.filesSkipped} files skipped (unchanged)`);
    if (run.filesFailed > 0) parts.push(`${run.filesFailed} files failed`);
    if (result.budgetExhausted) parts.push('budget exhausted (some uploads may be incomplete)');

    if (parts.length > 0) {
      process.stderr.write(`claude-session-sync: ${parts.join(', ')}.\n`);
    }

    if (run.errors && run.errors.length > 0) {
      const errorSummary = run.errors.join(', ');
      process.stderr.write(`claude-session-sync: errors: ${errorSummary}.\n`);
    }
  }

  return result.exitCode;
}

async function main(): Promise<number> {
  try {
    const raw = await readStdin();
    const parsed = parseClaudeHookInput(raw);
    const cwd = parsed.ok ? parsed.input.cwd : process.cwd();
    const env = await resolveCliEnv(cwd);
    return await runSessionEnd(raw, { env });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`claude-session-sync session-end error: ${message}\n`);
    try {
      const dataDir = getDataDir(process.env);
      const record = zeroRun('session-end', 'unknown', 'session-end');
      record.errors = ['SYNC_INTERNAL_ERROR'];
      record.errorDetails = [{ code: 'SYNC_INTERNAL_ERROR', message }];
      await emitTelemetry(
        dataDir,
        buildTelemetryRecord({
          run: record,
          sessionId: 'unknown',
          command: 'session-end',
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
