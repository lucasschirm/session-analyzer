import type { DevinMessageLine } from '@lucasschirm/sal-devin-session-parser';
import type { NormalizedEvidenceRecord } from '@lucasschirm/sal-transformer-shared';
import { provenanceForArtifact, stableId } from './session-spine.js';

/**
 * Builds Sub Agent-domain evidence (DS-B28 (#294)) from
 * `DevinParsedBundle.detachedMessages` — every message reachable from a
 * root OTHER than the session's true main root (see `parse-bundle.ts`'s
 * `orderMessages`). Two shapes come out of that set:
 *
 * 1. **Synthetic sub-agent prompt/result lines** (`jsonl-writer.ts`'s
 *    `subagent-lines.ts`, tagged via `sal/synthetic_subagent_kind`) — a
 *    confident, tool_call_id-correlated prompt/result pair per
 *    `run_subagent` invocation. These become `subagent_turn` records.
 * 2. **Genuine, real orphan trees** (e.g. `foremost-hide`'s nodes 316-322 —
 *    a timed-out sub-agent's own disconnected reasoning) with no confident
 *    correlation to a specific `run_subagent` call (`chain_node_id`'s
 *    semantics are unconfirmed — DS-B28 finding #2 — so it is never used to
 *    force one). These become generic `detached_conversation` records:
 *    never dropped, never mis-attributed.
 *
 * #298 design item 3 audit: `buildSubagentTurnPayload` reads
 * `parsedMetadata.extensions` (our own synthetic bookkeeping bag — see
 * `subagent-lines.ts`) by five named keys and `message.subagent` (the
 * parser's typed 4-field struct) by name; every key either module
 * currently writes is already modeled here, so no field-selection gap was
 * found in THIS file's own logic. `unmodeledExtensions` still captures any
 * future `subagent-lines.ts` bookkeeping key generically, so a later
 * addition here doesn't silently vanish for lack of a matching named
 * field. The one real gap found in the wider #294/#298 data path —
 * `chat_message.metadata.extensions`'s `subagent/*` real-data namespace
 * being whitelisted to 4 keys by the parser package's
 * `parseSubagentExtensions`, upstream of `message.subagent` — is outside
 * this issue's scope (`packages/parsers/devin-session-parser`); this
 * module cannot see past that whitelist since it only receives the
 * already-parsed, already-narrowed `DevinMessageLine`.
 */

const SYNTHETIC_KIND_KEY = 'sal/synthetic_subagent_kind';
const SYNTHETIC_RAWINPUT_PROFILE_KEY = 'sal/synthetic_subagent_rawinput_profile';
const SYNTHETIC_TOOL_CALL_ID_KEY = 'sal/synthetic_subagent_tool_call_id';
const SYNTHETIC_SOURCE_NODE_ID_KEY = 'sal/synthetic_subagent_source_node_id';
const SYNTHETIC_IS_BACKGROUND_KEY = 'sal/synthetic_subagent_is_background';

/**
 * A sub-agent's prompt or result turn, reconstructed from real data (the
 * parent's `run_subagent` tool call's `rawInput.task`, and the correct
 * report-source node per the foreground/background asymmetry — see
 * `subagent-lines.ts`). No token/cache/cost fields exist here, ever — that
 * data genuinely doesn't exist to capture (DS-B28 finding #7,
 * `missing-is-never-zero`).
 */
export interface DevinSubagentTurnPayload {
  readonly eventId: string;
  readonly version: number;
  readonly category: 'subagent_turn';
  readonly agentId: string;
  /** The real `rawInput.profile` value (e.g. `"subagent_explore"`, DS-F11
   * (#288)) — paired with the `profileName` LABEL below per
   * `component-identity-not-display-name`; present on the prompt turn. */
  readonly rawInputProfile?: string;
  /** `subagent/profile_name` — a label (e.g. `"Explore"`), never used alone
   * as identity; pair with `rawInputProfile`. */
  readonly profileName?: string;
  /** `subagent/model` — always the raw coarse label (e.g. `"Subagent
   * Default"`); never a fabricated resolved model id. */
  readonly model?: string;
  /** `subagent/chain_node_id`, raw only. Semantics unconfirmed (DS-B28
   * finding #2) — never used as a correlation/join key here or anywhere in
   * this module. See `DevinSubagentExtensions`'s doc comment. */
  readonly chainNodeId?: number;
  readonly kind: 'prompt' | 'result';
  readonly content?: string;
  /** Only present on a `result` turn. */
  readonly isBackground?: boolean;
  /** The real underlying node the result content was sourced from (the
   * tagged node itself for foreground, or the untagged
   * `<subagent_completion_notification>` node for background). */
  readonly sourceNodeId?: number;
  /** The `run_subagent` `tool_call_state.tool_call_id` that spawned this
   * invocation. */
  readonly spawningToolCallId?: string;
  /**
   * Any `parsedMetadata.extensions` key on this node that isn't one of the
   * five named bookkeeping keys above (#298 design item 3 audit: this
   * module previously read only those five by name, silently dropping a
   * key `subagent-lines.ts` might add later without a matching update
   * here). Empty/absent today — every key `subagent-lines.ts` currently
   * writes is named above — but present so a future addition is captured
   * by default rather than by remembering to wire it in both places.
   */
  readonly additionalExtensions?: Record<string, unknown>;
}

