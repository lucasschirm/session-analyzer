/**
 * `parseSkillDefinition` — spec §3 (`SkillDefinition`) + §4.
 *
 * Grounded against real files: `~/.claude/plugins/.../skills/<name>/SKILL.md`
 * (37 real files surveyed; no user-level `~/.claude/skills/*` directory
 * exists on this machine, only plugin-shipped skills). `name`/`description`
 * are universal (37/37). The real key for allowed-tool scoping is split
 * between `allowed-tools` (8/37, kebab-case, matching the spec's note that
 * "the real key may be `allowed-tools`") and a bare `tools` (2/37) — both
 * are read here, `allowed-tools` taking precedence since it's the more
 * common and more specific real key.
 *
 * See spec: docs/superpowers/specs/2026-08-12-claude-session-parser-design.md
 */

import type { ClaudeScope, ParseError } from '../types/common.js';
import type { SkillDefinition } from '../types/config.js';
import { parseFrontmatter } from '../utils/frontmatter.js';
import { stripBom } from '../utils/text.js';
import { makeParseError } from '../utils/errors.js';

export function parseSkillDefinition(content: string, sourcePath?: string, scope?: ClaudeScope): SkillDefinition {
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
        `Skill definition frontmatter has no "name"; falling back to the source path basename "${name}".`,
      ),
    );
  } else {
    name = '';
    parseErrors.push(
      makeParseError(
        'missing_name',
        'Skill definition frontmatter has no "name" and no sourcePath was supplied to fall back to; name is empty.',
      ),
    );
  }

  const description = typeof frontmatter.description === 'string' ? frontmatter.description : undefined;
  // `allowed-tools` is the more common/specific real key (see file header);
  // a bare `tools` is accepted as a fallback for the rarer real files that
  // use it instead.
  const allowedToolsRaw = 'allowed-tools' in frontmatter ? frontmatter['allowed-tools'] : frontmatter.tools;
  const allowedTools = normalizeToolsField(allowedToolsRaw);
  const pluginPrefix = derivePluginPrefix(name, sourcePath);

  return {
    kind: 'skill-definition',
    sourcePath,
    scope: scope ?? inferScopeFromPath(sourcePath),
    name,
    description,
    pluginPrefix,
    allowedTools,
    frontmatter,
    body,
    // `supportingFiles` is intentionally left unset: this package has zero
    // filesystem access (no `fs`, no directory listing — see AGENT_BRIEF
    // "Engineering constraints"), so it cannot discover a skill directory's
    // sibling files on its own. A caller that already knows the directory
    // listing (e.g. a browser upload of a whole `.claude/skills/<name>/`
    // folder) supplies `supportingFiles` itself when composing/enriching
    // this result — inventing filesystem access here would violate the
    // package's zero-I/O, pure-function contract.
    parseErrors,
  };
}

// ---------------------------------------------------------------------------
// Local helpers — duplicated (not shared) across the three config/*-definition
// files on purpose: see the matching comment in `agent-definition.ts` for why.
// ---------------------------------------------------------------------------

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

function basenameWithoutExt(sourcePath: string): string {
  const normalized = sourcePath.replace(/\\/g, '/');
  const segments = normalized.split('/').filter((s) => s.length > 0);
  const last = segments[segments.length - 1] ?? '';
  return last.replace(/\.md$/i, '');
}

function inferScopeFromPath(sourcePath: string | undefined): ClaudeScope {
  if (!sourcePath) return 'unknown';
  const normalized = sourcePath.replace(/\\/g, '/');
  if (/(^|\/)plugins\//.test(normalized)) return 'plugin';
  if (/^~\/\.claude\//.test(normalized) || /(^|\/)(Users|home)\/[^/]+\/\.claude\//.test(normalized)) return 'user';
  if (/(^|\/)\.claude\//.test(normalized)) return 'project';
  return 'unknown';
}

const ALL_TOOLS_SENTINEL = '*';

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

/**
 * Derives `pluginPrefix`, in precedence order:
 *   1. A `plugin:skill`-style qualified `name` in frontmatter — e.g.
 *      `name: "pep:custom-skill"` — split on the first `:`. Not observed in
 *      the real corpus (every real `SKILL.md` uses a bare `name:`), but the
 *      spec calls this form out explicitly, so it's handled defensively as
 *      the higher-precedence signal when it does occur.
 *   2. `sourcePath` matching the confirmed real layout
 *      `.../plugins/<plugin>/skills/<skill>/SKILL.md` (e.g.
 *      `~/.claude/plugins/marketplaces/<marketplace>/plugins/<plugin>/
 *      skills/<skill>/SKILL.md`) — `<plugin>` is captured from the segment
 *      directly between `plugins/` and `skills/`. Does **not** resolve the
 *      `plugins/cache/<marketplace>/<plugin>-<version>/skills/...`
 *      cache-variant layout (no direct `plugins/<name>/skills/` adjacency
 *      there) — left undefined in that case rather than guessing.
 *   3. Otherwise undefined.
 */
function derivePluginPrefix(name: string, sourcePath: string | undefined): string | undefined {
  const colonIdx = name.indexOf(':');
  if (colonIdx > 0) {
    return name.slice(0, colonIdx);
  }
  if (sourcePath) {
    const normalized = sourcePath.replace(/\\/g, '/');
    const match = normalized.match(/\/plugins\/([^/]+)\/skills\//);
    if (match) return match[1];
  }
  return undefined;
}
