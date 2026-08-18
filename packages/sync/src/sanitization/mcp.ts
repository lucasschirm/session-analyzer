import { DEFAULT_MAX_JSON_DEPTH } from '../limits.js';
import {
  DEFAULT_SANITIZATION_POLICY,
  type McpRedactionRule,
  type RedactionAction,
  type SanitizationPolicy,
} from './contract.js';
import { applyRedaction, checkDepth } from './redaction.js';
import { redactSecrets } from './secrets.js';

export interface SanitizeMcpOptions {
  policy?: SanitizationPolicy;
  maxDepth?: number;
  action?: RedactionAction;
}

type JsonValue = unknown;

function buildRedactionFieldSet(fields: readonly string[]): ReadonlySet<string> {
  return new Set(fields.map((field) => field.toLowerCase()));
}

function matchRulePath(rule: McpRedactionRule, path: string[]): boolean {
  const parts = rule.target.split('.');
  if (parts.length !== path.length) return false;

  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === '*') continue;
    if (parts[i].toLowerCase() !== path[i].toLowerCase()) return false;
  }
  return true;
}

function findMatchingRule(
  rules: readonly McpRedactionRule[],
  path: string[],
): McpRedactionRule | undefined {
  for (const rule of rules) {
    if (matchRulePath(rule, path)) return rule;
  }
  return undefined;
}

function applyMcpRule(
  value: JsonValue,
  rule: McpRedactionRule,
  policy: SanitizationPolicy,
  maxDepth: number,
  depth: number,
): JsonValue {
  if (rule.target.toLowerCase().endsWith('.args')) {
    if (rule.action === 'remove') return undefined;
    if (!Array.isArray(value)) return value;
    if (rule.action === 'hash') {
      return value.map((arg) =>
        typeof arg === 'string' ? applyRedaction(arg, 'hash', maxDepth, depth + 1) : arg,
      );
    }
    return value.map((arg) =>
      typeof arg === 'string'
        ? redactSecrets(arg, { patterns: policy.stringRedactionPatterns })
        : arg,
    );
  }

  if (rule.target.toLowerCase().endsWith('.headers.authorization')) {
    if (rule.action === 'remove') return undefined;
    return applyRedaction(value, rule.action, maxDepth, depth);
  }

  return applyRedaction(value, rule.action, maxDepth, depth);
}

function sanitizeMcpValue(
  value: JsonValue,
  redactionFields: ReadonlySet<string>,
  policy: SanitizationPolicy,
  maxDepth: number,
  depth: number,
  action: RedactionAction,
  path: string[],
): JsonValue {
  checkDepth(depth, maxDepth);

  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item, index) =>
      sanitizeMcpValue(item, redactionFields, policy, maxDepth, depth + 1, action, [
        ...path,
        String(index),
      ]),
    );
  }

  const result: Record<string, JsonValue> = {};
  for (const [key, child] of Object.entries(value)) {
    const childPath = [...path, key];
    const rule = findMatchingRule(policy.mcpRedactionRules, childPath);
    if (rule) {
      const redacted = applyMcpRule(child, rule, policy, maxDepth, depth + 1);
      if (redacted !== undefined) {
        result[key] = redacted;
      }
      continue;
    }

    const lowerKey = key.toLowerCase();
    if (redactionFields.has(lowerKey)) {
      const redacted = applyRedaction(child, action, maxDepth, depth + 1);
      if (redacted !== undefined) {
        result[key] = redacted;
      }
    } else {
      result[key] = sanitizeMcpValue(
        child,
        redactionFields,
        policy,
        maxDepth,
        depth + 1,
        action,
        childPath,
      );
    }
  }
  return result;
}

export function sanitizeMcpConfig(value: JsonValue, options?: SanitizeMcpOptions): JsonValue {
  const policy = options?.policy ?? DEFAULT_SANITIZATION_POLICY;
  const maxDepth = options?.maxDepth ?? DEFAULT_MAX_JSON_DEPTH;
  const action = options?.action ?? 'redact';
  const redactionFields = buildRedactionFieldSet(policy.jsonRedactionFields);

  return sanitizeMcpValue(value, redactionFields, policy, maxDepth, 0, action, []);
}
