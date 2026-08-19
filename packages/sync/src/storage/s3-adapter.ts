import { createHash } from 'node:crypto';
import {
  DeleteObjectsCommand,
  type DeleteObjectsCommandOutput,
  GetObjectCommand,
  type GetObjectCommandOutput,
  HeadObjectCommand,
  type HeadObjectCommandOutput,
  ListObjectsV2Command,
  type ListObjectsV2CommandOutput,
  PutObjectCommand,
  type PutObjectCommandOutput,
  S3Client,
} from '@aws-sdk/client-s3';

import type { StorageConfig } from '../config/contract.js';
import { SYNC_ERROR_CATALOG, type SyncErrorCode } from '../errors.js';
import {
  type DeleteObjectsInput,
  type DeleteObjectsResult,
  type GetObjectInput,
  type GetObjectResult,
  type HeadObjectInput,
  type HeadObjectResult,
  type ListObjectEntry,
  type ListObjectsInput,
  type ListObjectsResult,
  type PutObjectInput,
  type PutObjectResult,
  type StorageAdapter,
  type StorageAdapterOptions,
  StorageError,
} from './contract.js';
import { buildObjectKey, encodeKeySegment } from './object-key.js';
import {
  calculateRetryDelay,
  isRetryableError,
  type RetryPolicyOptions,
  resolveRetryOptions,
  withRetry,
} from './retry.js';

function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

interface AwsErrorLike {
  name?: string;
  code?: string;
  message?: string;
  $metadata?: { httpStatusCode?: number };
}

function toAwsErrorLike(err: unknown): AwsErrorLike {
  return err as AwsErrorLike;
}

/**
 * Build the `<projectId>/` or `<projectId>/<sessionId>/` prefix shared by
 * `listObjects` and `deleteObjects`. Never resolves to a prefix that would
 * match `global/cas/` objects, since those are not scoped to a project.
 */
function buildScopePrefix(input: { projectId?: string; sessionId?: string }): string {
  if (!input.projectId) return '';
  const projectSegment = encodeKeySegment(input.projectId);
  if (!input.sessionId) return `${projectSegment}/`;
  return `${projectSegment}/${encodeKeySegment(input.sessionId)}/`;
}

/**
 * Map an AWS SDK or network error to a credential-safe StorageError.
 *
 * The returned message is built from the catalog description and the HTTP
 * status, never from the raw exception message, so credentials cannot leak
 * through error telemetry.
 */
export function mapS3Error(err: unknown): StorageError {
  if (err instanceof StorageError) {
    return err;
  }

  const e = toAwsErrorLike(err);
  const status = e.$metadata?.httpStatusCode;
  let code: SyncErrorCode = 'SYNC_STORAGE_ERROR';
  let retryable = false;

  if (status === 401 || status === 403) {
    code = 'SYNC_AUTH_FAILED';
    retryable = false;
  } else if (status === 404) {
    code = 'SYNC_STORAGE_ERROR';
    retryable = false;
  } else if (status === 408 || status === 429) {
    code = 'SYNC_STORAGE_ERROR';
    retryable = true;
  } else if (status !== undefined && status >= 500 && status < 600) {
    code = 'SYNC_STORAGE_ERROR';
    retryable = true;
  } else if (isRetryableError(err)) {
    code = 'SYNC_NETWORK_TIMEOUT';
    retryable = true;
  } else {
    code = 'SYNC_STORAGE_ERROR';
    retryable = false;
  }

  const statusSuffix = status !== undefined ? ` (HTTP ${status})` : '';
  const baseMessage = `${code}: ${SYNC_ERROR_CATALOG[code].description}${statusSuffix}`;
  // Include the underlying error message for debugging, except for auth errors
  // where the AWS SDK message may contain credentials or sensitive signing info.
  const underlying = err instanceof Error ? err.message : '';
  const underlyingSuffix =
    underlying && underlying !== baseMessage && code !== 'SYNC_AUTH_FAILED'
      ? `: ${underlying}`
      : '';
  const message = `${baseMessage}${underlyingSuffix}`;
  return new StorageError(code, message, retryable, err);
}

/**
 * S3-compatible storage adapter using the official AWS SDK.
 *
 * No credentials are logged, persisted, or included in error messages. The
 * adapter uses deterministic object keys, content-addressed SHA256 metadata, and
 * bounded exponential backoff.
 */
export class S3StorageAdapter implements StorageAdapter {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly retryOptions: RetryPolicyOptions;

  constructor(config: StorageConfig, options?: StorageAdapterOptions) {
    if (!config.bucket) {
      throw new StorageError(
        'SYNC_CONFIG_MISSING',
        `${SYNC_ERROR_CATALOG.SYNC_CONFIG_MISSING.description} (storage bucket is required)`,
        false,
      );
    }

    this.bucket = config.bucket;
    this.retryOptions = resolveRetryOptions(options);

    const credentials =
      config.accessKeyId && config.secretAccessKey
        ? {
            accessKeyId: config.accessKeyId,
            secretAccessKey: config.secretAccessKey,
            ...(config.sessionToken ? { sessionToken: config.sessionToken } : {}),
          }
        : undefined;

    this.client = new S3Client({
      region: config.region ?? 'us-east-1',
      ...(config.endpoint ? { endpoint: config.endpoint, forcePathStyle: true } : {}),
      ...(credentials ? { credentials } : {}),
    });
  }

