import type { CaptureAllowlist } from './allowlist.js';

/**
 * Describes where a harness stores a session's transcript files on disk and
 * what those files are called once uploaded to storage. Generalizes the
 * Claude Code convention (`<sessionId>.jsonl` on disk, `transcript.jsonl` in
 * storage, `subagents/*.jsonl` + `subagents/*.meta.json` sidecars) so other
 * harnesses (e.g. Devin) can describe a different on-disk layout without
 * forking the discovery/watcher engine.
 */
export interface SessionLayoutDescriptor {
  /**
   * Storage-relative name for the main transcript artifact within the
   * `session` scope (e.g. `transcript.jsonl`). The S3 key already includes
   * the sessionId at `<projectId>/<sessionId>/...`, so this is a fixed name
   * shared by every session rather than one that repeats the sessionId.
   */
  mainTranscriptStorageName: string;
  /**
   * On-disk main transcript filename convention, with `{sessionId}` as a
   * placeholder (e.g. `{sessionId}.jsonl`). Resolve with
   * {@link resolveMainTranscriptFileName}.
   */
  mainTranscriptFilePattern: string;
  /** Relative glob (rooted at the per-session directory) for subagent transcripts. */
  subagentTranscriptsPattern: string;
  /** Relative glob (rooted at the per-session directory) for subagent metadata sidecars. */
  subagentMetaPattern: string;
}

/**
 * Resolve a `SessionLayoutDescriptor`'s on-disk main transcript filename for
 * a concrete session id.
 */
export function resolveMainTranscriptFileName(
  layout: SessionLayoutDescriptor,
  sessionId: string,
): string {
  return layout.mainTranscriptFilePattern.replace('{sessionId}', sessionId);
}

/**
 * A `HarnessProfile` parameterizes the harness-agnostic sync engine
 * (discovery, the transcript watcher, and the security env blocklist) for a
 * specific coding-agent harness (Claude Code, Devin, ...). It carries no
 * behavior of its own beyond `configDir`; everything else is plain data
 * consumed by `packages/sync`.
 */
export interface HarnessProfile {
  /** Stable harness identity, e.g. `'claude'` or `'devin'`. Feeds the
   * manifest's `harness` field and downstream transformer resolution — see
   * `.agents/rules/manifest-backed-classification.md`. */
  harness: string;
  /** The harness CLI/plugin adapter version, not the harness's own product version. */
  harnessVersion: string;
  /** Resolve the harness's global config directory (e.g. `~/.claude`) from an env record. */
  configDir(env: Record<string, string | undefined>): string;
  /** Workspace/global/session capture allowlist for this harness. */
  captureAllowlist: CaptureAllowlist;
  /** On-disk/storage session transcript layout convention for this harness. */
  sessionLayout: SessionLayoutDescriptor;
  /**
   * Env var names that must never be sourced from a committed settings file
   * for this harness (e.g. storage credentials) — only from `process.env` or
   * an explicitly gitignored local override file.
   */
  securityBlocklist: readonly string[];
}
