/**
 * Detection — spec §4 "Detection" block.
 *
 * `detectClaudeCode` decides whether a blob of text is a Claude Code session
 * transcript (main or subagent). `detectClaudeCodeArtifact` goes further,
 * classifying any Claude Code artifact this package understands: session/
 * subagent transcripts, the `agent-<id>.meta.json` sidecar, and the six
 * config-surface kinds (settings, mcp-config, agent/skill/rule definitions,
 * plugin marketplace).
 *
 * Both are schema-based, never extension-based (repo-wide `AGENTS.md`
 * rule) — every decision below inspects parsed JSON shape or YAML
 * frontmatter keys actually present in `content`. `fileName`/`relativePath`
 * are only ever used as corroborating hints/tiebreaks, never as the primary
 * signal, per this task's brief.
 *
 * See spec: docs/superpowers/specs/2026-08-12-claude-session-parser-design.md
 */

import { parseFrontmatter } from './utils/frontmatter.js';
import { safeJsonParse, stripBom } from './utils/text.js';

export type ClaudeCodeArtifactKind =
  | 'session-transcript'
  | 'subagent-transcript'
  | 'subagent-meta'
  | 'settings'
  | 'mcp-config'
  | 'agent-definition'
  | 'skill-definition'
  | 'rule-definition'
  | 'plugin-marketplace'
  | 'unknown';

// ---------------------------------------------------------------------------
// detectClaudeCode
// ---------------------------------------------------------------------------

/**
 * Real transcripts in the corpus this package was designed against reach
 * 13.68MB, with single JSONL lines up to ~0.68MB (spec §4). Detection must
 * never scale with file size, so every scan below is bounded to a fixed
 * prefix of `content` — `PREFIX_SCAN_CHAR_CAP` (measured in JS string
 * length/UTF-16 code units, a cheap proxy for bytes that's fine for a
 * boolean sniff) comfortably covers several full lines even in the
 * worst-case ~0.68MB single-line scenario, while staying a small, constant
 * fraction of the corpus's largest real file. `PREFIX_SCAN_MAX_LINES` caps
 * the *number* of lines actually JSON.parsed, since real transcripts reveal
 * their tell-tale fields within the first ~10 lines (verified: real
 * corpus files open with `queue-operation`/`mode`/`last-prompt` bookkeeping
 * lines, then a `user` turn by line 3-9) — 40 gives generous headroom
 * without ever approaching a full-file scan.
 */
const PREFIX_SCAN_CHAR_CAP = 1_048_576; // 1 MiB of JS string length
const PREFIX_SCAN_MAX_LINES = 40;

function stripLineEnding(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

/**
 * Walks a bounded prefix of `content` and returns up to
 * `PREFIX_SCAN_MAX_LINES` non-blank lines, CRLF-tolerant. Uses `indexOf`
 * rather than `content.split('\n')` so work stays proportional to the
 * bounded prefix, never the whole (possibly multi-MB) string. The final
 * fragment inside the scanned prefix is only kept as a line if it's the
 * real end of `content` (no trailing newline) — a fragment cut off by the
 * artificial cap is a partial line we can't trust and is dropped rather
 * than fed to `JSON.parse` as if it were complete.
 */
function scanPrefixLines(content: string): string[] {
  const stripped = stripBom(content);
  const limit = Math.min(stripped.length, PREFIX_SCAN_CHAR_CAP);
  const lines: string[] = [];
  let start = 0;

  while (start <= limit && lines.length < PREFIX_SCAN_MAX_LINES) {
    const nl = stripped.indexOf('\n', start);
    if (nl === -1 || nl > limit) {
      if (nl === -1 && limit === stripped.length) {
        const text = stripLineEnding(stripped.slice(start));
        if (text.trim() !== '') lines.push(text);
      }
      break;
    }
    const text = stripLineEnding(stripped.slice(start, nl));
    if (text.trim() !== '') lines.push(text);
    start = nl + 1;
  }

  return lines;
}

/** Parses each bounded-prefix line as JSON, keeping only plain objects
 *  (never arrays/primitives) and silently skipping lines that fail to
 *  parse — a truncated/partial line must never abort detection. */
function scanPrefixEntries(content: string): Array<Record<string, unknown>> {
  const entries: Array<Record<string, unknown>> = [];
  for (const line of scanPrefixLines(content)) {
    const { value } = safeJsonParse<unknown>(line);
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      entries.push(value as Record<string, unknown>);
    }
  }
  return entries;
}