/**
 * A real, disconnected `message_nodes` subtree (DS-B28 finding #5) with no
 * confident correlation to a specific spawning call yet. Captured so it is
 * never silently dropped and never merged into main `turnOrdinal`.
 */
export interface DevinDetachedConversationPayload {
  readonly eventId: string;
  readonly version: number;
  readonly category: 'detached_conversation';
  readonly rootNodeId: number;
  readonly nodeCount: number;
  readonly note: string;
}

function messageContent(chatMessage: unknown): string | undefined {
  if (!chatMessage || typeof chatMessage !== 'object') return undefined;
  const content = (chatMessage as { content?: unknown }).content;
  return typeof content === 'string' ? content : undefined;
}

function extensionValue(message: DevinMessageLine, key: string): unknown {
  return message.parsedMetadata?.extensions?.[key];
}

/** Every named bookkeeping key this module already reads by name (#298
 * design item 3's audit target for `unmodeledExtensions`). */
const KNOWN_SYNTHETIC_KEYS: readonly string[] = [
  SYNTHETIC_KIND_KEY,
  SYNTHETIC_RAWINPUT_PROFILE_KEY,
  SYNTHETIC_TOOL_CALL_ID_KEY,
  SYNTHETIC_SOURCE_NODE_ID_KEY,
  SYNTHETIC_IS_BACKGROUND_KEY,
];

/** `parsedMetadata.extensions` keys this module doesn't already model by
 * name — captured generically so a future `subagent-lines.ts` addition is
 * never silently dropped for lack of a matching named field here. */
