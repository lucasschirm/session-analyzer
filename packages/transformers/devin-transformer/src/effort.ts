import type { DevinModelRecord } from '@lucasschirm/sal-devin-session-parser';
import {
  NORMALIZED_EFFORT_LEVELS,
  type NormalizedEffort,
} from '@lucasschirm/sal-transformer-shared';

/**
 * Devin encodes reasoning-effort tier inside its model catalog's `label`
 * field (e.g. `"GLM-5.3 Low"`), never in `model_uid` alone — a `model_uid`
 * suffix is NOT a reliable tier signal (some families' base/unsuffixed
 * variant, e.g. `"swe-1-7"`, is itself tiered per its `label`: `"SWE-1.7
 * Max"`). This module reads only `label`, deliberately, per
 * `.agents/rules/missing-is-never-zero.md`.
 */
export interface DevinEffortResult {
  readonly raw: string | null;
  readonly normalized: NormalizedEffort | null;
}

const MODIFIER_TOKENS = new Set(['fast', 'priority', '1m']);

/** Every `NORMALIZED_EFFORT_LEVELS` member except `'none'` — Devin spells a
 * single tier word (`Minimal`/`Low`/.../`Max`) directly; `'none'` is only
 * reachable via the two-word `"No Thinking"` phrase, never a bare word. */
const TIER_WORDS = new Set<string>(NORMALIZED_EFFORT_LEVELS.filter((level) => level !== 'none'));

const NO_MATCH: DevinEffortResult = { raw: null, normalized: null };

function stripTrailingModifiers(tokens: readonly string[]): string[] {
  const result = [...tokens];
  while (result.length > 0 && MODIFIER_TOKENS.has(result[result.length - 1].toLowerCase())) {
    result.pop();
  }
  return result;
}

function matchNoThinking(tokens: readonly string[]): DevinEffortResult | null {
  if (tokens.length < 2) return null;
  const last = tokens[tokens.length - 1];
  const secondLast = tokens[tokens.length - 2];
  if (secondLast.toLowerCase() !== 'no' || last.toLowerCase() !== 'thinking') return null;
  return { raw: `${secondLast} ${last}`, normalized: 'none' };
}

function matchTierWord(tokens: readonly string[]): DevinEffortResult {
  const last = tokens[tokens.length - 1];
  if (last === undefined) return NO_MATCH;
  const normalized = last.toLowerCase();
  return TIER_WORDS.has(normalized)
    ? { raw: last, normalized: normalized as NormalizedEffort }
    : NO_MATCH;
}

/**
 * Tokenizes `label` on whitespace, strips trailing modifier tokens (`Fast`,
 * `Priority`, `1M`, case-insensitive) one at a time from the end, then
 * checks whether the remaining trailing token(s) spell `"No Thinking"` or a
 * single tier word. Returns `{ raw: null, normalized: null }` — never a
 * guess — when no known tier phrase is found.
 */
export function parseDevinEffortFromLabel(label: string): DevinEffortResult {
  const tokens = label.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return NO_MATCH;
  const stripped = stripTrailingModifiers(tokens);
  return matchNoThinking(stripped) ?? matchTierWord(stripped);
}

/**
 * Looks up `modelUid` in the already-captured models catalog and derives
 * its effort tier from the matched record's `label`. Returns
 * `{ raw: null, normalized: null }` for an unrecognized uid, the
 * `"compactor"` pseudo-model, or a missing/unavailable catalog — never
 * guessed. `modelUid` may be `null` (e.g. an ATIF step with no recorded
 * `generation_model`), which is treated the same as "no match".
 */
export function resolveDevinEffortForModel(
  modelUid: string | null,
  models: readonly DevinModelRecord[],
): DevinEffortResult {
  if (!modelUid) return NO_MATCH;
  const match = models.find((model) => model.modelUid === modelUid);
  return match ? parseDevinEffortFromLabel(match.label) : NO_MATCH;
}
