import process from 'node:process';
import type { HarnessProfile, HarnessSession, HookInput, SyncTrigger } from '@lucasschirm/sal-sync';
import { DEVIN_HARNESS, DevinHarnessProfile } from './devin-profile.js';

// Hoisted to `packages/sync/src/cli/read-stdin.ts` (#354) — re-exported here
// to preserve this plugin's public import path (`../src/devin.js`, asserted
// on directly by `tests/devin.test.ts`).
export { readStdin } from '@lucasschirm/sal-sync';
export { DEVIN_HARNESS };

/**
 * Devin plugin only wires 4 of the 8 documented ACP hook events (see
 * `hooks.json` and the module doc comment there for the verified Cloud-vs-CLI
 * caveat): `SessionStart`, `Stop`, `PostCompaction`, `SessionEnd`. The other
 * four (`PreToolUse`, `PostToolUse`, `PermissionRequest`, `UserPromptSubmit`)
 * are ACP-tool-related and out of scope for this issue.
 */
export const DEVIN_SYNC_TRIGGERS: Record<string, SyncTrigger> = {
  SessionStart: 'session-start',
  Stop: 'stop',
  PostCompaction: 'post-compact',
  SessionEnd: 'session-end',
};

/**
 * Stdin JSON shape Devin's command hooks pass: `{hook_event_name, tool_name,
 * tool_input, session_id, prompt_id}` per the plugin format spec (master plan
 * Part A3). `cwd` is not guaranteed on every event the way Claude's hook
 * input carries it, so callers fall back to `process.cwd()` — see
 * `toHarnessSession`.
 */
export interface DevinHookInput {
  session_id: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: unknown;
  prompt_id?: string;
  reason?: string;
  started_at?: string;
  ended_at?: string;
  duration_ms?: number;
  model?: string;
  [key: string]: unknown;
}

export type ParseResult =
  | { ok: true; input: DevinHookInput }
  | { ok: false; missing: string[]; raw: unknown };

/**
 * Parses raw stdin JSON into a `DevinHookInput`. Only `session_id` is
 * strictly required — Devin's hook payload does not guarantee `cwd` on every
 * event, unlike Claude Code's. Malformed/missing input is reported, never
 * thrown.
 */
export function parseDevinHookInput(raw: unknown): ParseResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, missing: ['session_id'], raw };
  }

  const input = raw as Record<string, unknown>;
  const sessionId = input.session_id;
  if (typeof sessionId !== 'string' || sessionId.trim() === '') {
    return { ok: false, missing: ['session_id'], raw };
  }

  return { ok: true, input: input as DevinHookInput };
}

export function toHarnessSession(
  input: DevinHookInput,
  cwd: string = process.cwd(),
): HarnessSession {
  return {
    harness: DEVIN_HARNESS,
    sessionId: input.session_id,
    cwd: typeof input.cwd === 'string' && input.cwd.trim() !== '' ? input.cwd : cwd,
    startedAt: input.started_at,
    endedAt: input.ended_at,
    endReason: input.reason,
    model: input.model,
  };
}

/**
 * Builds the generic engine's `HookInput`. `transcript_path` must be filled
 * in by the caller once the session's `sessions.db` content has been
 * materialized to a local JSONL file (see `session-sync.ts`'s
 * `materializeSessionTranscript`) — this function does not touch the
 * filesystem.
 */
export function toSyncInput(
  session: HarnessSession,
  trigger: SyncTrigger,
  transcriptPath: string,
  extra?: Record<string, unknown>,
  profile: HarnessProfile = DevinHarnessProfile,
): HookInput {
  return {
    ...extra,
    session_id: session.sessionId,
    cwd: session.cwd,
    transcript_path: transcriptPath,
    started_at: session.startedAt,
    ended_at: session.endedAt,
    reason: session.endReason,
    model: session.model,
    harness: profile.harness,
    harness_version: profile.harnessVersion,
    trigger,
  };
}

export function devinEventToSyncTrigger(event: string | undefined): SyncTrigger {
  if (event && event in DEVIN_SYNC_TRIGGERS) {
    return DEVIN_SYNC_TRIGGERS[event] as SyncTrigger;
  }
  return 'manual';
}
