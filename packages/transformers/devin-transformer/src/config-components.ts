import type {
  ClassifiedArtifact,
  ComponentSummary,
  Issue,
} from '@lucasschirm/sal-transformer-shared';
import { artifactIdFor, normalizeSlashes, toTextContent } from './classification.js';
import { componentIdentity } from './session-components.js';
import { stableId } from './session-spine.js';

/**
 * File-backed config component extraction for `.devin/skills|agents|rules/**`,
 * `.devin/hooks.v1.json`, and `plugins/discovered.json` (#342). Unlike
 * `session-components.ts`'s cog-derived components (no backing file, keyed on
 * `stableId(kind, {source, name})`), these have a real path and are keyed on
 * `stableId(kind, {source, scope, path, name})`
 * (`.agents/rules/component-identity-not-display-name.md`) — the same
 * source+path+name convention `claude-transformer`'s `extractSkillComponent`
 * et al. already use (no content hash: renaming/editing a file must not
 * mint a new identity, matching that precedent).
 *
 * Everything here is defensive: a hand-rolled minimal frontmatter reader
 * (Devin's `name`/`description`/`trigger` fields are all flat scalars, not a
 * full YAML parser), never throws (`extractConfigComponents` wraps every
 * call), and degrades to zero components rather than fabricating one from a
 * shape it doesn't recognize. `plugins/discovered.json` in particular has no
 * confirmed real-world sample — its extractor only activates for an
 * unambiguous `{ name, kind }` shape and structurally excludes anything
 * whose kind isn't exactly `skill`/`agent` (never `mcp`/`mcp_server`, per
 * #271's exclusion), pending a real-sample spike.
 */

interface ParsedFrontmatter {
  readonly fields: Readonly<Record<string, string>>;
  readonly body: string;
}

interface ExtractionCtx {
  readonly artifact: { relativePath: string; sha256?: string };
  readonly classified: ClassifiedArtifact;
  readonly sourceId: string;
}

const FRONTMATTER_BLOCK = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
const FRONTMATTER_LINE = /^([A-Za-z0-9_-]+):\s*(.*)$/;
const HEADING = /^#{1,6}[ \t]+(.+?)\s*$/m;

function unquote(value: string): string {
  const isQuoted =
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")));
  return isQuoted ? value.slice(1, -1) : value;
}

/**
 * Reads a leading `---`-delimited frontmatter block of flat `key: value`
 * scalars — not a full YAML parser (Devin never nests these fields).
 * Content with no frontmatter block returns empty fields and the content
 * itself as `body`, never throws.
 */
export function parseFlatFrontmatter(content: string): ParsedFrontmatter {
  const match = FRONTMATTER_BLOCK.exec(content);
  if (!match) return { fields: {}, body: content };
  const fields: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const kv = FRONTMATTER_LINE.exec(line.trim());
    if (kv) fields[kv[1]] = unquote(kv[2].trim());
  }
  return { fields, body: match[2] ?? '' };
}

/** Used by `classification.ts`'s content confirmation to bump confidence to
 * 'exact' when the expected frontmatter key is actually present. */
export function hasFrontmatterKey(content: string, key: string): boolean {
  return key in parseFlatFrontmatter(content).fields;
}

function parentDirName(relativePath: string): string {
  const segments = normalizeSlashes(relativePath)
    .split('/')
    .filter((s) => s.length > 0);
  return segments.length >= 2 ? segments[segments.length - 2] : (segments[0] ?? relativePath);
}

function basenameNoExt(relativePath: string): string {
  const segments = normalizeSlashes(relativePath)
    .split('/')
    .filter((s) => s.length > 0);
  const last = segments[segments.length - 1] ?? relativePath;
  return last.replace(/\.[^./]+$/, '');
}

/** Title precedence mirrors `claude-session-parser`'s `deriveTitle`: first
 * markdown heading, else the rule's `description` frontmatter field, else
 * the file's basename — never a raw path or hash. */
function deriveRuleTitle(
  fields: Readonly<Record<string, string>>,
  body: string,
  path: string,
): string {
  const heading = HEADING.exec(body)?.[1]?.trim();
  return heading || fields.description || basenameNoExt(path);
}

function fileComponentId(kind: string, ctx: ExtractionCtx, name: string): string {
  return stableId(kind, {
    source: ctx.sourceId,
    scope: ctx.classified.scope,
    path: normalizeSlashes(ctx.artifact.relativePath),
    name,
  });
}

