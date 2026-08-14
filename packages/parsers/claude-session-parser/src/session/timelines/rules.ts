/**
 * `deriveRuleTimeline` — spec §2 "Rules". Builds one `RuleRecord` per rule
 * file path, from two direct transcript signals:
 *
 *  - `nested_memory` attachments: a complete injection record (the file was
 *    actually assembled into context — path, body, raw file, globs).
 *  - `compact_file_reference` attachments: a reference-without-content
 *    record (Claude Code mentions the file by name during/after compaction,
 *    but the transcript carries none of its content).
 *
 * **Critical semantic — read before touching `injectionStatus`:**
 * `RuleInjectionStatus` is tri-state (`'injected' | 'available' | 'unknown'`)
 * ON PURPOSE. Root-scope `CLAUDE.md`/`AGENTS.md` content is assembled into
 * the system prompt, which Claude Code *never* writes to the JSONL — so a
 * transcript alone can never prove whether a root-scope rule was in
 * context. `'available'` must never be emitted here as a way of saying "we
 * saw the file but not an injection"; that case is `'unknown'`. Getting
 * this backwards would make the parser assert something the data cannot
 * support. (`'available'` is reserved for `origin: 'config_inventory'`
 * records that T9's `appendRule` builder step adds from on-disk config
 * inventories — not something this function ever produces.)
 */

import type {
  AttachmentEntry,
  ClaudeCodeEntry,
  CompactFileReferenceAttachment,
  NestedMemoryAttachment,
} from '../../types/session.js';
import type { RuleAvailabilityAction, RuleFrontmatter, RuleRecord, RuleScope } from '../../types/timeline.js';
import { normalizeGlobs, parseFrontmatter } from '../../utils/frontmatter.js';
import { clampBlob } from '../../utils/text.js';
import { eventFrom, isAttachment } from './context.js';
import type { TimelineDeriveOptions } from './context.js';

const KNOWN_RULE_SCOPES = new Set<RuleScope>(['Project', 'User', 'Local', 'Managed']);

function toRuleScope(type: string | undefined): RuleScope {
  return type !== undefined && KNOWN_RULE_SCOPES.has(type as RuleScope) ? (type as RuleScope) : 'Unknown';
}

/** Last path segment, tolerant of a trailing slash. Used as the filename
 *  fallback for title derivation and for `compact_file_reference` records,
 *  which carry no body to pull a heading from. */
function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

/** `title` is derived from the first markdown heading (`#`…`######`) found
 *  in the rule's body, falling back to the file's basename when no heading
 *  is present (real rule/memory files are not guaranteed to start with a
 *  heading). */
function deriveTitle(body: string, path: string): string {
  const match = body.match(/^#{1,6}[ \t]+(.+?)[ \t]*$/m);
  if (match && match[1].trim().length > 0) return match[1].trim();
  return basename(path);
}

export function deriveRuleTimeline(entries: ClaudeCodeEntry[], options?: TimelineDeriveOptions): RuleRecord[] {
  const maxBlobBytes = options?.maxBlobBytes;
  const byPath = new Map<string, RuleRecord>();
  const order: string[] = [];

  for (const entry of entries) {
    if (isAttachment(entry, 'nested_memory')) {
      const attachment = (entry as AttachmentEntry).attachment as NestedMemoryAttachment;
      const path = attachment.path;
      const content = attachment.content ?? ({} as NestedMemoryAttachment['content']);
      const rawContent = content.rawContent ?? '';
      // `content.content` is already the frontmatter-stripped body Claude
      // Code actually injected; parsing `rawContent` ourselves gives us the
      // frontmatter object (and a body we fall back to only if `content`
      // itself is somehow absent).
      const { frontmatter: parsedFrontmatter, body: parsedBody } = parseFrontmatter(rawContent);
      const frontmatter = parsedFrontmatter as RuleFrontmatter;
      const injectedBody = content.content ?? parsedBody;
      // Prefer the attachment's own `content.globs` whenever the key is
      // present at all (even an empty array is real signal from Claude
      // Code itself) — only fall back to parsing frontmatter when the
      // attachment didn't carry globs of its own.
      const globs = content.globs !== undefined ? content.globs : normalizeGlobs(frontmatter);

      let record = byPath.get(path);
      if (!record) {
        record = {
          path,
          title: basename(path),
          scope: 'Unknown',
          injectionStatus: 'unknown',
          availability: [],
          origin: 'compact_file_reference',
        };
        byPath.set(path, record);
        order.push(path);
      }

      // Direct evidence always wins: seeing a `nested_memory` attachment
      // proves this rule WAS injected, even if an earlier sighting for the
      // same path was only a `compact_file_reference` (reference-without-
      // content). Never regress a proven 'injected' status back toward
      // 'unknown' — this mirrors the tri-state discipline documented above,
      // just applied across merged sightings instead of a single one.
      record.injectionStatus = 'injected';
      record.origin = 'nested_memory';
      record.title = deriveTitle(injectedBody, path);
      record.scope = toRuleScope(content.type);
      record.injectedContent = clampBlob(injectedBody, maxBlobBytes);
      record.rawContent = clampBlob(rawContent, maxBlobBytes);
      record.frontmatter = frontmatter;
      record.globs = globs;
      record.contentDiffersFromDisk = content.contentDiffersFromDisk;

      record.availability.push(eventFrom<RuleAvailabilityAction>(entry, 'injected'));
      continue;
    }

    if (isAttachment(entry, 'compact_file_reference')) {
      const attachment = (entry as AttachmentEntry).attachment as CompactFileReferenceAttachment;
      const path = attachment.filename;

      let record = byPath.get(path);
      if (!record) {
        record = {
          path,
          displayPath: attachment.displayPath,
          title: basename(path),
          scope: 'Unknown',
          injectionStatus: 'unknown',
          availability: [],
          origin: 'compact_file_reference',
        };
        byPath.set(path, record);
        order.push(path);
      } else {
        // Fill in displayPath if a prior nested_memory sighting didn't
        // have one to offer — never touch injectionStatus/origin/title
        // here, a reference-without-content sighting must not weaken
        // stronger evidence already recorded for this path.
        record.displayPath = attachment.displayPath;
      }

      record.availability.push(eventFrom<RuleAvailabilityAction>(entry, 'referenced'));
      continue;
    }
  }

  return order.map((path) => byPath.get(path)!);
}
