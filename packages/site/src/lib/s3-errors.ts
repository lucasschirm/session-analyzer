import { S3Error } from '@lucasschirm/sal-sync-core';

const CORS_DOCS_URL =
  'https://github.com/lucasschirm/session-analyzer/blob/main/packages/site/README.md#cors-configuration';

/** A human-readable hint and optional docs link for an S3 error. */
export interface S3ErrorHint {
  hint: string;
  link?: string;
}

/**
 * Chooses a human hint and an optional docs link for an S3 error, so the user
 * can debug the issue without opening the network tab.
 */
export function hintForS3Error(error: S3Error): S3ErrorHint {
  if (error.kind === 'cors' || error.kind === 'network') {
    return {
      hint: 'Could not reach the S3 endpoint. This is often a CORS misconfiguration or an incorrect endpoint.',
      link: CORS_DOCS_URL,
    };
  }
  switch (error.code) {
    case 'SignatureDoesNotMatch':
      return { hint: 'Check the secret access key and region are correct.' };
    case 'NoSuchBucket':
      return { hint: 'Check the bucket name and region are correct.' };
    case 'AccessDenied':
      return { hint: 'Check this key has permission to access the bucket.' };
    case 'RequestTimeTooSkewed':
      return { hint: 'Check your system clock is accurate.' };
    case 'NoSuchKey':
      return { hint: 'The requested object does not exist in the bucket.' };
    default:
      return { hint: 'Check the endpoint, credentials, and bucket details.' };
  }
}

/**
 * Formats an error into a user-facing message string. When the error is an
 * {@link S3Error}, the message includes the HTTP status, S3 error code, and
 * parsed message so the user has enough context to debug without dev tools.
 */
export function formatS3Error(error: unknown): string {
  if (error instanceof S3Error) {
    const parts: string[] = [];
    if (error.status > 0) parts.push(`HTTP ${error.status}`);
    if (error.code && error.code !== 'UnknownError') parts.push(error.code);
    if (error.message) parts.push(error.message);
    return parts.join(' • ');
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Returns a structured error detail object suitable for toast notifications.
 * Includes the formatted message and a debugging hint.
 */
export function describeS3Error(error: unknown): {
  message: string;
  hint: string;
  link?: string;
} {
  if (error instanceof S3Error) {
    const { hint, link } = hintForS3Error(error);
    return { message: formatS3Error(error), hint, link };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { message, hint: 'Check the endpoint, credentials, and bucket details.' };
}
