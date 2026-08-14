/**
 * `deriveAgentTimeline` — spec §2/Agents.
 *
 * Sources, per the spec's Evidence paragraph:
 *  - `agent_listing_delta` attachments: direct `'listed'`/`'delisted'`
 *    signal (`addedTypes`/`removedTypes` — real non-empty `removedTypes`
 *    confirmed in the corpus), plus `addedLines[]` free-text descriptions.
 *  - `agent_mention` attachments: `'mentioned'`.
 *  - A `tool_use` block whose name passes `isAgentTool` (`Agent` or legacy
 *    `Task`): `'invoked'` and a `SubagentLaunchRecord`, paired with its
 *    result by `tool_use.id` <-> `tool_result.tool_use_id` /
 *    `sourceToolUseID`. `toolUseResult.agentId` is confirmed (cross-checked
 *    against a real `subagents/agent-<id>.meta.json`'s `toolUseId` field)
 *    to be the exact bidirectional key into that subagent's own transcript.
 *  - `attributionAgent` on assistant entries: per-turn attribution
 *    (appears on sidechain entries).
 */

import type {
  AgentListingDeltaAttachment,
  AgentMentionAttachment,
  AssistantEntry,
  AttachmentEntry,
  ClaudeCodeEntry,
  ContentBlock,
  ToolUseResult,
  UserEntry,
} from '../../types/session.js';
import type { AgentAvailabilityRecord, SubagentLaunchRecord } from '../../types/timeline.js';
import type { TimelineDeriveOptions } from './context.js';
import { eventFrom, isAttachment } from './context.js';
import { getOrThrow } from '../../utils/maps.js';
import { isAgentTool } from '../../utils/tool-names.js';

/**
 * `entry.type === 'user'`/`'assistant'` alone doesn't narrow `entry` away
 * from `UnknownEntry` — `UnknownEntry.type` is typed as plain `string`
 * (forward-compatibility catch-all), which TS treats as still assignable
 * from any literal, so an equality check against it can never be proven
 * false for that union member. Checking for a field `UnknownEntry` doesn't
 * declare (`message`) forces a real narrow.
 */
function isUserEntry(entry: ClaudeCodeEntry): entry is UserEntry {
  return entry.type === 'user' && 'message' in entry;
}
function isAssistantEntry(entry: ClaudeCodeEntry): entry is AssistantEntry {
  return entry.type === 'assistant' && 'message' in entry;
}

/**
 * `ContentBlock`'s forward-compatible catch-all member (`{ type: string;
 * [k: string]: unknown }`) carries an index signature, which defeats
 * ordinary discriminated-union narrowing the same way `UnknownEntry` does
 * above — worse, its index signature means even an `'id' in block`-style
 * guard can't exclude it either. An explicit `Extract` cast, applied only
 * after checking the runtime discriminant, sidesteps the problem instead
 * of fighting it.
 */
type ToolUseBlock = Extract<ContentBlock, { type: 'tool_use' }>;

/** First-`:` split, mirroring `splitSkillName` in `skills.ts`. */
function splitAgentType(agentType: string): { pluginPrefix?: string } {
  const idx = agentType.indexOf(':');
  if (idx === -1) return {};
  return { pluginPrefix: agentType.slice(0, idx) };
}

/**
 * `agent_listing_delta.addedLines[i]` corresponds 1:1, in order, to
 * `addedTypes[i]` (confirmed real) and looks like
 * `"- <name>: <description…, possibly with literal embedded newlines>
 * (Tools: All tools)"`. Since the exact `name` is already known from
 * `addedTypes`, this strips the known `"- <name>: "` prefix and then
 * splits off the trailing `" (Tools: …)"` suffix from the end, rather than
 * re-parsing the name — descriptions can themselves contain parenthesized
 * text, so anchoring on the known prefix/suffix is more robust than a
 * single greedy regex.
 */
function parseAgentListingLine(line: string, agentType: string): { description?: string; tools?: string } {
  const prefix = `- ${agentType}: `;
  const rest = line.startsWith(prefix) ? line.slice(prefix.length) : line;

  const marker = ' (Tools: ';
  const idx = rest.lastIndexOf(marker);
  if (idx === -1) {
    const description = rest.trim();
    return description ? { description } : {};
  }

  let tools = rest.slice(idx + marker.length);
  if (tools.endsWith(')')) tools = tools.slice(0, -1);
  const description = rest.slice(0, idx).trim();
  const result: { description?: string; tools?: string } = {};
  if (description) result.description = description;
  if (tools) result.tools = tools;
  return result;
}

/**
 * Index of the entries array by `tool_result.tool_use_id` /
 * `sourceToolUseID`, first match wins — built once so pairing each launch
 * with its result is O(1) instead of an O(n) forward scan per launch. Real
 * `Agent` results are always paired via the `tool_result` content block
 * (confirmed corpus-wide); `sourceToolUseID` is included too per the task
 * brief's instruction, as a defensive fallback for a pairing shape not
 * observed in this machine's corpus.
 */
