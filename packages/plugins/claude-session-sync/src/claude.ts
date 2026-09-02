import process from 'node:process';
import type { HarnessProfile, HarnessSession, HookInput, SyncTrigger } from '@lucasschirm/sal-sync';
import { CLAUDE_HARNESS, ClaudeHarnessProfile } from './claude-profile.js';

export const CLAUDE_SYNC_TRIGGERS: Record<string, SyncTrigger> = {
  SessionStart: 'session-start',
  PreCompact: 'pre-compact',
  PostCompact: 'post-compact',
  Stop: 'stop',
  StopFailure: 'stop-failure',
  SubagentStop: 'subagent-stop',
  SessionEnd: 'session-end',
};

export interface ClaudeHookInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  hook_event_name?: string;
  model?: string;
  source?: string;
  reason?: string;
  started_at?: string;
  ended_at?: string;
  duration_ms?: number;
  [key: string]: unknown;
}

export type ParseResult =
  | { ok: true; input: ClaudeHookInput }
  | { ok: false; missing: string[]; raw: unknown };

export function parseClaudeHookInput(raw: unknown): ParseResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, missing: ['session_id', 'cwd', 'transcript_path'], raw };
  }

  const input = raw as Record<string, unknown>;
  const missing: string[] = [];

  for (const field of ['session_id', 'cwd', 'transcript_path']) {
    const value = input[field];
    if (typeof value !== 'string' || value.trim() === '') {
      missing.push(field);
    }
  }

  if (missing.length > 0) {
    return { ok: false, missing, raw };
  }

  return { ok: true, input: input as ClaudeHookInput };
}

export function toHarnessSession(input: ClaudeHookInput): HarnessSession {
  return {
    harness: CLAUDE_HARNESS,
    sessionId: input.session_id,
    cwd: input.cwd,
    transcriptPath: input.transcript_path,
    startedAt: input.started_at,
    endedAt: input.ended_at,
    endReason: input.reason,
    model: input.model,
  };
}

export function toSyncInput(
  session: HarnessSession,
  trigger: SyncTrigger,
  extra?: Record<string, unknown>,
  profile: HarnessProfile = ClaudeHarnessProfile,
): HookInput {
  return {
    ...extra,
    session_id: session.sessionId,
    cwd: session.cwd,
    transcript_path: session.transcriptPath ?? '',
    started_at: session.startedAt,
    ended_at: session.endedAt,
    reason: session.endReason,
    model: session.model,
    harness: profile.harness,
    harness_version: profile.harnessVersion,
    trigger,
  };
}

export function claudeEventToSyncTrigger(event: string | undefined): SyncTrigger {
  if (event && event in CLAUDE_SYNC_TRIGGERS) {
    return CLAUDE_SYNC_TRIGGERS[event] as SyncTrigger;
  }
  return 'manual';
}

export function readStdin(stdin: NodeJS.ReadableStream = process.stdin): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];

    stdin.on('data', (chunk: string | Buffer) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8'));
    });

    stdin.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (text.length === 0) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        resolve(undefined);
      }
    });

    stdin.on('error', reject);
  });
}
