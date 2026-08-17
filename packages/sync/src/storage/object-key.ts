import { SYNC_ERROR_CATALOG } from '../errors.js';
import type { PutObjectInput } from './contract.js';
import { StorageError } from './contract.js';

const S3_KEY_MAX_BYTES = 1024;

const VALID_SCOPES = new Set<string>(['session', 'workspace', 'global', 'runtime', 'manifest']);

function storageError(message: string, cause?: unknown): StorageError {
  return new StorageError(
    'SYNC_STORAGE_ERROR',
    `${SYNC_ERROR_CATALOG.SYNC_STORAGE_ERROR.description} (${message})`,
    false,
    cause,
  );
}

function isAbsolutePath(relativePath: string): boolean {
  if (relativePath.startsWith('/')) return true;
  if (/^[a-zA-Z]:[\\/]/.test(relativePath)) return true;
  return false;
}

function normalizeSlashes(input: string): string {
  return input.replace(/\\/g, '/').replace(/\/+/g, '/');
}

function encodeKeySegment(segment: string): string {
  return encodeURIComponent(segment);
}

/**
 * Build a deterministic S3 object key from a storage input.
 *
 * Keys follow the layout:
 *   `<projectId>/<sessionId>/manifest.json`
 *   `<projectId>/<sessionId>/<scope>/<relativePath>`
 *
 * All path segments are percent-encoded to avoid traversal, special characters
 * and absolute paths. No arbitrary filesystem path is allowed to become part of
 * an object key.
 */
export function buildObjectKey(
  input: Pick<PutObjectInput, 'projectId' | 'sessionId' | 'scope' | 'relativePath'>,
): string {
  const { projectId, sessionId, scope, relativePath } = input;

  if (!projectId || !sessionId || !relativePath) {
    throw storageError('projectId, sessionId and relativePath are required');
  }

  if (!VALID_SCOPES.has(scope)) {
    throw storageError(`unsupported scope: ${scope}`);
  }

  if (isAbsolutePath(relativePath)) {
    throw storageError('absolute paths are not allowed in object keys');
  }

  let normalized = normalizeSlashes(relativePath);
  normalized = normalized.replace(/^\//, '').replace(/\/$/, '');

  const parts = normalized.split('/').filter((part) => part !== '' && part !== '.');
  if (parts.some((part) => part === '..')) {
    throw storageError('parent directory references are not allowed in object keys');
  }

  const scopeParts = scope === 'manifest' ? [] : [scope];
  const segments = [projectId, sessionId, ...scopeParts, ...parts];
  const encoded = segments.map(encodeKeySegment).join('/');

  if (Buffer.byteLength(encoded, 'utf8') > S3_KEY_MAX_BYTES) {
    throw storageError('object key exceeds S3 maximum length');
  }

  return encoded;
}
