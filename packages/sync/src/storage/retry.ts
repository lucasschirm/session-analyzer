import type { StorageAdapterOptions } from './contract.js';
import { StorageError } from './contract.js';

export interface RetryPolicyOptions {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

const RETRYABLE_ERROR_NAMES = new Set<string>([
  'TimeoutError',
  'RequestTimeout',
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EPIPE',
  'ETIMEDOUT',
  'NetworkError',
  'ConnectionError',
  'AbortError',
  'SlowDown',
  'Throttling',
  'RequestLimitExceeded',
  'InternalError',
  'ServiceUnavailable',
]);

const NON_RETRYABLE_ERROR_NAMES = new Set<string>([
  'NoSuchBucket',
  'NoSuchKey',
  'NotFound',
  'AccessDenied',
  'InvalidAccessKeyId',
  'SignatureDoesNotMatch',
  'InvalidSecurity',
  'InvalidBucketName',
  'MalformedXML',
  'InvalidArgument',
  'InvalidObjectState',
  'EntityTooSmall',
  'EntityTooLarge',
  'KeyTooLong',
  'MethodNotAllowed',
  'NotImplemented',
  'InvalidRequest',
  'CredentialsProviderError',
  'NoCredentials',
]);

const RETRYABLE_STATUS_CODES = new Set<number>([408, 429]);

interface ErrorLike {
  name?: string;
  code?: string;
  message?: string;
  $metadata?: { httpStatusCode?: number };
}

function toErrorLike(err: unknown): ErrorLike {
  return err as ErrorLike;
}

function isRetryableByMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes('timeout') ||
    lower.includes('timed out') ||
    lower.includes('connection reset') ||
    lower.includes('econnreset') ||
    lower.includes('econnrefused') ||
    lower.includes('enotfound') ||
    lower.includes('throttl') ||
    lower.includes('rate limit') ||
    lower.includes('slow down') ||
    lower.includes('internal error') ||
    lower.includes('service unavailable')
  );
}

/**
 * Classify an error as retryable or non-retryable.
 *
 * Retryable: network timeouts, connection resets, temporary S3 service errors,
 * rate limiting and 5xx responses.
 * Non-retryable: invalid credentials, invalid bucket, permission denied,
 * malformed configuration and invalid object keys (4xx except 408/429).
 */
export function isRetryableError(err: unknown): boolean {
  if (err instanceof StorageError) {
    return err.retryable;
  }

  const e = toErrorLike(err);
  const status = e.$metadata?.httpStatusCode;

  if (status !== undefined) {
    if (status >= 500 && status < 600) return true;
    if (RETRYABLE_STATUS_CODES.has(status)) return true;
    if (status >= 400 && status < 500) return false;
  }

  const name = e.name ?? e.code ?? '';
  if (RETRYABLE_ERROR_NAMES.has(name)) return true;
  if (NON_RETRYABLE_ERROR_NAMES.has(name)) return false;

  if (e.message && isRetryableByMessage(e.message)) return true;

  return false;
}

/**
 * Calculate the delay before a given retry attempt using bounded exponential
 * backoff.
 */
export function calculateRetryDelay(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
): number {
  return Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
}

/**
 * Retry an operation with bounded exponential backoff. The `isRetryable`
 * predicate decides whether an error is worth retrying. After `maxRetries`
 * attempts the last error is re-thrown.
 */
export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  isRetryable: (err: unknown) => boolean,
  options: RetryPolicyOptions,
): Promise<T> {
  const { maxRetries, baseDelayMs, maxDelayMs } = options;
  let lastErr: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation(attempt);
    } catch (err) {
      lastErr = err;
      if (attempt >= maxRetries || !isRetryable(err)) {
        throw err;
      }
      const delay = calculateRetryDelay(attempt, baseDelayMs, maxDelayMs);
      await sleep(delay);
    }
  }

  throw lastErr;
}

/**
 * Resolve retry options, filling in defaults.
 */
export function resolveRetryOptions(options?: StorageAdapterOptions): RetryPolicyOptions {
  return {
    maxRetries: options?.retries ?? 3,
    baseDelayMs: options?.baseDelayMs ?? 250,
    maxDelayMs: options?.maxDelayMs ?? 10_000,
  };
}
