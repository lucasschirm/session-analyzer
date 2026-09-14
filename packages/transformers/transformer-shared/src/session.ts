export interface SessionSummary {
  readonly sessionId: string;
  readonly rootSessionId: string;
  readonly parentSessionId?: string;
  readonly harness: string;
  readonly startTime?: string;
  readonly endTime?: string;
  readonly finality: 'final' | 'partial' | 'censored';
}

/**
 * Maximum length of a session title derived from the first real user
 * prompt — mirrors the short single-line first-prompt label Claude Code's
 * session picker and Devin CLI both use.
 */
export const MAX_DERIVED_SESSION_TITLE_LENGTH = 50;

/**
 * Collapses raw prompt text to a single line and truncates to
 * {@link MAX_DERIVED_SESSION_TITLE_LENGTH}, appending an ellipsis when cut.
 * Harness plugins emit the result as the session spine's `fallbackTitle`;
 * ingestion only writes it when no better title (ai-title, user rename)
 * exists on the session row.
 */
export function truncateSessionTitle(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= MAX_DERIVED_SESSION_TITLE_LENGTH) return normalized;
  return `${normalized.slice(0, MAX_DERIVED_SESSION_TITLE_LENGTH).trimEnd()}…`;
}
