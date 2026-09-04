import type { DevinMessageNodeRow, DevinToolCallStateRow } from './types.js';

/**
 * Synthesizes `message`-shaped `message_nodes` rows for a sub-agent's
 * prompt and result, per DS-B28 (#294) design item 4. These are NOT real
 * `sessions.db` rows — Devin never persists an independent row for a
 * sub-agent's own first turn (finding #6) or, for a background sub-agent,
 * a row tagged with its `agent_id` that actually carries the report
 * (finding #3). This module reconstructs both from real, verbatim data
 * already present elsewhere (the parent's `run_subagent` tool call and the
 * correct source node per the foreground/background asymmetry) and hands
 * the result back as ordinary `DevinMessageNodeRow`s so the caller
 * (`jsonl-writer.ts`) can emit them through the exact same `messageLine()`
 * used for real rows — no bespoke line format (acceptance criterion).
 *
 * This module deliberately does its own minimal JSON parsing rather than
 * depending on `@lucasschirm/sal-devin-session-parser`'s ACP parser: this
 * package (`devin-session-sync`) has zero runtime dependencies by design
 * (see `package.json`), mirroring the extractor's existing lightweight
 * `chat_message` string-matching in `jsonl-writer.ts`'s
 * `referencesToolCallId`.
 */

const SYNTHETIC_KIND_KEY = 'sal/synthetic_subagent_kind';
const SYNTHETIC_RAWINPUT_PROFILE_KEY = 'sal/synthetic_subagent_rawinput_profile';
const SYNTHETIC_TOOL_CALL_ID_KEY = 'sal/synthetic_subagent_tool_call_id';
const SYNTHETIC_SOURCE_NODE_ID_KEY = 'sal/synthetic_subagent_source_node_id';
const SYNTHETIC_IS_BACKGROUND_KEY = 'sal/synthetic_subagent_is_background';

