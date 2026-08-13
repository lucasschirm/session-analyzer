import type { ClaudeScope } from '../types/common.js';
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
 * - `command` present -> `'stdio'` (real `.mcp.json` shape, e.g. `pep:mcp`
 *   running `node tools/pep-mcp/dist/index.js`).
 * - `url` present -> `'sse' | 'http'`, distinguished by an explicit
 *   `type`/`transport` key when present (real files use `"type": "http"`,
 *   e.g. the `devin` server at `https://mcp.devin.ai/mcp`). When `url` is
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
 * wrapper) — detected as: no `mcpServers` key present, but every top-level
 * value looks like a server config (a plain object). That bare-map shape is
 * accepted silently (not a `ParseError` — it's a supported input shape, not
 * malformed input); which shape was accepted only affects which object this
 * function walks, so no output field records it.
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

  const parseErrors = [];
  let serverMap: Record<string, unknown>;
  if (isPlainObject(value.mcpServers)) {
    serverMap = value.mcpServers;
  } else {
    // Bare shape: the file itself is the server map.
    serverMap = value;
  }

  const servers: McpServerConfig[] = [];
  for (const [name, raw] of Object.entries(serverMap)) {
    const server = parseServerConfig(name, raw);
    if (server) {
      servers.push(server);
    } else {
      parseErrors.push(makeParseError('invalid_server_config', `MCP server "${name}" is not a valid config object`));
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
