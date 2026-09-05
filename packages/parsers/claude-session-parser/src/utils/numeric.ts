/**
 * Shared numeric-coercion primitives for parsing Claude Code transcript
 * fields. Kept in exactly one place per `workspace-rules.md`'s
 * anti-duplication rule — `numOr0` previously existed as byte-identical
 * copies in both `entry-parsers.ts` and `aggregate-usage.ts` (#377).
 */

/**
 * Coerces to a finite number, defaulting to `0` — for contexts where the
 * field is being folded into a running sum and a missing/malformed value
 * legitimately contributes nothing to that sum (see
 * `.agents/rules/missing-is-never-zero.md`: "a missing value does not
 * contribute to a sum and is not counted as a zero observation" — the sum
 * itself stays a definite number even though individual missing terms never
 * count as measured zeros). Never use this where the per-record
 * missing-vs-zero distinction itself must survive — use `numOrNull` there.
 */
export function numOr0(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * Coerces to a finite number, preserving `null` for anything absent or
 * malformed — for contexts where "the source never reported this field"
 * must remain distinguishable from "the source reported a measured zero",
 * per `.agents/rules/missing-is-never-zero.md`.
 */
export function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
