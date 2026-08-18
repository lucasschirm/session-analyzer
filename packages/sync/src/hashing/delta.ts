import { Buffer } from 'node:buffer';

import type {
  ArtifactIdentity,
  ArtifactScope,
  ArtifactStatus,
  ManifestArtifact,
} from '../artifact.js';
import { SYNC_ERROR_CATALOG, type SyncErrorCode } from '../errors.js';
import type { SyncManifest } from '../manifest/index.js';
import type { SessionData } from '../session.js';
import {
  getArtifactRecord,
  isArtifactPending,
  recordArtifactFailure,
  recordArtifactHashed,
  recordArtifactUploaded,
  recordArtifactUploading,
  type SyncState,
} from '../state/index.js';
import type { SyncRun, SyncTrigger } from '../sync-run.js';
import { DEFAULT_PLUGIN_VERSION, MANIFEST_SCHEMA_VERSION, SYNC_VERSION } from '../versions.js';
import { type ArtifactSanitizer, selectSanitizer } from './sanitize.js';
import { sha256Hex } from './sha256.js';

export type { ArtifactSanitizer };

export interface ArtifactCandidate {
  projectId: string;
  sessionId: string;
  scope: ArtifactScope;
  relativePath: string;
  content: string;
  sanitizer?: ArtifactSanitizer;
}

export interface HashResult {
  artifact: ArtifactIdentity;
  sanitized: string;
  size: number;
}

export type ArtifactUploader = (artifact: ArtifactIdentity, content: string) => Promise<void>;

export type TriggerScope = 'bulk' | 'watcher-delta' | 'hash-filtered' | 'session-end-final';

export function getTriggerScope(trigger: SyncTrigger): TriggerScope {
  switch (trigger) {
    case 'session-start':
      return 'bulk';
    case 'file-changed':
      return 'watcher-delta';
    case 'session-end':
      return 'session-end-final';
    default:
      return 'hash-filtered';
  }
}

export interface ProcessDeltaOptions {
  state: SyncState;
  trigger: SyncTrigger;
  candidates: ArtifactCandidate[];
  uploader: ArtifactUploader;
  targetRelativePath?: string;
  session?: SessionData;
  pluginVersion?: string;
  transcriptsCaptured?: boolean;
}

export interface DeltaEngineResult extends SyncRun {
  errors: SyncErrorCode[];
  filesUnchanged: number;
  manifest?: SyncManifest;
  uploaded: ArtifactIdentity[];
  skipped: ArtifactIdentity[];
  failed: ArtifactIdentity[];
}

function resolveErrorCode(err: unknown): SyncErrorCode {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code: unknown }).code;
    if (typeof code === 'string' && code in SYNC_ERROR_CATALOG) {
      return code as SyncErrorCode;
    }
  }
  return 'SYNC_STORAGE_ERROR';
}

export function hashCandidate(candidate: ArtifactCandidate): HashResult {
  const sanitizer = candidate.sanitizer ?? selectSanitizer(candidate.relativePath, candidate.scope);
  const sanitized = sanitizer(candidate.content);
  const sha256 = sha256Hex(sanitized);
  const artifact: ArtifactIdentity = {
    projectId: candidate.projectId,
    sessionId: candidate.sessionId,
    scope: candidate.scope,
    relativePath: candidate.relativePath,
    sha256,
  };
  return {
    artifact,
    sanitized,
    size: Buffer.byteLength(sanitized, 'utf8'),
  };
}

function buildSyncRun(result: DeltaEngineResult): SyncRun {
  return {
    trigger: result.trigger,
    filesDiscovered: result.filesDiscovered,
    filesChanged: result.filesChanged,
    filesUploaded: result.filesUploaded,
    filesFailed: result.filesFailed,
    filesSkipped: result.filesSkipped,
    bytesDiscovered: result.bytesDiscovered,
    bytesChanged: result.bytesChanged,
    bytesUploaded: result.bytesUploaded,
    errors: result.errors,
    discoveryDurationMs: result.discoveryDurationMs,
    sanitizationDurationMs: result.sanitizationDurationMs,
    hashDurationMs: result.hashDurationMs,
    uploadDurationMs: result.uploadDurationMs,
    totalDurationMs: result.totalDurationMs,
  };
}

function buildManifestArtifacts(hashed: HashResult[], state: SyncState): ManifestArtifact[] {
  return hashed.map((item) => {
    const record = getArtifactRecord(state, item.artifact);
    let status: ArtifactStatus = 'pending';
    if (record) {
      if (record.lastUploadedHash === item.artifact.sha256 && record.status === 'uploaded') {
        status = 'uploaded';
      } else if (record.status === 'failed') {
        status = 'failed';
      } else if (!isArtifactPending(record, item.artifact.sha256)) {
        status = 'skipped';
      }
    }
    return { ...item.artifact, size: item.size, status };
  });
}

