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

/**
 * `{configDir}/...` patterns are resolved against `HarnessProfile.configDir(env)`
 * (Claude's default: `~/.claude`, overridable via `CLAUDE_CONFIG_DIR`); a plain
 * `~/...` pattern is always resolved against the home directory regardless of
 * the harness's config directory. See `expandAllowlistPattern` in
 * `packages/sync/src/discovery/glob.ts`.
 */
export const GLOBAL_ALLOWLIST_PATTERNS: readonly string[] = [
  '{configDir}/settings.json',
  '{configDir}/CLAUDE.md',
  '{configDir}/agents/**',
  '~/.claude.json',
];

/**
 * @deprecated Claude Code's capture allowlist, kept as a top-level export so
 * published `@lucasschirm/claude-session-sync` versions that import it
 * directly do not break. New code should use `ClaudeHarnessProfile.captureAllowlist`
 * (`packages/plugins/claude-session-sync`) — or, for a different harness, that
 * harness's own `HarnessProfile.captureAllowlist` — instead of importing this
 * constant, since it is Claude-specific and no longer the implicit default
 * used by `packages/sync`'s discovery functions.
 */
export const CAPTURE_ALLOWLIST: CaptureAllowlist = {
  version: CAPTURE_ALLOWLIST_VERSION,
  // Session discovery is handled directly by discoverSession() using the exact
  // transcriptPath and the session's per-session supplementary directory.
  session: [],
  workspace: WORKSPACE_ALLOWLIST_PATTERNS.map((pattern) => ({ scope: 'workspace', pattern })),
  global: GLOBAL_ALLOWLIST_PATTERNS.map((pattern) => ({ scope: 'global', pattern })),
};

export { CAPTURE_ALLOWLIST_VERSION };