  async putObject(input: PutObjectInput): Promise<PutObjectResult> {
    let key: string;
    try {
      key = buildObjectKey(input);
    } catch (err) {
      if (err instanceof StorageError) throw err;
      throw mapS3Error(err);
    }

    const sha256 = input.contentSha256 ?? sha256Hex(input.body);
    const metadata: Record<string, string> = { sha256, ...(input.metadata ?? {}) };

    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: input.body,
      ...(input.contentType ? { ContentType: input.contentType } : {}),
      Metadata: metadata,
    });

    try {
      const output = await withRetry<PutObjectCommandOutput>(
        async () => this.client.send(command),
        isRetryableError,
        this.retryOptions,
      );

      return {
        key,
        etag: output.ETag,
        versionId: output.VersionId,
        sha256,
      };
    } catch (err) {
      throw mapS3Error(err);
    }
  }

  async getObject(input: GetObjectInput): Promise<GetObjectResult | undefined> {
    const key = buildObjectKey(input);
    const command = new GetObjectCommand({ Bucket: this.bucket, Key: key });

    let output: GetObjectCommandOutput;
    try {
      output = await withRetry(
        async () => this.client.send(command),
        isRetryableError,
        this.retryOptions,
      );
    } catch (err) {
      const e = toAwsErrorLike(err);
      if (e.$metadata?.httpStatusCode === 404) {
        return undefined;
      }
      throw mapS3Error(err);
    }

    if (!output.Body) {
      return undefined;
    }

    const body = await output.Body.transformToByteArray();
    return {
      body: new Uint8Array(body),
      contentType: output.ContentType,
      etag: output.ETag,
      lastModified: output.LastModified,
      metadata: output.Metadata as Record<string, string> | undefined,
    };
  }

  async headObject(input: HeadObjectInput): Promise<HeadObjectResult | undefined> {
    const key = buildObjectKey(input);
    const command = new HeadObjectCommand({ Bucket: this.bucket, Key: key });

    let output: HeadObjectCommandOutput;
    try {
      output = await withRetry(
        async () => this.client.send(command),
        isRetryableError,
        this.retryOptions,
      );
    } catch (err) {
      const e = toAwsErrorLike(err);
      if (e.$metadata?.httpStatusCode === 404) {
        return undefined;
      }
      throw mapS3Error(err);
    }

    return {
      contentLength: output.ContentLength,
      contentType: output.ContentType,
      etag: output.ETag,
      lastModified: output.LastModified,
      metadata: output.Metadata as Record<string, string> | undefined,
    };
  }

  async listObjects(input: ListObjectsInput): Promise<ListObjectsResult> {
    const prefix = buildScopePrefix(input);
    const entries: ListObjectEntry[] = [];

    for await (const page of this.listRawPages(prefix)) {
      for (const obj of page) {
        if (!obj.Key) continue;
        entries.push({
          key: decodeURIComponent(obj.Key),
          size: obj.Size,
          lastModified: obj.LastModified,
          etag: obj.ETag,
        });
      }
    }

    return { objects: entries };
  }

  private async *listRawPages(
    prefix: string,
  ): AsyncGenerator<NonNullable<ListObjectsV2CommandOutput['Contents']>> {
    let continuationToken: string | undefined;
    do {
      const command = new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: prefix,
        ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
      });

      let output: ListObjectsV2CommandOutput;
      try {
        output = await withRetry(
          async () => this.client.send(command),
          isRetryableError,
          this.retryOptions,
        );
      } catch (err) {
        throw mapS3Error(err);
      }

      yield output.Contents ?? [];
      continuationToken = output.IsTruncated ? output.NextContinuationToken : undefined;
    } while (continuationToken);
  }

  /**
   * Delete every object under `<projectId>/` (or `<projectId>/<sessionId>/`
   * when `sessionId` is given). Never touches `global/cas/<hash>` objects —
   * `buildScopePrefix` only ever produces project-scoped prefixes.
   */
  async deleteObjects(input: DeleteObjectsInput): Promise<DeleteObjectsResult> {
    const prefix = buildScopePrefix(input);
    if (!prefix) {
      throw new StorageError(
        'SYNC_STORAGE_ERROR',
        `${SYNC_ERROR_CATALOG.SYNC_STORAGE_ERROR.description} (projectId is required to delete objects)`,
        false,
      );
    }

    const rawKeys: string[] = [];
    for await (const page of this.listRawPages(prefix)) {
      for (const obj of page) {
        if (obj.Key) rawKeys.push(obj.Key);
      }
    }

    return this.deleteRawKeys(rawKeys);
  }

  private async deleteRawKeys(rawKeys: string[]): Promise<DeleteObjectsResult> {
    const deletedKeys: string[] = [];
    const errors: Array<{ key: string; message: string }> = [];
    const BATCH_SIZE = 1000;

    for (let i = 0; i < rawKeys.length; i += BATCH_SIZE) {
      const batch = await this.deleteBatch(rawKeys.slice(i, i + BATCH_SIZE));
      deletedKeys.push(...batch.deletedKeys);
      errors.push(...batch.errors);
    }

    return { deletedKeys, errors };
  }

  private async deleteBatch(rawKeys: string[]): Promise<DeleteObjectsResult> {
    const command = new DeleteObjectsCommand({
      Bucket: this.bucket,
      Delete: { Objects: rawKeys.map((Key) => ({ Key })), Quiet: false },
    });

    let output: DeleteObjectsCommandOutput;
    try {
      output = await withRetry(
        async () => this.client.send(command),
        isRetryableError,
        this.retryOptions,
      );
    } catch (err) {
      throw mapS3Error(err);
    }

    const deletedKeys = (output.Deleted ?? [])
      .map((d) => d.Key)
      .filter((k): k is string => Boolean(k))
      .map(decodeURIComponent);
    const errors = (output.Errors ?? []).map((e) => ({
      key: e.Key ? decodeURIComponent(e.Key) : 'unknown',
      message: e.Message ?? 'unknown error',
    }));

    return { deletedKeys, errors };
  }
}

export { calculateRetryDelay };
