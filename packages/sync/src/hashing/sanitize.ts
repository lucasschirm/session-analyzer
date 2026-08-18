import type { ArtifactScope } from '../artifact.js';
import {
  DEFAULT_SANITIZATION_POLICY,
  redactSecrets,
  sanitizeJson,
  sanitizeJsonl,
  sanitizeMcpConfig,
} from '../sanitization/index.js';

export type ArtifactSanitizer = (content: string) => string;

function isTranscriptJsonl(relativePath: string, scope: ArtifactScope): boolean {
  return scope === 'session' && relativePath.endsWith('.jsonl');
}

export function selectSanitizer(relativePath: string, scope: ArtifactScope): ArtifactSanitizer {
  if (relativePath.endsWith('.mcp.json')) {
    return (content) => {
      const parsed = JSON.parse(content) as unknown;
      const sanitized = sanitizeMcpConfig(parsed, { policy: DEFAULT_SANITIZATION_POLICY });
      return JSON.stringify(sanitized);
    };
  }

  if (relativePath.endsWith('.json')) {
    return (content) => {
      const parsed = JSON.parse(content) as unknown;
      const sanitized = sanitizeJson(parsed, { policy: DEFAULT_SANITIZATION_POLICY });
      return JSON.stringify(sanitized);
    };
  }

  if (relativePath.endsWith('.jsonl')) {
    return (content) =>
      sanitizeJsonl(content, {
        policy: DEFAULT_SANITIZATION_POLICY,
        isTranscript: isTranscriptJsonl(relativePath, scope),
      });
  }

  return (content) =>
    redactSecrets(content, { patterns: DEFAULT_SANITIZATION_POLICY.stringRedactionPatterns });
}
