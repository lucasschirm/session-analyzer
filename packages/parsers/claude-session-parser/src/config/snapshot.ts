/**
 * `buildConfigSnapshot` — spec §3 (`ClaudeFolderInventory`,
 * `ClaudeConfigSnapshot`) + §4 (config-only composition, no transcript at
 * all). Buckets a flat, already-parsed, mixed array into
 * `ClaudeFolderInventory[]` plus a merged `ClaudeConfigSnapshot` — no
 * builder is needed here (unlike `session/builder.ts`) since there is no
 * availability-timeline logic to fold, just sorting into the right buckets.
 *
 * See spec: docs/superpowers/specs/2026-08-12-claude-session-parser-design.md
 */

import type { ClaudeScope } from '../types/common.js';
import type {
  AgentDefinition,
  ClaudeCodeSettings,
  ClaudeConfigSnapshot,
  ClaudeFolderInventory,
  McpConfig,
  McpServerConfig,
  PluginMarketplace,
  RuleDefinition,
  SkillDefinition,
} from '../types/config.js';
import { makeParseError } from '../utils/errors.js';
import { getOrThrow } from '../utils/maps.js';

type ParsedConfigItem =
  | AgentDefinition
  | SkillDefinition
  | RuleDefinition
  | McpConfig
  | ClaudeCodeSettings
  | PluginMarketplace;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function emptyInventory(scope: ClaudeScope, rootPath: string | undefined): ClaudeFolderInventory {
  return {
    scope,
    rootPath,
    agents: [],
    skills: [],
    rules: [],
    // No standalone "hook definition file" type exists among the six
    // discriminants this function accepts — hooks only ever arrive nested
    // inside `ClaudeCodeSettings.hooks`, which is a settings.json concern,
    // not a file this function buckets independently. `hooks` therefore
    // always stays empty here; a future `parseHookDefinition` (if one is
    // ever added) would be the thing that populates it.
    hooks: [],
    unrecognized: [],
    parseErrors: [],
  };
}

/**
 * Derives a stable "which `.claude` root does this file belong to" key from
 * a `sourcePath`, purely by string inspection (no `fs`/`path` — this package
 * has zero filesystem access). This is what lets `buildConfigSnapshot` honor
 * the spec §5 resolved decision ("merge everything found, including
 * worktree/nested-resource copies — no default exclusion") *and* keep
 * distinct physical roots in distinct `ClaudeFolderInventory` entries rather
 * than collapsing every same-scope file into one bucket: two `project`-scope
 * `.claude` roots living in two different worktrees produce two different
 * `rootPath`s here (their `sourcePath`s differ upstream of the trailing
 * `.claude` segment), and therefore two separate inventories.
 *
 * - `.../<dir>/.claude/<...>` -> rootPath `.../<dir>/.claude`.
 * - `.../<dir>/.claude-plugin/<...>` (marketplace manifests) -> rootPath
 *   `.../<dir>/.claude-plugin`.
 * - Anything else (no sourcePath, or one with neither segment — e.g. a
 *   caller that only ever hands this function bare file contents with no
 *   path) -> `undefined`; such items still get bucketed (by scope alone,
 *   see `bucketKeyFor`), just without a `rootPath` to report.
 */
