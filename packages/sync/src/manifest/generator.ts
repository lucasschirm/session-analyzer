import type {
  ArtifactStatus,
  ManifestArtifact,
  SessionData,
  SyncManifest,
  SyncRun,
} from '@lucasschirm/sal-sync-core';
import {
  DEFAULT_PLUGIN_VERSION,
  MANIFEST_SCHEMA_VERSION,
  SYNC_VERSION,
  UNKNOWN_HARNESS_VERSION,
} from '@lucasschirm/sal-sync-core';
import {
  type ArtifactStateRecord,
  getArtifactRecord,
  isArtifactPending,
  type SyncState,
} from '../state/index.js';

export interface BuildManifestOptions {
  captureTranscripts?: boolean;
  pluginVersion?: string;
}

function resolveArtifactStatus(
  record: ArtifactStateRecord | undefined,
  currentHash: string,
): ArtifactStatus {
  if (record) {
    if (record.lastUploadedHash === currentHash && record.status === 'uploaded') {
      return 'uploaded';
    }
    if (record.status === 'failed') {
      return 'failed';
    }
    if (!isArtifactPending(record, currentHash)) {
      return 'skipped';
    }
  }
  return 'pending';
}

/**
 * Resolve the durable status for a list of candidate artifacts against SyncState.
 *
 * The candidate artifacts carry the current sha256 and size; their status is
 * overwritten from durable state so the manifest reflects the true upload state
 * rather than the transient in-memory counters of a single sync run.
 */
export function buildManifestArtifacts(
  candidates: ManifestArtifact[],
  state: SyncState,
  options?: BuildManifestOptions,
): ManifestArtifact[] {
  const captureTranscripts = options?.captureTranscripts ?? true;
  const result: ManifestArtifact[] = [];

  for (const artifact of candidates) {
    if (!captureTranscripts && artifact.scope === 'session') {
      continue;
    }
    const record = getArtifactRecord(state, artifact);
    const status = resolveArtifactStatus(record, artifact.sha256);
    result.push({
      ...artifact,
      status,
      syncError: status === 'failed' ? record?.lastErrorMessage : undefined,
    });
  }

  return result;
}

/**
 * Build a SyncManifest from durable state and per-trigger run telemetry.
 *
 * The manifest schema is assembled from the session metadata, the resolved
 * artifact list, and the accumulated sync runs. All version fields are
 * independently observable and come from the versioned constants.
 */
export function buildManifest(
  session: SessionData,
  candidates: ManifestArtifact[],
  state: SyncState,
  runs: SyncRun[],
  options?: BuildManifestOptions,
): SyncManifest {
  const artifacts = buildManifestArtifacts(candidates, state, options);
  // The main transcript is stored at the session root (the session layout's
  // mainTranscriptStorageName — 'transcript.jsonl' for both Claude and
  // Devin), while every other session-scoped artifact lives under a
  // subdirectory (subagents/, plans/, native/). When the main transcript is
  // absent from the artifact list (e.g. skipped by a discovery limit), the
  // manifest reports no main transcript rather than mislabeling a subagent
  // transcript as the main one.
  const sessionArtifacts = artifacts.filter((a) => a.scope === 'session');
  const mainTranscript = sessionArtifacts.find((a) => !a.relativePath.includes('/'));

  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    projectId: session.projectId,
    sessionId: session.sessionId,
    harness: session.harness,
    harnessVersion: session.harnessVersion.trim() || UNKNOWN_HARNESS_VERSION,
    model: session.model,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    durationMs: session.durationMs,
    endReason: session.endReason,
    syncVersion: SYNC_VERSION,
    pluginVersion: options?.pluginVersion ?? DEFAULT_PLUGIN_VERSION,
    transcriptsCaptured: options?.captureTranscripts ?? true,
    mainTranscriptRelativePath: mainTranscript?.relativePath,
    mainTranscriptError: mainTranscript?.syncError,
    artifacts,
    syncRunsCount: runs.length,
    updatedAt: new Date().toISOString(),
  };
}
