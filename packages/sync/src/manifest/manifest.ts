import { Buffer } from 'node:buffer';
import type {
  ArtifactIdentity,
  ManifestArtifact,
  SessionData,
  SyncManifest,
  SyncRun,
} from '@lucasschirm/sal-sync-core';
import {
  DEFAULT_PLUGIN_VERSION,
  type StorageAdapter,
  StorageError,
  SYNC_ERROR_CATALOG,
  type SyncErrorCode,
} from '@lucasschirm/sal-sync-core';
import { sha256Hex } from '../hashing/sha256.js';
import {
  recordArtifactFailure,
  recordArtifactHashed,
  recordArtifactUploaded,
  recordArtifactUploading,
  StateStore,
} from '../state/index.js';
import { buildManifest } from './generator.js';
import { ManifestRunStore } from './runs.js';

export interface ManifestUploadResult {
  key: string;
  sha256: string;
  size: number;
}

export interface ManifestGeneratorOptions {
  pluginVersion?: string;
  storageAdapter?: StorageAdapter;
}

function resolveErrorCode(err: unknown): SyncErrorCode {
  if (err instanceof StorageError) {
    return err.code;
  }
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code: unknown }).code;
    if (typeof code === 'string' && code in SYNC_ERROR_CATALOG) {
      return code as SyncErrorCode;
    }
  }
  return 'SYNC_STORAGE_ERROR';
}

/**
 * Durable, session-aware manifest generator and uploader.
 *
 * The generator reads artifact state from the shared StateStore and per-trigger
 * sync-run telemetry from a durable run log. It can regenerate and re-upload a
 * manifest at any point during or after a session without relying on transient
 * in-memory counters.
 */
export class ManifestGenerator {
  private readonly stateStore: StateStore;
  private readonly runStore: ManifestRunStore;
  private readonly storageAdapter?: StorageAdapter;
  private readonly pluginVersion: string;

  constructor(dataDir: string, options?: ManifestGeneratorOptions) {
    this.stateStore = new StateStore(dataDir);
    this.runStore = new ManifestRunStore(dataDir);
    this.storageAdapter = options?.storageAdapter;
    this.pluginVersion = options?.pluginVersion ?? DEFAULT_PLUGIN_VERSION;
  }

  async recordRun(sessionId: string, run: SyncRun): Promise<void> {
    await this.runStore.append(sessionId, run);
  }

  async generate(
    session: SessionData,
    candidates: ManifestArtifact[],
    options?: { captureTranscripts?: boolean; pluginVersion?: string },
  ): Promise<SyncManifest> {
    const state = await this.stateStore.readState();
    const runs = await this.runStore.load(session.sessionId);
    return buildManifest(session, candidates, state, runs, {
      captureTranscripts: options?.captureTranscripts,
      pluginVersion: options?.pluginVersion ?? this.pluginVersion,
    });
  }

  async upload(manifest: SyncManifest): Promise<ManifestUploadResult> {
    const adapter = this.storageAdapter;
    if (!adapter) {
      throw new StorageError(
        'SYNC_CONFIG_MISSING',
        `${SYNC_ERROR_CATALOG.SYNC_CONFIG_MISSING.description} (storage adapter is required)`,
        false,
      );
    }

    const manifestJson = JSON.stringify(manifest);
    const manifestBytes = Buffer.from(manifestJson, 'utf8');
    const manifestHash = sha256Hex(manifestJson);
    const manifestArtifact: ArtifactIdentity = {
      projectId: manifest.projectId,
      sessionId: manifest.sessionId,
      scope: 'runtime',
      relativePath: 'manifest.json',
      sha256: manifestHash,
    };

    const result = await this.stateStore.withState(async (state) => {
      recordArtifactHashed(state, manifestArtifact);
      recordArtifactUploading(state, manifestArtifact);

      try {
        const putResult = await adapter.putObject({
          projectId: manifest.projectId,
          sessionId: manifest.sessionId,
          scope: 'manifest',
          relativePath: 'manifest.json',
          body: manifestBytes,
          contentType: 'application/json',
          contentSha256: manifestHash,
        });
        recordArtifactUploaded(state, manifestArtifact, manifestHash);
        return { ok: true as const, putResult };
      } catch (err) {
        const code = resolveErrorCode(err);
        recordArtifactFailure(state, manifestArtifact, code);
        return { ok: false as const, err };
      }
    });

    if (!result.ok) {
      throw result.err;
    }

    return {
      key: result.putResult.key,
      sha256: manifestHash,
      size: manifestBytes.length,
    };
  }
}
