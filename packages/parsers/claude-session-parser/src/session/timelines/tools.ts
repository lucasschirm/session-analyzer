/**
 * `deriveToolTimeline` — spec §2/Tools.
 *
 * One `ToolAvailabilityRecord` per distinct tool name, built from a single
 * chronological pass over `entries`. `deferred_tools_delta` attachments are
 * the primary signal for availability changes; every `tool_use` content
 * block contributes an `'invoked'` event and the invocation counters.
 *
 * NOTE: `command_permissions.allowedTools` attachments are a *different*
 * axis (permission scoping, not tool *availability*) — spec §2/Tools says so
 * explicitly. This function deliberately does not read `command_permissions`
 * attachments at all; do not "fix" this by wiring them in here.
 */

import type {
  AssistantEntry,
  AttachmentEntry,
  ClaudeCodeEntry,
  DeferredToolsDeltaAttachment,
} from '../../types/session.js';
import type { ToolAvailabilityAction, ToolAvailabilityRecord } from '../../types/timeline.js';
import { splitMcpToolName } from '../../utils/mcp-names.js';
import type { TimelineDeriveOptions } from './context.js';
import { entryTimestampMs, eventFrom } from './context.js';

/** `ClaudeCodeEntry`'s `UnknownEntry` member types `type` as a bare
 *  `string`, which TypeScript can't exclude via a `entry.type === '...'`
 *  literal check the way it can for the other, precisely-discriminated
 *  members — so every switch below narrows manually with a cast instead of
 *  relying on control-flow narrowing alone. Same for `ContentBlock`'s
 *  forward-compatible catch-all member. */
type ToolUseBlock = { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };

/**
 * `addedLines[i]` is index-aligned with `addedNames[i]` in every real
 * `deferred_tools_delta` sample checked (corpus grep, 2026-08) — but the
 * spec explicitly warns not to assume that alignment holds in general, so
 * this verifies the line actually starts with the bare name (at a word
 * boundary) before trusting the positional match, and falls back to a
 * content search otherwise. Returns `undefined` when the line is just the
 * bare name (no description) or no matching line is found.
 */
function extractDescription(
  name: string,
  addedNames: string[],
  addedLines: string[],
): string | undefined {
  if (addedLines.length === 0) return undefined;

  const isWordBoundaryMatch = (line: string): boolean => {
    if (line === name) return true;
    if (!line.startsWith(name)) return false;
    const next = line.charAt(name.length);
    return next === '' || !/[A-Za-z0-9_]/.test(next);
  };

  const idx = addedNames.indexOf(name);
  let line: string | undefined;
  if (idx !== -1 && idx < addedLines.length && isWordBoundaryMatch(addedLines[idx])) {
    line = addedLines[idx];
  } else {
    line = addedLines.find(isWordBoundaryMatch);
  }
  if (line === undefined || line === name) return undefined;

  const rest = line.slice(name.length);
  const separatorMatch = rest.match(/^\s*[:\-—]\s*(.+)$/);
  const description = (separatorMatch ? separatorMatch[1] : rest).trim();
  return description.length > 0 ? description : undefined;
}

/**
 * `'undeferred'` has no explicit "tool loaded" signal anywhere in the
 * transcript (spec §2/Tools). Model it best-effort, derived only from an
 * unambiguous `ToolSearch` invocation whose `query` is the `select:name1,
 * name2` form — never guess from free-text queries (e.g. "notebook
 * jupyter"), which real transcripts also contain alongside `select:` ones.
 */
function parseToolSearchSelectQuery(query: string): string[] | undefined {
  const prefix = 'select:';
  if (!query.startsWith(prefix)) return undefined;
  const names = query
    .slice(prefix.length)
    .split(',')
    .map((n) => n.trim())
    .filter((n) => n.length > 0);
  return names.length > 0 ? names : undefined;
}

