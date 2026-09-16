import type {
  DevinChatMessageToolCall,
  DevinMessageLine,
} from '@lucasschirm/sal-devin-session-parser';
import { type DevinInvocationKind, invocationKindForToolName } from './tool-invocations.js';

/**
 * Per-message Tool / Skill / Agent classification (DS-UI: the session context
 * growth chart has to tell a Skill invocation apart from a plain tool call).
 *
 * Unlike `tool-invocations.ts`, which normalizes the harness's
 * `tool_call_state` rows into canonical `invocation` records, this module
 * classifies the *conversation* nodes themselves — what a given message in
 * the transcript actually was. Both read the same domain mapping
 * (`invocationKindForToolName`) so a message is never labeled a different
 * domain than the invocation it produced
 * (`.agents/rules/analytics-domain-distinctions.md`).
 *
 * Two native shapes carry the signal, and both are used:
 *
 * 1. an assistant node whose `chat_message.tool_calls[]` (OpenAI format)
 *    dispatches one or more tools — e.g. `{ name: 'skill', arguments:
 *    { skill: 'add-pipeline-e2e-test' } }` makes that node a Skill message;
 * 2. a tool-result node (`chat_message.role === 'tool'`) carrying
 *    `chat_message.tool_call_id`, which resolves back to the domain of the
 *    call it answers.
 *
 * Everything else (user prompts, system notes, agent narration with no call)
 * stays unclassified on purpose: absent is absent, never a defaulted `tool`
 * (`.agents/rules/missing-is-never-zero.md`).
 */

/** Domain precedence when one node dispatches several kinds at once. */
const KIND_PRIORITY: readonly DevinInvocationKind[] = ['skill', 'agent', 'tool'];

function kindForCalls(calls: readonly DevinChatMessageToolCall[]): DevinInvocationKind | null {
  const kinds = new Set(calls.map((call) => invocationKindForToolName(call.name)));
  for (const kind of KIND_PRIORITY) {
    if (kinds.has(kind)) return kind;
  }
  return null;
}

/**
 * Maps `nodeId` -> invocation domain for every message node in `messages`
 * that dispatched or answered a tool call. Nodes with no tool relationship
 * are simply absent from the map (never present with a `null`/`'tool'`
 * placeholder).
 */
export function classifyDevinMessageKinds(
  messages: readonly DevinMessageLine[],
): Map<number, DevinInvocationKind> {
  const kinds = new Map<number, DevinInvocationKind>();
  /** `tool_calls[].id` -> domain, so a result node can inherit its call's. */
  const kindByCallId = new Map<string, DevinInvocationKind>();

  for (const message of messages) {
    const calls = message.toolCalls;
    if (!calls || calls.length === 0) continue;
    for (const call of calls) {
      kindByCallId.set(call.id, invocationKindForToolName(call.name));
    }
    const kind = kindForCalls(calls);
    if (kind === null) continue;
    kinds.set(message.nodeId, kind);
  }

  for (const message of messages) {
    if (kinds.has(message.nodeId)) continue;
    if (!message.toolCallId) continue;
    const kind = kindByCallId.get(message.toolCallId);
    if (kind) kinds.set(message.nodeId, kind);
  }

  return kinds;
}
