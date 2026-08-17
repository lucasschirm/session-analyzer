import type { ManifestArtifact } from '../artifact.js';
import type { SyncRun } from '../sync-run.js';
import { MANIFEST_SCHEMA_VERSION, SYNC_VERSION } from '../versions.js';

export interface SyncManifest {
  schemaVersion: number;
  projectId: string;
  sessionId: string;
  harness: string;
  harnessVersion: string;
  model?: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  endReason?: string;
  syncVersion: string;
  pluginVersion: string;
  transcriptsCaptured: boolean;
  artifacts: ManifestArtifact[];
  syncRuns: SyncRun[];
}
