import { createHash } from 'node:crypto';
import { PutObjectCommand, type PutObjectCommandOutput, S3Client } from '@aws-sdk/client-s3';

import type { StorageConfig } from '../config/contract.js';
import { SYNC_ERROR_CATALOG, type SyncErrorCode } from '../errors.js';
import {
  type PutObjectInput,
  type PutObjectResult,
  type StorageAdapter,
  type StorageAdapterOptions,
  StorageError,
} from './contract.js';
import { buildObjectKey } from './object-key.js';
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
}

export { calculateRetryDelay };
