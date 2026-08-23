import type { ManifestArtifact } from '../artifact.js';
import type { SyncRun } from '../sync-run.js';
import type { MANIFEST_SCHEMA_VERSION } from '../versions.js';

export interface SyncManifest {
  schemaVersion: typeof MANIFEST_SCHEMA_VERSION;
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
  /** Relative path within the `session` scope of the primary transcript artifact. */
  mainTranscriptRelativePath?: string;
  artifacts: ManifestArtifact[];
  syncRuns: SyncRun[];
}
