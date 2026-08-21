import type { ArtifactIdentity } from '@lucasschirm/sal-sync-core';

export function buildS3ObjectKey(
  artifact: Pick<ArtifactIdentity, 'projectId' | 'sessionId' | 'scope' | 'relativePath'>,
): string {
  return `${artifact.projectId}/${artifact.sessionId}/${artifact.scope}/${artifact.relativePath}`;
}
