import type { ArtifactStatus, ManifestArtifact } from '../artifact.js';
import type { SessionData } from '../session.js';
import {
  type ArtifactStateRecord,
  getArtifactRecord,
  isArtifactPending,
  type SyncState,
} from '../state/index.js';
import type { SyncRun } from '../sync-run.js';
import {
  DEFAULT_PLUGIN_VERSION,
  MANIFEST_SCHEMA_VERSION,
  SYNC_VERSION,
  UNKNOWN_HARNESS_VERSION,
} from '../versions.js';
import type { SyncManifest } from './contract.js';

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
    result.push({ ...artifact, status });
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
  // The main transcript is always the first session-scoped artifact discovered
  // (discoverSession adds the exact transcriptPath before any subagents).
  const mainTranscript = artifacts.find((a) => a.scope === 'session');

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
    artifacts,
    syncRuns: [...runs],
  };
}
