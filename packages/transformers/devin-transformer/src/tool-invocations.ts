import type { DevinToolCallLine } from '@lucasschirm/sal-devin-session-parser';
import type { NormalizedEvidenceRecord } from '@lucasschirm/sal-transformer-shared';
import { stableId } from './session-spine.js';

export interface ToolInvocationResult {
  readonly records: readonly NormalizedEvidenceRecord[];
  readonly toolCount: number;
}

function toolName(call: DevinToolCallLine['call'], update: DevinToolCallLine['update']): string {
  return (
    update?.inferenceToolName ?? call?.inferenceToolName ?? call?.title ?? call?.kind ?? 'unknown'
  );
}

function rawInputString(call: DevinToolCallLine['call'], field: string): string | undefined {
  if (!call?.rawInput || typeof call.rawInput !== 'object') return undefined;
  const value = (call.rawInput as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Resolves the domain-correct `kind`/`name` for one invocation, per
 * `.agents/rules/analytics-domain-distinctions.md`: `Skill` and `Agent`
 * (`run_subagent`) invocations are their own domains, never folded into the
 * generic `tool` pool (DS-F11 (#288)). Every other call keeps the existing
 * `kind: 'tool'` behavior, with `name` resolved exactly as before.
 *
 * `_meta["cognition.ai/inferenceToolName"]` is read from `update` first,
 * falling back to `call`'s own copy of the same `_meta` key (DS-F11 (#288)
 * review finding): Devin stamps this `_meta` key on both `tool_call_json`
 * and `tool_call_update_json` when it is present at all, but
 * `tool_call_update_json` can be entirely missing for a call whose session
 * was interrupted before it completed. Reading `update` only would silently
 * fall back to `kind: 'tool'` for such a call, reproducing the exact
 * Skill/Agent-into-tool conflation this function exists to fix, just for a
 * narrower trigger (no update record instead of no `_meta` at all).
 */
function invocationKindAndName(
  call: DevinToolCallLine['call'],
  update: DevinToolCallLine['update'],
): { kind: 'tool' | 'skill' | 'agent'; name: string; target?: string } {
  const inferenceToolName = update?.inferenceToolName ?? call?.inferenceToolName;
  if (inferenceToolName === 'skill') {
    return { kind: 'skill', name: rawInputString(call, 'skill') ?? toolName(call, update) };
  }
  if (inferenceToolName === 'run_subagent') {
    return {
      kind: 'agent',
      name: rawInputString(call, 'profile') ?? toolName(call, update),
      target: rawInputString(call, 'title'),
    };
  }
  return { kind: 'tool', name: toolName(call, update) };
}

function toolTarget(call: DevinToolCallLine['call']): string | undefined {
  if (!call) return undefined;
  if (typeof call.rawInput === 'string') return call.rawInput;
  if (typeof call.content === 'string') return call.content;
  if (call.rawInput && typeof call.rawInput === 'object') {
    const raw = call.rawInput as Record<string, unknown>;
    const path = raw.file_path ?? raw.path ?? raw.filename;
    if (typeof path === 'string') return path;
  }
  if (call.content && typeof call.content === 'object') {
    const raw = call.content as Record<string, unknown>;
    const path = raw.file_path ?? raw.path ?? raw.filename;
    if (typeof path === 'string') return path;
  }
  return undefined;
}

function toolStatus(
  update: DevinToolCallLine['update'],
): 'success' | 'error' | 'incomplete' | 'unknown' {
  const status = update?.status ?? '';
  if (typeof status !== 'string') return 'unknown';
  const lower = status.toLowerCase();
  if (['success', 'completed', 'done', 'ok'].includes(lower)) return 'success';
  if (['error', 'failed', 'failure', 'interrupted', 'cancelled', 'canceled'].includes(lower))
    return 'error';
  if (lower === 'incomplete' || lower === 'pending') return 'incomplete';
  return 'unknown';
}

function byteLength(value: unknown): number {
  if (typeof value === 'string') return value.length;
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
}

export function buildToolInvocationRecords(
  sessionId: string,
  toolCalls: readonly DevinToolCallLine[],
  rootArtifactId: string,
): ToolInvocationResult {
  const records: NormalizedEvidenceRecord[] = [];
  let toolCount = 0;

  for (const toolCall of toolCalls) {
    if (!toolCall.call) continue;
    const call = toolCall.call;
    const update = toolCall.update;
    const toolCallId = toolCall.toolCallId;
    const { kind, name, target: domainTarget } = invocationKindAndName(call, update);
    const target = kind === 'tool' ? toolTarget(call) : domainTarget;
    const status = toolStatus(update);

    records.push({
      recordId: stableId('invocation', { session: sessionId, tool: toolCallId }),
      recordType: 'invocation',
      sessionId,
      sourceEventId: toolCallId,
      sourceField: 'tool_call_json',
      provenance: {
        artifactId: rootArtifactId,
        sourceEventId: toolCallId,
        sourceField: 'tool_call_json',
        path: rootArtifactId,
      },
      payload: {
        kind,
        name,
        target,
        startId: toolCallId,
        resultId: toolCallId,
        status,
        origin: 'root',
        rootSessionId: sessionId,
      },
    });

    records.push({
      recordId: stableId('payload', { session: sessionId, tool: toolCallId, type: 'input' }),
      recordType: 'payload',
      sessionId,
      parentId: stableId('invocation', { session: sessionId, tool: toolCallId }),
      sourceEventId: toolCallId,
      sourceField: 'tool_call_json',
      provenance: {
        artifactId: rootArtifactId,
        sourceEventId: toolCallId,
        sourceField: 'tool_call_json',
        path: rootArtifactId,
      },
      payload: {
        payloadType: 'input',
        toolUseId: toolCallId,
        sourceEventId: toolCallId,
        bytes: byteLength(call.rawInput),
        tokens: 0,
        tokenSource: 'estimated',
        mediaCount: 0,
        structureCount: 0,
        contentKind: 'unknown',
      },
    });

    if (update) {
      records.push({
        recordId: stableId('payload', { session: sessionId, tool: toolCallId, type: 'result' }),
        recordType: 'payload',
        sessionId,
        parentId: stableId('invocation', { session: sessionId, tool: toolCallId }),
        sourceEventId: toolCallId,
        sourceField: 'tool_call_update_json',
        provenance: {
          artifactId: rootArtifactId,
          sourceEventId: toolCallId,
          sourceField: 'tool_call_update_json',
          path: rootArtifactId,
        },
        payload: {
          payloadType: 'result',
          toolUseId: toolCallId,
          sourceEventId: toolCallId,
          bytes: byteLength(update.raw),
          tokens: 0,
          tokenSource: 'estimated',
          mediaCount: 0,
          structureCount: 0,
          contentKind: 'unknown',
        },
      });
    }

    toolCount += 1;
  }

  return { records, toolCount };
}