function makeFileComponent(
  kind: ComponentSummary['kind'],
  ctx: ExtractionCtx,
  componentId: string,
  nativeId: string,
): ComponentSummary {
  return {
    componentId,
    kind,
    identity: componentIdentity(componentId, nativeId),
    sourceArtifactIds: [artifactIdFor(ctx.artifact)],
  };
}

/**
 * One component per `SKILL.md`/`AGENT.md` identity file, keyed on the
 * PARENT DIRECTORY name (Devin's real identity convention — unlike Claude's
 * flat files, unrelated to the file's own basename). Only the genuine
 * identity file (no `role` set) yields a component: a non-identity
 * supporting file under a named skill/agent directory (`role:
 * 'supporting-file'`) or a loose file with no name subdirectory at all
 * (`role: 'loose-file'`, PR #375 review finding 1) still classify but never
 * yield their own component — a supporting file would fabricate a duplicate
 * identity, and a loose file has no directory name to derive one from.
 */
function extractIdentityFileComponent(
  kind: 'skill' | 'agent',
  ctx: ExtractionCtx,
): ComponentSummary[] {
  if (ctx.classified.role !== undefined) return [];
  const name = parentDirName(ctx.artifact.relativePath);
  return [makeFileComponent(kind, ctx, fileComponentId(kind, ctx, name), name)];
}

export function extractSkillFileComponents(ctx: ExtractionCtx): ComponentSummary[] {
  return extractIdentityFileComponent('skill', ctx);
}

export function extractAgentFileComponents(ctx: ExtractionCtx): ComponentSummary[] {
  return extractIdentityFileComponent('agent', ctx);
}

/**
 * One component per rule file (`.devin/rules/**`, `.devin/global_rules.md`,
 * `.windsurf/rules/**`, and the root `AGENTS.md`/`AGENT.md`/`AGENTS.local.md`
 * memory files), titled via `deriveRuleTitle`.
 *
 * `.devin/rules/**` and `.devin/global_rules.md` carry a deeper risk than
 * the already-documented scope-mislabeling limitation
 * (`classification.ts`'s `DEVIN_KINDS` comment,
 * `.agents/rules/manifest-backed-classification.md`): `componentId` is
 * `stableId('rule', {source, scope, path, name})`, and a truly-global
 * `~/.devin/rules/x.md` and a truly-workspace `.devin/rules/x.md` normalize
 * to the IDENTICAL `relativePath`, both default to the same `scope:
 * 'workspace'`, AND — if they also happen to derive the same title (no
 * distinguishing heading/description, both falling back to the shared
 * basename `x`) — the SAME `name`. All four `stableId` inputs coincide, so
 * this doesn't just mislabel one file's scope: it silently merges two
 * logically distinct rule files from two different machines/scopes into
 * ONE Component Ecosystem entry (whichever `sourceArtifactIds` last wins).
 * PR #375 review finding 4: same root cause as the scope-collision
 * limitation (`Artifact` has no `scope` field), same fix required
 * (sync-side, out of scope for #342) — documented here so the risk isn't
 * understated as "just a scope label".
 */
export function extractRuleFileComponents(ctx: ExtractionCtx, content: string): ComponentSummary[] {
  const { fields, body } = parseFlatFrontmatter(content);
  const title = deriveRuleTitle(fields, body, ctx.artifact.relativePath);
  return [makeFileComponent('rule', ctx, fileComponentId('rule', ctx, title), title)];
}

function safeJsonParse(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    return undefined;
  }
}

function hookComponent(
  ctx: ExtractionCtx,
  event: string,
  hook: unknown,
  index: string,
): ComponentSummary | undefined {
  if (typeof hook !== 'object' || hook === null) return undefined;
  const type = (hook as { type?: unknown }).type;
  if (typeof type !== 'string' || type.length === 0) return undefined;
  const name = `${event}:${type}`;
  return makeFileComponent('tool', ctx, fileComponentId('tool', ctx, `${name}:${index}`), name);
}

function hookGroupComponents(
  ctx: ExtractionCtx,
  event: string,
  group: unknown,
  groupIndex: number,
): ComponentSummary[] {
  if (typeof group !== 'object' || group === null) return [];
  const hooks = (group as { hooks?: unknown }).hooks;
  if (!Array.isArray(hooks)) return [];
  const components: ComponentSummary[] = [];
  hooks.forEach((hook, hookIndex) => {
    const component = hookComponent(ctx, event, hook, `${groupIndex}:${hookIndex}`);
    if (component) components.push(component);
  });
  return components;
}

