import process from 'node:process';

import {
  type CliOptions,
  type CommandResult,
  parseCliArgs,
  removeWatcherPid,
  writeWatcherPid,
} from './common.js';

export interface WatchOptions extends CliOptions {
  watcher?(options: {
    dataDir: string;
    sessionId: string;
    transcriptPath: string;
    /** Project root (session cwd) used to strip machine-specific path prefixes. */
    cwd?: string;
  }): Promise<void>;
}

/**
 * Thin CLI wrapper for the transcript watcher.
 *
 * Parses argv, writes a pid file so the session can be shut down later, and
 * invokes the pluggable watcher function. The actual watcher core is provided
 * by TSK0011.
 */
export async function watch(options: WatchOptions = {}): Promise<CommandResult> {
  const args = parseCliArgs(options.argv ?? process.argv.slice(2));
  const sessionId = args.sessionId;
  const dataDir = options.dataDir ?? args.dataDir ?? '';
  const transcriptPath = args.transcriptPath ?? '';
  const cwd = args.cwd;

  if (!sessionId || !dataDir) {
    return { exitCode: 0 };
  }

  const watcher =
    options.watcher ??
    (() => {
      // Default: wait forever. The real watcher (TSK0011) will be injected.
      return new Promise<void>(() => {});
    });

  await writeWatcherPid(dataDir, sessionId, process.pid);

  const shutdown = async (): Promise<void> => {
    await removeWatcherPid(dataDir, sessionId);
  };

  process.on('SIGTERM', () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.on('SIGINT', () => {
    void shutdown().finally(() => process.exit(0));
  });

  try {
    await watcher({ dataDir, sessionId, transcriptPath, cwd });
    await shutdown();
    return { exitCode: 0 };
  } catch {
    await shutdown();
    return { exitCode: 1 };
  }
}
