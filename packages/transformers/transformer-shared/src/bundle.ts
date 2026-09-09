export type ArtifactScope = 'session' | 'workspace' | 'global' | 'runtime';

export type ArtifactStatus = 'uploaded' | 'failed' | 'skipped' | 'pending';

export interface SourceIdentity {
  readonly sourceId: string;
  readonly environmentId?: string;
  readonly projectId?: string;
  readonly sessionId?: string;
}

export interface Artifact<TContent = unknown> {
  readonly relativePath: string;
  readonly mediaType: string;
  readonly content: TContent;
  readonly sha256?: string;
  readonly size?: number;
  readonly status?: ArtifactStatus;
}

export interface ArtifactBundle<TContent = unknown> {
  readonly artifacts: readonly Artifact<TContent>[];
  readonly sourceIdentity?: SourceIdentity;
  readonly sourceFingerprint?: string;
}

export type UnknownArtifactBundle = ArtifactBundle<unknown>;
