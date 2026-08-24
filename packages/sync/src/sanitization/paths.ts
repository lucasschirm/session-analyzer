/**
 * Path-prefix stripping for uploaded transcripts.
 *
 * Absolute filesystem paths from the authoring machine make stored transcripts
 * impossible to match across environments and leak machine structure. This
 * module rewrites the project-root prefix to "/" (e.g.
 * "/Users/me/dev/repo/.gitignore" -> "/.gitignore") and applies a best-effort
 * home-dir shortening ("$HOME/notes.txt" -> "~/notes.txt") for paths outside
 * the project root.
 *
 * The rewrite is purely textual (guarded regex over the raw content), so it
 * never fails on malformed lines and catches paths wherever they occur — tool
 * parameters, prose, nested subagent entries.
 */

import path from 'node:path';

/** Characters that continue a filesystem path component. A prefix match whose
 * next character is one of these is part of a longer name (e.g. "repo-v2")
 * and must NOT be rewritten. */
const PATH_COMPONENT_CHARS = '[A-Za-z0-9._\\-]';

const NOT_PATH_COMPONENT = `(?!(?:${PATH_COMPONENT_CHARS}))`;

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Normalizes a candidate prefix: resolves relative segments and strips
 * trailing slashes. Returns undefined for values that should never trigger a
 * rewrite (empty, "/", or non-absolute).
 */
function sanitizePrefix(prefix: string | undefined): string | undefined {
  if (!prefix || typeof prefix !== 'string') return undefined;
  const trimmed = prefix.trim();
  if (!trimmed.startsWith('/')) return undefined;
  const normalized = path.normalize(trimmed).replace(/\/+$/, '');
  if (!normalized || normalized === '/') return undefined;
  return normalized;
}

/**
 * Pattern for the project-root prefix. Two alternatives:
 *  - "<root>/" (slash consumed) -> "/" so "<root>/.gitignore" becomes
 *    "/.gitignore", not "//.gitignore"
 *  - "<root>" followed by a non-path character (end of JSON string, whitespace,
 *    punctuation, end of content) -> "/"
 * A following path component char blocks the match so sibling directories such
 * as "<root>-v2" stay intact.
 */
function buildRootPattern(root: string): RegExp {
  const escaped = escapeRegExp(root);
  return new RegExp(`${escaped}/|${escaped}(?!(?:${PATH_COMPONENT_CHARS}|/))`, 'g');
}

/**
 * Pattern for the home-dir prefix (best-effort shortening). A following slash
 * is allowed here because the replacement is "~": "$HOME/sub/x" -> "~/sub/x".
 */
function buildHomePattern(home: string): RegExp {
  return new RegExp(`${escapeRegExp(home)}${NOT_PATH_COMPONENT}`, 'g');
}

/**
 * Rewrites machine-specific path prefixes inside transcript content.
 *
 * @param content raw transcript text (JSONL or otherwise)
 * @param projectRoot absolute project root to strip (e.g. the session cwd);
 *   missing, relative, or "/" values disable the rewrite
 * @param homeDir absolute home directory for best-effort shortening of
 *   out-of-project paths; applied after the project-root pass
 */
export function normalizeTranscriptPaths(
  content: string,
  projectRoot?: string,
  homeDir?: string,
): string {
  let result = content;

  const root = sanitizePrefix(projectRoot);
  if (root) {
    result = result.replace(buildRootPattern(root), '/');
  }

  const home = sanitizePrefix(homeDir);
  if (home && home !== root) {
    result = result.replace(buildHomePattern(home), '~');
  }

  return result;
}

/**
 * Delta variant used by the incremental transcript watcher.
 *
 * Watcher deltas are byte-offset reads and may end mid-line while the writer
 * is still appending. A prefix match at the very end of such a fragment cannot
 * inspect the real following character (the lookahead would wrongly accept an
 * end-of-fragment boundary), so normalization is limited to the complete-line
 * region and any trailing partial line is passed through untouched. This can
 * at worst miss a rewrite; it can never corrupt content or split a path.
 */
export function normalizeTranscriptDelta(
  content: string,
  projectRoot?: string,
  homeDir?: string,
): string {
  const lastNewline = content.lastIndexOf('\n');
  if (lastNewline === -1) {
    return content;
  }
  return (
    normalizeTranscriptPaths(content.slice(0, lastNewline + 1), projectRoot, homeDir) +
    content.slice(lastNewline + 1)
  );
}
