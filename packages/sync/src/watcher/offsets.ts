import * as fsp from 'node:fs/promises';
import path from 'node:path';

import { writeFileAtomic } from '../state/state.js';

export interface WatcherFileOffset {
  /** Last byte offset successfully uploaded. */
  offset: number;
  /** Latest file size the watcher has attempted to process (prevents retry storms). */
  lastProcessedSize: number;
}

export interface WatcherOffsets {
  version: number;
  offsets: Record<string, WatcherFileOffset>;
}

const WATCHER_OFFSETS_VERSION = 1;

function safeSessionId(sessionId: string): string {
  if (!sessionId) {
    throw new Error('sessionId is required');
  }
  return encodeURIComponent(sessionId);
}

export function getWatcherStatePath(dataDir: string, sessionId: string): string {
  return path.join(dataDir, 'watcher', `${safeSessionId(sessionId)}.state.json`);
}

export async function readWatcherOffsets(
  statePath: string,
): Promise<Record<string, WatcherFileOffset>> {
  try {
    const raw = await fsp.readFile(statePath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'version' in parsed &&
      typeof (parsed as WatcherOffsets).version === 'number' &&
      'offsets' in parsed &&
      typeof (parsed as WatcherOffsets).offsets === 'object' &&
      (parsed as WatcherOffsets).offsets !== null
    ) {
      return (parsed as WatcherOffsets).offsets;
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return {};
    }
  }
  return {};
}

export async function writeWatcherOffsets(
  statePath: string,
  offsets: Record<string, WatcherFileOffset>,
): Promise<void> {
  await fsp.mkdir(path.dirname(statePath), { recursive: true });
  const content: WatcherOffsets = {
    version: WATCHER_OFFSETS_VERSION,
    offsets,
  };
  await writeFileAtomic(statePath, JSON.stringify(content, null, 2));
}
