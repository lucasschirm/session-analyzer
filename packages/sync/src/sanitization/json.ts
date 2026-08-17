import { DEFAULT_MAX_JSON_DEPTH } from '../limits.js';
import {
  DEFAULT_SANITIZATION_POLICY,
  type RedactionAction,
  type SanitizationPolicy,
} from './contract.js';
import { applyRedaction, checkDepth } from './redaction.js';

export interface SanitizeJsonOptions {
  policy?: SanitizationPolicy;
  maxDepth?: number;
  action?: RedactionAction;
}

function normalizeFieldName(field: string): string {
  return field.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function buildRedactionFieldSet(fields: readonly string[]): ReadonlySet<string> {
  return new Set(fields.map((field) => normalizeFieldName(field)));
}

function sanitizeValue(
  value: unknown,
  redactionFields: ReadonlySet<string>,
  maxDepth: number,
  depth: number,
  action: RedactionAction,
): unknown {
  checkDepth(depth, maxDepth);

  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, redactionFields, maxDepth, depth + 1, action));
  }

  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = normalizeFieldName(key);
    if (redactionFields.has(normalizedKey)) {
      const redacted = applyRedaction(child, action, maxDepth, depth + 1);
      if (redacted !== undefined) {
        result[key] = redacted;
      }
    } else {
      result[key] = sanitizeValue(child, redactionFields, maxDepth, depth + 1, action);
    }
  }
  return result;
}

export function sanitizeJson(value: unknown, options?: SanitizeJsonOptions): unknown {
  const policy = options?.policy ?? DEFAULT_SANITIZATION_POLICY;
  const maxDepth = options?.maxDepth ?? DEFAULT_MAX_JSON_DEPTH;
  const action = options?.action ?? 'redact';
  const redactionFields = buildRedactionFieldSet(policy.jsonRedactionFields);

  return sanitizeValue(value, redactionFields, maxDepth, 0, action);
}
