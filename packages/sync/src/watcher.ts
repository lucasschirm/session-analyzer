import { WATCHER_MATCHER_VERSION } from './versions.js';

export interface WatcherMatcher {
  baseDirectory: string;
  allowedRelativePatterns: readonly string[];
}

export const WATCHER_TRANSCRIPT_PATTERN = '*.jsonl';
export const WATCHER_SUBAGENT_TRANSCRIPT_PATTERN = 'subagents/*.jsonl';

export const WATCHER_ALLOWED_PATTERNS: readonly string[] = [
  WATCHER_TRANSCRIPT_PATTERN,
  WATCHER_SUBAGENT_TRANSCRIPT_PATTERN,
];

export const DEFAULT_WATCHER_MATCHER: WatcherMatcher = {
  baseDirectory: '',
  allowedRelativePatterns: WATCHER_ALLOWED_PATTERNS,
};

export { WATCHER_MATCHER_VERSION };