function unmodeledExtensions(message: DevinMessageLine): Record<string, unknown> | undefined {
  const extensions = message.parsedMetadata?.extensions;
  if (!extensions) return undefined;
  const entries = Object.entries(extensions).filter(([key]) => !KNOWN_SYNTHETIC_KEYS.includes(key));
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function syntheticKind(message: DevinMessageLine): 'prompt' | 'result' | null {
  const value = extensionValue(message, SYNTHETIC_KIND_KEY);
  return value === 'prompt' || value === 'result' ? value : null;
}

function buildSubagentTurnPayload(
  message: DevinMessageLine,
  kind: 'prompt' | 'result',
  agentId: string,
  recordId: string,
): DevinSubagentTurnPayload {
  const subagent = message.subagent as NonNullable<DevinMessageLine['subagent']>;
  const rawInputProfile = extensionValue(message, SYNTHETIC_RAWINPUT_PROFILE_KEY);
  const isBackground = extensionValue(message, SYNTHETIC_IS_BACKGROUND_KEY);
  const sourceNodeId = extensionValue(message, SYNTHETIC_SOURCE_NODE_ID_KEY);
  const toolCallId = extensionValue(message, SYNTHETIC_TOOL_CALL_ID_KEY);
  const content = messageContent(message.chatMessage);
  const additionalExtensions = unmodeledExtensions(message);

  return {
    eventId: recordId,
    version: 1,
    category: 'subagent_turn',
    agentId,
    kind,
    ...(typeof rawInputProfile === 'string' ? { rawInputProfile } : {}),
    ...(subagent.profileName !== null ? { profileName: subagent.profileName } : {}),
    ...(subagent.model !== null ? { model: subagent.model } : {}),
    ...(subagent.chainNodeId !== null ? { chainNodeId: subagent.chainNodeId } : {}),
    ...(content !== undefined ? { content } : {}),
    ...(typeof isBackground === 'boolean' ? { isBackground } : {}),
    ...(typeof sourceNodeId === 'number' ? { sourceNodeId } : {}),
    ...(typeof toolCallId === 'string' ? { spawningToolCallId: toolCallId } : {}),
    ...(additionalExtensions ? { additionalExtensions } : {}),
  };
}

function buildSubagentTurnRecord(
  sessionId: string,
  message: DevinMessageLine,
  kind: 'prompt' | 'result',
  rootArtifactId: string,
): NormalizedEvidenceRecord | null {
  const agentId = message.subagent?.agentId;
  if (!agentId) return null;

  const sourceEventId = `node-${message.nodeId}`;
  const recordId = stableId('normalized_event', {
    session: sessionId,
    category: 'subagent_turn',
    source: sourceEventId,
  });

  return {
    recordId,
    recordType: 'normalized_event',
    sessionId,
    sourceEventId,
    sourceField: 'chat_message.metadata.extensions',
    provenance: provenanceForArtifact(
      rootArtifactId,
      sourceEventId,
      'chat_message.metadata.extensions',
    ),
    payload: buildSubagentTurnPayload(message, kind, agentId, recordId),
  };
}

/** Roots of `messages`, i.e. every node whose parent is absent or outside
 * this same set — mirrors `parse-bundle.ts`'s `findRootIds`, kept local to
 * avoid coupling this module to that one's internals. */
function treeRoots(messages: readonly DevinMessageLine[]): DevinMessageLine[] {
  const ids = new Set(messages.map((m) => m.nodeId));
  return messages
    .filter((m) => m.parentNodeId === null || !ids.has(m.parentNodeId))
    .sort((a, b) => a.nodeId - b.nodeId);
}

function subtreeNodeCount(root: DevinMessageLine, messages: readonly DevinMessageLine[]): number {
  const childrenByParent = new Map<number, number[]>();
  for (const m of messages) {
    if (m.parentNodeId === null) continue;
    const bucket = childrenByParent.get(m.parentNodeId);
    bucket ? bucket.push(m.nodeId) : childrenByParent.set(m.parentNodeId, [m.nodeId]);
  }
  const visited = new Set<number>();
  const stack = [root.nodeId];
  while (stack.length > 0) {
    const id = stack.pop() as number;
    if (visited.has(id)) continue;
    visited.add(id);
    for (const childId of childrenByParent.get(id) ?? []) stack.push(childId);
  }
  return visited.size;
}

const DETACHED_CONVERSATION_NOTE =
  'A message_nodes subtree disconnected from the session main conversation ' +
  '(DS-B28/#294 finding #5) -- excluded from main turnOrdinal sequencing. ' +
  'Its correlation to a specific run_subagent call is not yet resolved ' +
  '(subagent/chain_node_id semantics are unconfirmed); captured as raw, ' +
  'unattributed evidence rather than guessed or dropped.';

function buildDetachedConversationRecord(
  sessionId: string,
  root: DevinMessageLine,
  nodeCount: number,
  rootArtifactId: string,
): NormalizedEvidenceRecord {
  const sourceEventId = `node-${root.nodeId}`;
  const recordId = stableId('normalized_event', {
    session: sessionId,
    category: 'detached_conversation',
    source: sourceEventId,
  });
  const payload: DevinDetachedConversationPayload = {
    eventId: recordId,
    version: 1,
    category: 'detached_conversation',
    rootNodeId: root.nodeId,
    nodeCount,
    note: DETACHED_CONVERSATION_NOTE,
  };
  return {
    recordId,
    recordType: 'normalized_event',
    sessionId,
    sourceEventId,
    sourceField: 'parent_node_id',
    provenance: provenanceForArtifact(rootArtifactId, sourceEventId, 'parent_node_id'),
    payload,
  };
}

export function buildDevinSubagentEvidence(
  sessionId: string,
  detachedMessages: readonly DevinMessageLine[],
  rootArtifactId: string,
): NormalizedEvidenceRecord[] {
  const records: NormalizedEvidenceRecord[] = [];
  const handled = new Set<number>();

  for (const message of detachedMessages) {
    const kind = syntheticKind(message);
    if (kind === null) continue;
    const record = buildSubagentTurnRecord(sessionId, message, kind, rootArtifactId);
    if (record) {
      records.push(record);
      handled.add(message.nodeId);
    }
  }

  const remaining = detachedMessages.filter((m) => !handled.has(m.nodeId));
  for (const root of treeRoots(remaining)) {
    records.push(
      buildDetachedConversationRecord(
        sessionId,
        root,
        subtreeNodeCount(root, remaining),
        rootArtifactId,
      ),
    );
  }

  return records;
}
