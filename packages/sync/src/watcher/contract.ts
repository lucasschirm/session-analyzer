export interface WatcherMatcher {
  baseDirectory: string;
  allowedRelativePatterns: readonly string[];
}

export const WATCHER_SUBAGENT_TRANSCRIPTS_PATTERN = 'subagents/*.jsonl';
export const WATCHER_SUBAGENT_META_PATTERN = 'subagents/*.meta.json';

export const DEFAULT_WATCHER_MATCHER: WatcherMatcher = {
  baseDirectory: '',
  allowedRelativePatterns: [],
};
