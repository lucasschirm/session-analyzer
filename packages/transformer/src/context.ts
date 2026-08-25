export interface TransformContext {
  readonly analysisReleaseId: string;
  readonly parserId: string;
  readonly parserVersion: string;
  readonly sourceManifestId?: string;
  readonly sourceEnvironmentId?: string;
  readonly sourceProjectId?: string;
  readonly sourceSessionId?: string;
  readonly sourceFingerprint: string;
}