/** The uuid-less "bookkeeping" entry types frozen in `types/session.ts`
 *  (`ModeEntry`, `AiTitleEntry`, `LastPromptEntry`, `PermissionModeEntry`,
 *  `AgentNameEntry`, `PrLinkEntry`, `BridgeSessionEntry`,
 *  `QueueOperationEntry`, `FileHistorySnapshotEntry`,
 *  `FileHistoryDeltaEntry`, `RelocatedEntry`, `WorktreeStateEntry`,
 *  `SummaryEntry`). The brief calls out `ai-title`/`last-prompt`/`pr-link`/
 *  `file-history-snapshot` as examples of this tell; the full uuid-less
 *  union is used here because real transcripts routinely *open* with other
 *  members of this same set (`queue-operation`, `mode`) before the first
 *  uuid-bearing turn — verified against the real corpus, where line 1 is
 *  `queue-operation` or `mode` far more often than not. Restricting to only
 *  the four examples would under-detect files that happen to get truncated
 *  right after their bookkeeping preamble, for no gain in precision (none
 *  of these type strings appear in any of the other five supported
 *  formats). */
const BOOKKEEPING_ENTRY_TYPES = new Set([
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

function looksLikeClaudeCodeEntry(obj: Record<string, unknown>): boolean {
  const type = obj.type;
  if (typeof type !== 'string' || type.length === 0) return false;

  const sessionId = obj.sessionId;
  if (typeof sessionId !== 'string' || sessionId.length === 0) return false;

  // Primary tell (spec §4 / this task's brief): every entry in
  // `ClaudeCodeEntryBase` carries `uuid` + `parentUuid` (even when
  // `parentUuid` is `null`, the key is always present) alongside
  // `sessionId` + `type`.
  if (typeof obj.uuid === 'string' && obj.uuid.length > 0 && 'parentUuid' in obj) {
    return true;
  }

  // The uuid-less bookkeeping entry types — equally distinctive, see the
  // set's doc comment above.
  if (BOOKKEEPING_ENTRY_TYPES.has(type)) return true;

  // Softer fallback: a `user`/`assistant`/`system`/`attachment` turn with
  // `sessionId` + `uuid` but (unusually) no `parentUuid` key. Every real
  // Claude Code transcript writes `parentUuid`, but this repo's own
  // simplified test fixtures (`packages/site/tests/e2e/fixtures/
  // claude-session.jsonl`) omit it while still being genuine Claude Code
  // content — this fallback keeps detection working there too. Still
  // unambiguous against the other five formats: none of them combine
  // `sessionId` + `uuid` + one of these four `type` values (verified
  // against every fixture under `packages/site/tests/e2e/fixtures/`).
  if (
    (type === 'user' || type === 'assistant' || type === 'system' || type === 'attachment') &&
    typeof obj.uuid === 'string' &&
    obj.uuid.length > 0
  ) {
    return true;
  }

  return false;
}

export function detectClaudeCode(content: string): boolean {
  if (typeof content !== 'string' || content.trim() === '') return false;

  for (const entry of scanPrefixEntries(content)) {
    if (looksLikeClaudeCodeEntry(entry)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// detectClaudeCodeArtifact
// ---------------------------------------------------------------------------

function normalizePath(input: { fileName?: string; relativePath?: string }): string {
  return (input.relativePath ?? input.fileName ?? '').replace(/\\/g, '/');
}

/** Subagent transcripts carry `isSidechain: true` and/or a non-empty
 *  `agentId` on every line (verified: real subagent transcripts on this
 *  machine carry `"isSidechain":true` on literally every entry; real main
 *  transcripts never carry `isSidechain:true` anywhere). Content is
 *  checked first; `subagents/` in the path is only a tiebreak for the rare
 *  case content is inconclusive (e.g. a prefix-only scan that happened not
 *  to reach a signal-bearing line). */
function classifyTranscript(content: string, path: string): ClaudeCodeArtifactKind {
  let sawSubagentSignal = false;
  for (const entry of scanPrefixEntries(content)) {
    if (entry.isSidechain === true) {
      sawSubagentSignal = true;
      break;
    }
    if (typeof entry.agentId === 'string' && entry.agentId.length > 0) {
      sawSubagentSignal = true;
      break;
    }
  }

  if (sawSubagentSignal) return 'subagent-transcript';
  if (/(^|\/)subagents\//.test(path)) return 'subagent-transcript';
  return 'session-transcript';
}

// ---- JSON config kinds -----------------------------------------------------

/** Keys that only ever appear on `ClaudeCodeSettings` in the real corpus —
 *  deliberately excludes the bare `model` key, since real
 *  `agent-<id>.meta.json` sidecars also carry a `model` field (e.g.
 *  `"sonnet"`) and `model` alone would make the two shapes ambiguous. */
const SETTINGS_ONLY_KEYS = [
  'permissions',
  'hooks',
  'env',
  'enabledPlugins',
  'extraKnownMarketplaces',
  'sandbox',
  'tui',
  'statusLine',
  'effortLevel',
];

function isSettingsShape(obj: Record<string, unknown>): boolean {
  return SETTINGS_ONLY_KEYS.some((key) => key in obj);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** `McpConfig`: a `{ mcpServers: {...} }` wrapper (the shape every real
 *  `.mcp.json` on this machine uses), or — per spec §3 — a bare
 *  server-name -> server-config map with no wrapper key. The bare-map
 *  branch requires every value look like a real `McpServerConfig` (has a
 *  `command` or `url`), so it can't accidentally swallow unrelated objects. */
function isMcpConfigShape(obj: Record<string, unknown>): boolean {
  if (isPlainObject(obj.mcpServers)) return true;

  const keys = Object.keys(obj);
  if (keys.length === 0) return false;
  return keys.every((key) => {
    const value = obj[key];
    return (
      isPlainObject(value) && (typeof value.command === 'string' || typeof value.url === 'string')
    );
  });
}

/** `PluginMarketplace`: top-level `name` + a `plugins` array whose entries
 *  (when present) carry `name`/`source` — matches every real
 *  `.claude-plugin/marketplace.json` on this machine. `source` accepts
 *  either shape `parsePluginMarketplace`'s `normalizeSource` supports: a
 *  plain string (a local relative path) or an object (a remote git
 *  reference, e.g. `{ source: "git-subdir", url, path }`) — real files use
 *  both. Requiring a bare string here would misclassify a legitimate
 *  object-form-source marketplace file as `'unknown'`. */
function isPluginMarketplaceShape(obj: Record<string, unknown>): boolean {
  if (typeof obj.name !== 'string' || !Array.isArray(obj.plugins)) return false;
  return obj.plugins.every(
    (item) =>
      isPlainObject(item) &&
      typeof item.name === 'string' &&
      (typeof item.source === 'string' || isPlainObject(item.source)),
  );
}

/** `SubagentMeta` (`agent-<id>.meta.json`): every key present must be one
 *  of the five real fields, and at least one *distinctive* one (not just
 *  the shared `model` key — see `SETTINGS_ONLY_KEYS` comment) must be
 *  present. Checked last, after the more structurally distinctive config
 *  kinds, so a config file that happens to be misnamed `agent-<x>.meta.json`
 *  (the filename trap flagged in spec §6 site follow-up item 4) is
 *  classified by its actual JSON shape, never by that filename. */
const SUBAGENT_META_KEYS = new Set([
  'agentType',
  'description',
  'toolUseId',
  'spawnDepth',
  'model',
]);

function isSubagentMetaShape(obj: Record<string, unknown>): boolean {
  const keys = Object.keys(obj);
  if (keys.length === 0) return false;
  const allRecognized = keys.every((key) => SUBAGENT_META_KEYS.has(key));
  const hasDistinctiveKey = keys.some((key) => key !== 'model');
  return allRecognized && hasDistinctiveKey;
}

/**
 * Classifies a single-document JSON blob (settings / mcp-config /
 * plugin-marketplace / subagent-meta). Not bounded/prefix-scanned like
 * `detectClaudeCode` — these are always small, hand-authored config files
 * (never the multi-MB transcripts), so a full `JSON.parse` is appropriate
 * and cheap.
 */
function classifyJsonConfig(content: string): ClaudeCodeArtifactKind {
  const trimmed = stripBom(content).trim();
  if (!trimmed.startsWith('{')) return 'unknown';

  const { value } = safeJsonParse<unknown>(trimmed);
  if (!isPlainObject(value)) return 'unknown';

  if (isPluginMarketplaceShape(value)) return 'plugin-marketplace';
  if (isSettingsShape(value)) return 'settings';
  if (isMcpConfigShape(value)) return 'mcp-config';
  if (isSubagentMetaShape(value)) return 'subagent-meta';
  return 'unknown';
}

// ---- Markdown/frontmatter kinds --------------------------------------------

/** Frontmatter keys observed in the real corpus to appear on agent
 *  definitions and *never* on skill definitions (`model`/`color` are
 *  always present on real agent `.md` files; `memory` is agent-only per
 *  spec §3). Deliberately excludes the bare `tools` key — real skills
 *  sometimes also declare `tools:` (e.g.
 *  `claude-automation-recommender/SKILL.md`), so it isn't a reliable
 *  agent-only signal on its own. */
const AGENT_ONLY_FRONTMATTER_KEYS = ['model', 'color', 'memory'];

/** Frontmatter keys observed to appear on real skill definitions and never
 *  on real agent definitions. */
const SKILL_ONLY_FRONTMATTER_KEYS = ['metadata', 'allowed-tools', 'user-invocable'];

/** Rule frontmatter's glob-scoping keys (spec §3 `RuleFrontmatter`/
 *  `normalizeGlobs`) — present on `.claude/rules/*.md` files, absent from
 *  agent/skill definitions (which never scope by file glob). */
const RULE_SIGNAL_FRONTMATTER_KEYS = ['globs', 'paths'];

function hasAnyKey(fm: Record<string, unknown>, keys: string[]): boolean {
  return keys.some((key) => key in fm);
}

/**
 * Classifies markdown content into one of the three definition kinds.
 * Content (frontmatter shape) is checked first; `path` is only a
 * corroborating hint/tiebreak, per this task's brief — matching the real
 * on-disk conventions (an `agents` directory member, a `SKILL.md` nested
 * under a `skills` directory, a `rules` directory member, or a bare
 * `CLAUDE.md`/`AGENTS.md`).
 */
function classifyMarkdown(content: string, path: string): ClaudeCodeArtifactKind {
  const trimmed = stripBom(content).trimStart();
  // Never guess a markdown kind out of content that's actually JSON-shaped
  // (it already failed `classifyJsonConfig`, so it's some other/unknown
  // JSON shape — not a definition file).
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return 'unknown';

  const { frontmatter } = parseFrontmatter(content);
  const lowerPath = path.toLowerCase();

  // Reserved memory-file basenames win over any directory they happen to
  // sit in (e.g. `~/.claude/agents/AGENTS.md` is a folder-inventory memory
  // doc, not an agent definition, despite living under `agents/`).
  const isMemoryFileName = /(^|\/)(claude|agents)\.md$/.test(lowerPath);
  if (isMemoryFileName) return 'rule-definition';

  const hasAgentSignal = hasAnyKey(frontmatter, AGENT_ONLY_FRONTMATTER_KEYS);
  const hasSkillSignal = hasAnyKey(frontmatter, SKILL_ONLY_FRONTMATTER_KEYS);
  const hasRuleSignal = hasAnyKey(frontmatter, RULE_SIGNAL_FRONTMATTER_KEYS);

  if (hasSkillSignal && !hasAgentSignal) return 'skill-definition';
  if (hasAgentSignal && !hasSkillSignal) return 'agent-definition';
  if (hasRuleSignal) return 'rule-definition';

  // Frontmatter was ambiguous (e.g. bare `name`+`description`, common to
  // both agents and skills, or no frontmatter at all — rule/memory files
  // routinely carry none) or absent — fall back to the real on-disk path
  // convention.
  if (/(^|\/)skills\/[^/]+\/skill\.md$/.test(lowerPath)) return 'skill-definition';
  if (/(^|\/)agents\/[^/]+\.md$/.test(lowerPath)) return 'agent-definition';
  if (/(^|\/)rules\/.*\.md$/.test(lowerPath)) return 'rule-definition';

  return 'unknown';
}

export function detectClaudeCodeArtifact(input: {
  content: string;
  fileName?: string;
  relativePath?: string;
}): ClaudeCodeArtifactKind {
  if (!input || typeof input.content !== 'string' || input.content.trim() === '') {
    return 'unknown';
  }

  const path = normalizePath(input);

  if (detectClaudeCode(input.content)) {
    return classifyTranscript(input.content, path);
  }

  const jsonKind = classifyJsonConfig(input.content);
  if (jsonKind !== 'unknown') return jsonKind;

  return classifyMarkdown(input.content, path);
}
