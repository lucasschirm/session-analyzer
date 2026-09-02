import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import type {
  CaptureAllowlist,
  HarnessProfile,
  SessionLayoutDescriptor,
} from '@lucasschirm/sal-sync';
import { UNKNOWN_HARNESS_VERSION } from '@lucasschirm/sal-sync';

export const DEVIN_HARNESS = 'devin' as const;

/**
 * `credentials.toml` (mode 600), `mcp/oauth/**` and `logs/**` must never sync
 * (Part A2). These are never added to {@link DEVIN_CAPTURE_ALLOWLIST}, but the
 * omission alone is not defense-in-depth per
 * `.agents/rules/manifest-backed-classification.md` — `applyHardBlocklist`
 * in `session-sync.ts` actively strips any matching path from a discovery
 * result even if a future allowlist change (e.g. a broadened `**` glob)
 * would otherwise sweep one in.
 */
export const DEVIN_HARD_BLOCKLIST_PATTERNS: readonly string[] = [
  'credentials.toml',
  'mcp/oauth/**',
  'logs/**',
];

/**
 * Workspace-scope capture allowlist (Part B2, initial). `~/.devin/plans/**`
 * is deliberately NOT here: plan files are session-linked (only entries whose
 * frontmatter `session:` matches the current session id belong to a given
 * session's manifest), which the generic scope-based allowlist discovery
 * cannot express — `session-sync.ts`'s `discoverSessionPlans` implements that
 * filter directly instead.
 */
const WORKSPACE_ALLOWLIST_PATTERNS: readonly string[] = [
  '.devin/hooks.v1.json',
  '.devin/hooks/**',
  '.devin/config.json',
  '.windsurf/**',
  'AGENTS.md',
];

/**
 * Global-scope capture allowlist. `~/.config/devin/config.json` is a fixed,
 * conventional home-relative location (Part B2) resolved via the `~/` prefix
 * independently of `configDir`. `plugins/discovered.json` lives under the
 * Devin CLI's XDG *data* root (the same directory as `sessions.db`), which is
 * what {@link resolveDevinConfigDir} returns as this profile's `configDir` —
 * see that function's doc comment for why data root (not `~/.config/devin`)
 * is the `{configDir}` resolution target here.
 */
const GLOBAL_ALLOWLIST_PATTERNS: readonly string[] = [
  '~/.config/devin/config.json',
  '{configDir}/plugins/discovered.json',
];

export const DEVIN_CAPTURE_ALLOWLIST: CaptureAllowlist = {
  version: 1,
  session: [],
  workspace: WORKSPACE_ALLOWLIST_PATTERNS.map((pattern) => ({ scope: 'workspace', pattern })),
  global: GLOBAL_ALLOWLIST_PATTERNS.map((pattern) => ({ scope: 'global', pattern })),
};

/** On-disk main transcript filename: `<sessionId>.jsonl`, materialized by
 * `session-sync.ts` from the DS-F2 (#157) extractor's `sessions.db` reads —
 * Devin never writes this file itself, unlike Claude Code. */
export const DEVIN_SESSION_LAYOUT: SessionLayoutDescriptor = {
  mainTranscriptStorageName: 'transcript.jsonl',
  mainTranscriptFilePattern: '{sessionId}.jsonl',
  // Devin has no subagent transcript convention today; these patterns never
  // match anything on disk and are kept only for structural parity with
  // `SessionLayoutDescriptor` consumers that assume both fields are present.
  subagentTranscriptsPattern: 'subagents/*.jsonl',
  subagentMetaPattern: 'subagents/*.meta.json',
};

/**
 * `~/.config/devin/config.json` and project `.devin/config.json` are
 * typically committed to git (or at least not gitignored by default),
 * mirroring Claude's `settings.json`. The storage endpoint and credentials
 * must never be sourced from a file anyone with commit/PR access can edit —
 * see `ClaudeHarnessProfile`'s identical rationale. Only `process.env` or a
 * `.devin/config.local.json` override (see `cli/env.ts`) may supply them.
 */
