import type { SyncErrorCode } from './errors.js';

/**
 * On-disk representation of a project metadata manifest.
 *
 * Invariant: `projectId` matches the project's directory/object-key prefix.
 */
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

function assertProjectManifestRecord(json: unknown): Record<string, unknown> {
  if (typeof json !== 'object' || json === null) {
    throw new ProjectManifestError('SYNC_JSON_PARSE_FAILED', 'Project manifest must be an object');
  }
  return json as Record<string, unknown>;
}

function assertProjectManifestSchema(record: Record<string, unknown>): void {
  if (record.schemaVersion !== 1) {
    throw new ProjectManifestError(
      'MANIFEST_UNSUPPORTED_SCHEMA',
      'Project manifest schemaVersion must be 1',
    );
  }
}

function assertProjectString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new ProjectManifestError(
      'SYNC_JSON_PARSE_FAILED',
      `Project manifest ${field} is required and must be a string`,
    );
  }
  return value;
}

function assertProjectDescription(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new ProjectManifestError(
      'SYNC_JSON_PARSE_FAILED',
      'Project manifest description must be a string when present',
    );
  }
  return value;
}

/**
 * Parse a raw JSON-decoded object into a {@link ProjectManifest}.
 *
 * Invariant: `schemaVersion` is normalized to 1 and every required string field is non-empty.
 */
export function parseProjectManifest(json: unknown): ProjectManifest {
  const record = assertProjectManifestRecord(json);
  assertProjectManifestSchema(record);
  return {
    ...record,
    schemaVersion: 1,
    projectId: assertProjectString(record.projectId, 'projectId'),
    name: assertProjectString(record.name, 'name'),
    description: assertProjectDescription(record.description),
    createdAt: assertProjectString(record.createdAt, 'createdAt'),
    writtenBy: assertProjectString(record.writtenBy, 'writtenBy'),
  } as ProjectManifest;
}

/**
 * Build a fresh {@link ProjectManifest} from project metadata.
 *
 * Invariant: the generated `createdAt` is an ISO-8601 timestamp.
 */
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
