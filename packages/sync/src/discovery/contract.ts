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
  /**
   * Explicit override for the harness's global config directory. When
   * omitted, it is resolved from the injected `HarnessProfile.configDir(env)`.
   */
  configDir?: string;
  homeDir?: string;
  /** Env record passed to `HarnessProfile.configDir` when `configDir` is not set explicitly. */
  env?: Record<string, string | undefined>;
}

export interface SessionDiscoveryInput extends DiscoveryOptions {
  transcriptPath?: string;
  captureTranscripts?: boolean;
}

export interface DiscoveryInput
  extends WorkspaceDiscoveryInput,
    GlobalDiscoveryInput,
    SessionDiscoveryInput {}
