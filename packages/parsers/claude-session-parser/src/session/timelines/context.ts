/**
 * Shared narrow helpers used by every `derive*Timeline` function. This is
 * the envelope factory all six derive functions (tools.ts, mcp.ts,
 * skills.ts, agents.ts, rules.ts, supporting.ts) build their
 * `AvailabilityEvent`s from — get this right once, here, rather than each
 * derive function re-deriving uuid/lineNumber/timestamp fallbacks.
 */

import type { AvailabilityEvent } from '../../types/common.js';
import type { AttachmentEntry, ClaudeCodeEntry } from '../../types/session.js';

/** Options threaded through every `derive*` function. */
export interface TimelineDeriveOptions {
  maxBlobBytes?: number;
}

/**
 * `lineNumber` is carried on every member of the `ClaudeCodeEntry` union —
 * both `ClaudeCodeEntryBase`-derived entries and the uuid-less bookkeeping
 * entries declare it explicitly (see spec §1.2) — so this never falls back
 * to anything.
 */
export function entryLineNumber(entry: ClaudeCodeEntry): number {
  return entry.lineNumber;
}

/**
 * Only `ClaudeCodeEntryBase`-derived entries (assistant/user/system/
 * attachment) carry a `uuid`; the uuid-less bookkeeping entries (mode,
 * ai-title, pr-link, …) do not, so this returns `undefined` for those —
 * callers fall back to `lineNumber` for identity in that case.
 */
export function entryUuid(entry: ClaudeCodeEntry): string | undefined {
  if ('uuid' in entry && typeof (entry as { uuid?: unknown }).uuid === 'string') {
    return (entry as { uuid: string }).uuid;
  }
  return undefined;
}

/**
 * Prefers the already-parsed `timestampMs` present on
 * `ClaudeCodeEntryBase`-derived entries. Several uuid-less bookkeeping
 * entries (`PrLinkEntry`, `QueueOperationEntry`, `FileHistoryDeltaEntry`)
 * still carry a raw ISO `timestamp` string with no pre-parsed
 * `timestampMs` — this falls back to parsing that string so timeline
 * events derived from those entries aren't silently left without a
 * timestamp. Entries with neither field (e.g. `ModeEntry`, `AiTitleEntry`)
 * return `undefined`.
 */
export function entryTimestampMs(entry: ClaudeCodeEntry): number | undefined {
  if (
    'timestampMs' in entry &&
    typeof (entry as { timestampMs?: unknown }).timestampMs === 'number'
  ) {
    return (entry as { timestampMs: number }).timestampMs;
  }
  if ('timestamp' in entry && typeof (entry as { timestamp?: unknown }).timestamp === 'string') {
    const parsed = Date.parse((entry as { timestamp: string }).timestamp);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

/** True when `entry` is an `AttachmentEntry` whose `attachment.type` is `type`. */
export function isAttachment(entry: ClaudeCodeEntry, type: string): boolean {
  return entry.type === 'attachment' && (entry as AttachmentEntry).attachment?.type === type;
}

/**
 * Envelope factory: pulls `entryUuid`/`lineNumber`/`timestampMs` off any
 * entry and folds them into an `AvailabilityEvent<A>`. Optional fields
 * (`entryUuid`, `timestampMs`, `isInitial`) are only set when a value is
 * actually available, so downstream consumers never see spurious
 * `undefined` keys.
 */
export function eventFrom<A extends string>(
  entry: ClaudeCodeEntry,
  action: A,
  isInitial?: boolean,
): AvailabilityEvent<A> {
  const event: AvailabilityEvent<A> = {
    action,
    lineNumber: entryLineNumber(entry),
  };
  const uuid = entryUuid(entry);
  if (uuid !== undefined) event.entryUuid = uuid;
  const timestampMs = entryTimestampMs(entry);
  if (timestampMs !== undefined) event.timestampMs = timestampMs;
  if (isInitial !== undefined) event.isInitial = isInitial;
  return event;
}
