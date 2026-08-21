import { SANITIZATION_POLICY_VERSION } from '@lucasschirm/sal-sync-core';

export type RedactionAction = 'redact' | 'remove' | 'hash';

export type TranscriptCapturePolicy = 'raw' | 'disabled';

export const JSON_REDACTION_FIELDS: readonly string[] = [
  'env',
  'password',
  'passwd',
  'secret',
  'clientSecret',
  'token',
  'accessToken',
  'refreshToken',
  'idToken',
  'apiKey',
  'api_key',
  'privateKey',
  'private_key',
  'authorization',
  'auth',
  'bearer',
  'credential',
  'credentials',
];

export interface StringRedactionPattern {
  name: string;
  pattern: string;
  replacement: string;
  description?: string;
}

export const STRING_REDACTION_PATTERNS: readonly StringRedactionPattern[] = [
  {
    name: 'authorization-header',
    pattern: '(?i)(Authorization:\\s*Bearer\\s+)[\\w\\-\\.]+',
    replacement: '$1[REDACTED]',
    description: 'Bearer tokens in Authorization headers.',
  },
  {
    name: 'credential-url',
    pattern: '(?<=https?://)[^@]+(?=@)',
    replacement: '[CREDENTIALS]',
    description: 'Userinfo embedded in URLs.',
  },
  {
    name: 'private-key-block',
    pattern: '-----BEGIN (\\w+ )?PRIVATE KEY-----[\\s\\S]*?-----END (\\w+ )?PRIVATE KEY-----',
    replacement: '[PRIVATE KEY REDACTED]',
    description: 'PEM private key blocks.',
  },
];

export interface McpRedactionRule {
  target: string;
  action: RedactionAction;
  description?: string;
}

export const MCP_REDACTION_RULES: readonly McpRedactionRule[] = [
  {
    target: 'mcpServers.*.env',
    action: 'redact',
    description: 'Redact every value in per-server env maps.',
  },
  {
    target: 'mcpServers.*.headers.Authorization',
    action: 'remove',
    description: 'Drop Authorization headers from MCP server config.',
  },
  {
    target: 'mcpServers.*.args',
    action: 'redact',
    description: 'Redact arguments that match the string redaction patterns.',
  },
];

export const DEFAULT_TRANSCRIPT_CAPTURE_POLICY: TranscriptCapturePolicy = 'raw';
export const TRANSCRIPT_OPT_OUT_ENV_VAR = 'SAL_CAPTURE_TRANSCRIPTS';
export const TRANSCRIPT_OPT_OUT_VALUE = 'false';

export interface SanitizationPolicy {
  version: number;
  jsonRedactionFields: readonly string[];
  stringRedactionPatterns: readonly StringRedactionPattern[];
  mcpRedactionRules: readonly McpRedactionRule[];
  transcriptCapturePolicy: TranscriptCapturePolicy;
}

export const DEFAULT_SANITIZATION_POLICY: SanitizationPolicy = {
  version: SANITIZATION_POLICY_VERSION,
  jsonRedactionFields: JSON_REDACTION_FIELDS,
  stringRedactionPatterns: STRING_REDACTION_PATTERNS,
  mcpRedactionRules: MCP_REDACTION_RULES,
  transcriptCapturePolicy: DEFAULT_TRANSCRIPT_CAPTURE_POLICY,
};

export { SANITIZATION_POLICY_VERSION };
