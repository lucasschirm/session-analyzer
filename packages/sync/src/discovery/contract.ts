import type { ArtifactScope, SyncErrorCode, SyncLimits } from '@lucasschirm/sal-sync-core';

export interface DiscoveryArtifact {
  projectId: string;
  sessionId: string;
  scope: ArtifactScope;
  relativePath: string;
  sha256: string;
  size: number;
  absolutePath: string;
}

export interface DiscoveryError {
  code: SyncErrorCode;
  path?: string;
  message: string;
}

export interface DiscoveryResult {
  artifacts: DiscoveryArtifact[];
  errors: DiscoveryError[];
  totalBytes: number;
  filesDiscovered: number;
}

export interface DiscoveryOptions {
  projectId: string;
  sessionId: string;
  limits?: SyncLimits;
}

export interface WorkspaceDiscoveryInput extends DiscoveryOptions {
  workspaceRoot: string;
}

export interface GlobalDiscoveryInput extends DiscoveryOptions {
  claudeConfigDir?: string;
  homeDir?: string;
}

export interface SessionDiscoveryInput extends DiscoveryOptions {
  transcriptPath?: string;
  captureTranscripts?: boolean;
}

export interface DiscoveryInput
  extends WorkspaceDiscoveryInput,
    GlobalDiscoveryInput,
    SessionDiscoveryInput {}
