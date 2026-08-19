import type { ArtifactScope } from '../artifact.js';
import { SYNC_ERROR_CATALOG } from '../errors.js';
import type { PutObjectInput, StorageObjectScope } from './contract.js';
import { StorageError } from './contract.js';

const S3_KEY_MAX_BYTES = 1024;
const CAS_PREFIX = 'global/cas';
const SHA256_HEX_LENGTH = 64;

const VALID_SCOPES = new Set<string>(['session', 'workspace', 'global', 'runtime', 'manifest']);
const CAS_SCOPES = new Set<string>(['workspace', 'global']);

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

function isSha256Hex(value: string): boolean {
  return value.length === SHA256_HEX_LENGTH && /^[0-9a-fA-F]+$/.test(value);
}

function validateCasHash(hash: string): string {
  if (!isSha256Hex(hash)) {
    throw storageError('contentSha256 must be a 64-character hex string');
  }
  return hash.toLowerCase();
}

export function encodeKeySegment(segment: string): string {
  return encodeURIComponent(segment);
}

/**
 * Components of a parsed storage object key.
 *
 * For a content-addressed key `global/cas/<sha256>` the `scope` is the literal
 * `'cas'`, `projectId` and `sessionId` are `undefined` (CAS objects are not
 * tied to a single project/session), and both `relativePath` and
 * `contentSha256` carry the lowercase hex hash.
 */
export interface ParsedObjectKey {
  projectId: string | undefined;
  sessionId: string | undefined;
  scope: StorageObjectScope | 'cas';
  relativePath: string;
  contentSha256?: string;
}

function buildCasKey(contentSha256: string): string {
  const hash = validateCasHash(contentSha256);
  const key = `${CAS_PREFIX}/${hash}`;
  if (Buffer.byteLength(key, 'utf8') > S3_KEY_MAX_BYTES) {
    throw storageError('object key exceeds S3 maximum length');
  }
  return key;
}

function validateRelativePath(relativePath: string): string[] {
  if (isAbsolutePath(relativePath)) {
    throw storageError('absolute paths are not allowed in object keys');
  }

  const normalized = normalizeSlashes(relativePath).replace(/^\//, '').replace(/\/$/, '');
  const parts = normalized.split('/').filter((part) => part !== '' && part !== '.');
  if (parts.some((part) => part === '..')) {
    throw storageError('parent directory references are not allowed in object keys');
  }
  if (parts.length === 0) {
    throw storageError('relativePath must not be empty');
  }
  return parts;
}

function buildLegacyKey(
  projectId: string,
  sessionId: string,
  scope: StorageObjectScope,
  relativePath: string,
): string {
  const parts = validateRelativePath(relativePath);
  const scopeParts = scope === 'manifest' ? [] : [scope];
  const segments = [projectId, sessionId, ...scopeParts, ...parts];
  const encoded = segments.map(encodeKeySegment).join('/');

  if (Buffer.byteLength(encoded, 'utf8') > S3_KEY_MAX_BYTES) {
    throw storageError('object key exceeds S3 maximum length');
  }

  return encoded;
}

/**
 * Build a deterministic S3 object key from a storage input.
 *
 * Legacy keys follow the layout:
 *   `<projectId>/<sessionId>/manifest.json`
 *   `<projectId>/<sessionId>/<scope>/<relativePath>`
 *
 * Content-addressed workspace and global objects use the flat layout:
 *   `global/cas/<contentSha256>`
 *
 * All path segments are percent-encoded to avoid traversal, special characters
 * and absolute paths. No arbitrary filesystem path is allowed to become part of
 * an object key.
 */
export function buildObjectKey(
  input: Pick<
    PutObjectInput,
    'projectId' | 'sessionId' | 'scope' | 'relativePath' | 'contentSha256'
  >,
): string {
  const { projectId, sessionId, scope, relativePath, contentSha256 } = input;

  if (!VALID_SCOPES.has(scope)) {
    throw storageError(`unsupported scope: ${scope}`);
  }

  if (CAS_SCOPES.has(scope)) {
    if (!contentSha256) {
      throw storageError('contentSha256 is required for workspace and global scope');
    }
    return buildCasKey(contentSha256);
  }

  if (!projectId || !sessionId || !relativePath) {
    throw storageError('projectId, sessionId and relativePath are required');
  }

  return buildLegacyKey(projectId, sessionId, scope, relativePath);
}

function parseCasKeySegments(segments: string[]): ParsedObjectKey | undefined {
  const hash = decodeURIComponent(segments[2] as string);
  if (!isSha256Hex(hash)) return undefined;
  const normalized = hash.toLowerCase();
  return {
    projectId: undefined,
    sessionId: undefined,
    scope: 'cas',
    relativePath: normalized,
    contentSha256: normalized,
  };
}

function parseLegacyKeySegments(segments: string[]): ParsedObjectKey | undefined {
  const projectId = decodeURIComponent(segments[0] as string);
  const sessionId = decodeURIComponent(segments[1] as string);
  const third = decodeURIComponent(segments[2] as string);

  // manifest.json lives at <projectId>/<sessionId>/manifest.json
  if (third === 'manifest.json' && segments.length === 3) {
    return { projectId, sessionId, scope: 'manifest', relativePath: 'manifest.json' };
  }

  if (!VALID_SCOPES.has(third)) {
    return undefined;
  }

  const scope = third as 'manifest' | ArtifactScope;
  const rest = segments.slice(3).map(decodeURIComponent).join('/');
  if (!rest) return undefined;

  return { projectId, sessionId, scope, relativePath: rest };
}

/**
 * Parse a decoded object key back into its components.
 *
 * Legacy keys follow the layout:
 *   `<projectId>/<sessionId>/manifest.json`
 *   `<projectId>/<sessionId>/<scope>/<relativePath>`
 *
 * Content-addressed keys follow the layout:
 *   `global/cas/<contentSha256>`
 *
 * Returns `undefined` if the key does not match an expected layout.
 */
export function parseObjectKey(key: string): ParsedObjectKey | undefined {
  if (!key) return undefined;

  const normalized = normalizeSlashes(key).replace(/^\//, '').replace(/\/$/, '');
  const segments = normalized.split('/').filter((part) => part !== '');
  if (segments.length < 3) return undefined;

  const first = decodeURIComponent(segments[0] as string);
  const second = decodeURIComponent(segments[1] as string);

  if (first === 'global' && second === 'cas' && segments.length === 3) {
    const casParsed = parseCasKeySegments(segments);
    if (casParsed) return casParsed;
  }

  return parseLegacyKeySegments(segments);
}
