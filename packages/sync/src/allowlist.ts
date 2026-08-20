import { CAPTURE_ALLOWLIST_VERSION } from './versions.js';

export type CaptureScope = 'session' | 'workspace' | 'global';

export interface AllowlistEntry {
  scope: CaptureScope;
  pattern: string;
}

export interface CaptureAllowlist {
  version: number;
  session: AllowlistEntry[];
  workspace: AllowlistEntry[];
  global: AllowlistEntry[];
}

export const WORKSPACE_ALLOWLIST_PATTERNS: readonly string[] = [
  'CLAUDE.md',
  '.mcp.json',
  '.claude/settings.json',
  '.claude/settings.local.json',
  '.claude/agents/**',
  '.claude/skills/**',
  '.claude/rules/**',
];

export const GLOBAL_ALLOWLIST_PATTERNS: readonly string[] = [
  '~/.claude/settings.json',
  '~/.claude/CLAUDE.md',
  '~/.claude/agents/**',
  '~/.claude.json',
];

export const CAPTURE_ALLOWLIST: CaptureAllowlist = {
  version: CAPTURE_ALLOWLIST_VERSION,
  // Session discovery is handled directly by discoverSession() using the exact
  // transcriptPath and the session's per-session supplementary directory.
  session: [],
  workspace: WORKSPACE_ALLOWLIST_PATTERNS.map((pattern) => ({ scope: 'workspace', pattern })),
  global: GLOBAL_ALLOWLIST_PATTERNS.map((pattern) => ({ scope: 'global', pattern })),
};

export { CAPTURE_ALLOWLIST_VERSION };
