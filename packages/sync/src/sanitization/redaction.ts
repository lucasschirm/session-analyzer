import { createHash } from 'node:crypto';

import type { SyncErrorCode } from '@lucasschirm/sal-sync-core';
import type { RedactionAction } from './contract.js';

const DEFAULT_REDACTED = '[REDACTED]';

export class SanitizationError extends Error {
  readonly code: SyncErrorCode;

  constructor(code: SyncErrorCode, message: string) {
    super(message);
    this.name = 'SanitizationError';
    this.code = code;
  }
}

export function checkDepth(depth: number, maxDepth: number): void {
  if (depth > maxDepth) {
    throw new SanitizationError(
      'SYNC_SANITIZATION_ERROR',
      `Maximum JSON depth of ${maxDepth} exceeded`,
    );
  }
}

function scalarToString(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  return String(value);
}

function hashScalar(value: unknown): string {
  const input = scalarToString(value);
  const hex = createHash('sha256').update(input).digest('hex');
  return `[HASH:${hex}]`;
}

function redactScalar(_value: unknown): string {
  return DEFAULT_REDACTED;
}

export function applyRedaction(
  value: unknown,
  action: RedactionAction,
  maxDepth: number,
  depth: number,
): unknown {
  checkDepth(depth, maxDepth);

  if (action === 'remove') {
    return undefined;
  }

  if (value === null || typeof value !== 'object') {
    return action === 'hash' ? hashScalar(value) : redactScalar(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => applyRedaction(item, action, maxDepth, depth + 1));
  }

  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>)) {
    result[key] = applyRedaction(
      (value as Record<string, unknown>)[key],
      action,
      maxDepth,
      depth + 1,
    );
  }
  return result;
}
