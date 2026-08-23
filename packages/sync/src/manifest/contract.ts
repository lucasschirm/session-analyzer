import type { ManifestArtifact } from '../artifact.js';
import type { SyncRun } from '../sync-run.js';

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
  /** Relative path within the `session` scope of the primary transcript artifact. */
  mainTranscriptRelativePath?: string;
  artifacts: ManifestArtifact[];
  syncRuns: SyncRun[];
}
