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
 * Input for a storage GET operation. The `contentSha256` field is required for
 * content-addressed `workspace` and `global` objects so the CAS key can be
 * derived.
 */
export interface GetObjectInput {
  projectId: string;
  sessionId: string;
  scope: StorageObjectScope;
  relativePath: string;
  contentSha256?: string;
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
 * Input for a storage HEAD operation. The `contentSha256` field is required for
 * content-addressed `workspace` and `global` objects so the CAS key can be
 * derived.
 */
export interface HeadObjectInput {
  projectId: string;
  sessionId: string;
  scope: StorageObjectScope;
  relativePath: string;
  contentSha256?: string;
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
 * Input for a storage LIST operation. When `projectId` is omitted, all objects
 * in the bucket are listed; when `projectId` is provided but `sessionId` is
 * omitted, all objects under `<projectId>/` are listed; when `sessionId` is
 * provided, only objects under `<projectId>/<sessionId>/`.
 */
export interface ListObjectsInput {
  projectId?: string;
  sessionId?: string;
}

/**
 * A single object entry returned by `listObjects`. `key` is the full, decoded
 * object key (e.g. `my-project/sess-1/session/transcript.jsonl`).
 */
export interface ListObjectEntry {
  key: string;
  size?: number;
  lastModified?: Date;
  etag?: string;
}

/**
 * Result of a successful LIST.
 */
export interface ListObjectsResult {
  objects: ListObjectEntry[];
}

/**
 * Storage-agnostic adapter contract. Implementations must support `putObject`;
 * `getObject`, `headObject`, and `listObjects` are optional conveniences for
 * callers that need them (e.g. the standalone CLI).
 */
export interface StorageAdapter {
  putObject(input: PutObjectInput): Promise<PutObjectResult>;
  getObject?(input: GetObjectInput): Promise<GetObjectResult | undefined>;
  headObject?(input: HeadObjectInput): Promise<HeadObjectResult | undefined>;
  listObjects?(input: ListObjectsInput): Promise<ListObjectsResult>;
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
