import * as fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

export interface WatcherPidFile {
  pid: number;
  ownerPid?: number;
  startedAt: number;
}

function safeSessionId(sessionId: string): string {
  if (!sessionId) {
    throw new Error('sessionId is required');
  }
  return encodeURIComponent(sessionId);
}

export function getWatcherPidPath(dataDir: string, sessionId: string): string {
  return path.join(dataDir, 'watcher', `${safeSessionId(sessionId)}.pid`);
}

export function isProcessAlive(pid: number): boolean {
  try {
    return process.kill(pid, 0);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export async function readWatcherPidFile(
  dataDir: string,
  sessionId: string,
): Promise<WatcherPidFile | undefined> {
  try {
    const raw = await fsp.readFile(getWatcherPidPath(dataDir, sessionId), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'pid' in parsed &&
      typeof (parsed as { pid: unknown }).pid === 'number'
    ) {
      return {
        pid: (parsed as WatcherPidFile).pid,
        ownerPid: (parsed as WatcherPidFile).ownerPid,
        startedAt: (parsed as WatcherPidFile).startedAt,
      };
    }
  } catch {
    // missing or unreadable pid file
  }
  return undefined;
}

export async function writeWatcherPidFile(
  dataDir: string,
  sessionId: string,
  pid: number,
  ownerPid?: number,
): Promise<void> {
  const pidPath = getWatcherPidPath(dataDir, sessionId);
  await fsp.mkdir(path.dirname(pidPath), { recursive: true });
  const content: WatcherPidFile = {
    pid,
    ...(ownerPid !== undefined ? { ownerPid } : {}),
    startedAt: Date.now(),
  };
  await fsp.writeFile(pidPath, JSON.stringify(content));
}

export async function removeWatcherPidFile(dataDir: string, sessionId: string): Promise<void> {
  try {
    await fsp.unlink(getWatcherPidPath(dataDir, sessionId));
  } catch {
    // best effort
  }
}
