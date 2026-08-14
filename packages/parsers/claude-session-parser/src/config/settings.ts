import type { ClaudeScope } from '../types/common.js';
import type { ClaudeCodeSettings, HookMatcherGroup } from '../types/config.js';
import { stripBom, safeJsonParse } from '../utils/text.js';
import { makeParseError } from '../utils/errors.js';

/** True for a non-null, non-array `object` — the only shape we ever trust
 *  enough to walk further. Every typed-field extraction below starts here;
 *  anything else (arrays, primitives, `null`) is left unset per the spec's
 *  "type-check each field before assigning" rule rather than trusted. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === 'string');
}

/** Builds a `Record<string, string>`, dropping any entry whose value isn't
 *  itself a string rather than rejecting the whole field — real files are
 *  otherwise well-formed and one stray non-string value shouldn't blank out
 *  every other (possibly secret-bearing) entry. */
function asStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isPlainObject(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

function asBooleanRecord(value: unknown): Record<string, boolean> | undefined {
  if (!isPlainObject(value)) return undefined;
  const out: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === 'boolean') out[k] = v;
  }
  return out;
}

function parsePermissions(value: unknown): ClaudeCodeSettings['permissions'] {
  if (!isPlainObject(value)) return undefined;
  const permissions: NonNullable<ClaudeCodeSettings['permissions']> = {};
  const defaultMode = asString(value.defaultMode);
  if (defaultMode !== undefined) permissions.defaultMode = defaultMode;
  const allow = asStringArray(value.allow);
  if (allow !== undefined) permissions.allow = allow;
  const deny = asStringArray(value.deny);
  if (deny !== undefined) permissions.deny = deny;
  const ask = asStringArray(value.ask);
  if (ask !== undefined) permissions.ask = ask;
  return permissions;
}

/** Validates one hook entry inside a `HookMatcherGroup.hooks` array. Real
 *  files are defensively parsed field-by-field — a hook missing `command`
 *  (e.g. an `agent` type using `prompt` instead) is still a valid partial
 *  hook, not a reason to drop the whole group. */
function parseHookAction(value: unknown): HookMatcherGroup['hooks'][number] | undefined {
  if (!isPlainObject(value)) return undefined;
  const type = asString(value.type);
  if (type === undefined) return undefined;
  const hook: HookMatcherGroup['hooks'][number] = { type: type as HookMatcherGroup['hooks'][number]['type'] };
  const command = asString(value.command);
  if (command !== undefined) hook.command = command;
  const prompt = asString(value.prompt);
  if (prompt !== undefined) hook.prompt = prompt;
  const timeout = typeof value.timeout === 'number' ? value.timeout : undefined;
  if (timeout !== undefined) hook.timeout = timeout;
  const statusMessage = asString(value.statusMessage);
  if (statusMessage !== undefined) hook.statusMessage = statusMessage;
  return hook;
}

function parseHookMatcherGroup(value: unknown): HookMatcherGroup | undefined {
  if (!isPlainObject(value)) return undefined;
  const hooksValue = value.hooks;
  if (!Array.isArray(hooksValue)) return undefined;
  const hooks: HookMatcherGroup['hooks'] = [];
  for (const raw of hooksValue) {
    const parsed = parseHookAction(raw);
    if (parsed) hooks.push(parsed);
  }
  const group: HookMatcherGroup = { hooks };
  const matcher = asString(value.matcher);
  if (matcher !== undefined) group.matcher = matcher;
  return group;
}

function parseHooks(value: unknown): Record<string, HookMatcherGroup[]> | undefined {
  if (!isPlainObject(value)) return undefined;
  const out: Record<string, HookMatcherGroup[]> = {};
  for (const [event, groupsValue] of Object.entries(value)) {
    if (!Array.isArray(groupsValue)) continue;
    const groups: HookMatcherGroup[] = [];
    for (const raw of groupsValue) {
      const group = parseHookMatcherGroup(raw);
      if (group) groups.push(group);
    }
    out[event] = groups;
  }
  return out;
}