const SUBAGENT_TAG_KEYS = [
  'subagent/agent_id',
  'subagent/profile_name',
  'subagent/model',
  'subagent/chain_node_id',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJsonRecord(json: string | null): Record<string, unknown> | null {
  if (!json) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function inferenceToolName(record: Record<string, unknown>): string | null {
  const meta = record._meta;
  if (!isRecord(meta)) return null;
  const value = meta['cognition.ai/inferenceToolName'];
  return typeof value === 'string' ? value : null;
}

interface RunSubagentInvocation {
  toolCallId: string;
  task: string | null;
  profile: string | null;
}

/** Finds every `run_subagent` ACP tool call, sourcing the real, verbatim
 * task text from `rawInput.task` (finding #6) — never synthesized. */
function findRunSubagentInvocations(
  toolCalls: readonly DevinToolCallStateRow[],
): RunSubagentInvocation[] {
  const invocations: RunSubagentInvocation[] = [];
  for (const toolCall of toolCalls) {
    const record = parseJsonRecord(toolCall.tool_call_json);
    if (!record || typeof record.toolCallId !== 'string') continue;
    if (inferenceToolName(record) !== 'run_subagent') continue;
    const rawInput = isRecord(record.rawInput) ? record.rawInput : null;
    invocations.push({
      toolCallId: record.toolCallId,
      task: rawInput && typeof rawInput.task === 'string' ? rawInput.task : null,
      profile: rawInput && typeof rawInput.profile === 'string' ? rawInput.profile : null,
    });
  }
  return invocations;
}

/** `chat_message.metadata.extensions`, parsed with the extractor's own
 * lightweight parse (mirrors `parseSubagentExtensions` in the parser
 * package's `parse-line.ts`, duplicated here rather than imported per this
 * package's zero-dependency design). */
function chatMessageExtensions(chatMessage: string | null): Record<string, unknown> | null {
  const record = parseJsonRecord(chatMessage);
  if (!record) return null;
  const metadata = record.metadata;
  if (!isRecord(metadata)) return null;
  const extensions = metadata.extensions;
  return isRecord(extensions) ? extensions : null;
}

function messageContent(chatMessage: string | null): string | null {
  const record = parseJsonRecord(chatMessage);
  return record && typeof record.content === 'string' ? record.content : null;
}

function messageRole(chatMessage: string | null): string | null {
  const record = parseJsonRecord(chatMessage);
  return record && typeof record.role === 'string' ? record.role : null;
}

function referencesToolCallId(chatMessage: string | null, toolCallId: string): boolean {
  return chatMessage?.includes(JSON.stringify(toolCallId)) ?? false;
}

interface TaggedNode {
  node: DevinMessageNodeRow;
  agentId: string;
}

/** Every node carrying a real `subagent/agent_id` extension tag. */
function findTaggedNodes(nodes: readonly DevinMessageNodeRow[]): TaggedNode[] {
  const tagged: TaggedNode[] = [];
  for (const node of nodes) {
    const extensions = chatMessageExtensions(node.chat_message);
    const agentId = extensions?.['subagent/agent_id'];
    if (typeof agentId === 'string') tagged.push({ node, agentId });
  }
  return tagged;
}

interface ResultSource {
  node: DevinMessageNodeRow;
  content: string;
  isBackground: boolean;
}

/**
 * Devin's own verbatim template prefix for a background `run_subagent`
 * result's "started" pointer (finding #3's real example:
 * `"Background subagent started with agent_id=55c47591 running in the
 * background."`) — never a real report. Used only to recognize that this
 * tagged node is a pointer, not to derive any content from it.
 */
const BACKGROUND_STARTED_PREFIX = 'Background subagent started';

/**
 * Resolves the node that actually carries the sub-agent's final report
 * text, per finding #3's foreground/background asymmetry:
 * - **foreground**: the tagged node's own `content` IS the report.
 * - **background**: the tagged node is only a "started" pointer. The real
 *   report lives in a LATER, UNTAGGED `system`-role node whose content
 *   begins `<subagent_completion_notification>` and mentions this same
 *   `agent_id` — not the tagged node, and not the intervening
 *   `read_subagent` result (also untagged, also not the report; see the
 *   issue's finding #3 for the full three-node background chain).
 *
 * Returns `null` when no report is recoverable at all — either the
 * `read_subagent` call never completed (finding #5's timeout case; the
 * tagged node is a "started" pointer with no later notification), or the
 * tagged/notification node's content itself couldn't be read. A "started"
 * pointer is never used as a fallback report — that would misrepresent an
 * unfinished background sub-agent as having produced a result.
 */
function findResultSource(
  nodes: readonly DevinMessageNodeRow[],
  tagged: TaggedNode,
): ResultSource | null {
  const notification = nodes.find((n) => {
    if (messageRole(n.chat_message) !== 'system') return false;
    const content = messageContent(n.chat_message);
    if (content === null) return false;
    return (
      content.startsWith('<subagent_completion_notification>') &&
      content.includes(`agent_id=${tagged.agentId}`)
    );
  });
  if (notification) {
    const content = messageContent(notification.chat_message);
    return content !== null ? { node: notification, content, isBackground: true } : null;
  }
  const taggedContent = messageContent(tagged.node.chat_message);
  if (taggedContent === null || taggedContent.startsWith(BACKGROUND_STARTED_PREFIX)) {
    return null;
  }
  return { node: tagged.node, content: taggedContent, isBackground: false };
}

/** Carries the four real `subagent/*` tag values from a tagged node
 * verbatim (never re-derived/guessed) into a synthetic line's extensions. */
function realSubagentTagExtensions(chatMessage: string | null): Record<string, unknown> {
  const extensions = chatMessageExtensions(chatMessage);
  const out: Record<string, unknown> = {};
  if (!extensions) return out;
  for (const key of SUBAGENT_TAG_KEYS) {
    if (key in extensions) out[key] = extensions[key];
  }
  return out;
}

/**
 * `row_id: -1` -- not a real sessions.db row_id (those are always
 * positive); there is no underlying row to reference for a synthesized
 * line, so this is a clearly out-of-band sentinel, never mistaken for real
 * DB data.
 *
 * `subagentExtensions` (real `subagent/*` keys only) is embedded under
 * `chat_message.metadata.extensions` -- the SAME location real Devin data
 * uses (see `DevinSubagentExtensions` in the parser package's `types.ts`)
 * -- so a consumer reading `DevinMessageLine.subagent` picks these up
 * through the exact same, unmodified parsing path as a real
 * subagent-tagged node. Never mixed with `syntheticBookkeeping`:
 * `parseSubagentExtensions` only recognizes the 4 real keys, so anything
 * else placed there would silently vanish, not "pass through".
 *
 * `syntheticBookkeeping` (our own "how was this line constructed" data,
 * never real Devin data) goes in the row-level `message_nodes.metadata`
 * column instead, written FLAT (matching the real column's shape -- see
 * `DevinMessageNodeMetadata`'s parsing in `parse-line.ts`: `extensions` is
 * a DERIVED field the parser computes by collecting whatever isn't
 * `summarized_from`/`num_tokens_preceding`/`is_system_prefix`, never a
 * literal `extensions` key in the raw JSON). This is the layer
 * `subagent-evidence.ts` reads (via `parsedMetadata.extensions`) to
 * recognize a synthetic line.
 */
function buildSyntheticNodeRow(
  base: DevinMessageNodeRow,
  nodeId: number,
  parentNodeId: number | null,
  role: 'user' | 'assistant',
  content: string,
  subagentExtensions: Record<string, unknown>,
  syntheticBookkeeping: Record<string, unknown>,
): DevinMessageNodeRow {
  return {
    row_id: -1,
    session_id: base.session_id,
    node_id: nodeId,
    parent_node_id: parentNodeId,
    chat_message: JSON.stringify({ role, content, metadata: { extensions: subagentExtensions } }),
    created_at: base.created_at,
    metadata: JSON.stringify(syntheticBookkeeping),
  };
}

/**
 * Builds the synthetic sub-agent prompt/result `DevinMessageNodeRow`s for
 * every `run_subagent` invocation in a session that has a correlated
 * result. Deterministic: node ids are derived from the tagged node's own
 * `node_id`, offset from `Number.MAX_SAFE_INTEGER` so they can never
 * collide with a real Devin node id (always a modest positive integer in
 * practice).
 *
 * Deliberately NOT negative: `devin-transformer`'s `orderMessages` picks
 * its default main-conversation root as the *lowest*-`node_id` root when a
 * session has no `main_chain_id` (a real, pre-existing fallback, unrelated
 * to this issue). A negative synthetic id would then always win that
 * tie-break over every real (positive) root, silently misclassifying the
 * real conversation as "detached" and promoting synthetic sub-agent lines
 * to "main" — the exact class of node_id-magnitude corruption DS-B28
 * (#294) finding #5 already documents as a bug. Using ids far above any
 * real id instead ensures a synthetic root can never win that (or any
 * other ascending-id) tie-break.
 *
 * Invocations are emitted in ascending tagged-node-id order. A
 * `run_subagent` call with no correlated tagged node yet (e.g. still
 * running) is skipped entirely -- nothing to synthesize. A call with a
 * correlated node but no recoverable report (finding #5's timeout case)
 * still gets its prompt line (the task is real, verbatim data) but no
 * result line (never fabricated).
 */
const SYNTHETIC_NODE_ID_CEILING = Number.MAX_SAFE_INTEGER;

interface Match {
  invocation: RunSubagentInvocation;
  tagged: TaggedNode;
}

/** Every `run_subagent` invocation with a real task and a correlated tagged
 * node, sorted deterministically by the tagged node's `node_id`. */
function findMatches(
  nodes: readonly DevinMessageNodeRow[],
  toolCalls: readonly DevinToolCallStateRow[],
): Match[] {
  const tagged = findTaggedNodes(nodes);
  const matches: Match[] = [];
  for (const invocation of findRunSubagentInvocations(toolCalls)) {
    if (invocation.task === null) continue;
    const match = tagged.find((t) =>
      referencesToolCallId(t.node.chat_message, invocation.toolCallId),
    );
    if (match) matches.push({ invocation, tagged: match });
  }
  return matches.sort((a, b) => a.tagged.node.node_id - b.tagged.node.node_id);
}

function buildPromptNode(match: Match, promptNodeId: number): DevinMessageNodeRow {
  return buildSyntheticNodeRow(
    match.tagged.node,
    promptNodeId,
    null,
    'user',
    match.invocation.task as string,
    { 'subagent/agent_id': match.tagged.agentId },
    {
      [SYNTHETIC_KIND_KEY]: 'prompt',
      [SYNTHETIC_RAWINPUT_PROFILE_KEY]: match.invocation.profile,
      [SYNTHETIC_TOOL_CALL_ID_KEY]: match.invocation.toolCallId,
    },
  );
}

function buildResultNode(
  nodes: readonly DevinMessageNodeRow[],
  match: Match,
  resultNodeId: number,
  promptNodeId: number,
): DevinMessageNodeRow | null {
  const result = findResultSource(nodes, match.tagged);
  if (result === null) return null;
  return buildSyntheticNodeRow(
    match.tagged.node,
    resultNodeId,
    promptNodeId,
    'assistant',
    result.content,
    realSubagentTagExtensions(match.tagged.node.chat_message),
    {
      [SYNTHETIC_KIND_KEY]: 'result',
      [SYNTHETIC_SOURCE_NODE_ID_KEY]: result.node.node_id,
      [SYNTHETIC_IS_BACKGROUND_KEY]: result.isBackground,
    },
  );
}

export function buildSubagentSyntheticNodes(
  nodes: readonly DevinMessageNodeRow[],
  toolCalls: readonly DevinToolCallStateRow[],
): DevinMessageNodeRow[] {
  const synthetic: DevinMessageNodeRow[] = [];
  for (const match of findMatches(nodes, toolCalls)) {
    const promptNodeId = SYNTHETIC_NODE_ID_CEILING - match.tagged.node.node_id * 2;
    const resultNodeId = SYNTHETIC_NODE_ID_CEILING - match.tagged.node.node_id * 2 - 1;
    synthetic.push(buildPromptNode(match, promptNodeId));
    const resultNode = buildResultNode(nodes, match, resultNodeId, promptNodeId);
    if (resultNode) synthetic.push(resultNode);
  }
  return synthetic;
}
