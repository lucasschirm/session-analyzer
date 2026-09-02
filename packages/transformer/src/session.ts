/**
 * Real, classifiable session outcomes. `undefined` on {@link SessionSummary}
 * is the distinct "not classifiable" sentinel (unreadable/missing final
 * native event, or a session too short to carry one) — it is never coerced
 * to one of these values, per `.agents/rules/missing-is-never-zero.md`. It
 * maps to `NULL` in the `sessions.outcome` canonical column, not to a
 * synthetic fourth value.
 *
 * Deliberately duplicated in `packages/db-core/src/session-evidence.ts`
 * (`SESSION_OUTCOMES`/`SessionOutcome`) rather than imported from there:
 * transformers never depend on `db-core`
 * (`.agents/rules/transformers-never-write-sqlite.md`). The two literal
 * arrays must be kept in sync by hand — a drift-detection test asserts
 * equality in `packages/db/tests/unit/session-outcomes-in-sync.test.ts`
 * (the one package that already depends on both).
 */
export const SESSION_OUTCOMES = ['clean', 'interrupted_by_user', 'ended_on_error'] as const;
export type SessionOutcome = (typeof SESSION_OUTCOMES)[number];

export interface SessionSummary {
  readonly sessionId: string;
  readonly rootSessionId: string;
  readonly parentSessionId?: string;
  readonly harness: string;
  readonly startTime?: string;
  readonly endTime?: string;
  readonly finality: 'final' | 'partial' | 'censored';
  /**
   * Classified from the session's final native event(s) per harness. Absent
   * (`undefined`) means the signal could not be read/classified — distinct
   * from any real outcome value (missing-is-never-zero).
   */
  readonly outcome?: SessionOutcome;
}
