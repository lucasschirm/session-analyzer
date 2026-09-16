/**
 * Subagent decomposition: extracts first-class child sessions from the
 * Devin detached message tree, mirroring how Claude Code's transformer
 * produces `session`/`session_relation`/turn/message/invocation records
 * per subagent transcript.
 *
 * Design invariants (`.agents/rules/analytics-domain-distinctions.md`):
 * - Each subagent becomes its own `SessionSummary` + evidence records.
 * - Root-only metrics NEVER include subagent activity.
 * - The root's `run_subagent` invocation links to the child via
 *   `payload.childSessionId`.
 *
 * Identification: a `run_subagent` invocation appears as a `tool_call`
 * line with `inferenceToolName === 'run_subagent'` AND a tool-result
 * message (role='tool') on the main chain whose `subagent/agent_id`
 * extension tags the matching `tool_call_id`. The detached subtree
 * rooted at the node containing `subagent/chain_node_id` is the
 * subagent's conversation.
 */

import type {
  DevinChatMessageToolCall,
  DevinMessageLine,
  DevinToolCallLine,
} from '@lucasschirm/sal-devin-session-parser';
import type { NormalizedEvidenceRecord, SessionSummary } from '@lucasschirm/sal-transformer-shared';
import { chatMessageText, messageId, provenanceForArtifact, stableId } from './session-spine.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Metadata extracted from the main-chain tool-result message. */
export interface SubagentIdentity {
  readonly agentId: string;
  readonly profileName: string | null;
  readonly model: string | null;
  readonly chainNodeId: number | null;
  readonly toolCallId: string;
  /** Raw profile from the `run_subagent` call's `rawInput.profile`. */
  readonly rawInputProfile: string | null;
  readonly taskDescription: string | null;
}