export function buildSessionManifest(
  session: SessionData,
  run: SyncRun,
  artifacts: ManifestArtifact[],
  options?: { pluginVersion?: string; transcriptsCaptured?: boolean },
): SyncManifest {
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    projectId: session.projectId,
    sessionId: session.sessionId,
    harness: session.harness,
    harnessVersion: session.harnessVersion,
    model: session.model,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    durationMs: session.durationMs,
    endReason: session.endReason,
    syncVersion: SYNC_VERSION,
    pluginVersion: options?.pluginVersion ?? DEFAULT_PLUGIN_VERSION,
    transcriptsCaptured: options?.transcriptsCaptured ?? true,
    artifacts,
    syncRuns: [run],
  };
}

export async function processDelta(options: ProcessDeltaOptions): Promise<DeltaEngineResult> {
  const start = Date.now();
  const {
    state,
    trigger,
    candidates,
    uploader,
    targetRelativePath,
    session,
    pluginVersion,
    transcriptsCaptured,
  } = options;
  const scope = getTriggerScope(trigger);

  const discovered =
    scope === 'watcher-delta' && targetRelativePath
      ? candidates.filter((candidate) => candidate.relativePath === targetRelativePath)
      : candidates;

  const result: DeltaEngineResult = {
    trigger,
    filesDiscovered: 0,
    filesChanged: 0,
    filesUploaded: 0,
    filesFailed: 0,
    filesSkipped: 0,
    filesUnchanged: 0,
    bytesDiscovered: 0,
    bytesChanged: 0,
    bytesUploaded: 0,
    discoveryDurationMs: 0,
    sanitizationDurationMs: 0,
    hashDurationMs: 0,
    uploadDurationMs: 0,
    totalDurationMs: 0,
    errors: [],
    uploaded: [],
    skipped: [],
    failed: [],
  };

  const hashed: HashResult[] = [];
  for (const candidate of discovered) {
    const item = hashCandidate(candidate);
    result.filesDiscovered += 1;
    result.bytesDiscovered += item.size;
    recordArtifactHashed(state, item.artifact);
    hashed.push(item);
  }

  const changed: HashResult[] = [];
  for (const item of hashed) {
    const record = getArtifactRecord(state, item.artifact);
    const pending = isArtifactPending(record, item.artifact.sha256);
    if (pending) {
      result.filesChanged += 1;
      result.bytesChanged += item.size;
      changed.push(item);
    } else {
      result.filesSkipped += 1;
      result.filesUnchanged += 1;
      result.skipped.push(item.artifact);
    }
  }

  for (const item of changed) {
    recordArtifactUploading(state, item.artifact);
    const uploadStart = Date.now();
    try {
      await uploader(item.artifact, item.sanitized);
      recordArtifactUploaded(state, item.artifact);
      result.uploadDurationMs += Date.now() - uploadStart;
      result.filesUploaded += 1;
      result.bytesUploaded += item.size;
      result.uploaded.push(item.artifact);
    } catch (err) {
      result.uploadDurationMs += Date.now() - uploadStart;
      const code = resolveErrorCode(err);
      recordArtifactFailure(state, item.artifact, code);
      result.filesFailed += 1;
      result.failed.push(item.artifact);
      if (!result.errors.includes(code)) {
        result.errors.push(code);
      }
    }
  }

  if (scope === 'session-end-final' && session) {
    const run = buildSyncRun(result);
    const manifestArtifacts = buildManifestArtifacts(hashed, state);
    const manifest = buildSessionManifest(session, run, manifestArtifacts, {
      pluginVersion,
      transcriptsCaptured,
    });
    const manifestJson = JSON.stringify(manifest);
    const manifestSize = Buffer.byteLength(manifestJson, 'utf8');
    const manifestHash = sha256Hex(manifestJson);
    const manifestArtifact: ArtifactIdentity = {
      projectId: session.projectId,
      sessionId: session.sessionId,
      scope: 'runtime',
      relativePath: 'manifest.json',
      sha256: manifestHash,
    };
    recordArtifactHashed(state, manifestArtifact);
    const uploadStart = Date.now();
    try {
      await uploader(manifestArtifact, manifestJson);
      recordArtifactUploaded(state, manifestArtifact);
      result.uploadDurationMs += Date.now() - uploadStart;
      result.filesUploaded += 1;
      result.bytesUploaded += manifestSize;
      result.uploaded.push(manifestArtifact);
    } catch (err) {
      result.uploadDurationMs += Date.now() - uploadStart;
      const code = resolveErrorCode(err);
      recordArtifactFailure(state, manifestArtifact, code);
      result.filesFailed += 1;
      result.failed.push(manifestArtifact);
      if (!result.errors.includes(code)) {
        result.errors.push(code);
      }
    }
    result.manifest = manifest;
  }

  result.totalDurationMs = Date.now() - start;
  return result;
}