const DEVIN_SECURITY_BLOCKLIST: readonly string[] = [
  'SAL_STORAGE_ENDPOINT',
  'SAL_STORAGE_ACCESS_KEY_ID',
  'SAL_STORAGE_SECRET_ACCESS_KEY',
];

/**
 * Resolves the Devin CLI's XDG *data* root: `$XDG_DATA_HOME/devin/cli` when
 * set, else `~/.local/share/devin/cli`. This mirrors
 * `extractor/paths.ts`'s `resolveDevinDataRoot` exactly (duplicated rather
 * than imported to keep `devin-profile.ts` free of a dependency on the
 * extractor module — `HarnessProfile.configDir` is consumed by `packages/sync`
 * discovery for the `{configDir}/...` global-allowlist prefix, which is a
 * narrower concern than the extractor's full path-resolution surface).
 *
 * `HarnessProfile.configDir` is used here for the *data* root (not
 * `~/.config/devin`) because `plugins/discovered.json` — the one
 * `{configDir}`-relative global pattern this profile declares — lives
 * alongside `sessions.db` in the data root, not in the config directory.
 * `~/.config/devin/config.json` is expressed as a fixed home-relative
 * pattern instead (see {@link GLOBAL_ALLOWLIST_PATTERNS}).
 */
export function resolveDevinConfigDir(env: Record<string, string | undefined>): string {
  const xdgDataHome = env.XDG_DATA_HOME;
  const base =
    xdgDataHome && xdgDataHome.trim() !== ''
      ? xdgDataHome
      : path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'devin', 'cli');
}

export type ExecFileSyncLike = (
  command: string,
  args: string[],
  options: { encoding: 'utf8'; stdio?: 'pipe' },
) => string;

/**
 * Resolves the live Devin CLI version via `devin --version`, never a
 * hardcoded literal (the exact DS-B5 #143 pattern this plugin must avoid).
 * Falls back to `UNKNOWN_HARNESS_VERSION` — never `''`/`'0.0.0'` — when the
 * `devin` binary is not on `PATH` (e.g. in CI/tests), per
 * `missing-is-never-zero`.
 */
export function resolveDevinCliVersion(execFn: ExecFileSyncLike = execFileSync): string {
  try {
    const output = execFn('devin', ['--version'], { encoding: 'utf8', stdio: 'pipe' });
    const trimmed = output.trim();
    return trimmed.length > 0 ? trimmed : UNKNOWN_HARNESS_VERSION;
  } catch {
    return UNKNOWN_HARNESS_VERSION;
  }
}

/**
 * Builds a concrete `HarnessProfile` for Devin, mirroring
 * `ClaudeHarnessProfile` (DS-F1 #156, `packages/plugins/claude-session-sync`)
 * — see that module's doc comment for why the concrete profile lives in the
 * plugin package rather than `sync-core`/`sync`.
 *
 * Unlike `ClaudeHarnessProfile.harnessVersion` (a static plugin-adapter
 * version string), `harnessVersion` here is resolved from the live `devin
 * --version` output at profile-construction time — required explicitly by
 * DS-F3 (#158) so every manifest's `harnessVersion` reflects the real
 * installed Devin CLI, never a literal. `createDevinHarnessProfile` is
 * exported so tests and callers that need a specific version (e.g. when
 * `devin` isn't installed in CI) can construct one without shelling out.
 */
export function createDevinHarnessProfile(
  harnessVersion: string = resolveDevinCliVersion(),
): HarnessProfile {
  return {
    harness: DEVIN_HARNESS,
    harnessVersion,
    configDir: (env) => resolveDevinConfigDir(env),
    captureAllowlist: DEVIN_CAPTURE_ALLOWLIST,
    sessionLayout: DEVIN_SESSION_LAYOUT,
    securityBlocklist: DEVIN_SECURITY_BLOCKLIST,
  };
}

export const DevinHarnessProfile: HarnessProfile = createDevinHarnessProfile();
