import type {
  AtifTranscript,
  DevinJsonlParseResult,
  DevinMessageLine,
  DevinModelRecord,
  DevinPromptLine,
  DevinSessionLine,
  DevinToolCallLine,
  ParseDevinModelsResult,
} from '@lucasschirm/sal-devin-session-parser';
import {
  parseAtifTranscript,
  parseDevinJsonlText,
  parseDevinModelsJson,
  parseSchemaDescriptor,
} from '@lucasschirm/sal-devin-session-parser';
import type { Artifact, Issue, UnknownArtifactBundle } from '@lucasschirm/sal-transformer-shared';
import { messageId } from './session-spine.js';

export interface DevinParsedBundle {
  readonly rootTranscriptText?: string;
  readonly parsedJsonl: DevinJsonlParseResult;
  readonly atif?: AtifTranscript;
  readonly models: readonly DevinModelRecord[];
  readonly modelsRaw?: string;
  readonly schemaDescriptor?: ReturnType<typeof parseSchemaDescriptor>;
  readonly planContent?: string;
  readonly sessionLine?: DevinSessionLine;
  readonly orderedMessages: readonly DevinMessageLine[];
  /** See `OrderMessagesResult.detached`. */
  readonly detachedMessages: readonly DevinMessageLine[];
  readonly toolCalls: readonly DevinToolCallLine[];
  readonly prompts: readonly DevinPromptLine[];
  readonly warnings: readonly Issue[];
}

function toText(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (content === null || content === undefined) return undefined;
  if (content instanceof Uint8Array) {
    return decodeUtf8(content);
  }
  if (content instanceof ArrayBuffer) {
    return decodeUtf8(new Uint8Array(content));
  }
  if (typeof content === 'object') {
    try {
      return JSON.stringify(content);
    } catch {
      return String(content);
    }
  }
  return String(content);
}

