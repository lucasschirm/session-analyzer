import type { ClaudeScope, ParseError } from '../types/common.js';
import type { McpConfig, McpServerConfig } from '../types/config.js';
import { stripBom, safeJsonParse } from '../utils/text.js';
import { makeParseError } from '../utils/errors.js';
import { mcpServerNameToNamespace } from '../utils/mcp-names.js';

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

function asStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isPlainObject(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

/**
 * Infers `McpServerConfig.transport` from a server's declared shape.
 *
 * - `command` present -> `'stdio'` (real `.mcp.json` shape, e.g. `acme:mcp`
 *   running `node tools/pep-mcp/dist/index.js`).
 * - `url` present -> `'sse' | 'http'`, distinguished by an explicit
 *   `type`/`transport` key when present (real files use `"type": "http"`,
 *   e.g. the `helper` server at `https://mcp.example.com/mcp`). When `url` is
 *   present with no explicit discriminant, this defaults to `'http'` — no
 *   real `sse`-typed file was found in this machine's corpus to confirm the
 *   opposite default, and `http` is Claude Code's current documented
 *   streaming-HTTP transport; `'sse'` remains reachable via an explicit
 *   `type`/`transport: "sse"` key for older configs. Documented here rather
 *   than guessed silently.
 * - Neither -> `'unknown'`.
 */
function inferTransport(server: Record<string, unknown>): McpServerConfig['transport'] {
  if (typeof server.command === 'string') return 'stdio';
  if (typeof server.url === 'string') {
    const discriminant = asString(server.type) ?? asString(server.transport);
    if (discriminant === 'sse' || discriminant === 'http') return discriminant;
    return 'http';
  }
  return 'unknown';
}

function parseServerConfig(name: string, value: unknown): McpServerConfig | undefined {
  if (!isPlainObject(value)) return undefined;

  const server: McpServerConfig = {
    name,
    toolNamespace: mcpServerNameToNamespace(name),
    transport: inferTransport(value),
    raw: value,
  };

  const command = asString(value.command);
  if (command !== undefined) server.command = command;

  const args = asStringArray(value.args);
  if (args !== undefined) server.args = args;

  const env = asStringRecord(value.env);
  if (env !== undefined) server.env = env;

  const url = asString(value.url);
  if (url !== undefined) server.url = url;

  const headers = asStringRecord(value.headers);
  if (headers !== undefined) server.headers = headers;

  return server;
}

/**
 * Parses a `.mcp.json` file (or an equivalent `mcpServers` block lifted out
 * of `~/.claude.json`).
 *
 * Real `.mcp.json` files nest servers under a top-level `mcpServers` key
 * (confirmed: `<project>/.mcp.json` files on this machine). This function
 * also tolerates a file that *is* the server map directly (no `mcpServers`
 * wrapper), but only when that's actually plausible — the guard is:
 *
 * - `mcpServers` key present and a plain object -> use it (the normal case).
 * - `mcpServers` key present but NOT a plain object (e.g. a string) -> this
 *   is malformed, not a bare map; no servers are produced, and a
 *   `ParseError` records it.
 * - `mcpServers` key absent -> the bare-map shape is accepted ONLY when at
 *   least one top-level value is itself a plain object (i.e. looks like a
 *   server config). Otherwise the input doesn't look like an MCP config at
 *   all (e.g. a `settings.json`-shaped file with no plain-object values) and
 *   a `ParseError` records that too, rather than misreading every top-level
 *   key as a server name.
 */
export function parseMcp(content: string, scope?: ClaudeScope, sourcePath?: string): McpConfig {
  const resolvedScope = scope ?? 'unknown';
  const stripped = stripBom(content);
  const { value, error } = safeJsonParse<unknown>(stripped);

  if (error !== undefined) {
    return {
      kind: 'mcp-config',
      sourcePath,
      scope: resolvedScope,
      servers: [],
      parseErrors: [makeParseError('invalid_json', `Failed to parse MCP config JSON: ${error}`, { rawSnippet: stripped.slice(0, 200) })],
    };
  }

  if (!isPlainObject(value)) {
    return {
      kind: 'mcp-config',
      sourcePath,
      scope: resolvedScope,
      servers: [],
      parseErrors: [makeParseError('unexpected_root_shape', 'MCP config JSON root is not an object', { rawSnippet: stripped.slice(0, 200) })],
    };
  }

  const parseErrors: ParseError[] = [];
  let serverMap: Record<string, unknown> | undefined;

  if ('mcpServers' in value) {
    if (isPlainObject(value.mcpServers)) {
      serverMap = value.mcpServers;
    } else {
      parseErrors.push(makeParseError('invalid_mcp_servers_shape', '"mcpServers" is present but is not an object'));
    }
  } else {
    // No `mcpServers` wrapper — only accept this as a bare server map when
    // at least one top-level value actually looks like a server config.
    const looksLikeServerMap = Object.values(value).some((v) => isPlainObject(v));
    if (looksLikeServerMap) {
      serverMap = value;
    } else {
      parseErrors.push(makeParseError('not_mcp_config', 'No "mcpServers" key and no top-level value looks like a server config'));
    }
  }

  const servers: McpServerConfig[] = [];
  if (serverMap) {
    for (const [name, raw] of Object.entries(serverMap)) {
      const server = parseServerConfig(name, raw);
      if (server) {
        servers.push(server);
      } else {
        parseErrors.push(makeParseError('invalid_server_config', `MCP server "${name}" is not a valid config object`));
      }
    }
  }

  return {
    kind: 'mcp-config',
    sourcePath,
    scope: resolvedScope,
    servers,
    parseErrors,
  };
}