function deriveRootPath(sourcePath: string | undefined): string | undefined {
  if (!sourcePath) return undefined;
  const normalized = sourcePath.replace(/\\/g, '/');
  const claudeMatch = normalized.match(/^(.*\.claude)\//);
  if (claudeMatch) return claudeMatch[1];
  const pluginMatch = normalized.match(/^(.*\.claude-plugin)\//);
  if (pluginMatch) return pluginMatch[1];
  return undefined;
}

/** Best-effort scope inference for `PluginMarketplace`, which (unlike every
 *  other config type here) has no `scope` field of its own — mirrors the
 *  `inferScopeFromPath`-style heuristic each `config/*-definition.ts` parser
 *  already uses locally (duplicated here on purpose, same rationale as
 *  those files: this task owns exactly this one file, and the AGENT_BRIEF's
 *  file-ownership rule forbids introducing a new shared util other parallel
 *  agents don't know about). */
function inferMarketplaceScope(
  sourcePath: string | undefined,
  fallback: ClaudeScope | undefined,
): ClaudeScope {
  if (sourcePath) {
    const normalized = sourcePath.replace(/\\/g, '/');
    if (/(^|\/)plugins\//.test(normalized)) return 'plugin';
  }
  return fallback ?? 'unknown';
}

function bucketKeyFor(rootPath: string | undefined, scope: ClaudeScope): string {
  return rootPath ?? `scope::${scope}`;
}

/**
 * Precedence ladder for `effectiveSettings` (spec §3: "managed < user <
 * project < local"). `'plugin'`/`'unknown'`-scoped settings are not part of
 * the spec's four-scope ladder at all — real Claude Code has no per-plugin
 * or unresolvable-scope `settings.json` — but per §5's "merge everything,
 * no exclusion", a caller-supplied one still contributes rather than being
 * dropped; it's placed at the lowest precedence (before `managed`) since
 * its actual authority relative to the known four scopes is undefined and
 * the safest default is "don't let it silently outrank a known scope".
 */
const SETTINGS_PRECEDENCE: ClaudeScope[] = [
  'unknown',
  'plugin',
  'managed',
  'user',
  'project',
  'local',
];

/**
 * Merges every `ClaudeCodeSettings` found (in all buckets) into one
 * effective settings object, in `SETTINGS_PRECEDENCE` order (ties within the
 * same scope broken by original array order — last item wins, matching the
 * "last wins" convention used for `agentsByName`/`skillsByName`/
 * `mcpServersByName` below).
 *
 * Merge strategy, decided and documented here since the spec leaves it open:
 * - Every top-level scalar/object field (`model`, `effortLevel`, `tui`,
 *   `statusLine`, `sandbox`) is a **shallow replace**: a later (higher
 *   precedence) scope's value fully replaces an earlier one's.
 * - `env`, `enabledPlugins`, `extraKnownMarketplaces`, `hooks` are **keyed
 *   maps that merge per-key**: a later scope's key wins for that key, but a
 *   key unique to an earlier scope survives — these are naturally additive
 *   (a project adds its own env vars/hooks without erasing the user's).
 * - `permissions.allow`/`.deny`/`.ask` **concatenate and de-duplicate**
 *   (preserving first-occurrence order) rather than replace — permission
 *   scoping in Claude Code is cumulative by design (a narrower scope can
 *   *add* an allow/deny entry; replacing outright would let a low-precedence
 *   local override silently erase a managed-scope `deny`, which is exactly
 *   backwards for a security-relevant list). `permissions.defaultMode` is a
 *   single-value field, so it stays last-wins like every other scalar.
 * - `raw` merges shallowly (later overwrites earlier per top-level key) for
 *   a lossless-ish passthrough; the merged object's own `sourcePath` is the
 *   highest-precedence contributing settings' `sourcePath` (the most
 *   specific file "in force"), and its `scope` is that same
 *   highest-precedence settings' scope.
 */
function mergeEffectiveSettings(
  allSettings: ClaudeCodeSettings[],
  fallbackScope: ClaudeScope,
): ClaudeCodeSettings {
  if (allSettings.length === 0) {
    return { kind: 'settings', scope: fallbackScope, raw: {}, parseErrors: [] };
  }

  const ordered = allSettings
    .map((s, originalIndex) => ({ s, originalIndex }))
    .sort((a, b) => {
      const pa = SETTINGS_PRECEDENCE.indexOf(a.s.scope);
      const pb = SETTINGS_PRECEDENCE.indexOf(b.s.scope);
      if (pa !== pb) return pa - pb;
      return a.originalIndex - b.originalIndex;
    })
    .map((x) => x.s);

  const merged: ClaudeCodeSettings = {
    kind: 'settings',
    scope: fallbackScope,
    raw: {},
    parseErrors: [],
  };
  const allowSeen = new Set<string>();
  const denySeen = new Set<string>();
  const askSeen = new Set<string>();
  const allow: string[] = [];
  const deny: string[] = [];
  const ask: string[] = [];

  for (const s of ordered) {
    merged.scope = s.scope;
    merged.sourcePath = s.sourcePath;
    merged.raw = { ...merged.raw, ...s.raw };
    if (s.model !== undefined) merged.model = s.model;
    if (s.effortLevel !== undefined) merged.effortLevel = s.effortLevel;
    if (s.tui !== undefined) merged.tui = s.tui;
    if ('statusLine' in s) merged.statusLine = s.statusLine;
    if (s.sandbox !== undefined) merged.sandbox = s.sandbox;

    if (s.env !== undefined) merged.env = { ...(merged.env ?? {}), ...s.env };
    if (s.enabledPlugins !== undefined)
      merged.enabledPlugins = { ...(merged.enabledPlugins ?? {}), ...s.enabledPlugins };
    if (s.extraKnownMarketplaces !== undefined) {
      merged.extraKnownMarketplaces = {
        ...(merged.extraKnownMarketplaces ?? {}),
        ...s.extraKnownMarketplaces,
      };
    }
    if (s.hooks !== undefined) merged.hooks = { ...(merged.hooks ?? {}), ...s.hooks };

    if (s.permissions?.defaultMode !== undefined) {
      merged.permissions = { ...merged.permissions, defaultMode: s.permissions.defaultMode };
    }
    for (const entry of s.permissions?.allow ?? []) {
      if (!allowSeen.has(entry)) {
        allowSeen.add(entry);
        allow.push(entry);
      }
    }
    for (const entry of s.permissions?.deny ?? []) {
      if (!denySeen.has(entry)) {
        denySeen.add(entry);
        deny.push(entry);
      }
    }
    for (const entry of s.permissions?.ask ?? []) {
      if (!askSeen.has(entry)) {
        askSeen.add(entry);
        ask.push(entry);
      }
    }

    merged.parseErrors.push(...s.parseErrors);
  }

  if (
    allow.length > 0 ||
    deny.length > 0 ||
    ask.length > 0 ||
    merged.permissions?.defaultMode !== undefined
  ) {
    merged.permissions = {
      ...merged.permissions,
      ...(allow.length > 0 ? { allow } : {}),
      ...(deny.length > 0 ? { deny } : {}),
      ...(ask.length > 0 ? { ask } : {}),
    };
  }

  return merged;
}

export function buildConfigSnapshot(
  parsed: Array<ParsedConfigItem>,
  scope?: ClaudeScope,
): ClaudeConfigSnapshot {
  const buckets = new Map<string, ClaudeFolderInventory>();
  const bucketOrder: string[] = [];
  const allSettings: ClaudeCodeSettings[] = [];
  const agentsByName: Record<string, AgentDefinition> = {};
  const skillsByName: Record<string, SkillDefinition> = {};
  const mcpServersByName: Record<string, McpServerConfig> = {};

  function getOrCreateBucket(
    rootPath: string | undefined,
    itemScope: ClaudeScope,
  ): ClaudeFolderInventory {
    const key = bucketKeyFor(rootPath, itemScope);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = emptyInventory(itemScope, rootPath);
      buckets.set(key, bucket);
      bucketOrder.push(key);
    } else if (bucket.scope === 'local' && itemScope !== 'local') {
      // Upgrade a bucket's reported scope away from a local-settings-only
      // guess once a "primary" (non-local) item for the same root is seen —
      // `localSettings` on `ClaudeFolderInventory` is a sibling of
      // `settings`, not its own root, so the bucket's own `scope` should
      // reflect the root's primary scope whenever one is known.
      bucket.scope = itemScope;
    }
    return bucket;
  }

  function recordUnrecognized(
    itemScope: ClaudeScope,
    label: string,
    code: string,
    message: string,
  ): void {
    const bucket = getOrCreateBucket(undefined, itemScope);
    bucket.unrecognized.push(label);
    bucket.parseErrors.push(makeParseError(code, message));
  }

  if (!Array.isArray(parsed)) {
    // Defensive: the frozen signature says `Array<...>`, but a JS caller
    // that ignores the TS types could hand this anything. Never throw —
    // fall through to the empty-snapshot return below.
    parsed = [];
  }

  parsed.forEach((item, index) => {
    try {
      if (!isPlainObject(item) || typeof (item as { kind?: unknown }).kind !== 'string') {
        recordUnrecognized(
          scope ?? 'unknown',
          `<unrecognized item at index ${index}>`,
          'unrecognized_config_item',
          `Item at index ${index} is not a recognized config object (missing/invalid "kind").`,
        );
        return;
      }

      const kind = (item as { kind: string }).kind;

      switch (kind) {
        case 'settings': {
          const settings = item as ClaudeCodeSettings;
          const rootPath = deriveRootPath(settings.sourcePath);
          const bucket = getOrCreateBucket(rootPath, settings.scope);
          if (settings.scope === 'local') bucket.localSettings = settings;
          else bucket.settings = settings;
          bucket.parseErrors.push(...settings.parseErrors);
          allSettings.push(settings);
          break;
        }
        case 'mcp-config': {
          const mcp = item as McpConfig;
          const rootPath = deriveRootPath(mcp.sourcePath);
          const bucket = getOrCreateBucket(rootPath, mcp.scope);
          bucket.mcp = mcp;
          bucket.parseErrors.push(...mcp.parseErrors);
          for (const server of mcp.servers) {
            // Duplicate server names: last one in `parsed` order wins,
            // matching plain-object-literal spread semantics (`{...a,
            // ...b}`) — see the matching note on `agentsByName`/
            // `skillsByName` below.
            mcpServersByName[server.name] = server;
          }
          break;
        }
        case 'agent-definition': {
          const def = item as AgentDefinition;
          const rootPath = deriveRootPath(def.sourcePath);
          const bucket = getOrCreateBucket(rootPath, def.scope);
          bucket.agents.push(def);
          bucket.parseErrors.push(...def.parseErrors);
          // Duplicate names: last item in `parsed` wins. Callers naturally
          // list configs in application order (e.g. managed, user, project,
          // local, or "base plugin defs then project overrides"), so "last
          // wins" matches the override semantics `effectiveSettings` already
          // establishes above — a later, more-specific definition is
          // expected to shadow an earlier one. An empty `name` (the
          // `parseAgentDefinition` fallback when neither frontmatter nor a
          // sourcePath could supply one) is skipped here so it can't pollute
          // the map with a bogus `''` key; the definition itself is still
          // preserved in `bucket.agents`.
          if (def.name) agentsByName[def.name] = def;
          break;
        }
        case 'skill-definition': {
          const def = item as SkillDefinition;
          const rootPath = deriveRootPath(def.sourcePath);
          const bucket = getOrCreateBucket(rootPath, def.scope);
          bucket.skills.push(def);
          bucket.parseErrors.push(...def.parseErrors);
          if (def.name) skillsByName[def.name] = def;
          break;
        }
        case 'rule-definition': {
          const def = item as RuleDefinition;
          const rootPath = deriveRootPath(def.sourcePath);
          const bucket = getOrCreateBucket(rootPath, def.scope);
          bucket.rules.push(def);
          bucket.parseErrors.push(...def.parseErrors);
          break;
        }
        case 'plugin-marketplace': {
          const marketplace = item as PluginMarketplace;
          const rootPath = deriveRootPath(marketplace.sourcePath);
          const itemScope = inferMarketplaceScope(marketplace.sourcePath, scope);
          const bucket = getOrCreateBucket(rootPath, itemScope);
          // `PluginMarketplace` carries no `parseErrors` field (a documented
          // asymmetry with every other config type here — see
          // `config/marketplace.ts`'s doc comment), so there is nothing to
          // collect for it beyond attaching the object itself.
          bucket.marketplace = marketplace;
          break;
        }
        default: {
          recordUnrecognized(
            scope ?? 'unknown',
            (item as { sourcePath?: unknown }).sourcePath &&
              typeof (item as { sourcePath?: unknown }).sourcePath === 'string'
              ? (item as { sourcePath: string }).sourcePath
              : `<unrecognized item at index ${index}>`,
            'unrecognized_config_kind',
            `Item at index ${index} has an unrecognized "kind": ${JSON.stringify(kind)}.`,
          );
        }
      }
    } catch (err) {
      // Never throw — an item that superficially looks valid (has a
      // recognized `kind`) but is malformed in some deeper way (e.g. a
      // getter that throws) still must not abort the whole snapshot.
      recordUnrecognized(
        scope ?? 'unknown',
        `<item at index ${index} raised while bucketing>`,
        'bucketing_error',
        `Item at index ${index} raised an error while being bucketed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  const inventories = bucketOrder.map((key) => getOrThrow(buckets, key));
  const effectiveSettings = mergeEffectiveSettings(allSettings, scope ?? 'unknown');

  return {
    inventories,
    effectiveSettings,
    agentsByName,
    skillsByName,
    mcpServersByName,
  };
}
