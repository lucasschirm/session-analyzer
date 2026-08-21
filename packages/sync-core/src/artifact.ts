export type ArtifactScope = 'session' | 'workspace' | 'global' | 'runtime';

export type ArtifactStatus = 'uploaded' | 'failed' | 'skipped' | 'pending';

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
}
