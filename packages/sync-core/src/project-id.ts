import { SYNC_ERROR_CATALOG, type SyncErrorCode } from './errors.js';
import { CAS_NAMESPACE_ROOT } from './storage/object-key.js';

const VALID_PROJECT_ID = /^[a-z0-9-]+$/;

class ProjectIdError extends Error {
  constructor(
    public readonly code: SyncErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ProjectIdError';
  }
}

export function validateProjectId(id: string): void {
  if (!VALID_PROJECT_ID.test(id)) {
    throw new ProjectIdError(
      'SYNC_CONFIG_MISSING',
      `${SYNC_ERROR_CATALOG.SYNC_CONFIG_MISSING.description} (projectId must match ${VALID_PROJECT_ID.source})`,
    );
  }
  if (id === CAS_NAMESPACE_ROOT) {
    throw new ProjectIdError(
      'SYNC_CONFIG_MISSING',
      `${SYNC_ERROR_CATALOG.SYNC_CONFIG_MISSING.description} (projectId must not be the reserved CAS namespace '${CAS_NAMESPACE_ROOT}')`,
    );
  }
}
