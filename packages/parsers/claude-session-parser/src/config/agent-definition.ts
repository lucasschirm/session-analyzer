/**
 * `parseAgentDefinition` — spec §3 (`AgentDefinition`) + §4.
 *
 * Grounded against real files: `~/.claude/agents/*.md`,
 * `~/.claude/plugins/.../agents/*.md` (43 real files surveyed). All 43 carry
 * `name`/`description`; `model` (34/43) and `tools` (30/43) are common;
 * `color` (27/43) and `effort` (7/43, not modeled — falls through to
 * `frontmatter` via its index-signature-free but still lossless capture)
 * are also common. **Correction to the design spec**: it states `tools`
 * and `color` were "not observed in any real file checked" on the machine
 * the spec was written from — re-surveying this machine's corpus today
 * shows both are actually common (30/43 and 27/43 respectively, see
 * counts above), so they are treated here as fully first-class optional
 * fields, not unverified ones. `memory` was seen in only 1/43 real files
 * despite being called out as "consistently" present in the spec — kept as
 * specified regardless, since the type already requires it be optional.
 *
 * See spec: docs/superpowers/specs/2026-08-12-claude-session-parser-design.md
 */

import type { ClaudeScope, ParseError } from '../types/common.js';
import type { AgentDefinition } from '../types/config.js';
import { parseFrontmatter } from '../utils/frontmatter.js';
import { stripBom } from '../utils/text.js';
import { makeParseError } from '../utils/errors.js';

export function parseAgentDefinition(content: string, sourcePath?: string, scope?: ClaudeScope): AgentDefinition {
  const stripped = stripBom(content ?? '');
  const { frontmatter, body } = parseFrontmatter(stripped);
  const parseErrors: ParseError[] = [];

  if (hasUnterminatedFrontmatterBlock(stripped)) {
    parseErrors.push(
      makeParseError(
        'unterminated_frontmatter',
        'Frontmatter block opened with "---" but was never closed; the entire file was treated as body.',
        { rawSnippet: clip(stripped) },
      ),
    );
  }

  let name: string;
  const rawName = frontmatter.name;
  if (typeof rawName === 'string' && rawName.trim().length > 0) {
    name = rawName.trim();
  } else if (sourcePath) {
    name = basenameWithoutExt(sourcePath);
    parseErrors.push(
      makeParseError(
        'missing_name_fallback',
        `Agent definition frontmatter has no "name"; falling back to the source path basename "${name}".`,
      ),
    );
  } else {
    name = '';
    parseErrors.push(
      makeParseError(
        'missing_name',
        'Agent definition frontmatter has no "name" and no sourcePath was supplied to fall back to; name is empty.',
      ),
    );
  }

  const description = typeof frontmatter.description === 'string' ? frontmatter.description : undefined;
  const model = typeof frontmatter.model === 'string' ? frontmatter.model : undefined;
  const memory =
    typeof frontmatter.memory === 'string' ? (frontmatter.memory as AgentDefinition['memory']) : undefined;
  const tools = normalizeToolsField(frontmatter.tools);
  const color = typeof frontmatter.color === 'string' ? frontmatter.color : undefined;

  return {
    kind: 'agent-definition',
    sourcePath,
    scope: scope ?? inferScopeFromPath(sourcePath),
    name,
    description,
    model,
    memory,
    tools,
    color,
    frontmatter,
    body,
    parseErrors,
  };
}

// ---------------------------------------------------------------------------
// Local helpers — duplicated (not shared) across the three config/*-definition
// files on purpose: this task owns exactly those three files plus its own
// test file, and the AGENT_BRIEF's file-ownership rule forbids introducing a
// new shared util file that other parallel agents don't know about. Each
// helper is small enough that the duplication cost is low.
// ---------------------------------------------------------------------------

/** Detects the specific malformed-input shape where a file opens a `---`
 *  frontmatter block but never closes it — `parseFrontmatter` already
 *  degrades this gracefully (`frontmatter: {}`, `body` = the whole file),
 *  but silently degrading isn't the same as recording it: this lets
 *  `parseAgentDefinition` surface a `ParseError` for genuinely malformed
 *  input while a plain prose file (no `---` at all) stays error-free. */
function hasUnterminatedFrontmatterBlock(content: string): boolean {
  if (!content) return false;
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  if (lines[0]?.trim() !== '---') return false;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') return false;
  }
  return true;
}

function clip(text: string, max = 200): string {
  return text.length > max ? text.slice(0, max) : text;
}

/** String-only basename-without-extension — no `path` module (package has
 *  zero Node API access; see AGENT_BRIEF "Engineering constraints"). */
function basenameWithoutExt(sourcePath: string): string {
  const normalized = sourcePath.replace(/\\/g, '/');
  const segments = normalized.split('/').filter((s) => s.length > 0);
  const last = segments[segments.length - 1] ?? '';
  return last.replace(/\.md$/i, '');
}

/**
 * Infers `ClaudeScope` from a source path via string inspection only (no
 * `path`/`fs`). Precedence, most-specific first:
 *   1. `'plugin'` — path contains a `/plugins/` segment. Checked *first*
 *      because installed-plugin config also lives under a home `.claude`
 *      root (`~/.claude/plugins/...`), which would otherwise also satisfy
 *      the `'user'` pattern below.
 *   2. `'user'` — `.claude` sits directly under a home-directory segment:
 *      `/Users/<name>/.claude/...`, `/home/<name>/.claude/...`, or a
 *      literal `~/.claude/...`.
 *   3. `'project'` — `.claude` appears anywhere else in the path (nested
 *      inside a repo/worktree checkout). Also the default for a bare
 *      relative path like `.claude/agents/foo.md`, since a relative path
 *      carries no home-directory evidence either way.
 *   4. `'unknown'` — no `.claude` segment found at all, or no sourcePath.
 */
function inferScopeFromPath(sourcePath: string | undefined): ClaudeScope {
  if (!sourcePath) return 'unknown';
  const normalized = sourcePath.replace(/\\/g, '/');
  if (/(^|\/)plugins\//.test(normalized)) return 'plugin';
  if (/^~\/\.claude\//.test(normalized) || /(^|\/)(Users|home)\/[^/]+\/\.claude\//.test(normalized)) return 'user';
  if (/(^|\/)\.claude\//.test(normalized)) return 'project';
  return 'unknown';
}

const ALL_TOOLS_SENTINEL = '*';

/**
 * Normalizes `tools`/`allowed-tools` frontmatter into `string[]`. Real
 * files use three distinct forms: a YAML list (block or inline), a bare
 * comma-separated scalar (`"Read, Glob, Grep, Bash"`), or the literal
 * all-tools sentinel spelled either `"*"` or the human-readable
 * `"All tools"`. Both all-tools spellings normalize to the single-element
 * array `['*']` — callers detect "all tools" by checking
 * `tools?.length === 1 && tools[0] === '*'` rather than needing to know
 * both source spellings.
 */
function normalizeToolsField(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (Array.isArray(raw)) {
    const items = raw.map((v) => String(v).trim()).filter((v) => v.length > 0);
    return items.length > 0 ? items : undefined;
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return undefined;
    if (trimmed === ALL_TOOLS_SENTINEL || trimmed.toLowerCase() === 'all tools') {
      return [ALL_TOOLS_SENTINEL];
    }
    return trimmed
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  return undefined;
}
