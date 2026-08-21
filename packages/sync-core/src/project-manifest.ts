import type { SyncErrorCode } from './errors.js';

export interface ProjectManifest {
  schemaVersion: 1;
  projectId: string;
  name: string;
  description?: string;
  createdAt: string;
  writtenBy: string;
}

class ProjectManifestError extends Error {
  constructor(
    public readonly code: SyncErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ProjectManifestError';
  }
}

export function parseProjectManifest(json: unknown): ProjectManifest {
  if (typeof json !== 'object' || json === null) {
    throw new ProjectManifestError('SYNC_JSON_PARSE_FAILED', 'Project manifest must be an object');
  }

  const record = json as Record<string, unknown>;

  if (record.schemaVersion !== 1) {
    throw new ProjectManifestError(
      'MANIFEST_UNSUPPORTED_SCHEMA',
      'Project manifest schemaVersion must be 1',
    );
  }

  if (typeof record.projectId !== 'string' || record.projectId === '') {
    throw new ProjectManifestError(
      'SYNC_JSON_PARSE_FAILED',
      'Project manifest projectId is required and must be a string',
    );
  }

  if (typeof record.name !== 'string' || record.name === '') {
    throw new ProjectManifestError(
      'SYNC_JSON_PARSE_FAILED',
      'Project manifest name is required and must be a string',
    );
  }

  if (record.description !== undefined && typeof record.description !== 'string') {
    throw new ProjectManifestError(
      'SYNC_JSON_PARSE_FAILED',
      'Project manifest description must be a string when present',
    );
  }

  if (typeof record.createdAt !== 'string' || record.createdAt === '') {
    throw new ProjectManifestError(
      'SYNC_JSON_PARSE_FAILED',
      'Project manifest createdAt is required and must be a string',
    );
  }

  if (typeof record.writtenBy !== 'string' || record.writtenBy === '') {
    throw new ProjectManifestError(
      'SYNC_JSON_PARSE_FAILED',
      'Project manifest writtenBy is required and must be a string',
    );
  }

  return {
    ...record,
    schemaVersion: 1,
    projectId: record.projectId as string,
    name: record.name as string,
    description: record.description,
    createdAt: record.createdAt as string,
    writtenBy: record.writtenBy as string,
  } as ProjectManifest;
}

export function buildProjectManifest(
  input: {
    projectId: string;
    name: string;
    description?: string;
    writtenBy: string;
  },
  now?: () => string,
): ProjectManifest {
  return {
    schemaVersion: 1,
    projectId: input.projectId,
    name: input.name,
    description: input.description,
    createdAt: now ? now() : new Date().toISOString(),
    writtenBy: input.writtenBy,
  };
}
