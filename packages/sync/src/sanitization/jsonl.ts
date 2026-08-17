import { DEFAULT_MAX_JSONL_LINE_BYTES } from '../limits.js';
import { DEFAULT_SANITIZATION_POLICY, type SanitizationPolicy } from './contract.js';
import { sanitizeJson } from './json.js';
import { SanitizationError } from './redaction.js';

export interface SanitizeJsonlOptions {
  policy?: SanitizationPolicy;
  maxDepth?: number;
  maxLineBytes?: number;
  isTranscript?: boolean;
}

export function sanitizeJsonl(content: string, options?: SanitizeJsonlOptions): string {
  if (options?.isTranscript) {
    return content;
  }

  const policy = options?.policy ?? DEFAULT_SANITIZATION_POLICY;
  const maxDepth = options?.maxDepth;
  const maxLineBytes = options?.maxLineBytes ?? DEFAULT_MAX_JSONL_LINE_BYTES;

  const lines = content.split(/\r?\n/);
  const sanitized: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length === 0) {
      sanitized.push(line);
      continue;
    }

    const lineBytes = Buffer.byteLength(line, 'utf8');
    if (lineBytes > maxLineBytes) {
      throw new SanitizationError(
        'SYNC_SANITIZATION_ERROR',
        `JSONL line ${i + 1} exceeded ${maxLineBytes} bytes (${lineBytes})`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      throw new SanitizationError(
        'SYNC_JSON_PARSE_FAILED',
        `JSONL line ${i + 1} could not be parsed: ${String(err)}`,
      );
    }

    const redacted = sanitizeJson(parsed, { policy, maxDepth });
    sanitized.push(JSON.stringify(redacted));
  }

  return sanitized.join('\n');
}
