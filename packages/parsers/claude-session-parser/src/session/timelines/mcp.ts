/**
 * `deriveMcpTimeline` — spec §2/MCP.
 *
 * One `McpServerRecord` per MCP server, built from a chronological pass over
 * `entries`. `mcp_instructions_delta` attachments carry instructions
 * availability directly; `deferred_tools_delta`'s `pendingMcpServers` /
 * `needsAuthMcpServers` carry connection status; `mcp__<ns>__<tool>`-shaped
 * names in `deferred_tools_delta` and in actual `tool_use` blocks carry
 * offered/invoked tools.
 *
 * Name normalization is the confirmed real gotcha (spec §2/MCP evidence): a
 * server declared as `"acme:mcp"` is reported with the colon intact by
 * `attributionMcpServer` and in `mcp_instructions_delta`/`pendingMcpServers`/
 * `needsAuthMcpServers`, but embedded in transcript tool names as
 * `mcp__acme_mcp__<tool>` (colon → underscore; hyphens like
 * `claude-in-chrome` preserved as-is). `server` on the resulting record
 * holds the literal name as Claude Code reports it; `toolNamespace` holds
 * the `mcpServerNameToNamespace`-mapped form used inside tool names.
 *
 * Does NOT model MCP prompts/resources or any health/disconnect status —
 * the transcript never records them (spec §8 refutes this explicitly against
 * the official MCP TypeScript SDK's wire protocol).
 */

import type {
  AssistantEntry,
  AttachmentEntry,
  ClaudeCodeEntry,
  DeferredToolsDeltaAttachment,
  McpInstructionsDeltaAttachment,
} from '../../types/session.js';
import type { McpServerRecord } from '../../types/timeline.js';
import { mcpServerNameToNamespace, splitMcpToolName } from '../../utils/mcp-names.js';
import type { TimelineDeriveOptions } from './context.js';
import { eventFrom } from './context.js';

/** `ClaudeCodeEntry`'s `UnknownEntry` member types `type` as a bare
 *  `string`, which TypeScript can't exclude via a `entry.type === '...'`
 *  literal check the way it can for the other, precisely-discriminated
 *  members — so every switch below narrows manually with a cast instead of
 *  relying on control-flow narrowing alone. Same for `ContentBlock`'s
 *  forward-compatible catch-all member. */
type ToolUseBlock = { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };

function getOrCreate(map: Map<string, McpServerRecord>, server: string): McpServerRecord {
  let record = map.get(server);
  if (!record) {
    record = {
      server,
      toolNamespace: mcpServerNameToNamespace(server),
      availability: [],
      offeredTools: [],
      invokedTools: [],
      pending: false,
      needsAuth: false,
    };
    map.set(server, record);
  }
  return record;
}

/**
 * `mcpServerNameToNamespace` is confirmed one-way/lossy (see its doc
 * comment in `utils/mcp-names.ts`): a bare `_` in a namespace is
 * indistinguishable from a mapped `:`. To join transcript tool names
 * (`mcp__<namespace>__<tool>`) back to the *literal* server name Claude Code
 * reports elsewhere (`"acme:mcp"`, not `"acme_mcp"`), this pre-scans the whole
 * entry list once for every place a literal server name is recorded
 * (`mcp_instructions_delta`, `pendingMcpServers`/`needsAuthMcpServers`,
 * `attributionMcpServer`) and indexes it by its mapped namespace. Falls back
 * to treating the namespace itself as the server name when no literal name
 * was ever observed for it — best-effort, since a session can invoke an MCP
 * tool for a server whose delta/attribution never appears in the visible
 * transcript (e.g. a subagent-only transcript slice).
 */
function buildNamespaceToServerName(entries: ClaudeCodeEntry[]): Map<string, string> {
  const namespaceToServer = new Map<string, string>();
  const note = (server: string): void => {
    const namespace = mcpServerNameToNamespace(server);
    if (!namespaceToServer.has(namespace)) namespaceToServer.set(namespace, server);
  };

  for (const entry of entries) {
    if (
      entry.type === 'attachment' &&
      (entry as AttachmentEntry).attachment.type === 'mcp_instructions_delta'
    ) {
      const att = (entry as AttachmentEntry).attachment as McpInstructionsDeltaAttachment;
      for (const name of att.addedNames) note(name);
      for (const name of att.removedNames) note(name);
    } else if (
      entry.type === 'attachment' &&
      (entry as AttachmentEntry).attachment.type === 'deferred_tools_delta'
    ) {
      const att = (entry as AttachmentEntry).attachment as DeferredToolsDeltaAttachment;
      for (const name of att.pendingMcpServers ?? []) note(name);
      for (const name of att.needsAuthMcpServers ?? []) note(name);
    } else if (entry.type === 'assistant' && (entry as AssistantEntry).attributionMcpServer) {
      note((entry as AssistantEntry).attributionMcpServer as string);
    }
  }
  return namespaceToServer;
}

/** Groups `mcp__<namespace>__<tool>`-shaped names by their resolved literal
 *  server name. Non-MCP-shaped names (plain tool names like `WebFetch`) are
 *  silently skipped — this is the MCP-specific view of the same
 *  `deferred_tools_delta` attachment `tools.ts` also reads for its own,
 *  non-MCP tool records. */
