export interface SessionSummary {
  readonly sessionId: string;
  readonly rootSessionId: string;
  readonly parentSessionId?: string;
  readonly harness: string;
  readonly startTime?: string;
  readonly endTime?: string;
  readonly finality: 'final' | 'partial' | 'censored';
}
