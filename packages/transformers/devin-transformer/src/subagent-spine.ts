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
import {
  chatMessageText,
  messageId,
  messageRole,
  provenanceForArtifact,
  stableId,
} from './session-spine.js';
import { byteLength } from './tool-invocations.js';

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

function registerSubagentIdentity(
  byAgentId: Map<string, SubagentIdentity>,
  m: DevinMessageLine,
  toolCalls: readonly DevinToolCallLine[],
): void {
  if (!m.subagent?.agentId || !m.toolCallId) return;
  const agentId = m.subagent.agentId;
  const toolCallId = m.toolCallId;
  const identity: SubagentIdentity = {
    agentId,
    profileName: m.subagent.profileName,
    model: m.subagent.model,
    chainNodeId: m.subagent.chainNodeId,
    toolCallId,
    rawInputProfile: rawInputProfileForToolCall(toolCalls, toolCallId),
    taskDescription: taskDescriptionForToolCall(toolCalls, toolCallId),
  };
  const existing = byAgentId.get(agentId);
  if (!existing || (existing.chainNodeId === null && identity.chainNodeId !== null)) {
    byAgentId.set(agentId, identity);
  }
}

/** Identifies all subagent groups from main-chain tool results, deduplicated by agentId. */
export function identifySubagents(
  orderedMessages: readonly DevinMessageLine[],
  toolCalls: readonly DevinToolCallLine[],
): SubagentIdentity[] {
  const resultMsgs = findSubagentResultMessages(orderedMessages);
  const byAgentId = new Map<string, SubagentIdentity>();
  for (const m of resultMsgs) {
    registerSubagentIdentity(byAgentId, m, toolCalls);
  }
  return Array.from(byAgentId.values());
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
  const visited = new Set<number>();
  for (;;) {
    if (visited.has(current)) {
      return current;
    }
    visited.add(current);
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
  const visited = new Set<number>();
  const stack = [rootId];
  while (stack.length > 0) {
    const id = stack.pop();
    if (id === undefined) break;
    if (visited.has(id)) continue;
    visited.add(id);
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
export function childSessionTimestamps(messages: readonly DevinMessageLine[]): {
  start?: string;
  end?: string;
} {
  const values: number[] = [];
  for (const m of messages) {
    if (typeof m.createdAt === 'number' && Number.isFinite(m.createdAt)) {
      values.push(m.createdAt * 1000);
    }
  }
  if (values.length === 0) return {};
  values.sort((a, b) => a - b);
  return {
    start: new Date(values[0]).toISOString(),
    end: new Date(values[values.length - 1]).toISOString(),
  };
}

function childSessionTitles(identity: SubagentIdentity): {
  title: string;
  aiTitle?: string;
  fallbackTitle?: string;
} {
  const shortId = identity.agentId.slice(0, 8);
  const fallback = `Subagent ${identity.profileName ?? shortId}`;
  if (identity.taskDescription) {
    const ai = `[${identity.profileName ?? 'Subagent'}] ${identity.taskDescription}`;
    return { title: ai, aiTitle: ai, fallbackTitle: fallback };
  }
  return { title: fallback, fallbackTitle: fallback };
}

function buildChildSessionRecord(
  childSessionId: string,
  identity: SubagentIdentity,
  timestamps: { start?: string; end?: string },
  rootArtifactId: string,
): NormalizedEvidenceRecord {
  const titles = childSessionTitles(identity);
  return {
    recordId: stableId('session', { session: childSessionId }),
    recordType: 'session',
    sessionId: childSessionId,
    sourceEventId: identity.agentId,
    provenance: provenanceForArtifact(rootArtifactId),
    payload: {
      harness: 'devin',
      nativeSessionId: identity.agentId,
      title: titles.title,
      aiTitle: titles.aiTitle,
      fallbackTitle: titles.fallbackTitle,
      model: identity.model,
      startTime: timestamps.start,
      endTime: timestamps.end,
      finality: 'partial' as const,
    },
  };
}

function buildChildRelationRecord(
  childSessionId: string,
  rootSessionId: string,
  identity: SubagentIdentity,
  rootArtifactId: string,
): NormalizedEvidenceRecord {
  return {
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
  };
}

function buildChildSessionRecords(
  childSessionId: string,
  rootSessionId: string,
  identity: SubagentIdentity,
  timestamps: { start?: string; end?: string },
  rootArtifactId: string,
): NormalizedEvidenceRecord[] {
  return [
    buildChildSessionRecord(childSessionId, identity, timestamps, rootArtifactId),
    buildChildRelationRecord(childSessionId, rootSessionId, identity, rootArtifactId),
  ];
}

function buildSingleTurnRecord(
  childSessionId: string,
  eventId: string,
  role: string,
  ordinal: number,
  nodeId: number,
  rootArtifactId: string,
): NormalizedEvidenceRecord {
  return {
    recordId: stableId('turn', { session: childSessionId, nodeId }),
    recordType: 'turn',
    sessionId: childSessionId,
    parentId: stableId('session', { session: childSessionId }),
    sourceEventId: eventId,
    sourceField: 'node_id',
    provenance: provenanceForArtifact(rootArtifactId, eventId, 'node_id'),
    payload: { role, ordinal, nodeId },
  };
}

function buildSingleMessageRecord(
  childSessionId: string,
  eventId: string,
  role: string,
  message: DevinMessageLine,
  rootArtifactId: string,
): NormalizedEvidenceRecord {
  const timestamp =
    typeof message.createdAt === 'number' && Number.isFinite(message.createdAt)
      ? new Date(message.createdAt * 1000).toISOString()
      : undefined;
  return {
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
      ...(timestamp ? { timestamp } : {}),
      storage: 'artifact-blob',
      path: rootArtifactId,
    },
  };
}

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
    const role = messageRole(message.chatMessage, message.role);
    records.push(
      buildSingleTurnRecord(
        childSessionId,
        eventId,
        role,
        turnOrdinal,
        message.nodeId,
        rootArtifactId,
      ),
      buildSingleMessageRecord(childSessionId, eventId, role, message, rootArtifactId),
    );
  }
  return records;
}

