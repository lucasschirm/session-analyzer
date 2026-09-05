import type { DevinMessageLine, DevinSessionLine } from '@lucasschirm/sal-devin-session-parser';
import type {
  NormalizedEvidenceRecord,
  Provenance,
  SessionSummary,
  SourceIdentity,
  TransformContext,
} from '@lucasschirm/sal-transformer-shared';

export interface DevinSessionSpine {
  readonly records: readonly NormalizedEvidenceRecord[];
  readonly summary: SessionSummary;
}

export function stableId(namespace: string, parts: Record<string, unknown>): string {
  const ordered: Record<string, unknown> = {};
  for (const key of Object.keys(parts).sort()) {
    const value = parts[key];
    if (value !== undefined) ordered[key] = value;
  }
  return `${namespace}:${JSON.stringify(ordered)}`;
}

/**
 * Resolves the harness-scoped source identity (ingestion source,
 * environment, project) used both for session ids and for component ids
 * that must stay stable across sessions from the same source
 * (`.agents/rules/component-identity-not-display-name.md`).
 */
export function resolveSourceIdentity(
  context: TransformContext,
  source?: SourceIdentity,
): Required<SourceIdentity> {
  return {
    sourceId: source?.sourceId ?? context.sourceFingerprint ?? 'manual',
    environmentId: source?.environmentId ?? context.sourceEnvironmentId ?? 'unknown',
    projectId: source?.projectId ?? context.sourceProjectId ?? 'unknown',
    sessionId: source?.sessionId ?? context.sourceSessionId ?? 'unknown',
  };
}

export function deriveSessionId(
  context: TransformContext,
  source: SourceIdentity | undefined,
  nativeSessionId: string,
): string {
  const s = resolveSourceIdentity(context, source);
  return stableId('session', {
    source: s.sourceId,
    env: s.environmentId,
    project: s.projectId,
    session: nativeSessionId,
  });
}

function sessionTimestamps(
  session?: DevinSessionLine,
  atifSteps?: readonly { timestamp: string | null }[],
): { start?: string; end?: string } {
  const values: number[] = [];
  if (session?.createdAt !== null && typeof session?.createdAt === 'number') {
    values.push(session.createdAt * 1000);
  }
  if (session?.lastActivityAt !== null && typeof session?.lastActivityAt === 'number') {
    values.push(session.lastActivityAt * 1000);
  }
  if (atifSteps) {
    for (const step of atifSteps) {
      if (step.timestamp) {
        const parsed = Date.parse(step.timestamp);
        if (!Number.isNaN(parsed)) values.push(parsed);
      }
    }
  }
  if (values.length === 0) return {};
  values.sort((a, b) => a - b);
  return {
    start: new Date(values[0]).toISOString(),
    end: new Date(values[values.length - 1]).toISOString(),
  };
}

