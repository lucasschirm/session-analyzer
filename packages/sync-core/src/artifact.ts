export type ArtifactScope = 'session' | 'workspace' | 'global' | 'runtime';

export type ArtifactStatus = 'uploaded' | 'failed' | 'skipped' | 'pending';

export type ArtifactRole = string;

export type ArtifactCollectionOutcome =
  | 'collected'
  | 'failed'
  | 'skipped'
  | 'pending'
  | 'unsupported';

export interface ArtifactIdentity {
  projectId: string;
  sessionId: string;
  scope: ArtifactScope;
  relativePath: string;
  sha256: string;
}

export interface ManifestArtifact extends ArtifactIdentity {
  size: number;
  status: ArtifactStatus;
  role?: ArtifactRole;
  mediaType?: string;
  encoding?: string;
  collectionOutcome?: ArtifactCollectionOutcome;
  collectionReason?: string;
}
