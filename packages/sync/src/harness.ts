export interface HarnessSession {
  harness: string;
  sessionId: string;
  cwd: string;
  transcriptPath?: string;
  startedAt?: string;
  endedAt?: string;
  endReason?: string;
  model?: string;
}
