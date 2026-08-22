import { S3Error } from '@lucasschirm/sal-sync-core';
import { describe, expect, it } from 'vitest';
import { describeS3Error, formatS3Error, hintForS3Error } from '../../src/lib/s3-errors';

function makeS3Error(
  status: number,
  code: string,
  message: string,
  kind: 's3' | 'network' | 'cors' | 'stall' = 's3',
): S3Error {
  return new S3Error({ status, code, message, kind });
}

describe('hintForS3Error', () => {
  it('returns a CORS hint with a docs link for cors errors', () => {
    const error = makeS3Error(0, 'FailedToFetch', 'Failed to fetch', 'cors');
    const { hint, link } = hintForS3Error(error);
    expect(hint).toContain('CORS');
    expect(link).toBeDefined();
  });

  it('returns a CORS hint with a docs link for network errors', () => {
    const error = makeS3Error(0, 'NetworkError', 'Network error', 'network');
    const { hint, link } = hintForS3Error(error);
    expect(hint).toContain('CORS');
    expect(link).toBeDefined();
  });

  it('returns a credential hint for SignatureDoesNotMatch', () => {
    const error = makeS3Error(403, 'SignatureDoesNotMatch', 'Signature mismatch');
    const { hint } = hintForS3Error(error);
    expect(hint).toContain('secret access key');
  });

  it('returns a bucket hint for NoSuchBucket', () => {
    const error = makeS3Error(404, 'NoSuchBucket', 'Bucket not found');
    const { hint } = hintForS3Error(error);
    expect(hint).toContain('bucket name');
  });

  it('returns a permissions hint for AccessDenied', () => {
    const error = makeS3Error(403, 'AccessDenied', 'Access denied');
    const { hint } = hintForS3Error(error);
    expect(hint).toContain('permission');
  });

  it('returns a clock hint for RequestTimeTooSkewed', () => {
    const error = makeS3Error(403, 'RequestTimeTooSkewed', 'Time skew');
    const { hint } = hintForS3Error(error);
    expect(hint).toContain('system clock');
  });

  it('returns a not-found hint for NoSuchKey', () => {
    const error = makeS3Error(404, 'NoSuchKey', 'Key not found');
    const { hint } = hintForS3Error(error);
    expect(hint).toContain('does not exist');
  });

  it('returns a generic hint for unknown error codes', () => {
    const error = makeS3Error(500, 'InternalError', 'Something broke');
    const { hint } = hintForS3Error(error);
    expect(hint).toContain('endpoint');
  });
});

describe('formatS3Error', () => {
  it('includes HTTP status, code, and message for an S3Error', () => {
    const error = makeS3Error(404, 'NoSuchKey', 'Key not found');
    const formatted = formatS3Error(error);
    expect(formatted).toContain('HTTP 404');
    expect(formatted).toContain('NoSuchKey');
    expect(formatted).toContain('Key not found');
  });

  it('omits HTTP status when it is 0 (network error)', () => {
    const error = makeS3Error(0, 'NetworkError', 'Failed to fetch', 'network');
    const formatted = formatS3Error(error);
    expect(formatted).not.toContain('HTTP 0');
    expect(formatted).toContain('NetworkError');
    expect(formatted).toContain('Failed to fetch');
  });

  it('returns the message for a generic Error', () => {
    const error = new Error('Something broke');
    expect(formatS3Error(error)).toBe('Something broke');
  });

  it('returns stringified value for non-Error throws', () => {
    expect(formatS3Error('oops')).toBe('oops');
  });
});

describe('describeS3Error', () => {
  it('returns message, hint, and link for an S3Error', () => {
    const error = makeS3Error(0, 'FailedToFetch', 'Failed to fetch', 'cors');
    const { message, hint, link } = describeS3Error(error);
    expect(message).toContain('FailedToFetch');
    expect(hint).toContain('CORS');
    expect(link).toBeDefined();
  });

  it('returns a generic hint for a non-S3 error', () => {
    const error = new Error('Random failure');
    const { message, hint } = describeS3Error(error);
    expect(message).toBe('Random failure');
    expect(hint).toContain('endpoint');
  });

  it('returns a stringified value for a non-Error throw', () => {
    const { message, hint } = describeS3Error('string error');
    expect(message).toBe('string error');
    expect(hint).toContain('endpoint');
  });

  it('returns a hint for a stall error kind', () => {
    const error = makeS3Error(0, 'STALL_TIMEOUT', 'Download stalled', 'stall');
    const { hint } = describeS3Error(error);
    // Stall errors fall through to the default hint since they're not cors/network
    expect(hint).toContain('endpoint');
  });
});