function getOrCreate(
  map: Map<string, ToolAvailabilityRecord>,
  name: string,
): ToolAvailabilityRecord {
  let record = map.get(name);
  if (!record) {
    const split = splitMcpToolName(name);
    record = {
      tool: name,
      availability: [],
      alwaysAvailable: false, // computed at the end of the pass — see below
      invocationCount: 0,
      ...(split ? { mcpServer: split.server, mcpToolName: split.tool } : {}),
    };
    map.set(name, record);
  }
  return record;
}

export function deriveToolTimeline(
  entries: ClaudeCodeEntry[],
  options?: TimelineDeriveOptions,
): ToolAvailabilityRecord[] {
  void options; // no blob-size-sensitive fields in this record type

  const records = new Map<string, ToolAvailabilityRecord>();
  /** Union, across the whole session, of every name that ever appeared in
   *  ANY `deferred_tools_delta` array (added/removed/readded). Used to
   *  compute `alwaysAvailable` per spec's resolved decision: "invoked but
   *  never in any delta ⇒ always-available", computed per-session rather
   *  than from the `ALWAYS_AVAILABLE_TOOLS` reference constant. */
  const everDeferredNames = new Set<string>();

  for (const entry of entries) {
    if (
      entry.type === 'attachment' &&
      (entry as AttachmentEntry).attachment.type === 'deferred_tools_delta'
    ) {
      const att = (entry as AttachmentEntry).attachment as DeferredToolsDeltaAttachment;
      const readdedSet = new Set(att.readdedNames ?? []);

      for (const name of att.addedNames) {
        everDeferredNames.add(name);
        const record = getOrCreate(records, name);
        const action: ToolAvailabilityAction = readdedSet.has(name) ? 'readded' : 'deferred';
        record.availability.push(eventFrom(entry, action));
        if (action === 'deferred') {
          const description = extractDescription(name, att.addedNames, att.addedLines);
          if (description !== undefined) record.description = description;
        }
      }

      // Defensive: real corpus always has `readdedNames ⊆ addedNames` (a
      // pure re-add delta repeats the names in both arrays), but the spec
      // doesn't guarantee that — cover any name that shows up only in
      // `readdedNames` too, without double-emitting for names already
      // handled above.
      for (const name of readdedSet) {
        if (att.addedNames.includes(name)) continue;
        everDeferredNames.add(name);
        const record = getOrCreate(records, name);
        record.availability.push(eventFrom(entry, 'readded'));
      }

      for (const name of att.removedNames) {
        everDeferredNames.add(name);
        const record = getOrCreate(records, name);
        record.availability.push(eventFrom(entry, 'removed'));
      }
    }

    if (entry.type === 'assistant') {
      const assistant = entry as AssistantEntry;
      for (const rawBlock of assistant.message.content) {
        if (rawBlock.type !== 'tool_use') continue;
        const block = rawBlock as ToolUseBlock;
        const name = block.name;
        const record = getOrCreate(records, name);

        record.invocationCount += 1;
        const timestampMs = entryTimestampMs(entry);
        if (timestampMs !== undefined) {
          if (record.firstInvokedAtMs === undefined) record.firstInvokedAtMs = timestampMs;
          record.lastInvokedAtMs = timestampMs;
        }
        record.availability.push(eventFrom(entry, 'invoked'));

        if (name === 'ToolSearch') {
          const query = block.input.query;
          if (typeof query === 'string') {
            const selected = parseToolSearchSelectQuery(query);
            if (selected) {
              for (const selectedName of selected) {
                const selectedRecord = getOrCreate(records, selectedName);
                selectedRecord.availability.push(eventFrom(entry, 'undeferred'));
              }
            }
            // else: free-text query (e.g. "notebook jupyter") — leave
            // 'undeferred' unset rather than guessing, per spec.
          }
        }
      }
    }
  }

  for (const record of records.values()) {
    record.alwaysAvailable = record.invocationCount > 0 && !everDeferredNames.has(record.tool);
  }

  return Array.from(records.values());
}
