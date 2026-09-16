import type { DevinMessageLine, DevinSessionLine } from '@lucasschirm/sal-devin-session-parser';
import type {
  NormalizedEvidenceRecord,
  Provenance,
  SessionSummary,
  SourceIdentity,
  TransformContext,
} from '@lucasschirm/sal-transformer-shared';
import { truncateSessionTitle } from '@lucasschirm/sal-transformer-shared';

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
  _context: TransformContext,
  source: SourceIdentity | undefined,
  nativeSessionId: string,
): string {
  if (nativeSessionId && nativeSessionId !== 'unknown') {
    return nativeSessionId;
  }
  return source?.sessionId ?? nativeSessionId ?? 'unknown';
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

/**
 * Extracts the text of a `chat_message` payload. The observed shape is a
 * plain string `content`; tolerate an array of content blocks (text blocks
 * only) for forward compatibility.
 */
export function chatMessageText(chatMessage: unknown): string | undefined {
  if (!chatMessage || typeof chatMessage !== 'object') return undefined;
  const content = (chatMessage as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const parts = content
    .map((block) =>
      block &&
      typeof block === 'object' &&
      (block as { type?: unknown }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string'
        ? (block as { text: string }).text
        : '',
    )
    .join(' ');
  return parts.trim() ? parts : undefined;
}

/**
 * Finds the first real user message in the ordered message nodes. Skips
 * empty and `<…>`-wrapped system/injected content — mirroring the
 * first-prompt extraction Claude Code performs for its session picker.
 */
function firstUserMessageText(messages: readonly DevinMessageLine[]): string | undefined {
  for (const message of messages) {
    if (messageRole(message.chatMessage, message.role) !== 'user') continue;
    const text = chatMessageText(message.chatMessage);
    if (!text) continue;
    const normalized = text.trim();
    if (!normalized || normalized.startsWith('<')) continue;
    return normalized;
  }
  return undefined;
}

/**
 * Derives a display title from the first user message for sessions whose
 * `sessions.db` row carries no title — the same first-message convention
 * Devin CLI itself uses. Emitted as `fallbackTitle`: ingestion only writes
 * it when no better title exists on the session row.
 */
function deriveSessionTitle(messages: readonly DevinMessageLine[]): string | undefined {
  const first = firstUserMessageText(messages);
  return first ? truncateSessionTitle(first) : undefined;
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
      // Devin CLI persists its own per-session title (derived from the
      // first user message); surface it as the canonical session title
      // (`ai_title`) for read paths — ingestion reads `aiTitle`.
      aiTitle: session?.title,
      // When sessions.db carries no title, derive one from the first user
      // message — the same convention Devin CLI itself uses. Ingestion
      // only writes it when the session row is untitled.
      fallbackTitle: session?.title?.trim() ? undefined : deriveSessionTitle(orderedMessages),
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
        // Carry the chat_message text so the context-timing computation can
        // populate `content` on ContextTimingPoint without a blob round-trip.
        // The drawer's on-demand hydration remains the fallback for sessions
        // whose message payloads predate this field (reprocessed generations
        // pick it up automatically via the processing-version bump).
        content: chatMessageText(message.chatMessage),
        // Devin's own per-node context-size checkpoint
        // (`message_nodes.metadata.num_tokens_preceding`) — the only context
        // signal on transcript-only sessions (no ATIF, no
        // response_dimensions), where the single session-level `model_usage`
        // record carries all-null tokens and the context-growth chart would
        // otherwise render 0 for every message. Emitted only when populated;
        // absent stays absent (missing-is-never-zero).
        ...(message.parsedMetadata?.numTokensPreceding !== null &&
        message.parsedMetadata?.numTokensPreceding !== undefined
          ? { numTokensPreceding: message.parsedMetadata.numTokensPreceding }
          : {}),
        timestamp:
          typeof message.createdAt === 'number' && Number.isFinite(message.createdAt)
            ? new Date(message.createdAt * 1000).toISOString()
            : undefined,
        storage: 'artifact-blob',
        path: rootArtifactId,
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
