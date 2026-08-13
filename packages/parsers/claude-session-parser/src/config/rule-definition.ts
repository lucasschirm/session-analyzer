/**
 * `parseRuleDefinition` — spec §3 (`RuleDefinition`) + §4.
 *
 * No `.claude/rules` directory (any depth) exists on this machine (surveyed
 * and confirmed empty/absent) — the memory family (`~/.claude/CLAUDE.md`,
 * `<project>/AGENTS.md`) is real and grounded here; the rule family
 * (markdown files nested under `.claude/rules`) is grounded against the
 * spec's own Evidence paragraph plus the real `globs:`/`paths:` frontmatter
 * forms already confirmed by T1's `normalizeGlobs` fixtures
 * (`t1-rule-globs-comma.md`, `t1-rule-paths-list.md`) and this task's own
 * `claude-rule-architect.md` agent, which documents `.claude/rules` with
 * `paths:` frontmatter as the real, current mechanism.
 *
 * See spec: docs/superpowers/specs/2026-08-12-claude-session-parser-design.md
 */

import type { ClaudeScope, ParseError } from '../types/common.js';
import type { RuleDefinition } from '../types/config.js';
import type { RuleFrontmatter } from '../types/timeline.js';
import { parseFrontmatter, normalizeGlobs } from '../utils/frontmatter.js';
import { stripBom } from '../utils/text.js';
import { makeParseError } from '../utils/errors.js';

export function parseRuleDefinition(content: string, sourcePath: string, scope?: ClaudeScope): RuleDefinition {
  const stripped = stripBom(content ?? '');
  const { frontmatter: rawFrontmatter, body } = parseFrontmatter(stripped);
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

  // Always an array, never undefined — normalizeGlobs already merges both
  // real `globs:`/`paths:` forms (bare/quoted/comma scalar, block/inline
  // list) into one `string[]`.
  const globs = normalizeGlobs(rawFrontmatter);
  const description = typeof rawFrontmatter.description === 'string' ? rawFrontmatter.description : undefined;
  // `RuleFrontmatter.globs` is typed `string[]` (already normalized), unlike
  // the raw scalar/list value `rawFrontmatter.globs`/`.paths` may hold — the
  // literal below deliberately overrides those raw keys with the normalized
  // array so the returned `frontmatter` matches its declared type, while
  // every other unknown key (including `paths` itself) survives losslessly
  // via the index signature.
  const frontmatter: RuleFrontmatter = { ...rawFrontmatter, description, globs };

  const ruleKind = inferRuleKind(sourcePath);
  const title = deriveTitle(body, rawFrontmatter, sourcePath);

  return {
    kind: 'rule-definition',
    sourcePath,
    scope: scope ?? inferScopeFromPath(sourcePath),
    title,
    ruleKind,
    frontmatter,
    globs,
    body,
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

/**
 * Discriminates the two real families named in the spec, from `sourcePath`
 * alone (the caller-required argument for this parser):
 *   - `'memory'` — the file's basename is `CLAUDE.md`/`AGENTS.md`, or a
 *     same-family variant like `CLAUDE.local.md`/`AGENTS.project.md`
 *     (matched case-insensitively — real filenames are consistently
 *     uppercase, but nothing in Claude Code enforces that).
 *   - `'rule'` — the path runs through a `.claude/rules/` directory.
 *   - Fallback: `'rule'`. `parseRuleDefinition` is only ever invoked for a
 *     file already known to be a rule/memory definition (see
 *     `detectClaudeCodeArtifact`'s `'rule-definition'` bucket), so an
 *     sourcePath matching neither known pattern defaults to the more
 *     general `'rule'` family rather than silently mislabeling it as the
 *     narrower, name-specific `'memory'` family.
 */
function inferRuleKind(sourcePath: string): 'memory' | 'rule' {
  const normalized = sourcePath.replace(/\\/g, '/');
  const segments = normalized.split('/').filter((s) => s.length > 0);
  const basename = segments[segments.length - 1] ?? '';
  if (/^(claude|agents)(\..+)?\.md$/i.test(basename)) return 'memory';
  if (/(^|\/)\.claude\/rules\//.test(normalized)) return 'rule';
  return 'rule';
}

/**
 * Title precedence, per AGENT_BRIEF: (1) the first markdown heading found
 * anywhere in the body (any `#`-`######` level — most real rule/memory
 * files lead with a single top-level `#`, but nothing requires that), else
 * (2) a `title:` frontmatter key, else (3) the sourcePath basename.
 */
function deriveTitle(body: string, rawFrontmatter: Record<string, unknown>, sourcePath: string): string {
  const headingMatch = body.match(/^#{1,6}[ \t]+(.+?)\s*$/m);
  if (headingMatch) return headingMatch[1].trim();
  if (typeof rawFrontmatter.title === 'string' && rawFrontmatter.title.trim().length > 0) {
    return rawFrontmatter.title.trim();
  }
  return basenameWithoutExt(sourcePath);
}
