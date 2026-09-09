/**
 * Shared, harness-agnostic reasoning-effort vocabulary.
 *
 * Adopted verbatim from llama.cpp's own `reasoning_effort` parameter
 * (`minimal`, `low`, `medium`, `high`, `xhigh`, `max`), plus `'none'` — a
 * real, distinct "reasoning explicitly disabled" state that llama.cpp's own
 * six level words do not represent (`'minimal'` is still some reasoning).
 *
 * llama.cpp's own `default` ("no explicit override, defer to the template")
 * is deliberately not included as a level: that is a request-time
 * absence-of-value, represented by a missing/null normalized effort, not a
 * stored sentinel string.
 *
 * This constant is a shared decision: `packages/db-core` independently
 * re-states the same seven literal values verbatim in a `CHECK` constraint
 * (transformer packages must never import `db-core`, and `db-core` has no
 * reason to depend on a transformer package, so the list is intentionally
 * duplicated rather than centrally imported). Any change to this list must
 * be mirrored there.
 */
export const NORMALIZED_EFFORT_LEVELS = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

export type NormalizedEffort = (typeof NORMALIZED_EFFORT_LEVELS)[number];
