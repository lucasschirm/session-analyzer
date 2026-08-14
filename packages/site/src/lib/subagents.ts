/**
 * Claude Code sessions can carry a supplementary data folder alongside the
 * main `<sessionId>.jsonl` transcript (named after the session id), holding
 * per-subagent transcripts under `subagents/agent-<id>.jsonl` (+ a paired
 * `agent-<id>.meta.json` sidecar with `agentType`/`description`) and large
 * tool-output overflow files under `tool-results/` (opaque blobs, not
 * transcripts - never parsed).
 *
 * This module classifies an uploaded batch of files into "main" transcripts
 * vs. subagent file pairs, and folds a parsed subagent's usage into its
 * parent session.
 */

import type { DashboardSession, SubagentUsage } from '../types';

/** A file paired with its path relative to the upload root, when known. */
export interface UploadedFile {
  file: File;
  relativePath: string;
}

export interface SubagentFileGroup {
  agentId: string;
  jsonl?: UploadedFile;
  meta?: UploadedFile;
}

export interface ClassifiedUpload {
  /** Top-level session transcripts (.json/.jsonl/.log), to parse normally. */
  mainFiles: UploadedFile[];
  /** subagents/agent-<id>.jsonl (+ optional .meta.json), keyed by agent id. */
  subagentGroups: SubagentFileGroup[];
}

const SUBAGENT_FILE_PATTERN = /(?:^|\/)agent-([a-zA-Z0-9._-]+)\.(jsonl|meta\.json)$/;
const SESSION_FILE_PATTERN = /\.(json|jsonl|log)$/i;

/** Splits an uploaded batch (files and/or a dropped folder) into main transcripts and subagent pairs. */
export function classifyUploadedFiles(uploads: UploadedFile[]): ClassifiedUpload {
  const mainFiles: UploadedFile[] = [];
  const groups = new Map<string, SubagentFileGroup>();

  for (const upload of uploads) {
    const subagentMatch = upload.relativePath.match(SUBAGENT_FILE_PATTERN);
    if (subagentMatch) {
      const [, agentId, kind] = subagentMatch;
      const group = groups.get(agentId) ?? { agentId };
      if (kind === 'jsonl') group.jsonl = upload;
      else group.meta = upload;
      groups.set(agentId, group);
      continue;
    }

    // Anything else that isn't a recognized transcript extension (e.g. the
    // opaque tool-results/*.txt overflow files) is silently skipped - it's
    // supplementary data, not something this parser understands.
    if (SESSION_FILE_PATTERN.test(upload.file.name)) {
      mainFiles.push(upload);
    }
  }

  return { mainFiles, subagentGroups: Array.from(groups.values()) };
}

export interface SubagentMeta {
  agentType?: string;
  description?: string;
}

export function parseSubagentMeta(raw: string): SubagentMeta {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const record = parsed as Record<string, unknown>;
    return {
      agentType: typeof record.agentType === 'string' ? record.agentType : undefined,
      description: typeof record.description === 'string' ? record.description : undefined,
    };
  } catch {
    return {};
  }
}

/**
 * Folds a subagent's already-parsed session (its own tokens/cache/models,
 * exactly as if it were a standalone session) into the parent session's
 * totals, and appends a `SubagentUsage` summary - including the subagent's
 * own `messages`, so its transcript can be shown later (see the Session
 * Transcript page). Mutates and returns `session`.
 *
 * Idempotent per agent id: if this agent was already merged in before (a
 * re-upload of the same folder), its previous contribution is subtracted
 * first so the net effect is a replace, not a double-count.
 */
export function mergeSubagentIntoSession(
  session: DashboardSession,
  agentId: string,
  subSession: DashboardSession,
  meta: SubagentMeta,
): DashboardSession {
  const existingIndex = session.subagents.findIndex((s) => s.agent_id === agentId);
  const previous = existingIndex >= 0 ? session.subagents[existingIndex] : undefined;
  if (previous) applyUsageDelta(session, previous, -1);

  applyUsageDelta(session, subSession, 1);

  const summary: SubagentUsage = {
    agent_id: agentId,
    agent_type: meta.agentType,
    description: meta.description,
    model: subSession.model,
    input_tokens: subSession.input_tokens,
    output_tokens: subSession.output_tokens,
    cache_creation_tokens: subSession.cache_creation_tokens,
    cache_read_tokens: subSession.cache_read_tokens,
    total_tokens: subSession.total_tokens,
    tool_call_count: subSession.tool_executions.length,
    started_at: subSession.started_at,
    ended_at: subSession.ended_at,
    messages: subSession.messages,
  };

  if (existingIndex >= 0) session.subagents[existingIndex] = summary;
  else session.subagents.push(summary);

  return session;
}

interface UsageAmount {
  model?: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  total_tokens: number;
}

function applyUsageDelta(session: DashboardSession, amount: UsageAmount, sign: 1 | -1): void {
  session.input_tokens += sign * amount.input_tokens;
  session.output_tokens += sign * amount.output_tokens;
  session.cache_creation_tokens += sign * amount.cache_creation_tokens;
  session.cache_read_tokens += sign * amount.cache_read_tokens;
  session.total_tokens += sign * amount.total_tokens;

  if (!amount.model) return;
  const existingModel = session.models.find((m) => m.model === amount.model);
  if (existingModel) {
    existingModel.input_tokens += sign * amount.input_tokens;
    existingModel.output_tokens += sign * amount.output_tokens;
    existingModel.cache_creation_tokens += sign * amount.cache_creation_tokens;
    existingModel.cache_read_tokens += sign * amount.cache_read_tokens;
  } else if (sign > 0) {
    session.models.push({
      model: amount.model,
      input_tokens: amount.input_tokens,
      output_tokens: amount.output_tokens,
      cache_creation_tokens: amount.cache_creation_tokens,
      cache_read_tokens: amount.cache_read_tokens,
    });
  }
}
