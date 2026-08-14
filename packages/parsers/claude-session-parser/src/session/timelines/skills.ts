/**
 * `deriveSkillTimeline` — spec §2/Skills.
 *
 * Sources, per the spec's Evidence paragraph:
 *  - `skill_listing` attachments: direct availability signal (`'listed'`),
 *    diffed against the previous listing to detect `'delisted'`.
 *  - `dynamic_skill` attachments: ties an available skill to its on-disk
 *    directory (`'discovered'`).
 *  - `invoked_skills` attachments: a second, independent source of
 *    `injectedContent`/`qualifiedPath`.
 *  - A `tool_use` block named `Skill` (`isSkillTool`): `'invoked'`.
 *  - A follow-up `isMeta: true` user entry whose text begins `"Base
 *    directory for this skill: <path>\n\n# <Title>…"`: the skill body
 *    actually being injected (`'expanded'`).
 *  - `attributionSkill` on assistant entries: per-turn attribution.
 *
 * Per `src/AGENTS.md`'s Domain Terminology, Skill is a concept distinct
 * from Tools/Agents — this module never folds a skill record into
 * `ToolAvailabilityRecord` or vice versa.
 */

import type {
  AssistantEntry,
  AttachmentEntry,
  ClaudeCodeEntry,
  ContentBlock,
  DynamicSkillAttachment,
  InvokedSkillsAttachment,
  SkillListingAttachment,
  UserEntry,
} from '../../types/session.js';
import type { SkillAvailabilityRecord } from '../../types/timeline.js';
import type { TimelineDeriveOptions } from './context.js';
import { eventFrom, isAttachment } from './context.js';
import { getOrThrow } from '../../utils/maps.js';
import { isSkillTool } from '../../utils/tool-names.js';
import { clampBlob } from '../../utils/text.js';

const EXPANSION_PREFIX = 'Base directory for this skill: ';

/**
 * `entry.type === 'user'`/`'assistant'` alone doesn't narrow `entry` away
 * from `UnknownEntry` — see the identical helper in `agents.ts` for why
 * (`UnknownEntry.type` is a plain `string`, not a literal, so equality
 * checks against it never prove that member false; checking for a field
 * `UnknownEntry` doesn't declare forces a real narrow).
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

/**
 * `skill_listing.content` is `"- <name>: <description>\n- …"`, but a
 * description can itself contain literal embedded newlines (confirmed
 * real: some skill descriptions are multi-paragraph, e.g. a `claude-api`
 * skill's trigger/skip rules span several raw lines with no leading `"- "`
 * marker of their own) — a naive per-line split would silently truncate
 * those descriptions at the first internal newline. `names` (from the same
 * attachment, confirmed to share `content`'s order) gives the authoritative
 * ordered set of `"- <name>: "` markers to slice on instead.
 */
function parseSkillListingDescriptions(content: string, names: string[]): Map<string, string> {
  const descriptions = new Map<string, string>();
  let cursor = 0;
  for (let i = 0; i < names.length; i++) {
    const marker = `- ${names[i]}: `;
    const start = content.indexOf(marker, cursor);
    if (start === -1) continue;
    const descStart = start + marker.length;
    let descEnd = content.length;
    for (let j = i + 1; j < names.length; j++) {
      const nextIdx = content.indexOf(`- ${names[j]}: `, descStart);
      if (nextIdx !== -1) {
        descEnd = nextIdx;
        break;
      }
    }
    descriptions.set(names[i], content.slice(descStart, descEnd).trim());
    cursor = descStart;
  }
  return descriptions;
}

/** First-`:` split: `"my-plugin:my-skill"` -> prefix + bare name. */
function splitSkillName(name: string): { pluginPrefix?: string; bareName: string } {
  const idx = name.indexOf(':');
  if (idx === -1) return { bareName: name };
  return { pluginPrefix: name.slice(0, idx), bareName: name.slice(idx + 1) };
}

/** Pulls the first `text` block's text out of a user message (or the string form directly). */
function extractUserText(message: UserEntry['message']): string | undefined {
  const { content } = message;
  if (typeof content === 'string') return content;
  for (const block of content) {
    if (block.type === 'text' && typeof (block as { text?: unknown }).text === 'string') {
      return (block as { text: string }).text;
    }
  }
  return undefined;
}

/**
 * Index of the entries array by `tool_result.tool_use_id`, first match
 * wins. Built once up front so pairing each `Skill` invocation with its
 * result is O(1) instead of an O(n) forward scan per invocation.
 */
function buildResultIndexByToolUseId(entries: ClaudeCodeEntry[]): Map<string, number> {
  const map = new Map<string, number>();
  entries.forEach((entry, idx) => {
    if (!isUserEntry(entry)) return;
    const { content } = entry.message;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (block.type === 'tool_result' && typeof block.tool_use_id === 'string' && !map.has(block.tool_use_id)) {
        map.set(block.tool_use_id, idx);
      }
    }
  });
  return map;
}