function groupMcpToolsByServer(
  names: string[],
  namespaceToServer: Map<string, string>,
): Map<string, string[]> {
  const bySrv = new Map<string, string[]>();
  for (const name of names) {
    const split = splitMcpToolName(name);
    if (!split) continue;
    const server = namespaceToServer.get(split.server) ?? split.server;
    const list = bySrv.get(server);
    if (list) list.push(split.tool);
    else bySrv.set(server, [split.tool]);
  }
  return bySrv;
}

export function deriveMcpTimeline(
  entries: ClaudeCodeEntry[],
  options?: TimelineDeriveOptions,
): McpServerRecord[] {
  void options; // no blob-size-sensitive fields retained beyond `instructions`, which is not capped here

  const namespaceToServer = buildNamespaceToServerName(entries);
  const records = new Map<string, McpServerRecord>();

  for (const entry of entries) {
    if (
      entry.type === 'attachment' &&
      (entry as AttachmentEntry).attachment.type === 'mcp_instructions_delta'
    ) {
      const att = (entry as AttachmentEntry).attachment as McpInstructionsDeltaAttachment;

      for (const name of att.addedNames) {
        const record = getOrCreate(records, name);
        record.availability.push(eventFrom(entry, 'instructions_added'));
      }

      // Match blocks to servers by their `## <server>` header rather than
      // by array position — more robust than assuming index-alignment with
      // `addedNames`, even though the real corpus happens to keep them
      // aligned. A block can end with a literal "… [truncated]" suffix
      // (confirmed, spec §1.2) — retained verbatim, it's free text.
      for (const block of att.addedBlocks) {
        const headerMatch = block.match(/^##\s+(.+?)\n([\s\S]*)$/);
        if (!headerMatch) continue; // unrecognized block shape — skip, never throw
        const [, blockServer, body] = headerMatch;
        const record = getOrCreate(records, blockServer);
        record.instructions = body;
      }

      for (const name of att.removedNames) {
        const record = getOrCreate(records, name);
        record.availability.push(eventFrom(entry, 'instructions_removed'));
        record.instructions = undefined; // superseded by removal
      }
    }

    if (
      entry.type === 'attachment' &&
      (entry as AttachmentEntry).attachment.type === 'deferred_tools_delta'
    ) {
      const att = (entry as AttachmentEntry).attachment as DeferredToolsDeltaAttachment;

      for (const server of att.pendingMcpServers ?? []) {
        const record = getOrCreate(records, server);
        record.pending = true;
        record.needsAuth = false; // the two statuses are mutually exclusive; the later one wins
        record.availability.push(eventFrom(entry, 'pending'));
      }

      for (const server of att.needsAuthMcpServers ?? []) {
        const record = getOrCreate(records, server);
        record.needsAuth = true;
        record.pending = false;
        record.availability.push(eventFrom(entry, 'needs_auth'));
      }

      // `readdedNames` is folded into the same `addedNames`-derived offer
      // set: the real corpus always has `readdedNames ⊆ addedNames` for a
      // pure re-add delta, and `McpAvailabilityAction` has no separate
      // "readded" action for offered tools anyway (only 'tools_offered' /
      // 'tools_removed') — a re-offer is observably the same event.
      const extraReadded = (att.readdedNames ?? []).filter((n) => !att.addedNames.includes(n));
      const offeredBySrv = groupMcpToolsByServer(
        [...att.addedNames, ...extraReadded],
        namespaceToServer,
      );
      for (const [server, tools] of offeredBySrv) {
        const record = getOrCreate(records, server);
        for (const tool of tools) {
          if (!record.offeredTools.includes(tool)) record.offeredTools.push(tool);
        }
        if (record.pending || record.needsAuth) {
          // Confirmed real transition: a `pendingMcpServers: ["helper"]`
          // delta was followed later in the same session by an
          // `addedNames: ["mcp__helper__..."]` delta for that same server —
          // tools actually being offered means the server finished
          // connecting, so pending/needs-auth status is superseded.
          record.pending = false;
          record.needsAuth = false;
        }
        record.availability.push(eventFrom(entry, 'tools_offered'));
      }

      const removedBySrv = groupMcpToolsByServer(att.removedNames, namespaceToServer);
      for (const [server, tools] of removedBySrv) {
        const record = getOrCreate(records, server);
        record.offeredTools = record.offeredTools.filter((t) => !tools.includes(t));
        record.availability.push(eventFrom(entry, 'tools_removed'));
      }
    }

    if (entry.type === 'assistant') {
      const assistant = entry as AssistantEntry;
      // `attributionMcpServer`/`attributionMcpTool` are used above (in the
      // pre-scan) as a literal-name signal only. They are deliberately NOT
      // used here to count invocations: real transcripts show this pair
      // staying set ("sticky") across many subsequent turns whose actual
      // `tool_use` blocks are unrelated tools (Bash, Read, TaskUpdate, ...),
      // so treating every attributed turn as an invocation would wildly
      // overcount. Only real `mcp__*` `tool_use` blocks count as invocations.
      for (const rawBlock of assistant.message.content) {
        if (rawBlock.type !== 'tool_use') continue;
        const block = rawBlock as ToolUseBlock;
        const split = splitMcpToolName(block.name);
        if (!split) continue;
        const server = namespaceToServer.get(split.server) ?? split.server;
        const record = getOrCreate(records, server);

        const existing = record.invokedTools.find((t) => t.tool === split.tool);
        if (existing) existing.count += 1;
        else record.invokedTools.push({ tool: split.tool, count: 1 });

        record.availability.push(eventFrom(entry, 'invoked'));
      }
    }
  }

  return Array.from(records.values());
}
