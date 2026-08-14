import type { PluginMarketplace } from '../types/config.js';
import { safeJsonParse, stripBom } from '../utils/text.js';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Best-effort fallback name derived from `sourcePath` when the file itself
 *  carries no usable `name`. Manual basename/dirname split — no `path`
 *  module (Node APIs are disallowed in this package). Falls back to
 *  `'unknown'` when `sourcePath` is absent or unhelpful (e.g. just
 *  `marketplace.json`). */
function fallbackName(sourcePath?: string): string {
  if (!sourcePath) return 'unknown';
  const segments = sourcePath.split('/').filter((s) => s.length > 0);
  // Typical real path: ".../<marketplace-dir>/.claude-plugin/marketplace.json"
  const pluginDirIdx = segments.lastIndexOf('.claude-plugin');
  if (pluginDirIdx > 0) return segments[pluginDirIdx - 1];
  return segments[segments.length - 1] ?? 'unknown';
}

/**
 * Normalizes a plugin listing's `source` field to a plain string.
 *
 * Real `marketplace.json` files use both forms (confirmed:
 * `~/.claude/plugins/marketplaces/*\/.claude-plugin/marketplace.json`):
 * - string: `"./plugins/agent-sdk-dev"` (local relative path)
 * - object: `{ source: "git-subdir", url: "...", path: "...", ref: "...",
 *   sha: "..." }` (remote git reference)
 *
 * For the object form, `url` is the most useful single string (the actual
 * fetchable location) so it's preferred; falling back through `path`, then
 * the object's own `source` sub-field (the source *type*, e.g.
 * `"git-subdir"`), then a JSON-stringified last resort so nothing is ever
 * silently dropped.
 */
function normalizeSource(value: unknown): string {
  if (typeof value === 'string') return value;
  if (isPlainObject(value)) {
    const url = asString(value.url);
    if (url !== undefined) return url;
    const path = asString(value.path);
    if (path !== undefined) return path;
    const sourceType = asString(value.source);
    if (sourceType !== undefined) return sourceType;
    try {
      return JSON.stringify(value);
    } catch {
      return '';
    }
  }
  return '';
}

function parsePlugins(value: unknown): PluginMarketplace['plugins'] {
  if (!Array.isArray(value)) return [];
  const plugins: PluginMarketplace['plugins'] = [];
  for (const entry of value) {
    if (!isPlainObject(entry)) continue;
    const name = asString(entry.name);
    if (name === undefined) continue;
    const plugin: PluginMarketplace['plugins'][number] = {
      name,
      source: normalizeSource(entry.source),
    };
    const description = asString(entry.description);
    if (description !== undefined) plugin.description = description;
    plugins.push(plugin);
  }
  return plugins;
}

/**
 * Parses a `.claude-plugin/marketplace.json` file.
 *
 * Note: `PluginMarketplace` has no `parseErrors` field in the spec (an
 * asymmetry with every other config type — flagged in this PR's "Notes for
 * the reviewer" rather than silently added here). Malformed input therefore
 * degrades to a minimal valid object (empty `plugins`, best-effort `name`)
 * instead of recording an error anywhere.
 */
export function parsePluginMarketplace(content: string, sourcePath?: string): PluginMarketplace {
  const stripped = stripBom(content);
  const { value } = safeJsonParse<unknown>(stripped);

  if (!isPlainObject(value)) {
    return {
      kind: 'plugin-marketplace',
      sourcePath,
      name: fallbackName(sourcePath),
      plugins: [],
    };
  }

  const marketplace: PluginMarketplace = {
    kind: 'plugin-marketplace',
    sourcePath,
    // Real files disagree on where the description lives: the official
    // marketplace puts it top-level (`description`), while at least one
    // real third-party file (an example marketplace) nests it under
    // `metadata.description` instead. Top-level wins when both are present.
    name: asString(value.name) ?? fallbackName(sourcePath),
    plugins: parsePlugins(value.plugins),
  };

  const description =
    asString(value.description) ??
    (isPlainObject(value.metadata) ? asString(value.metadata.description) : undefined);
  if (description !== undefined) marketplace.description = description;

  if (isPlainObject(value.owner)) {
    const ownerName = asString(value.owner.name);
    if (ownerName !== undefined) marketplace.owner = { name: ownerName };
  }

  return marketplace;
}