function mapToolResults(messages: readonly DevinMessageLine[]): Map<string, DevinMessageLine> {
  const results = new Map<string, DevinMessageLine>();
  for (const m of messages) {
    if (m.toolCallId) results.set(m.toolCallId, m);
  }
  return results;
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
  const resultsByToolCallId = mapToolResults(childMessages);

  for (const message of childMessages) {
    if (!message.toolCalls) continue;
    for (const tc of message.toolCalls) {
      if (seen.has(tc.id)) continue;
      seen.add(tc.id);
      const resultMessage = resultsByToolCallId.get(tc.id);
      records.push(
        ...buildSingleInvocation(childSessionId, rootSessionId, tc, resultMessage, rootArtifactId),
      );
    }
  }
  return records;
}

/** Resolves a file path target from tool call arguments when available. */
function resolveToolTarget(tc: DevinChatMessageToolCall): string | undefined {
  if (!tc.arguments || typeof tc.arguments !== 'object') return undefined;
  const args = tc.arguments as Record<string, unknown>;
  const path = args.file_path ?? args.path ?? args.filename ?? args.pattern;
  return typeof path === 'string' ? path : undefined;
}

function classifyEmbeddedToolCall(tc: DevinChatMessageToolCall): {
  kind: 'tool' | 'skill' | 'agent';
  name: string;
  target?: string;
} {
  const args =
    typeof tc.arguments === 'object' && tc.arguments !== null
      ? (tc.arguments as Record<string, unknown>)
      : null;
  const rawKind = tc.kind?.toLowerCase();
  const nameLower = tc.name.toLowerCase();

  if (rawKind === 'skill' || nameLower === 'skill' || nameLower === 'run_skill') {
    const skillName = args && typeof args.skill === 'string' ? args.skill : tc.name;
    const target = args && typeof args.target === 'string' ? args.target : undefined;
    return { kind: 'skill', name: skillName, target };
  }
  if (rawKind === 'agent' || nameLower === 'run_subagent' || nameLower === 'subagent') {
    const profile = args && typeof args.profile === 'string' ? args.profile : tc.name;
    const target =
      args && typeof args.title === 'string'
        ? args.title
        : typeof args?.task === 'string'
          ? args.task
          : undefined;
    return { kind: 'agent', name: profile, target };
  }
  return { kind: 'tool', name: tc.name, target: resolveToolTarget(tc) };
}

function buildInvocationRecord(
  invocationId: string,
  childSessionId: string,
  rootSessionId: string,
  tc: DevinChatMessageToolCall,
  resultMessage: DevinMessageLine | undefined,
  rootArtifactId: string,
): NormalizedEvidenceRecord {
  const hasResult = resultMessage !== undefined;
  const { kind, name, target } = classifyEmbeddedToolCall(tc);
  return {
    recordId: invocationId,
    recordType: 'invocation',
    sessionId: childSessionId,
    sourceEventId: tc.id,
    sourceField: 'chat_message.tool_calls',
    provenance: provenanceForArtifact(rootArtifactId, tc.id, 'chat_message.tool_calls'),
    payload: {
      kind,
      name,
      target,
      startId: tc.id,
      resultId: hasResult ? tc.id : undefined,
      status: hasResult ? 'success' : 'unknown',
      origin: 'subagent',
      rootSessionId,
    },
  };
}

function buildInputPayloadRecord(
  invocationId: string,
  childSessionId: string,
  tc: DevinChatMessageToolCall,
  rootArtifactId: string,
): NormalizedEvidenceRecord {
  return {
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
  };
}