export function deriveSkillTimeline(entries: ClaudeCodeEntry[], options?: TimelineDeriveOptions): SkillAvailabilityRecord[] {
  const maxBlobBytes = options?.maxBlobBytes;
  const records = new Map<string, SkillAvailabilityRecord>();
  const order: string[] = [];

  function getOrCreate(name: string): SkillAvailabilityRecord {
    let rec = records.get(name);
    if (!rec) {
      const { pluginPrefix, bareName } = splitSkillName(name);
      rec = {
        name,
        pluginPrefix,
        bareName,
        availability: [],
        invocationCount: 0,
        invocations: [],
        attributedTurnCount: 0,
      };
      records.set(name, rec);
      order.push(name);
    }
    return rec;
  }

  // Real evidence (see PR notes): `skill_listing.names` is a per-context
  // listing, not always the whole-session superset — a subagent's own
  // narrower skill set can legitimately show up as a later `skill_listing`
  // with far fewer names than the session-opening one. Per this task's
  // brief, delisting is still computed by diffing each listing against the
  // immediately previous one; see `## Notes for the reviewer` in the PR for
  // the corpus evidence behind this caveat.
  let previousNames: Set<string> | null = null;

  // `Skill` tool_use results are looked up once, up front (see helper doc).
  const resultIndexByToolUseId = buildResultIndexByToolUseId(entries);

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];

    if (isAttachment(entry, 'skill_listing')) {
      const att = (entry as AttachmentEntry).attachment as SkillListingAttachment;
      const descriptions = parseSkillListingDescriptions(att.content, att.names);
      const currentNames = new Set(att.names);

      for (const name of att.names) {
        const rec = getOrCreate(name);
        const desc = descriptions.get(name);
        if (desc && rec.description === undefined) rec.description = desc;
        rec.availability.push(eventFrom(entry, 'listed', att.isInitial));
      }

      if (previousNames) {
        for (const prevName of previousNames) {
          if (!currentNames.has(prevName)) {
            const rec = getOrCreate(prevName);
            rec.availability.push(eventFrom(entry, 'delisted'));
          }
        }
      }
      previousNames = currentNames;
      continue;
    }

    if (isAttachment(entry, 'dynamic_skill')) {
      const att = (entry as AttachmentEntry).attachment as DynamicSkillAttachment;
      for (const name of att.skillNames) {
        const rec = getOrCreate(name);
        if (rec.sourceDir === undefined) rec.sourceDir = att.skillDir;
        if (rec.displayPath === undefined) rec.displayPath = att.displayPath;
        rec.availability.push(eventFrom(entry, 'discovered'));
      }
      continue;
    }

    if (isAttachment(entry, 'invoked_skills')) {
      const att = (entry as AttachmentEntry).attachment as InvokedSkillsAttachment;
      for (const s of att.skills) {
        const rec = getOrCreate(s.name);
        if (rec.qualifiedPath === undefined) rec.qualifiedPath = s.path;
        if (rec.injectedContent === undefined && s.content) {
          rec.injectedContent = clampBlob(s.content, maxBlobBytes);
        }
      }
      continue;
    }

    if (isAssistantEntry(entry)) {
      if (entry.attributionSkill) {
        const rec = getOrCreate(entry.attributionSkill);
        rec.attributedTurnCount += 1;
      }

      for (const raw of entry.message.content) {
        if (raw.type !== 'tool_use') continue;
        const block = raw as ToolUseBlock;
        if (!isSkillTool(block.name)) continue;

        const skillName = typeof block.input.skill === 'string' ? (block.input.skill as string) : undefined;
        if (!skillName) continue;

        const rec = getOrCreate(skillName);
        const args = typeof block.input.args === 'string' ? (block.input.args as string) : undefined;

        const invocation: SkillAvailabilityRecord['invocations'][number] = {
          entryUuid: entry.uuid,
          toolUseId: block.id,
          timestampMs: entry.timestampMs,
          launched: false,
        };
        if (args !== undefined) invocation.args = args;
        rec.invocations.push(invocation);
        rec.availability.push(eventFrom(entry, 'invoked'));

        // Expansion detection: the entry immediately following this
        // invocation's `tool_result` — when it's an `isMeta` user entry
        // whose text starts with the skill-body marker, the invocation
        // "launched" (Claude Code actually injected the skill body).
        // Confirmed real: `<tool_use> -> <tool_result> -> <isMeta
        // expansion>` are consecutive array entries in every observed case
        // (dozens across the corpus); a failed invocation (e.g. "Unknown
        // skill: X", `is_error: true`) has no such follow-up, so
        // `launched` correctly stays `false` for it.
        const resultIdx = resultIndexByToolUseId.get(block.id);
        if (resultIdx !== undefined) {
          const candidate = entries[resultIdx + 1];
          if (candidate && candidate.type === 'user' && (candidate as UserEntry).isMeta) {
            const text = extractUserText((candidate as UserEntry).message);
            if (text?.startsWith(EXPANSION_PREFIX)) {
              invocation.launched = true;
              if (rec.injectedContent === undefined) {
                rec.injectedContent = clampBlob(text, maxBlobBytes);
              }
              const pathEnd = text.indexOf('\n\n', EXPANSION_PREFIX.length);
              if (rec.sourceDir === undefined && pathEnd !== -1) {
                rec.sourceDir = text.slice(EXPANSION_PREFIX.length, pathEnd);
              }
              rec.availability.push(eventFrom(candidate, 'expanded'));
            }
          }
        }
      }
    }
  }

  for (const name of order) {
    const rec = getOrThrow(records, name);
    rec.invocationCount = rec.invocations.length;
  }

  return order.map((name) => getOrThrow(records, name));
}
