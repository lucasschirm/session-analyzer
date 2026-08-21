import * as fsp from 'node:fs/promises';
import path from 'node:path';
import type { SyncRun } from '@lucasschirm/sal-sync-core';
import { writeFileAtomic } from '../state/index.js';

type RunLog = Record<string, SyncRun[]>;

function emptyLog(): RunLog {
  return {};
}

/**
 * Durable append-only log of per-session sync runs.
 *
 * Runs are keyed by sessionId in a single JSON file under the data directory
 * so the manifest can be regenerated and re-uploaded even after a process
 * crash or a failed manifest upload.
 */
export class ManifestRunStore {
  private readonly filePath: string;

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, 'manifest-runs.json');
  }

  async load(sessionId: string): Promise<SyncRun[]> {
    const log = await this.loadAll();
    return log[sessionId] ?? [];
  }

  async append(sessionId: string, run: SyncRun): Promise<void> {
    const log = await this.loadAll();
    const sessionRuns = log[sessionId] ?? [];
    sessionRuns.push(run);
    log[sessionId] = sessionRuns;
    await this.saveAll(log);
  }

  private async loadAll(): Promise<RunLog> {
    try {
      const raw = await fsp.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as RunLog;
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return emptyLog();
      }
      throw new Error(`Failed to read manifest run log: ${(err as Error).message}`);
    }
    return emptyLog();
  }

  private async saveAll(log: RunLog): Promise<void> {
    await writeFileAtomic(this.filePath, JSON.stringify(log, null, 2));
  }
}
