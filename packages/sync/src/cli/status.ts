import * as fsp from 'node:fs/promises';
import process from 'node:process';

import type { ArtifactStatus } from '@lucasschirm/sal-sync-core';
import { discover } from '../discovery/index.js';
import {
  type ArtifactStateStatus,
  getArtifactRecord,
  isArtifactPending,
  StateStore,
} from '../state/index.js';
import {
  buildCandidates,
  type CommandResult,
  getDataDir,
  getSessionSyncLockPath,
  isProcessAlive,
  parseCliArgs,
  readWatcherPid,
  resolveConfig,
  type StatusArtifact,
  type StatusReport,
  type SyncErrorCode,
} from './common.js';

function mapStateStatus(stateStatus: ArtifactStateStatus): ArtifactStatus {
  if (stateStatus === 'uploaded' || stateStatus === 'failed') {
    return stateStatus;
  }
  return 'pending';
}

async function getLockPid(dataDir: string, sessionId: string): Promise<number | undefined> {
  try {
    const raw = await fsp.readFile(getSessionSyncLockPath(dataDir, sessionId), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && 'pid' in parsed) {
      return (parsed as { pid: number }).pid;
    }
  } catch {
    // no lock or unreadable
  }
  return undefined;
}

function appendWatcherCrashError(report: StatusReport, sessionId?: string): void {
  if (!sessionId || report.watcherAlive || report.pendingFiles === 0) {
    return;
  }
  const code: SyncErrorCode = 'SYNC_WATCHER_ERROR';
  if (!report.lastErrors.includes(code)) {
    report.lastErrors.push(code);
  }
}

/**
 * Report per-artifact upload state, pending delta size, last errors, and
 * watcher alive status.
 */
export async function status(
  options: { argv?: string[]; env?: Record<string, string | undefined>; dataDir?: string } = {},
): Promise<CommandResult> {
  const args = parseCliArgs(options.argv ?? process.argv.slice(2));
  const dataDir = options.dataDir ?? args.dataDir ?? getDataDir(options.env);
  const sessionId = args.sessionId;

  const resolved = await resolveConfig({
    env: options.env,
    dataDir,
  });

  const stateStore = new StateStore(dataDir);
  const state = await stateStore.readState();
  const session = sessionId ? await stateStore.getSession(sessionId) : undefined;

  const report: StatusReport = {
    sessionId,
    projectId: session?.projectId,
    watcherAlive: false,
    syncRunning: false,
    artifacts: [],
    pendingFiles: 0,
    pendingBytes: 0,
    lastErrors: state.errors ?? [],
  };

  if (sessionId) {
    const pid = await readWatcherPid(dataDir, sessionId);
    if (pid !== undefined && isProcessAlive(pid)) {
      report.watcherAlive = true;
    }
    const syncPid = await getLockPid(dataDir, sessionId);
    if (syncPid !== undefined && isProcessAlive(syncPid)) {
      report.syncRunning = true;
    }
  }

  // Collect state records for the session.
  if (sessionId) {
    for (const record of Object.values(state.artifacts)) {
      if (record.sessionId !== sessionId) {
        continue;
      }
      if (record.lastError && !report.lastErrors.includes(record.lastError)) {
        report.lastErrors.push(record.lastError);
      }
      const artifact: StatusArtifact = {
        scope: record.scope,
        relativePath: record.relativePath,
        sha256: record.lastDiscoveredHash,
        status: mapStateStatus(record.status),
        lastError: record.lastError,
        lastUploadedAt: record.lastUploadedAt,
      };
      report.artifacts.push(artifact);
    }
  }

  // Try to compute pending delta size by re-discovering current files.
  if (sessionId && resolved.config && args.cwd) {
    try {
      const discovery = await discover({
        projectId: resolved.config.projectId,
        sessionId,
        workspaceRoot: args.cwd,
        transcriptPath: args.transcriptPath,
        captureTranscripts: resolved.config.captureTranscripts,
        limits: resolved.config.limits,
      });
      const candidateResults = await buildCandidates(discovery, resolved.config, {
        projectRoot: args.cwd,
      });
      for (const result of candidateResults) {
        const record = getArtifactRecord(state, {
          projectId: resolved.config.projectId,
          sessionId,
          scope: result.candidate.scope,
          relativePath: result.candidate.relativePath,
          sha256: result.sha256,
        });
        const pending = isArtifactPending(record, result.sha256);
        if (pending) {
          report.pendingFiles += 1;
          report.pendingBytes += result.size;
        }
        const resolvedStatus: ArtifactStatus = record
          ? record.lastUploadedHash === result.sha256 && record.status === 'uploaded'
            ? 'uploaded'
            : record.status === 'failed'
              ? 'failed'
              : 'pending'
          : 'pending';
        const artifact: StatusArtifact = {
          scope: result.candidate.scope,
          relativePath: result.candidate.relativePath,
          sha256: result.sha256,
          size: result.size,
          status: resolvedStatus,
          lastError: record?.lastError,
          lastUploadedAt: record?.lastUploadedAt,
        };
        const existingIndex = report.artifacts.findIndex(
          (a) => a.scope === artifact.scope && a.relativePath === artifact.relativePath,
        );
        if (existingIndex >= 0) {
          report.artifacts[existingIndex] = artifact;
        } else {
          report.artifacts.push(artifact);
        }
      }

      appendWatcherCrashError(report, sessionId);
    } catch {
      // Best effort: status still reports durable state.
    }
  }

  const exitCode = report.lastErrors.length > 0 ? 1 : 0;
  return { exitCode, status: report };
}
