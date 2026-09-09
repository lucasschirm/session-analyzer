/**
 * Parses `sessions.cogs_json` — a real column on Devin's `sessions` table,
 * captured verbatim into every `transcript.jsonl` `session` line as
 * `DevinSessionLine.cogsJson`. Verified against 27 real sessions / 513 cog
 * objects (DS-F11 (#288) research). A JSON array of "cog" objects: 15 fixed
 * cogs present in every session (`core/model`, `core/bypass`, ...) plus
 * session-varying `skill/<name>` cogs, present only when that skill was
 * actually invoked in the session.
 *
 * Tolerant, never-throws parse mirroring `models/parse.ts`'s
 * `isRecord`/`optionalNumber` style: malformed entries are skipped with a
 * warning rather than aborting the whole array.
 *
 * `set_system_prefix`/`append_system_messages`/`context`/`footer_messages`/
 * `user_display` are intentionally NOT modeled in this version — they are
 * only needed for the out-of-scope `core/subagent_profiles` markdown-bullet
 * catalog parse (DS-F11 (#288) "Related, explicitly out of scope").
 */

export interface DevinCogLifetime {
  unique: string;
  namespace: string;
  name: string;
}

export type DevinCogPermissionTarget =
  | { kind: 'tool_kind'; toolKind: string }
  | { kind: 'tool_name'; toolName: string }
  | { kind: 'scope_read'; glob: string }
  | { kind: 'scope_write'; glob: string }
  | { kind: 'any_scope' }
  | { kind: 'unknown'; raw: unknown };

export interface DevinCogPermission {
  target: DevinCogPermissionTarget;
  action: string;
}

export type DevinCogToolAvailability =
  | { mode: 'allow'; names: readonly string[] }
  | { mode: 'block'; names: readonly string[] }
  | undefined;

export interface DevinCog {
  /** Preserved raw — see module doc's 5 `source` shapes; no consumer needs a typed union in this version. */
  source: unknown;
  lifetime: DevinCogLifetime;
  model: string | null;
  toolAvailability: DevinCogToolAvailability;
  permissions: readonly DevinCogPermission[];
}

export interface ParseDevinCogsResult {
  cogs: readonly DevinCog[];
  warnings: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseLifetime(raw: unknown): DevinCogLifetime | null {
  if (!isRecord(raw) || typeof raw.Unique !== 'string') return null;
  const unique = raw.Unique;
  const slash = unique.indexOf('/');
  if (slash < 0) return { unique, namespace: unique, name: '' };
  return { unique, namespace: unique.slice(0, slash), name: unique.slice(slash + 1) };
}

function nameEntryValue(raw: unknown): string | null {
  if (!isRecord(raw) || !isRecord(raw.Name)) return null;
  if (typeof raw.Name.exact === 'string') return raw.Name.exact;
  if (typeof raw.Name.literal === 'string') return raw.Name.literal;
  return null;
}

function parseNameEntries(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const names: string[] = [];
  for (const entry of raw) {
    const name = nameEntryValue(entry);
    if (name !== null) names.push(name);
  }
  return names;
}

function parseToolAvailability(raw: unknown): DevinCogToolAvailability {
  if (!isRecord(raw)) return undefined;
  if (Array.isArray(raw.AllowList))
    return { mode: 'allow', names: parseNameEntries(raw.AllowList) };
  if (Array.isArray(raw.BlockList))
    return { mode: 'block', names: parseNameEntries(raw.BlockList) };
  return undefined;
}

function parseToolTarget(tool: Record<string, unknown>): DevinCogPermissionTarget | null {
  if (typeof tool.Kind === 'string') return { kind: 'tool_kind', toolKind: tool.Kind };
  const name = nameEntryValue({ Name: tool.Name });
  return name !== null ? { kind: 'tool_name', toolName: name } : null;
}

function parseScopeTarget(scope: Record<string, unknown>): DevinCogPermissionTarget | null {
  if (isRecord(scope.Read) && typeof scope.Read.glob === 'string') {
    return { kind: 'scope_read', glob: scope.Read.glob };
  }
  if (isRecord(scope.Write) && typeof scope.Write.glob === 'string') {
    return { kind: 'scope_write', glob: scope.Write.glob };
  }
  return null;
}

function parsePermissionTarget(raw: unknown): DevinCogPermissionTarget {
  if (raw === 'AnyScope') return { kind: 'any_scope' };
  if (!isRecord(raw)) return { kind: 'unknown', raw };
  const target =
    (isRecord(raw.Tool) && parseToolTarget(raw.Tool)) ||
    (isRecord(raw.Scope) && parseScopeTarget(raw.Scope)) ||
    null;
  return target ?? { kind: 'unknown', raw };
}

function parsePermission(raw: unknown): DevinCogPermission | null {
  if (!Array.isArray(raw) || raw.length !== 2 || typeof raw[1] !== 'string') return null;
  return { target: parsePermissionTarget(raw[0]), action: raw[1] };
}

function parsePermissions(raw: unknown): DevinCogPermission[] {
  if (!Array.isArray(raw)) return [];
  const permissions: DevinCogPermission[] = [];
  for (const entry of raw) {
    const permission = parsePermission(entry);
    if (permission) permissions.push(permission);
  }
  return permissions;
}

function parseCog(raw: unknown): DevinCog | null {
  if (!isRecord(raw)) return null;
  const lifetime = parseLifetime(raw.lifetime);
  if (!lifetime) return null;
  return {
    source: raw.source,
    lifetime,
    model: typeof raw.model === 'string' ? raw.model : null,
    toolAvailability: parseToolAvailability(raw.tool_availability),
    permissions: parsePermissions(raw.permissions),
  };
}

/** Parses `sessions.cogs_json`; malformed entries are skipped, never thrown. */
export function parseDevinCogsJson(raw: string | null): ParseDevinCogsResult {
  if (raw === null) return { cogs: [], warnings: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { cogs: [], warnings: ['cogs_json is not valid JSON'] };
  }
  if (!Array.isArray(parsed)) {
    return { cogs: [], warnings: ['cogs_json root is not an array'] };
  }
  const cogs: DevinCog[] = [];
  const warnings: string[] = [];
  parsed.forEach((entry, index) => {
    const cog = parseCog(entry);
    cog ? cogs.push(cog) : warnings.push(`skipped malformed cog entry at index ${index}`);
  });
  return { cogs, warnings };
}
