/**
 * `parseSessionTranscript` — spec §1 + §4. Parses one Claude Code JSONL
 * session transcript (already read into a string by the caller) into a
 * `ClaudeCodeSession`. Never throws — malformed lines land in `parseErrors`.
 *
 * See spec: docs/superpowers/specs/2026-08-12-claude-session-parser-design.md
 */

import { stripBom, splitLines, safeJsonParse, clampBlob } from '../utils/text.js';
import { makeParseError } from '../utils/errors.js';
import { parseEntry } from './entry-parsers.js';
import { accumulateUsage } from './aggregate-usage.js';
import { deriveTimelines, emptyTimelines } from './timelines/index.js';
import type { ParseError, ParseOptions } from '../types/common.js';
import type { ClaudeCodeEntry, ClaudeCodeSession, UnknownEntry } from '../types/session.js';

/** Real transcript lines reach ~0.68MB (spec §4) — a ParseError's rawSnippet
 *  must stay short, not echo the whole offending line. */
const RAW_SNIPPET_MAX_BYTES = 200;

/** Every literal `type` value in the `ClaudeCodeEntry` union except
 *  `UnknownEntry` (whose `type` is plain `string`, forward-compatible). */
const KNOWN_ENTRY_TYPES = new Set<string>([
  'assistant',
  'user',
  'system',
  'attachment',
  'mode',
  'permission-mode',
  'ai-title',
  'last-prompt',
  'agent-name',
  'pr-link',
  'bridge-session',
  'queue-operation',
  'file-history-snapshot',
  'file-history-delta',
  'relocated',
  'worktree-state',
  'summary',
]);

/** `UnknownEntry.type` is typed as plain `string`, so it structurally
 *  overlaps every literal type in the union — a bare `entry.type === 'x'`
 *  equality check can never fully rule it out for TypeScript's narrowing.
 *  This predicate excludes it explicitly so the root-field-folding switch
 *  below narrows cleanly to the known entry types. */
function isKnownEntry(entry: ClaudeCodeEntry): entry is Exclude<ClaudeCodeEntry, UnknownEntry> {
  return KNOWN_ENTRY_TYPES.has(entry.type);
}

export function parseSessionTranscript(content: string, options?: ParseOptions): ClaudeCodeSession {
  const parseErrors: ParseError[] = [];
  const unknownTypes: Record<string, number> = {};
  const entries: ClaudeCodeEntry[] = [];

  // Root singular fields — spec §1.1: "first non-empty value seen wins" for
  // everything except `aiTitle` (last `ai-title` entry wins).
  let sessionId: string | undefined;
  let aiTitle: string | undefined;
  let slug: string | undefined;
  let agentName: string | undefined;
  let cwd: string | undefined;
  let gitBranch: string | undefined;
  let agentId: string | undefined;
  const cliVersions: string[] = [];
  const seenCliVersions = new Set<string>();
  let isSidechain = false;

  const normalized = stripBom(content);
  const lines = splitLines(normalized);

  for (const line of lines) {
    // Skip blank/whitespace-only lines silently — lineNumber already
    // accounts for them via splitLines, so numbering of real entries stays
    // correct against the source file.
    if (line.text.trim() === '') continue;

    const parsed = safeJsonParse<Record<string, unknown>>(line.text);
    if (parsed.error !== undefined) {
      parseErrors.push(
        makeParseError('invalid_json', parsed.error, {
          line: line.lineNumber,
          rawSnippet: clampBlob(line.text, RAW_SNIPPET_MAX_BYTES),
        }),
      );
      continue;
    }

    // A JSON-valid line can still deserialize to something that isn't a
    // transcript entry object (an array, a bare number/string, `null`) —
    // parseEntry is responsible for handling that defensively, never this
    // loop assuming shape.
    const rawValue: Record<string, unknown> = parsed.value ?? {};
    const outcome = parseEntry(rawValue, line.lineNumber, options);

    for (const err of outcome.errors) parseErrors.push(err);
    if (outcome.unknownType !== undefined) {
      unknownTypes[outcome.unknownType] = (unknownTypes[outcome.unknownType] ?? 0) + 1;
    }
    if (!outcome.entry) continue;

    const entry = outcome.entry;
    entries.push(entry);

    // ---- Root singular field folding --------------------------------
    if (!isKnownEntry(entry)) continue;

    if (entry.type === 'ai-title') {
      aiTitle = entry.aiTitle; // last ai-title entry wins
    }
    if (entry.type === 'agent-name' && agentName === undefined && entry.agentName) {
      agentName = entry.agentName;
    }
    if ('sessionId' in entry && typeof entry.sessionId === 'string' && entry.sessionId && sessionId === undefined) {
      sessionId = entry.sessionId;
    }
    if ('slug' in entry && typeof entry.slug === 'string' && entry.slug && slug === undefined) {
      slug = entry.slug;
    }
    if ('cwd' in entry && typeof entry.cwd === 'string' && entry.cwd && cwd === undefined) {
      cwd = entry.cwd;
    }
    if ('gitBranch' in entry && typeof entry.gitBranch === 'string' && entry.gitBranch && gitBranch === undefined) {
      gitBranch = entry.gitBranch;
    }
    if ('agentId' in entry && typeof entry.agentId === 'string' && entry.agentId && agentId === undefined) {
      agentId = entry.agentId;
    }
    if ('version' in entry && typeof entry.version === 'string' && entry.version && !seenCliVersions.has(entry.version)) {
      seenCliVersions.add(entry.version);
      cliVersions.push(entry.version);
    }
    if ('isSidechain' in entry && entry.isSidechain === true) {
      isSidechain = true;
    }
  }

  const aggregateUsage = accumulateUsage(entries);
  const timelines = options?.skipTimelines ? emptyTimelines() : deriveTimelines(entries, options);

  const session: ClaudeCodeSession = {
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(aiTitle !== undefined ? { aiTitle } : {}),
    ...(slug !== undefined ? { slug } : {}),
    ...(agentName !== undefined ? { agentName } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
    ...(gitBranch !== undefined ? { gitBranch } : {}),
    cliVersions,
    isSidechain,
    ...(agentId !== undefined ? { agentId } : {}),
    entries,
    aggregateUsage,
    ...timelines,
    parseErrors,
    unknownTypes,
  };

  return session;
}
