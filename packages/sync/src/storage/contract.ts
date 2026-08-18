import type { ArtifactScope } from '../artifact.js';
import type { SyncErrorCode } from '../errors.js';

/**
 * Storage scopes. The first four mirror {@link ArtifactScope}; `manifest` is
 * a synthetic scope used for the per-session manifest object, which lives at
 * `<projectId>/<sessionId>/manifest.json` rather than under a scope folder.
 */
export type StorageObjectScope = ArtifactScope | 'manifest';

/**
 * Input for a storage PUT operation. The `projectId`, `sessionId`, `scope` and
 * `relativePath` are used to derive a deterministic, normalized object key.
 */
export interface PutObjectInput {
  projectId: string;
  sessionId: string;
  scope: StorageObjectScope;
  relativePath: string;
  body: Uint8Array;
  contentType?: string;
  contentSha256?: string;
  metadata?: Record<string, string>;
}

/**
 * Result of a successful PUT. `sha256` is always the hex digest of the body
 * and can be used for content-addressed verification.
 */
export interface PutObjectResult {
  key: string;
  etag?: string;
  versionId?: string;
  sha256: string;
}

/**
 * Input for a storage GET operation.
 */
export interface GetObjectInput {
  projectId: string;
  sessionId: string;
  scope: StorageObjectScope;
  relativePath: string;
}

/**
 * Result of a successful GET.
 */
export interface GetObjectResult {
  body: Uint8Array;
  contentType?: string;
  etag?: string;
  lastModified?: Date;
  metadata?: Record<string, string>;
}

/**
 * Input for a storage HEAD operation.
 */
export interface HeadObjectInput {
  projectId: string;
  sessionId: string;
  scope: StorageObjectScope;
  relativePath: string;
}

/**
 * Result of a successful HEAD.
 */
export interface HeadObjectResult {
  contentLength?: number;
  contentType?: string;
  etag?: string;
  lastModified?: Date;
  metadata?: Record<string, string>;
}

/**
 * Storage-agnostic adapter contract. Implementations must support `putObject`;
 * `getObject` and `headObject` are optional conveniences for callers that need
 * them.
 */
export interface StorageAdapter {
  putObject(input: PutObjectInput): Promise<PutObjectResult>;
  getObject?(input: GetObjectInput): Promise<GetObjectResult | undefined>;
  headObject?(input: HeadObjectInput): Promise<HeadObjectResult | undefined>;
}

/**
 * Retry policy options shared by storage adapters.
 */
export interface StorageAdapterOptions {
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

/**
 * Storage-specific error. The message is always constructed from a safe,
 * catalog description and never from raw SDK exception strings, so it cannot
 * leak credentials or other sensitive values.
 */
export class StorageError extends Error {
  public readonly cause?: unknown;

  constructor(
    public readonly code: SyncErrorCode,
    message: string,
    public readonly retryable: boolean,
    cause?: unknown,
  ) {
    super(message);
    this.name = 'StorageError';
    if (cause !== undefined) {
      (this as { cause?: unknown }).cause = cause;
    }
  }
}
