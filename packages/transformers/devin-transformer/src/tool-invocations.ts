import type { DevinToolCallLine } from '@lucasschirm/sal-devin-session-parser';
import type { NormalizedEvidenceRecord } from '@lucasschirm/sal-transformer-shared';
import { stableId } from './session-spine.js';

export interface ToolInvocationResult {
  readonly records: readonly NormalizedEvidenceRecord[];
  readonly toolCount: number;
}

function toolName(call: DevinToolCallLine['call'], update: DevinToolCallLine['update']): string {
  return update?.inferenceToolName ?? call?.title ?? call?.kind ?? 'unknown';
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
    const name = toolName(call, update);
    const target = toolTarget(call);
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
        kind: 'tool',
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