/**
 * `.devin/hooks.v1.json` is Claude-Code-hook-compatible: top-level
 * event-name keys map directly to the SAME `HookGroup[]` shape Claude
 * nests under `settings.hooks` — no wrapper key. One `kind: 'tool'`
 * component per hook entry, mirroring `claude-code.ts`'s
 * `extractSettingsComponents` hook loop.
 */
export function extractHookComponents(ctx: ExtractionCtx, content: string): ComponentSummary[] {
  const parsed = safeJsonParse(content);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return [];
  const components: ComponentSummary[] = [];
  for (const [event, groups] of Object.entries(parsed as Record<string, unknown>)) {
    if (!Array.isArray(groups)) continue;
    groups.forEach((group, groupIndex) => {
      components.push(...hookGroupComponents(ctx, event, group, groupIndex));
    });
  }
  return components;
}

/** Only `skill`/`agent` map — deliberately excludes `mcp`/`mcp_server` (and
 * anything else) so an unrecognized or MCP-tagged catalog entry can never be
 * promoted to a component (#271's exclusion). */
const CATALOG_KIND_MAP: Readonly<Record<string, ComponentSummary['kind']>> = {
  skill: 'skill',
  agent: 'agent',
};

function catalogEntryComponent(
  ctx: ExtractionCtx,
  entry: unknown,
  index: number,
): ComponentSummary | undefined {
  if (typeof entry !== 'object' || entry === null) return undefined;
  const { name, kind, type } = entry as { name?: unknown; kind?: unknown; type?: unknown };
  const rawKind = kind ?? type;
  const mapped = typeof rawKind === 'string' ? CATALOG_KIND_MAP[rawKind] : undefined;
  if (!mapped || typeof name !== 'string' || name.length === 0) return undefined;
  return makeFileComponent(mapped, ctx, fileComponentId(mapped, ctx, `${name}:${index}`), name);
}

/**
 * `plugins/discovered.json`'s schema is genuinely undocumented (no real
 * sample confirmed) — see this module's doc comment. Only a maximally
 * self-describing shape (`{ name: string, kind: 'skill' | 'agent' }`) is
 * ever extracted; anything else, including a non-array root or an entry
 * with no recognized kind, safely contributes zero components.
 */
export function extractDiscoveredCatalogComponents(
  ctx: ExtractionCtx,
  content: string,
): ComponentSummary[] {
  const parsed = safeJsonParse(content);
  const entries = Array.isArray(parsed) ? parsed : [];
  const components: ComponentSummary[] = [];
  entries.forEach((entry, index) => {
    const component = catalogEntryComponent(ctx, entry, index);
    if (component) components.push(component);
  });
  return components;
}

function dispatch(ctx: ExtractionCtx, content: string): ComponentSummary[] {
  const { kind, role } = ctx.classified;
  if (kind === 'skill') return extractSkillFileComponents(ctx);
  if (kind === 'agent') return extractAgentFileComponents(ctx);
  if (kind === 'rule') return extractRuleFileComponents(ctx, content);
  if (kind === 'settings' && role === 'hooks') return extractHookComponents(ctx, content);
  if (kind === 'settings' && role === 'discovered-catalog') {
    return extractDiscoveredCatalogComponents(ctx, content);
  }
  return [];
}

function extractionFailedIssue(path: string, err: unknown): Issue {
  return {
    code: 'component_extraction_failed',
    severity: 'warning',
    message: `Failed to extract components from ${path}: ${err instanceof Error ? err.message : String(err)}`,
    provenance: { path },
  };
}

/**
 * Dispatches a classified artifact to its family's extractor, per
 * `classified.kind`/`role`. Never throws: any extraction failure degrades
 * to zero components plus a warning `Issue`, matching
 * `claude-code.ts`'s `extractComponents` contract.
 */
export function extractConfigComponents(
  artifact: { relativePath: string; sha256?: string; content: unknown },
  classified: ClassifiedArtifact,
  sourceId: string,
): { components: ComponentSummary[]; issues: Issue[] } {
  const content = toTextContent(artifact.content);
  if (content === undefined) return { components: [], issues: [] };
  const ctx: ExtractionCtx = { artifact, classified, sourceId };
  try {
    return { components: dispatch(ctx, content), issues: [] };
  } catch (err) {
    return { components: [], issues: [extractionFailedIssue(artifact.relativePath, err)] };
  }
}
