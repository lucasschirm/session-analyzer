import type { ManifestArtifact } from '../artifact.js';
import type { SyncRun } from '../sync-run.js';
import type { MANIFEST_SCHEMA_VERSION, MANIFEST_SCHEMA_VERSION_LATEST } from '../versions.js';

export type ManifestSchemaVersion =
  | typeof MANIFEST_SCHEMA_VERSION
  | typeof MANIFEST_SCHEMA_VERSION_LATEST;

export type ManifestFinality = 'final' | 'partial' | 'superseded';

export type DiscoveryCompleteness = 'complete' | 'partial' | 'unsupported' | 'unknown';

export interface CategoryCoverageDetail {
  discoveryCompleteness: DiscoveryCompleteness;
  reasons?: readonly string[];
}

export interface SourceTombstone {
  sourceType: string;
  sourceId: string;
  deletedAt: string;
  reason?: string;
}

export interface SyncManifest {
  schemaVersion: ManifestSchemaVersion;
  projectId: string;
  sessionId: string;
  harness: string;
  harnessVersion: string;
  sourceEnvironmentNamespace?: string;
  environmentId?: string;
  finality?: ManifestFinality;
  occurrenceTime?: string;
  ingestionTime?: string;
  captureTime?: string;
  sequenceNumber?: number;
  workspaceId?: string;
  repositoryId?: string;
  scopeChain?: readonly string[];
  collectorVersion?: string;
  sanitizationPolicyVersion?: string;
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
  expectedCategoryCoverage?: readonly string[];
  categoryCoverage?: Record<string, CategoryCoverageDetail>;
  sourceTombstones?: SourceTombstone[];
  artifacts: ManifestArtifact[];
  syncRuns: SyncRun[];
}