function parseExtraKnownMarketplaces(value: unknown): ClaudeCodeSettings['extraKnownMarketplaces'] {
  if (!isPlainObject(value)) return undefined;
  const out: NonNullable<ClaudeCodeSettings['extraKnownMarketplaces']> = {};
  for (const [name, entry] of Object.entries(value)) {
    if (!isPlainObject(entry) || !isPlainObject(entry.source)) continue;
    const source = asString(entry.source.source);
    if (source === undefined) continue;
    const normalized: { source: string; repo?: string; path?: string } = { source };
    const repo = asString(entry.source.repo);
    if (repo !== undefined) normalized.repo = repo;
    const path = asString(entry.source.path);
    if (path !== undefined) normalized.path = path;
    out[name] = { source: normalized };
  }
  return out;
}

function parseSandbox(value: unknown): ClaudeCodeSettings['sandbox'] {
  if (!isPlainObject(value)) return undefined;
  const sandbox: NonNullable<ClaudeCodeSettings['sandbox']> = {};
  if (typeof value.enabled === 'boolean') sandbox.enabled = value.enabled;
  if (isPlainObject(value.network)) {
    const allowedDomains = asStringArray(value.network.allowedDomains);
    if (allowedDomains !== undefined) sandbox.network = { allowedDomains };
  }
  return sandbox;
}

/**
 * Parses a Claude Code `settings.json` / `settings.local.json` file.
 *
 * `settings.local.json` files can carry plaintext secrets in `env` (API
 * keys, tokens, etc.). Per the spec's resolved decision ("Secret handling
 * in parseSettings" — never redact), this parser is a faithful mirror of
 * its input: it does NOT redact, mask, or otherwise transform secret-looking
 * values. Redaction, if ever needed, belongs in a UI/display layer that
 * consumes this output — do not add redaction here.
 */
export function parseSettings(content: string, scope: ClaudeScope, sourcePath?: string): ClaudeCodeSettings {
  const stripped = stripBom(content);
  const { value, error } = safeJsonParse<unknown>(stripped);

  if (error !== undefined) {
    return {
      kind: 'settings',
      scope,
      sourcePath,
      raw: {},
      parseErrors: [makeParseError('invalid_json', `Failed to parse settings JSON: ${error}`, { rawSnippet: stripped.slice(0, 200) })],
    };
  }

  if (!isPlainObject(value)) {
    return {
      kind: 'settings',
      scope,
      sourcePath,
      raw: {},
      parseErrors: [makeParseError('unexpected_root_shape', 'Settings JSON root is not an object', { rawSnippet: stripped.slice(0, 200) })],
    };
  }

  const settings: ClaudeCodeSettings = {
    kind: 'settings',
    scope,
    sourcePath,
    raw: value,
    parseErrors: [],
  };

  const model = asString(value.model);
  if (model !== undefined) settings.model = model;

  const effortLevel = asString(value.effortLevel);
  if (effortLevel !== undefined) settings.effortLevel = effortLevel;

  const permissions = parsePermissions(value.permissions);
  if (permissions !== undefined) settings.permissions = permissions;

  // Never redact — see the doc comment above and spec §5 "Secret handling in
  // parseSettings". `env` is mirrored verbatim, plaintext secrets included.
  const env = asStringRecord(value.env);
  if (env !== undefined) settings.env = env;

  const hooks = parseHooks(value.hooks);
  if (hooks !== undefined) settings.hooks = hooks;

  const enabledPlugins = asBooleanRecord(value.enabledPlugins);
  if (enabledPlugins !== undefined) settings.enabledPlugins = enabledPlugins;

  const extraKnownMarketplaces = parseExtraKnownMarketplaces(value.extraKnownMarketplaces);
  if (extraKnownMarketplaces !== undefined) settings.extraKnownMarketplaces = extraKnownMarketplaces;

  const sandbox = parseSandbox(value.sandbox);
  if (sandbox !== undefined) settings.sandbox = sandbox;

  const tui = asString(value.tui);
  if (tui !== undefined) settings.tui = tui;

  if ('statusLine' in value) settings.statusLine = value.statusLine;

  return settings;
}
