import { UNKNOWN_HARNESS_VERSION } from './versions.js';

export type SessionEndReason = string;

export interface SessionData {
  sessionId: string;
  projectId: string;
  harness: string;
  harnessVersion: string;
  model?: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  endReason?: SessionEndReason;
}

export type SessionTelemetry = SessionData;

export { UNKNOWN_HARNESS_VERSION };