export interface SubagentSpineResult {
  readonly summaries: readonly SessionSummary[];
  readonly records: readonly NormalizedEvidenceRecord[];
  /** Nodes consumed by subagent decomposition (excluded from detached fallback). */
  readonly consumedNodeIds: ReadonlySet<number>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Derives a stable child session id matching Claude Code's convention. */
export function deriveChildSessionId(
  rootSessionId: string,
  sourceId: string,
  environmentId: string,
  projectId: string,
  agentId: string,
): string {
  return stableId('subagent', {
    source: sourceId,
    env: environmentId,
    project: projectId,
    parentSession: rootSessionId,
    agentId,
    session: agentId,
  });
}

/** Finds the tool-result message on the main chain that tags a subagent. */
function findSubagentResultMessages(
  orderedMessages: readonly DevinMessageLine[],
): DevinMessageLine[] {
  return orderedMessages.filter((m) => m.subagent?.agentId != null && m.toolCallId != null);
}

/** Resolves the rawInput.profile from the matching tool_call line. */
function rawInputProfileForToolCall(
  toolCalls: readonly DevinToolCallLine[],
  toolCallId: string,
): string | null {
  for (const tc of toolCalls) {
    if (tc.toolCallId !== toolCallId) continue;
    const raw = tc.call?.rawInput;
    if (raw && typeof raw === 'object') {
      const profile = (raw as Record<string, unknown>).profile;
      if (typeof profile === 'string') return profile;
    }
  }
  return null;
}

/** Resolves the rawInput.task (task description) from the tool_call line. */
function taskDescriptionForToolCall(
  toolCalls: readonly DevinToolCallLine[],
  toolCallId: string,
): string | null {
  for (const tc of toolCalls) {
    if (tc.toolCallId !== toolCallId) continue;
    const raw = tc.call?.rawInput;
    if (raw && typeof raw === 'object') {
      const task = (raw as Record<string, unknown>).task;
      if (typeof task === 'string') return task;
    }
  }
  return null;
}

/** Identifies all subagent groups from main-chain tool results. */
export function identifySubagents(
  orderedMessages: readonly DevinMessageLine[],
  toolCalls: readonly DevinToolCallLine[],
): SubagentIdentity[] {
  const resultMsgs = findSubagentResultMessages(orderedMessages);
  return resultMsgs.map((m) => ({
    agentId: m.subagent!.agentId!,
    profileName: m.subagent!.profileName,
    model: m.subagent!.model,
    chainNodeId: m.subagent!.chainNodeId,
    toolCallId: m.toolCallId!,
    rawInputProfile: rawInputProfileForToolCall(toolCalls, m.toolCallId!),
    taskDescription: taskDescriptionForToolCall(toolCalls, m.toolCallId!),
  }));
}

// ---------------------------------------------------------------------------
// Tree walking
// ---------------------------------------------------------------------------

/** Walks up from `leafNodeId` to find the subtree root in `detached`. */
function findSubtreeRootId(
  leafNodeId: number,
  nodeMap: ReadonlyMap<number, DevinMessageLine>,
): number {
  let current = leafNodeId;
  for (;;) {
    const node = nodeMap.get(current);
    if (!node || node.parentNodeId === null || !nodeMap.has(node.parentNodeId)) {
      return current;
    }
    current = node.parentNodeId;
  }
}

/** Collects all nodes in the subtree rooted at `rootId`. */
function collectSubtree(
  rootId: number,
  childrenByParent: ReadonlyMap<number, number[]>,
  nodeMap: ReadonlyMap<number, DevinMessageLine>,
): DevinMessageLine[] {
  const result: DevinMessageLine[] = [];
  const stack = [rootId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    const node = nodeMap.get(id);
    if (node) result.push(node);
    for (const childId of childrenByParent.get(id) ?? []) {
      stack.push(childId);
    }
  }
  return result.sort((a, b) => a.nodeId - b.nodeId);
}

/** Builds parent→children index for the detached message set. */
function buildChildrenIndex(messages: readonly DevinMessageLine[]): Map<number, number[]> {
  const index = new Map<number, number[]>();
  for (const m of messages) {
    if (m.parentNodeId === null) continue;
    const bucket = index.get(m.parentNodeId);
    if (bucket) bucket.push(m.nodeId);
    else index.set(m.parentNodeId, [m.nodeId]);
  }
  return index;
}

// ---------------------------------------------------------------------------
// Record builders
// ---------------------------------------------------------------------------

/** Builds session + session_relation records for a child session. */
function buildChildSessionRecords(
  childSessionId: string,
  rootSessionId: string,
  identity: SubagentIdentity,
  childMessages: readonly DevinMessageLine[],
  rootArtifactId: string,
): NormalizedEvidenceRecord[] {
  const records: NormalizedEvidenceRecord[] = [];

  records.push({
    recordId: stableId('session', { session: childSessionId }),
    recordType: 'session',
    sessionId: childSessionId,
    sourceEventId: identity.agentId,
    provenance: provenanceForArtifact(rootArtifactId),
    payload: {
      harness: 'devin',
      nativeSessionId: identity.agentId,
      title: identity.taskDescription
        ? `[${identity.profileName ?? 'Subagent'}] ${identity.taskDescription}`
        : `Subagent ${identity.profileName ?? identity.agentId}`,
      aiTitle: identity.taskDescription
        ? `[${identity.profileName ?? 'Subagent'}] ${identity.taskDescription}`
        : undefined,
      model: identity.model,
      finality: 'partial' as const,
    },
  });

  records.push({
    recordId: stableId('session_relation', { child: childSessionId }),
    recordType: 'session_relation',
    sessionId: childSessionId,
    parentId: rootSessionId,
    sourceEventId: identity.toolCallId,
    provenance: provenanceForArtifact(rootArtifactId),
    payload: {
      rootSessionId,
      parentSessionId: rootSessionId,
      spawnInvocation: identity.toolCallId,
      depth: 1,
      nativeInclusionSemantics: 'subagent',
    },
  });

  return records;
}

/** Builds turn + message records for a child session's messages. */
function buildChildTurnAndMessageRecords(
  childSessionId: string,
  childMessages: readonly DevinMessageLine[],
  rootArtifactId: string,
): NormalizedEvidenceRecord[] {
  const records: NormalizedEvidenceRecord[] = [];
  let turnOrdinal = 0;

  for (const message of childMessages) {
    turnOrdinal++;
    const eventId = messageId(message);
    const role = chatMessageRole(message);

    records.push({
      recordId: stableId('turn', { session: childSessionId, nodeId: message.nodeId }),
      recordType: 'turn',
      sessionId: childSessionId,
      parentId: stableId('session', { session: childSessionId }),
      sourceEventId: eventId,
      sourceField: 'node_id',
      provenance: provenanceForArtifact(rootArtifactId, eventId, 'node_id'),
      payload: { role, ordinal: turnOrdinal, nodeId: message.nodeId },
    });

    records.push({
      recordId: stableId('message', { session: childSessionId, nodeId: message.nodeId }),
      recordType: 'message',
      sessionId: childSessionId,
      parentId: stableId('turn', { session: childSessionId, nodeId: message.nodeId }),
      sourceEventId: eventId,
      sourceField: 'chat_message',
      provenance: provenanceForArtifact(rootArtifactId, eventId, 'chat_message'),
      payload: {
        role,
        messageId: eventId,
        nodeId: message.nodeId,
        content: chatMessageText(message.chatMessage),
        storage: 'artifact-blob',
        path: rootArtifactId,
      },
    });
  }

  return records;
}

/** Extracts the role string from a message's chatMessage. */
function chatMessageRole(message: DevinMessageLine): string {
  const cm = message.chatMessage;
  if (cm && typeof cm === 'object') {
    const raw = (cm as { role?: unknown }).role;
    if (typeof raw === 'string') return raw;
  }
  return message.role;
}

/** Builds invocation + payload records for embedded tool calls. */
function buildChildInvocationRecords(
  childSessionId: string,
  rootSessionId: string,
  childMessages: readonly DevinMessageLine[],
  rootArtifactId: string,
): NormalizedEvidenceRecord[] {
  const records: NormalizedEvidenceRecord[] = [];
  const seen = new Set<string>();

  for (const message of childMessages) {
    if (!message.toolCalls) continue;
    for (const tc of message.toolCalls) {
      if (seen.has(tc.id)) continue;
      seen.add(tc.id);
      records.push(...buildSingleInvocation(childSessionId, rootSessionId, tc, rootArtifactId));
    }
  }

  return records;
}

/** Builds invocation + input payload for one embedded tool call. */
function buildSingleInvocation(
  childSessionId: string,
  rootSessionId: string,
  tc: DevinChatMessageToolCall,
  rootArtifactId: string,
): NormalizedEvidenceRecord[] {
  const invocationId = stableId('invocation', { session: childSessionId, tool: tc.id });
  const records: NormalizedEvidenceRecord[] = [];

  records.push({
    recordId: invocationId,
    recordType: 'invocation',
    sessionId: childSessionId,
    sourceEventId: tc.id,
    sourceField: 'chat_message.tool_calls',
    provenance: provenanceForArtifact(rootArtifactId, tc.id, 'chat_message.tool_calls'),
    payload: {
      kind: 'tool',
      name: tc.name,
      target: resolveToolTarget(tc),
      startId: tc.id,
      resultId: tc.id,
      status: 'unknown',
      origin: 'subagent',
      rootSessionId,
    },
  });

  records.push({
    recordId: stableId('payload', { session: childSessionId, tool: tc.id, type: 'input' }),
    recordType: 'payload',
    sessionId: childSessionId,
    parentId: invocationId,
    sourceEventId: tc.id,
    sourceField: 'chat_message.tool_calls',
    provenance: provenanceForArtifact(rootArtifactId, tc.id, 'chat_message.tool_calls'),
    payload: {
      payloadType: 'input',
      toolUseId: tc.id,
      sourceEventId: tc.id,
      bytes: byteLength(tc.arguments),
      tokens: 0,
      tokenSource: 'estimated',
      mediaCount: 0,
      structureCount: 0,
      contentKind: 'unknown',
    },
  });

  return records;
}

/** Resolves a file path target from tool call arguments when available. */
function resolveToolTarget(tc: DevinChatMessageToolCall): string | undefined {
  if (!tc.arguments || typeof tc.arguments !== 'object') return undefined;
  const args = tc.arguments as Record<string, unknown>;
  const path = args.file_path ?? args.path ?? args.filename ?? args.pattern;
  return typeof path === 'string' ? path : undefined;
}

function byteLength(value: unknown): number {
  if (typeof value === 'string') return value.length;
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Decomposes subagent detached trees into canonical child sessions.
 *
 * For each identified subagent (from main-chain tool results):
 * 1. Locates the detached subtree via `chain_node_id`.
 * 2. Generates `SessionSummary`, `session`, `session_relation` records.
 * 3. Generates `turn`, `message` records scoped to the child session.
 * 4. Generates `invocation`, `payload` records from embedded tool calls.
 * 5. Returns consumed node ids so `subagent-evidence.ts` can skip them.
 */
export function buildSubagentChildSessions(
  rootSessionId: string,
  sourceId: string,
  environmentId: string,
  projectId: string,
  subagents: readonly SubagentIdentity[],
  detachedMessages: readonly DevinMessageLine[],
  rootArtifactId: string,
): SubagentSpineResult {
  if (subagents.length === 0) {
    return { summaries: [], records: [], consumedNodeIds: new Set() };
  }

  const nodeMap = new Map(detachedMessages.map((m) => [m.nodeId, m]));
  const childrenIndex = buildChildrenIndex(detachedMessages);
  const consumedNodeIds = new Set<number>();
  const summaries: SessionSummary[] = [];
  const records: NormalizedEvidenceRecord[] = [];

  for (const identity of subagents) {
    const result = buildOneSubagentSession(
      rootSessionId,
      sourceId,
      environmentId,
      projectId,
      identity,
      nodeMap,
      childrenIndex,
      rootArtifactId,
    );
    summaries.push(result.summary);
    records.push(...result.records);
    for (const id of result.nodeIds) consumedNodeIds.add(id);
  }

  return { summaries, records, consumedNodeIds };
}

/** Builds a single child session from one identified subagent. */
function buildOneSubagentSession(
  rootSessionId: string,
  sourceId: string,
  environmentId: string,
  projectId: string,
  identity: SubagentIdentity,
  nodeMap: ReadonlyMap<number, DevinMessageLine>,
  childrenIndex: ReadonlyMap<number, number[]>,
  rootArtifactId: string,
): { summary: SessionSummary; records: NormalizedEvidenceRecord[]; nodeIds: number[] } {
  const childSessionId = deriveChildSessionId(
    rootSessionId,
    sourceId,
    environmentId,
    projectId,
    identity.agentId,
  );

  // Locate the subtree: walk up from chain_node_id to find root, then collect
  const childMessages = resolveSubtreeMessages(identity.chainNodeId, nodeMap, childrenIndex);

  const sessionRecords = buildChildSessionRecords(
    childSessionId,
    rootSessionId,
    identity,
    childMessages,
    rootArtifactId,
  );
  const turnRecords = buildChildTurnAndMessageRecords(
    childSessionId,
    childMessages,
    rootArtifactId,
  );
  const invocationRecords = buildChildInvocationRecords(
    childSessionId,
    rootSessionId,
    childMessages,
    rootArtifactId,
  );

  const summary: SessionSummary = {
    sessionId: childSessionId,
    rootSessionId,
    parentSessionId: rootSessionId,
    harness: 'devin',
    finality: 'partial',
  };

  return {
    summary,
    records: [...sessionRecords, ...turnRecords, ...invocationRecords],
    nodeIds: childMessages.map((m) => m.nodeId),
  };
}

/** Resolves the subtree messages for a subagent given its chain_node_id. */
function resolveSubtreeMessages(
  chainNodeId: number | null,
  nodeMap: ReadonlyMap<number, DevinMessageLine>,
  childrenIndex: ReadonlyMap<number, number[]>,
): DevinMessageLine[] {
  if (chainNodeId === null || !nodeMap.has(chainNodeId)) return [];
  const rootId = findSubtreeRootId(chainNodeId, nodeMap);
  return collectSubtree(rootId, childrenIndex, nodeMap);
}
