/**
 * Real, classifiable session outcomes. `undefined` on {@link SessionSummary}
 * is the distinct "not classifiable" sentinel (unreadable/missing final
 * native event, or a session too short to carry one) — it is never coerced
 * to one of these values, per `.agents/rules/missing-is-never-zero.md`. It
 * maps to `NULL` in the `sessions.outcome` canonical column, not to a
 * synthetic fourth value.
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
