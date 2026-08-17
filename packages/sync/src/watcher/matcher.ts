import fs from 'node:fs';
import path from 'node:path';

import { isPathWithinRoot } from '../discovery/paths.js';
import {
  DEFAULT_WATCHER_MATCHER,
  WATCHER_ALLOWED_PATTERNS,
  type WatcherMatcher,
} from './contract.js';

export type { WatcherMatcher };
export { DEFAULT_WATCHER_MATCHER, WATCHER_ALLOWED_PATTERNS };

/**
 * Convert a simple glob pattern (using `*` and `?`) into a regular expression.
 * Path separators are treated literally; wildcards do not cross directory
 * boundaries, so `subagents/*.jsonl` only matches direct children of the
 * `subagents` directory.
 */
export function globToRegExp(pattern: string): RegExp {
  let regex = '^';
  for (const char of pattern) {
    if (char === '*') {
      regex += '[^/]*';
    } else if (char === '?') {
      regex += '[^/]';
    } else if (/[.+^${}()|[\]\\]/.test(char)) {
      regex += `\\${char}`;
    } else if (char === '/') {
      regex += '/';
    } else {
      regex += char;
    }
  }
  regex += '$';
  return new RegExp(regex);
}

/**
 * Build a matcher that watches only files beneath `baseDirectory` which match
 * the supplied relative patterns.
 */
export function createWatcherMatcher(
  baseDirectory: string,
  allowedRelativePatterns: readonly string[] = WATCHER_ALLOWED_PATTERNS,
): WatcherMatcher {
  const resolved = path.resolve(baseDirectory);
  try {
    return {
      baseDirectory: fs.realpathSync(resolved),
      allowedRelativePatterns,
    };
  } catch {
    return {
      baseDirectory: resolved,
      allowedRelativePatterns,
    };
  }
}

function resolveAndRealpath(filePath: string): string {
  const resolved = path.resolve(filePath);
  const parts: string[] = [];
  let current = resolved;

  // Walk up to the nearest existing ancestor so the matcher correctly
  // handles non-existent expected paths (e.g. `subagents/agent-1.jsonl`
  // before it is created) and normalizes `/var` -> `/private` symlinks
  // on macOS.
  while (true) {
    try {
      const realPath = fs.realpathSync(current);
      return parts.length === 0 ? realPath : path.join(realPath, ...parts.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        return resolved;
      }
      parts.push(path.basename(current));
      current = parent;
    }
  }
}

function patternRegexes(matcher: WatcherMatcher): RegExp[] {
  return matcher.allowedRelativePatterns.map((pattern) => globToRegExp(pattern));
}

/**
 * Return the relative path from the matcher base if the resolved file path is
 * within the base directory and matches one of the allowed patterns. Returns
 * `undefined` for paths outside the base, non-matching names, or paths which
 * resolve elsewhere (e.g. a symlink pointing outside the tree).
 */
export function getWatchedRelativePath(
  matcher: WatcherMatcher,
  filePath: string,
): string | undefined {
  const resolved = resolveAndRealpath(filePath);
  const base = path.resolve(matcher.baseDirectory);

  if (!isPathWithinRoot(resolved, base)) {
    return undefined;
  }

  const relative = path.relative(base, resolved).replace(/\\/g, '/');
  if (relative === '' || relative.startsWith('..') || relative.startsWith('/')) {
    return undefined;
  }

  const regexes = patternRegexes(matcher);
  if (!regexes.some((regex) => regex.test(relative))) {
    return undefined;
  }

  return relative;
}

/** Quick boolean check for whether a file path should be watched. */
export function isPathWatched(matcher: WatcherMatcher, filePath: string): boolean {
  return getWatchedRelativePath(matcher, filePath) !== undefined;
}
