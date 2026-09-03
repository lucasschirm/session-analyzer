import {
  CAPTURE_ALLOWLIST,
  type HarnessProfile,
  UNKNOWN_HARNESS_VERSION,
} from '@lucasschirm/sal-sync-core';
import { resolveClaudeConfigDir } from './paths.js';
import { CLAUDE_SESSION_LAYOUT } from './session-layout.js';

/**
 * Backward-compatible default profile used by the generic sync engine entry
 * points (`capture`, `sessionStart`, `sessionEnd`, `watchTranscripts`, and
 * `discover`'s convenience callers) when no `HarnessProfile` is explicitly
 * supplied. It mirrors the Claude Code behavior this package hardcoded
 * before the harness-profile abstraction, so existing consumers that predate
 * it keep working unchanged.
 *
 * New integrations — including the Claude plugin itself and any future
 * harness — should construct and pass their own `HarnessProfile` explicitly
 * (see `ClaudeHarnessProfile` in `packages/plugins/claude-session-sync`)
 * rather than relying on this default. `securityBlocklist` is empty here
 * because this package does not resolve env from settings files itself;
 * that is a plugin-level concern (see `ClaudeHarnessProfile.securityBlocklist`).
 */
export const DEFAULT_HARNESS_PROFILE: HarnessProfile = {
  harness: 'claude',
  harnessVersion: UNKNOWN_HARNESS_VERSION,
  configDir: (env) => resolveClaudeConfigDir(env),
  captureAllowlist: CAPTURE_ALLOWLIST,
  sessionLayout: CLAUDE_SESSION_LAYOUT,
  securityBlocklist: [],
};
