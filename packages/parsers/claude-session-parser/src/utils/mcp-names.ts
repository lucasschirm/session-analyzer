/**
 * MCP tool/server name mapping. Confirmed real gotcha (spec §2/MCP): a
 * server declared in `.mcp.json` as `"acme:mcp"` shows up in transcript tool
 * names as `mcp__acme_mcp__<tool>` — the colon is replaced with an
 * underscore, and hyphens (e.g. `claude-in-chrome`) are preserved as-is.
 */

/**
 * Splits a transcript tool name like `mcp__acme_mcp__foo` into its
 * namespace and bare tool name. Returns `null` for anything that doesn't
 * match the `mcp__<namespace>__<tool>` shape. `server` here is the
 * *namespace* as embedded in the tool name (already colon→underscore
 * mapped) — see `mcpServerNameToNamespace`'s doc comment for why this
 * cannot be reversed back to the original `.mcp.json` server name.
 */
export function splitMcpToolName(name: string): { server: string; tool: string } | null {
  const prefix = 'mcp__';
  if (!name.startsWith(prefix)) return null;
  const rest = name.slice(prefix.length);
  const sepIdx = rest.indexOf('__');
  if (sepIdx === -1) return null;
  const server = rest.slice(0, sepIdx);
  const tool = rest.slice(sepIdx + 2);
  if (server === '' || tool === '') return null;
  return { server, tool };
}

/**
 * Maps a `.mcp.json` server name (e.g. `"acme:mcp"`) to the namespace used
 * inside transcript tool names (e.g. `"acme_mcp"`).
 *
 * LOSSY, ONE-WAY: `:` is replaced with `_`; hyphens are left untouched.
 * Because plain `_` in a server name is indistinguishable from a mapped
 * `:`, there is no way to invert this mapping — do not assume
 * `splitMcpToolName(...).server` can be turned back into the original
 * `.mcp.json` server name.
 */
export function mcpServerNameToNamespace(name: string): string {
  return name.split(':').join('_');
}