function messageContent(chatMessage: unknown): string | undefined {
  if (!chatMessage || typeof chatMessage !== 'object') return undefined;
  const content = (chatMessage as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  return undefined;
}

function messageRole(chatMessage: unknown, normalizedRole: string): string {
  if (chatMessage && typeof chatMessage === 'object') {
    const raw = (chatMessage as { role?: unknown }).role;
    if (typeof raw === 'string') return raw;
  }
  return normalizedRole;
}

/**
 * Surfaces a node's `subagent/*` extension tags on its `message` payload
 * "wherever present" (DS-B28 (#294) design item 1's acceptance criterion),
 * including for a naturally in-main-chain tagged node (e.g. a real
 * foreground result like `shadow-collar` node 178) that never becomes
 * `detachedMessages` and so is never picked up by `subagent-evidence.ts`.
 * Only non-null fields are included; `undefined` (not present at all) when
 * the node carries no subagent tag, so a plain `message` payload's shape is
 * unchanged for the overwhelming majority of ordinary nodes.
 */
function subagentTagFields(message: DevinMessageLine): Record<string, unknown> | undefined {
  const subagent = message.subagent;
  if (!subagent) return undefined;
  return {
    ...(subagent.agentId !== null ? { subagentAgentId: subagent.agentId } : {}),
    ...(subagent.profileName !== null ? { subagentProfileName: subagent.profileName } : {}),
    ...(subagent.model !== null ? { subagentModel: subagent.model } : {}),
    ...(subagent.chainNodeId !== null ? { subagentChainNodeId: subagent.chainNodeId } : {}),
  };
}

/**
 * Resolves the real `chat_message.message_id` when present, falling back to
 * a `node-<id>`-derived synthetic id. This is the SAME identity key
 * `parse-bundle.ts`'s `orderMessages` dedups on (DS-B28 (#294) finding #4):
 * two `message_nodes` rows with different `node_id` but the same
 * `message_id` are the same logical message, and must not be double-counted
 * — see that module's `dedupeByMessageId`.
 */
export function messageId(message: DevinMessageLine): string {
  const chatMessage = message.chatMessage;
  if (chatMessage && typeof chatMessage === 'object') {
    const id = (chatMessage as { message_id?: unknown }).message_id;
    if (typeof id === 'string') return id;
  }
  return `node-${message.nodeId}`;
}

export function buildSessionSpine(
  sessionId: string,
  session: DevinSessionLine | undefined,
  orderedMessages: readonly DevinMessageLine[],
  atifSteps: readonly { timestamp: string | null }[],
  rootArtifactId: string,
): DevinSessionSpine {
  const { start, end } = sessionTimestamps(session, atifSteps);
  const records: NormalizedEvidenceRecord[] = [];

  records.push({
    recordId: stableId('session', { session: sessionId }),
    recordType: 'session',
    sessionId,
    sourceEventId: session?.id ?? 'unknown',
    provenance: { artifactId: rootArtifactId, path: rootArtifactId },
    payload: {
      harness: 'devin',
      nativeSessionId: session?.id ?? 'unknown',
      workingDirectory: session?.workingDirectory,
      model: session?.model,
      agentMode: session?.agentMode,
      title: session?.title,
      startTime: start,
      endTime: end,
      finality: 'partial',
    },
  });

  let turnOrdinal = 0;
  for (const message of orderedMessages) {
    turnOrdinal++;
    const eventId = messageId(message);
    const role = messageRole(message.chatMessage, message.role);

    records.push({
      recordId: stableId('turn', { session: sessionId, nodeId: message.nodeId }),
      recordType: 'turn',
      sessionId,
      parentId: stableId('session', { session: sessionId }),
      sourceEventId: eventId,
      sourceField: 'node_id',
      provenance: {
        artifactId: rootArtifactId,
        sourceEventId: eventId,
        sourceField: 'node_id',
        path: rootArtifactId,
      },
      payload: {
        role,
        ordinal: turnOrdinal,
        nodeId: message.nodeId,
        parentNodeId: message.parentNodeId,
        rawRole: message.rawRole,
      },
    });

    records.push({
      recordId: stableId('message', { session: sessionId, nodeId: message.nodeId }),
      recordType: 'message',
      sessionId,
      parentId: stableId('turn', { session: sessionId, nodeId: message.nodeId }),
      sourceEventId: eventId,
      sourceField: 'chat_message',
      provenance: {
        artifactId: rootArtifactId,
        sourceEventId: eventId,
        sourceField: 'chat_message',
        path: rootArtifactId,
      },
      payload: {
        role,
        messageId: eventId,
        nodeId: message.nodeId,
        parentNodeId: message.parentNodeId,
        content: messageContent(message.chatMessage),
        ...subagentTagFields(message),
      },
    });
  }

  const summary: SessionSummary = {
    sessionId,
    rootSessionId: sessionId,
    harness: 'devin',
    startTime: start,
    endTime: end,
    finality: 'partial',
  };

  return { records, summary };
}

export function provenanceForArtifact(
  artifactId: string,
  sourceEventId?: string,
  sourceField?: string,
): Provenance {
  return { artifactId, sourceEventId, sourceField, path: artifactId };
}