function buildResultPayloadRecord(
  invocationId: string,
  childSessionId: string,
  tc: DevinChatMessageToolCall,
  resultMessage: DevinMessageLine,
  rootArtifactId: string,
): NormalizedEvidenceRecord {
  const resultEventId = messageId(resultMessage);
  return {
    recordId: stableId('payload', { session: childSessionId, tool: tc.id, type: 'result' }),
    recordType: 'payload',
    sessionId: childSessionId,
    parentId: invocationId,
    sourceEventId: tc.id,
    sourceField: 'chat_message.tool_call_id',
    provenance: provenanceForArtifact(rootArtifactId, resultEventId, 'chat_message'),
    payload: {
      payloadType: 'result',
      toolUseId: tc.id,
      sourceEventId: tc.id,
      bytes: byteLength(resultMessage.chatMessage),
      tokens: 0,
      tokenSource: 'estimated',
      mediaCount: 0,
      structureCount: 0,
      contentKind: 'unknown',
    },
  };
}

/** Builds invocation + input (and optional result) payload for one embedded tool call. */
function buildSingleInvocation(
  childSessionId: string,
  rootSessionId: string,
  tc: DevinChatMessageToolCall,
  resultMessage: DevinMessageLine | undefined,
  rootArtifactId: string,
): NormalizedEvidenceRecord[] {
  const invocationId = stableId('invocation', { session: childSessionId, tool: tc.id });
  const records: NormalizedEvidenceRecord[] = [
    buildInvocationRecord(
      invocationId,
      childSessionId,
      rootSessionId,
      tc,
      resultMessage,
      rootArtifactId,
    ),
    buildInputPayloadRecord(invocationId, childSessionId, tc, rootArtifactId),
  ];
  if (resultMessage !== undefined) {
    records.push(
      buildResultPayloadRecord(invocationId, childSessionId, tc, resultMessage, rootArtifactId),
    );
  }
  return records;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

interface ChildSessionContext {
  readonly rootSessionId: string;
  readonly sourceId: string;
  readonly environmentId: string;
  readonly projectId: string;
  readonly rootArtifactId: string;
}

interface OneSubagentResult {
  readonly summary: SessionSummary;
  readonly records: readonly NormalizedEvidenceRecord[];
  readonly nodeIds: readonly number[];
}

function assembleSubagentRecords(
  childSessionId: string,
  ctx: ChildSessionContext,
  identity: SubagentIdentity,
  childMessages: readonly DevinMessageLine[],
  timestamps: { start?: string; end?: string },
): NormalizedEvidenceRecord[] {
  const sessionRecs = buildChildSessionRecords(
    childSessionId,
    ctx.rootSessionId,
    identity,
    timestamps,
    ctx.rootArtifactId,
  );
  const turnRecs = buildChildTurnAndMessageRecords(
    childSessionId,
    childMessages,
    ctx.rootArtifactId,
  );
  const invRecs = buildChildInvocationRecords(
    childSessionId,
    ctx.rootSessionId,
    childMessages,
    ctx.rootArtifactId,
  );
  return [...sessionRecs, ...turnRecs, ...invRecs];
}

function buildSubagentSummary(
  childSessionId: string,
  rootSessionId: string,
  timestamps: { start?: string; end?: string },
): SessionSummary {
  return {
    sessionId: childSessionId,
    rootSessionId,
    parentSessionId: rootSessionId,
    harness: 'devin',
    finality: 'partial',
    startTime: timestamps.start,
    endTime: timestamps.end,
  };
}

function buildOneSubagentSession(
  ctx: ChildSessionContext,
  identity: SubagentIdentity,
  nodeMap: ReadonlyMap<number, DevinMessageLine>,
  childrenIndex: ReadonlyMap<number, number[]>,
): OneSubagentResult {
  const childSessionId = deriveChildSessionId(
    ctx.rootSessionId,
    ctx.sourceId,
    ctx.environmentId,
    ctx.projectId,
    identity.agentId,
  );
  const childMessages = resolveSubtreeMessages(identity.chainNodeId, nodeMap, childrenIndex);
  const timestamps = childSessionTimestamps(childMessages);
  const records = assembleSubagentRecords(childSessionId, ctx, identity, childMessages, timestamps);
  const summary = buildSubagentSummary(childSessionId, ctx.rootSessionId, timestamps);

  return {
    summary,
    records,
    nodeIds: childMessages.map((m) => m.nodeId),
  };
}

function collectSubagentSessions(
  subagents: readonly SubagentIdentity[],
  ctx: ChildSessionContext,
  nodeMap: ReadonlyMap<number, DevinMessageLine>,
  childrenIndex: ReadonlyMap<number, number[]>,
): SubagentSpineResult {
  const consumedNodeIds = new Set<number>();
  const summaries: SessionSummary[] = [];
  const records: NormalizedEvidenceRecord[] = [];

  for (const identity of subagents) {
    const res = buildOneSubagentSession(ctx, identity, nodeMap, childrenIndex);
    summaries.push(res.summary);
    records.push(...res.records);
    for (const id of res.nodeIds) consumedNodeIds.add(id);
  }
  return { summaries, records, consumedNodeIds };
}

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
  const ctx: ChildSessionContext = {
    rootSessionId,
    sourceId,
    environmentId,
    projectId,
    rootArtifactId,
  };
  return collectSubagentSessions(subagents, ctx, nodeMap, childrenIndex);
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