function buildResultIndexByToolUseId(entries: ClaudeCodeEntry[]): Map<string, UserEntry> {
  const map = new Map<string, UserEntry>();
  for (const entry of entries) {
    if (!isUserEntry(entry)) continue;
    const { content } = entry.message;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'tool_result' && typeof block.tool_use_id === 'string' && !map.has(block.tool_use_id)) {
          map.set(block.tool_use_id, entry);
        }
      }
    }
    if (entry.sourceToolUseID && !map.has(entry.sourceToolUseID)) {
      map.set(entry.sourceToolUseID, entry);
    }
  }
  return map;
}

export function deriveAgentTimeline(
  entries: ClaudeCodeEntry[],
  options?: TimelineDeriveOptions,
): { agents: AgentAvailabilityRecord[]; subagentLaunches: SubagentLaunchRecord[] } {
  void options; // no retained-blob fields in this timeline today

  const records = new Map<string, AgentAvailabilityRecord>();
  const order: string[] = [];
  const subagentLaunches: SubagentLaunchRecord[] = [];

  function getOrCreate(agentType: string): AgentAvailabilityRecord {
    let rec = records.get(agentType);
    if (!rec) {
      rec = {
        agentType,
        ...splitAgentType(agentType),
        availability: [],
        invocations: [],
        attributedTurnCount: 0,
      };
      records.set(agentType, rec);
      order.push(agentType);
    }
    return rec;
  }

  const resultByToolUseId = buildResultIndexByToolUseId(entries);

  for (const entry of entries) {
    if (isAttachment(entry, 'agent_listing_delta')) {
      const att = (entry as AttachmentEntry).attachment as AgentListingDeltaAttachment;

      att.addedTypes.forEach((agentType, idx) => {
        const rec = getOrCreate(agentType);
        const parsed = parseAgentListingLine(att.addedLines[idx] ?? '', agentType);
        if (parsed.description && rec.listingDescription === undefined) {
          rec.listingDescription = parsed.description;
        }
        if (parsed.tools && rec.listingTools === undefined) {
          rec.listingTools = parsed.tools;
        }
        rec.availability.push(eventFrom(entry, 'listed', att.isInitial));
      });

      for (const agentType of att.removedTypes) {
        const rec = getOrCreate(agentType);
        rec.availability.push(eventFrom(entry, 'delisted'));
      }
      continue;
    }

    if (isAttachment(entry, 'agent_mention')) {
      const att = (entry as AttachmentEntry).attachment as AgentMentionAttachment;
      if (att.agentType) {
        const rec = getOrCreate(att.agentType);
        rec.availability.push(eventFrom(entry, 'mentioned'));
      }
      continue;
    }

    if (isAssistantEntry(entry)) {
      if (entry.attributionAgent) {
        const rec = getOrCreate(entry.attributionAgent);
        rec.attributedTurnCount += 1;
      }

      for (const raw of entry.message.content) {
        if (raw.type !== 'tool_use') continue;
        const block = raw as ToolUseBlock;
        if (!isAgentTool(block.name)) continue;

        // Never treats TaskCreate/TaskUpdate/TaskGet/TaskList/TaskOutput/
        // TaskStop as agent launches — `isAgentTool` already excludes them.
        const input = block.input;
        const agentType = typeof input.subagent_type === 'string' ? (input.subagent_type as string) : '';
        const rec = getOrCreate(agentType);

        const launch: SubagentLaunchRecord = {
          toolUseId: block.id,
          entryUuid: entry.uuid,
          agentType,
          timestampMs: entry.timestampMs,
        };
        if (typeof input.description === 'string') launch.description = input.description as string;
        if (typeof input.prompt === 'string') launch.prompt = input.prompt as string;
        if (typeof input.run_in_background === 'boolean') launch.runInBackground = input.run_in_background as boolean;

        const resultEntry = resultByToolUseId.get(block.id);
        if (resultEntry) {
          if (resultEntry.uuid) launch.resultEntryUuid = resultEntry.uuid;
          const tur: ToolUseResult | undefined = resultEntry.toolUseResult;
          if (tur) {
            if (typeof tur.agentId === 'string') launch.agentId = tur.agentId;
            if (typeof tur.resolvedModel === 'string') launch.model = tur.resolvedModel;
            if (typeof tur.isAsync === 'boolean') launch.isAsync = tur.isAsync;
            if (typeof tur.totalTokens === 'number') launch.totalTokens = tur.totalTokens;
          }
        }
        // No result found (e.g. background agent that never resolved in
        // this transcript) — `resultEntryUuid` and friends simply stay
        // unset; this must never throw.

        rec.invocations.push(launch);
        subagentLaunches.push(launch);
        rec.availability.push(eventFrom(entry, 'invoked'));
      }
    }
  }

  return { agents: order.map((t) => getOrThrow(records, t)), subagentLaunches };
}