function decodeUtf8(bytes: Uint8Array): string {
  let result = '';
  let i = 0;
  while (i < bytes.length) {
    const b1 = bytes[i++];
    if (b1 < 0x80) {
      result += String.fromCharCode(b1);
    } else if (b1 < 0xc0) {
    } else if (b1 < 0xe0) {
      const b2 = bytes[i++];
      result += String.fromCharCode(((b1 & 0x1f) << 6) | (b2 & 0x3f));
    } else if (b1 < 0xf0) {
      const b2 = bytes[i++];
      const b3 = bytes[i++];
      result += String.fromCharCode(((b1 & 0x0f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f));
    } else {
      const b2 = bytes[i++];
      const b3 = bytes[i++];
      const b4 = bytes[i++];
      const codePoint =
        ((b1 & 0x07) << 18) | ((b2 & 0x3f) << 12) | ((b3 & 0x3f) << 6) | (b4 & 0x3f);
      const adjusted = codePoint - 0x10000;
      result += String.fromCharCode(0xd800 + (adjusted >> 10), 0xdc00 + (adjusted & 0x3ff));
    }
  }
  return result;
}

function findRootTranscript(
  artifacts: readonly Artifact<unknown>[],
): Artifact<unknown> | undefined {
  for (const a of artifacts) {
    const normalized = a.relativePath.replace(/\\/g, '/').toLowerCase();
    if (normalized === 'transcript.jsonl') return a;
  }
  return undefined;
}

function findAtifTranscript(
  artifacts: readonly Artifact<unknown>[],
): Artifact<unknown> | undefined {
  for (const a of artifacts) {
    const normalized = a.relativePath.replace(/\\/g, '/').toLowerCase();
    if (normalized === 'native/atif-transcript.json') return a;
  }
  return undefined;
}

function findModels(
  artifacts: readonly Artifact<unknown>[],
): { parsed: ParseDevinModelsResult; text?: string } | undefined {
  for (const a of artifacts) {
    const normalized = a.relativePath.replace(/\\/g, '/').toLowerCase();
    if (normalized === 'native/models.json') {
      const text = toText(a.content);
      if (!text) return undefined;
      try {
        const parsed: unknown = JSON.parse(text);
        return { parsed: parseDevinModelsJson(parsed), text };
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

function findModelsRaw(artifacts: readonly Artifact<unknown>[]): string | undefined {
  for (const a of artifacts) {
    const normalized = a.relativePath.replace(/\\/g, '/').toLowerCase();
    if (normalized === 'native/models-list.raw.json') return toText(a.content);
  }
  return undefined;
}

function findSchemaDescriptor(
  artifacts: readonly Artifact<unknown>[],
): ReturnType<typeof parseSchemaDescriptor> | undefined {
  for (const a of artifacts) {
    const normalized = a.relativePath.replace(/\\/g, '/').toLowerCase();
    if (normalized === 'native/schema-descriptor.json') {
      const text = toText(a.content);
      if (!text) return undefined;
      try {
        const parsed: unknown = JSON.parse(text);
        return parseSchemaDescriptor(parsed) ?? undefined;
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

function findPlan(artifacts: readonly Artifact<unknown>[]): string | undefined {
  for (const a of artifacts) {
    const normalized = a.relativePath.replace(/\\/g, '/').toLowerCase();
    if (/^plans\/plan-[^/]+\.md$/.test(normalized)) return toText(a.content);
  }
  return undefined;
}

function sessionLine(lines: DevinJsonlParseResult['lines']): DevinSessionLine | undefined {
  for (const line of lines) {
    if (line.type === 'session') return line;
  }
  return undefined;
}

function messageLines(lines: DevinJsonlParseResult['lines']): DevinMessageLine[] {
  const result: DevinMessageLine[] = [];
  for (const line of lines) {
    if (line.type === 'message') result.push(line);
  }
  return result;
}

function toolCallLines(lines: DevinJsonlParseResult['lines']): DevinToolCallLine[] {
  const result: DevinToolCallLine[] = [];
  for (const line of lines) {
    if (line.type === 'tool_call') result.push(line);
  }
  return result;
}

function promptLines(lines: DevinJsonlParseResult['lines']): DevinPromptLine[] {
  const result: DevinPromptLine[] = [];
  for (const line of lines) {
    if (line.type === 'prompt') result.push(line);
  }
  return result;
}

function mainChainIdNumber(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function buildMessageTree(messages: readonly DevinMessageLine[]): Map<number, DevinMessageLine[]> {
  const children = new Map<number, DevinMessageLine[]>();
  for (const message of messages) {
    const parent = message.parentNodeId ?? -1;
    const list = children.get(parent) ?? [];
    list.push(message);
    children.set(parent, list);
  }
  for (const list of children.values()) {
    list.sort((a, b) => a.nodeId - b.nodeId);
  }
  return children;
}

function findRootIds(messages: readonly DevinMessageLine[]): number[] {
  const all = new Set(messages.map((m) => m.nodeId));
  const roots: number[] = [];
  for (const message of messages) {
    if (message.parentNodeId === null || !all.has(message.parentNodeId)) {
      roots.push(message.nodeId);
    }
  }
  return roots.sort((a, b) => a - b);
}

function buildMainChain(
  messages: readonly DevinMessageLine[],
  mainChainId: number | undefined,
): { chain: number[]; leaf: number } {
  const byId = new Map(messages.map((m) => [m.nodeId, m]));
  const children = buildMessageTree(messages);
  const roots = findRootIds(messages);

  function pathToLeaf(leaf: number): number[] {
    const path: number[] = [];
    let current: number | undefined = leaf;
    while (current !== undefined && byId.has(current)) {
      path.unshift(current);
      const message = byId.get(current);
      current = message?.parentNodeId ?? undefined;
    }
    return path;
  }

  function defaultLeaf(): number {
    if (mainChainId !== undefined && byId.has(mainChainId)) return mainChainId;
    const allChildren = new Set<number>();
    for (const list of children.values()) {
      for (const child of list) allChildren.add(child.nodeId);
    }
    const leaves = messages.filter((m) => !allChildren.has(m.nodeId));
    if (leaves.length === 0) return roots[0] ?? 0;
    leaves.sort((a, b) => a.nodeId - b.nodeId);
    return leaves[leaves.length - 1].nodeId;
  }

  const leaf = mainChainId !== undefined && byId.has(mainChainId) ? mainChainId : defaultLeaf();
  const chain = pathToLeaf(leaf);
  return { chain, leaf };
}

/**
 * Deduplicates `message_nodes` rows that represent the same logical message
 * twice under two different `node_id`s (DS-B28 (#294) finding #4, real
 * example: `shadow-collar` nodes 249/250 — a "plain" copy with `metadata:
 * null` and an "annotated" copy carrying `summarized_from`/
 * `num_tokens_preceding`/`is_system_prefix`, same `chat_message.message_id`,
 * same content). Left unfixed, both copies survive into `orderedMessages`
 * and each gets its own `turnOrdinal`/message count — this is the fix.
 *
 * Grouped by `messageId()` (the real `chat_message.message_id`, falling
 * back to a synthetic `node-<id>` when absent — the same key
 * `session-spine.ts` already uses for `sourceEventId`). Within a group with
 * more than one member, the entry carrying `parsedMetadata` is kept
 * (strictly more information — never discard the more complete record,
 * per `missing-is-never-zero`'s spirit); ties (including "neither has
 * metadata") break on the lower `nodeId` for determinism. Every dropped
 * duplicate's `nodeId` is redirected to the kept entry's `nodeId` in every
 * OTHER message's `parentNodeId` field, so a hypothetical future child of a
 * dropped duplicate stays correctly attached to the tree rather than
 * becoming a spurious orphan root.
 */
function groupByMessageId(messages: readonly DevinMessageLine[]): Map<string, DevinMessageLine[]> {
  const groups = new Map<string, DevinMessageLine[]>();
  for (const message of messages) {
    const id = messageId(message);
    const bucket = groups.get(id);
    bucket ? bucket.push(message) : groups.set(id, [message]);
  }
  return groups;
}

/** Picks one canonical message per `messageId()` group: the entry carrying
 * `parsedMetadata` (strictly more information), tie-broken by lower
 * `nodeId`. Returns the kept node ids plus a `droppedNodeId -> canonicalNodeId`
 * redirect map for every other group member. */
function resolveCanonicalNodes(groups: Map<string, DevinMessageLine[]>): {
  keepNodeIds: Set<number>;
  redirect: Map<number, number>;
} {
  const keepNodeIds = new Set<number>();
  const redirect = new Map<number, number>();
  for (const group of groups.values()) {
    if (group.length === 1) {
      keepNodeIds.add(group[0].nodeId);
      continue;
    }
    const sorted = [...group].sort((a, b) => {
      const aRank = a.parsedMetadata !== null ? 0 : 1;
      const bRank = b.parsedMetadata !== null ? 0 : 1;
      return aRank !== bRank ? aRank - bRank : a.nodeId - b.nodeId;
    });
    keepNodeIds.add(sorted[0].nodeId);
    for (const duplicate of sorted.slice(1)) redirect.set(duplicate.nodeId, sorted[0].nodeId);
  }
  return { keepNodeIds, redirect };
}

function dedupeByMessageId(messages: readonly DevinMessageLine[]): DevinMessageLine[] {
  const { keepNodeIds, redirect } = resolveCanonicalNodes(groupByMessageId(messages));
  if (redirect.size === 0) return [...messages];
  return messages
    .filter((m) => keepNodeIds.has(m.nodeId))
    .map((m) =>
      m.parentNodeId !== null && redirect.has(m.parentNodeId)
        ? { ...m, parentNodeId: redirect.get(m.parentNodeId) as number }
        : m,
    );
}

export interface OrderMessagesResult {
  /** The session's true main-conversation sequence, deduplicated, in
   * `turnOrdinal`-safe order. */
  ordered: DevinMessageLine[];
  /**
   * Every message reachable from a root OTHER than the session's true root
   * (DS-B28 (#294) finding #5, real example: `foremost-hide`'s nodes
   * 316-322 — a `pr-review` sub-agent's own disconnected conversation,
   * `parent_node_id: null` and never linking back to the `run_subagent`
   * call site). Grouped per-tree in the same DFS order `ordered` uses, trees
   * concatenated in ascending root-`nodeId` order for determinism. Never
   * merged into `ordered` (that's the corruption this fixes) and never
   * silently dropped — callers that don't yet have a confident correlation
   * to a specific `run_subagent` call still surface these as generic,
   * unattributed evidence (see `subagent-evidence.ts`).
   */
  detached: DevinMessageLine[];
}

interface MessageTreeContext {
  byId: Map<number, DevinMessageLine>;
  children: Map<number, DevinMessageLine[]>;
  chainSet: Set<number>;
  visited: Set<number>;
}

/** DFS from `nodeId` into `sink`, biasing towards the main-chain child first
 * (when `onMainChain`) — the whole subtree lands in `sink` either way. */
function visitSubtree(
  ctx: MessageTreeContext,
  nodeId: number,
  onMainChain: boolean,
  sink: DevinMessageLine[],
): void {
  if (ctx.visited.has(nodeId)) return;
  ctx.visited.add(nodeId);
  const message = ctx.byId.get(nodeId);
  if (message) sink.push(message);
  const childList = ctx.children.get(nodeId) ?? [];
  const mainChainChild = onMainChain
    ? childList.find((c) => ctx.chainSet.has(c.nodeId))
    : undefined;
  if (mainChainChild) visitSubtree(ctx, mainChainChild.nodeId, true, sink);
  for (const child of childList) {
    if (child !== mainChainChild) visitSubtree(ctx, child.nodeId, false, sink);
  }
}

function buildMessageTreeContext(
  messages: readonly DevinMessageLine[],
  chain: number[],
): MessageTreeContext {
  return {
    byId: new Map(messages.map((m) => [m.nodeId, m])),
    children: buildMessageTree(messages),
    chainSet: new Set(chain),
    visited: new Set<number>(),
  };
}

/**
 * `chain[0]` (from `buildMainChain`) is the session's one true root: it
 * walks `parentNodeId` up from the resolved leaf until it runs out of
 * in-batch ancestors, so it necessarily terminates at a root (see
 * `findRootIds`). Every OTHER root's whole subtree goes to `detached`,
 * never spliced into `ordered` purely by `node_id` magnitude (the bug).
 */
function orderMessages(
  rawMessages: readonly DevinMessageLine[],
  mainChainId: number | undefined,
): OrderMessagesResult {
  if (rawMessages.length === 0) return { ordered: [], detached: [] };
  const messages = dedupeByMessageId(rawMessages);
  const { chain } = buildMainChain(messages, mainChainId);
  const ctx = buildMessageTreeContext(messages, chain);

  const ordered: DevinMessageLine[] = [];
  const detached: DevinMessageLine[] = [];
  const trueRootId = chain[0];
  if (trueRootId !== undefined) visitSubtree(ctx, trueRootId, true, ordered);
  for (const rootId of findRootIds(messages)) {
    if (rootId !== trueRootId) visitSubtree(ctx, rootId, false, detached);
  }
  return { ordered, detached };
}

function makeIssue(
  code: string,
  message: string,
  severity: 'warning' | 'fatal' | 'recoverable',
  path?: string,
): Issue {
  return { code, severity, message, provenance: path ? { path } : undefined };
}

export function parseDevinBundle(bundle: UnknownArtifactBundle): DevinParsedBundle {
  const warnings: Issue[] = [];
  const rootArtifact = findRootTranscript(bundle.artifacts);
  const rootTranscriptText = rootArtifact ? toText(rootArtifact.content) : undefined;
  const parsedJsonl: DevinJsonlParseResult = rootTranscriptText
    ? parseDevinJsonlText(rootTranscriptText)
    : { lines: [], warnings: [] };

  for (const w of parsedJsonl.warnings) {
    warnings.push(
      makeIssue('jsonl_parse_warning', `${w.reason}: ${w.rawLine}`, 'warning', 'transcript.jsonl'),
    );
  }

  const atifArtifact = findAtifTranscript(bundle.artifacts as readonly Artifact<unknown>[]);
  let atif: AtifTranscript | undefined;
  if (atifArtifact) {
    const text = toText(atifArtifact.content);
    if (text) {
      try {
        const parsed: unknown = JSON.parse(text);
        const result = parseAtifTranscript(parsed);
        if (result.ok) {
          atif = result.transcript;
        } else {
          warnings.push(
            makeIssue('atif_parse_warning', result.reason, 'warning', atifArtifact.relativePath),
          );
        }
      } catch {
        warnings.push(
          makeIssue('atif_parse_warning', 'invalid JSON', 'warning', atifArtifact.relativePath),
        );
      }
    }
  }

  const modelsResult = findModels(bundle.artifacts as readonly Artifact<unknown>[]);
  const models = modelsResult?.parsed.models ?? [];
  const modelsRaw = findModelsRaw(bundle.artifacts as readonly Artifact<unknown>[]);
  const schemaDescriptor = findSchemaDescriptor(bundle.artifacts as readonly Artifact<unknown>[]);
  const planContent = findPlan(bundle.artifacts as readonly Artifact<unknown>[]);

  const session = sessionLine(parsedJsonl.lines);
  const mainChainId = session ? mainChainIdNumber(session.mainChainId) : undefined;
  const { ordered: orderedMessages, detached: detachedMessages } = orderMessages(
    messageLines(parsedJsonl.lines),
    mainChainId,
  );

  return {
    rootTranscriptText,
    parsedJsonl,
    atif,
    models,
    modelsRaw,
    schemaDescriptor,
    planContent,
    sessionLine: session,
    orderedMessages,
    detachedMessages,
    toolCalls: toolCallLines(parsedJsonl.lines),
    prompts: promptLines(parsedJsonl.lines),
    warnings,
  };
}
