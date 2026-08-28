import type { SyncManifest } from '@lucasschirm/sal-sync-core';
import type { Artifact, SourceIdentity } from '@lucasschirm/sal-transformer';
import type { ArtifactContent, ResolvedArtifact } from './ports.js';

export type ManifestInput = SyncManifest;

export type { Artifact };

export interface VerifiedManifestBundle {
  readonly manifest: SyncManifest;
  readonly source: SourceIdentity;
  readonly resolvedArtifacts: readonly ResolvedArtifact[];
  readonly integrityVerified: boolean;
}

export interface ManualIngestionBundle {
  readonly artifacts: readonly Artifact<ArtifactContent>[];
  readonly source: SourceIdentity;
  readonly harness: string;
  readonly harnessVersion?: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly workspaceId?: string;
  readonly repositoryId?: string;
}