describe('hintForS3Error edge cases', () => {
  it('returns a generic hint for an unknown S3 error code with s3 kind', () => {
    const error = makeS3Error(500, 'InternalError', 'Internal error');
    const { hint, link } = hintForS3Error(error);
    expect(hint).toContain('endpoint');
    expect(link).toBeUndefined();
  });

  it('returns the CORS docs link for cors kind regardless of code', () => {
    const error = makeS3Error(0, 'SomeRandomCode', 'msg', 'cors');
    const { link } = hintForS3Error(error);
    expect(link).toBeDefined();
    expect(link).toContain('cors-configuration');
  });

  it('returns the CORS docs link for network kind regardless of code', () => {
    const error = makeS3Error(0, 'SomeRandomCode', 'msg', 'network');
    const { link } = hintForS3Error(error);
    expect(link).toBeDefined();
  });

  it('returns a not-found hint for NoSuchKey with 404 status', () => {
    const error = makeS3Error(404, 'NoSuchKey', 'Key not found');
    const { hint } = hintForS3Error(error);
    expect(hint).toContain('does not exist');
  });

  it('handles AccessDenied with a permissions hint', () => {
    const error = makeS3Error(403, 'AccessDenied', 'Access denied');
    const { hint } = hintForS3Error(error);
    expect(hint).toContain('permission');
  });
});

describe('formatS3Error edge cases', () => {
  it('handles UnknownError code by omitting it from the output', () => {
    const error = makeS3Error(500, 'UnknownError', 'Something broke');
    const formatted = formatS3Error(error);
    expect(formatted).toContain('HTTP 500');
    // UnknownError is the fallback code — it's deliberately omitted
    expect(formatted).not.toContain('UnknownError');
    expect(formatted).toContain('Something broke');
  });

  it('handles an S3Error with an empty message', () => {
    const error = makeS3Error(403, 'AccessDenied', '');
    const formatted = formatS3Error(error);
    expect(formatted).toContain('HTTP 403');
    expect(formatted).toContain('AccessDenied');
    // Empty message means it's omitted from the parts array
    expect(formatted).not.toContain('•  •');
  });

  it('handles a stall error (status 0, stall kind)', () => {
    const error = makeS3Error(0, 'STALL_TIMEOUT', 'Download stalled', 'stall');
    const formatted = formatS3Error(error);
    expect(formatted).not.toContain('HTTP 0');
    expect(formatted).toContain('STALL_TIMEOUT');
    expect(formatted).toContain('Download stalled');
  });

  it('handles null/undefined input gracefully', () => {
    expect(formatS3Error(null)).toBe('null');
    expect(formatS3Error(undefined)).toBe('undefined');
  });

  it('handles a number input', () => {
    expect(formatS3Error(42)).toBe('42');
  });
});

describe('describeS3Error edge cases', () => {
  it('includes the hint and link for a SignatureDoesNotMatch error', () => {
    const error = makeS3Error(403, 'SignatureDoesNotMatch', 'Signature mismatch');
    const { message, hint } = describeS3Error(error);
    expect(message).toContain('HTTP 403');
    expect(message).toContain('SignatureDoesNotMatch');
    expect(hint).toContain('secret access key');
  });

  it('includes the hint for a NoSuchBucket error', () => {
    const error = makeS3Error(404, 'NoSuchBucket', 'Bucket not found');
    const { hint } = describeS3Error(error);
    expect(hint).toContain('bucket name');
  });

  it('includes the hint for a RequestTimeTooSkewed error', () => {
    const error = makeS3Error(403, 'RequestTimeTooSkewed', 'Time skew');
    const { hint } = describeS3Error(error);
    expect(hint).toContain('system clock');
  });
});
