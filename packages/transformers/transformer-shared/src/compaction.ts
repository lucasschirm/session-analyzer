/**
 * Harness-agnostic canonical shape for a `category: 'compaction'`
 * `normalized_event` evidence record: a context-compaction / conversation
 * summarization boundary, generalized from Claude Code's `/compact`
 * evidence shape (previously defined only in `claude-transformer`'s
 * `NormalizedEventRecordPayload`) so a second harness (Devin CLI's
 * `/compact`) can produce the same canonical record kind instead of a
 * second, incompatible shape that happens to share a string literal.
 *
 * Every field below is common to how any harness would describe a
 * compaction boundary. A harness that cannot supply a field (e.g. Devin has
 * no analog for `postTokens`/`cumulativeDroppedTokens`/`compactionDurationMs`)
 * must omit it — never coerce to `0` — per `missing-is-never-zero`. Fields
 * genuinely specific to one harness (Claude's `preservedSegment`/
 * `preservedMessages` uuid ranges; Devin's recovered `prunedNodeIds`) are
 * NOT part of this shared shape; they stay as extensions on that harness's
 * own producing package.
 */
export interface CompactionEventPayload {
  readonly eventId: string;
  readonly version: number;
  /** Always `'compaction'` for a record matching this shape; typed as
   * `string` (not the literal) because `normalized_event` is a shared
   * record type spanning many other categories with the same base fields. */
  readonly category: string;
  readonly eventType: string;
  readonly timestampMs: number;
  readonly sourceEventId: string;
  /** The harness's closest analog to a JSONL line number for the source
   * event; missing (not a fabricated `0`) when the harness has no such
   * concept for this record, or the source node it would derive from
   * cannot be located — per `missing-is-never-zero`. */
  readonly lineNumber?: number;
  readonly summary?: string;
  /** `'manual'` | `'auto'` | a harness-native string; missing (not a
   * guessed default) when the trigger can't be determined from evidence. */
  readonly trigger?: string;
  readonly preTokens?: number;
  readonly postTokens?: number;
  readonly cumulativeDroppedTokens?: number;
  readonly compactionDurationMs?: number;
}
