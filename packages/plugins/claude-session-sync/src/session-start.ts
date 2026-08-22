import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  buildTelemetryRecord,
  type CliOptions,
  emitTelemetry,
  getDataDir,
  sessionStart,
  type WatcherHandle,
  type WatcherSpawner,
  zeroRun,
} from '@lucasschirm/sal-sync';
import { parseClaudeHookInput, readStdin, toHarnessSession, toSyncInput } from './claude.js';
import { resolveCliEnv } from './cli/env.js';
import { isMainModule } from './is-main-module.js';

export interface SessionStartRunOptions extends CliOptions {
  watcherPath?: string;
}

export function getTranscriptWatcherPath(): string {
  const envPath = process.env.SAL_CLAUDE_WATCHER_PATH;
  if (envPath) {
    return path.resolve(envPath);
  }

  const currentFile = fileURLToPath(import.meta.url);
  const currentDir = path.dirname(currentFile);

  const candidates = ['transcript-watcher.js', 'transcript-watcher', 'transcript-watcher.mjs'];
  for (const rel of ['.', '..']) {
    for (const name of candidates) {
      const candidate = path.resolve(currentDir, rel, name);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return path.resolve(currentDir, '..', 'bin', 'transcript-watcher');
}

function createDefaultSpawnWatcher(watcherPath: string): WatcherSpawner {
  return (args: string[]) => {
    const child = spawn(process.execPath, [watcherPath, ...args], {
      detached: true,
      stdio: 'ignore',
    });

    const handle: WatcherHandle = {
      unref: () => {
        child.unref();
      },
      pid: child.pid ?? undefined,
      on: (event, listener) => {
        child.on(event, listener as () => void);
        return handle;
      },
    };

    return handle;
  };
}

export async function runSessionStart(
  raw: unknown,
  options: SessionStartRunOptions = {},
): Promise<number> {
  const parsed = parseClaudeHookInput(raw);
  if (!parsed.ok) {
    return 0;
  }

  const session = toHarnessSession(parsed.input);
  session.startedAt = session.startedAt ?? new Date().toISOString();
  const syncInput = toSyncInput(session, 'session-start');

  const spawner =
    options.spawnWatcher ??
    createDefaultSpawnWatcher(options.watcherPath ?? getTranscriptWatcherPath());

  const result = await sessionStart({
    ...options,
    input: syncInput,
    spawnWatcher: spawner,
  });

  return result.exitCode;
}

async function main(): Promise<number> {
  try {
    const raw = await readStdin();
    const parsed = parseClaudeHookInput(raw);
    const cwd = parsed.ok ? parsed.input.cwd : process.cwd();
    const env = await resolveCliEnv(cwd);
    return await runSessionStart(raw, { env });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`claude-session-sync session-start error: ${message}\n`);
    try {
      const dataDir = getDataDir(process.env);
      const record = zeroRun('session-start', 'unknown', 'session-start');
      record.errors = ['SYNC_INTERNAL_ERROR'];
      record.errorDetails = [{ code: 'SYNC_INTERNAL_ERROR', message }];
      await emitTelemetry(
        dataDir,
        buildTelemetryRecord({
          run: record,
          sessionId: 'unknown',
          command: 'session-start',
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
