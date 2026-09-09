import type { SessionLayoutDescriptor } from '@lucasschirm/sal-sync-core';

/**
 * Storage-relative name for the main transcript file within the `session`
 * scope. The on-disk filename is `<sessionId>.jsonl`, but the S3 key already
 * includes the sessionId at `<projectId>/<sessionId>/...`, so a fixed name
 * avoids repeating the sessionId in the key.
 */
export const MAIN_TRANSCRIPT_STORAGE_NAME = 'transcript.jsonl';

/** On-disk main transcript filename convention: `<sessionId>.jsonl`. */
export const MAIN_TRANSCRIPT_FILE_PATTERN = '{sessionId}.jsonl';

export const SUBAGENT_TRANSCRIPTS_PATTERN = 'subagents/*.jsonl';
export const SUBAGENT_META_PATTERN = 'subagents/*.meta.json';

/**
 * Claude Code's session transcript layout: `<sessionId>.jsonl` on disk with a
 * per-session `subagents/` directory of subagent transcripts + metadata
 * sidecars. This is plain data (not a `HarnessProfile`), reused by
 * `ClaudeHarnessProfile` (`packages/plugins/claude-session-sync`) and by this
 * package's own default fallback (`DEFAULT_HARNESS_PROFILE` in
 * `./default-profile.js`) so `packages/sync`'s golden-behavior discovery
 * tests can exercise the real Claude layout without depending on the plugin
 * package.
 */
export const CLAUDE_SESSION_LAYOUT: SessionLayoutDescriptor = {
  mainTranscriptStorageName: MAIN_TRANSCRIPT_STORAGE_NAME,
  mainTranscriptFilePattern: MAIN_TRANSCRIPT_FILE_PATTERN,
  subagentTranscriptsPattern: SUBAGENT_TRANSCRIPTS_PATTERN,
  subagentMetaPattern: SUBAGENT_META_PATTERN,
};
