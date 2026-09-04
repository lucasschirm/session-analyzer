/**
 * Typed shapes for `devin-session-jsonl/v1` — the line format produced by
 * the DS-F2 (#157) extractor (`packages/plugins/devin-session-sync/src/extractor`).
 *
 * Every line is `{ type, ts, order, ...rawRow }` (see that package's
 * `DevinJsonlLine`). This module re-declares the shape locally rather than
 * importing it: parser packages under `packages/parsers/*` are dependency-free
 * and never depend on a `packages/plugins/*` package, mirroring
 * `claude-session-parser`'s standalone posture.
 */

import type { DevinNormalizedRole } from '../message/role-map.js';
import type { AcpToolCall, AcpToolCallUpdate } from '../tool-call/acp-parse.js';

/** Discriminator for a `devin-session-jsonl/v1` line. */
export type DevinJsonlLineType = 'session' | 'message' | 'tool_call' | 'prompt';

/** Raw, untyped `devin-session-jsonl/v1` line as read off disk. */
export interface RawDevinJsonlLine {
  type?: unknown;
  ts?: unknown;
  order?: unknown;
  [rawField: string]: unknown;
}

/** A parsed `sessions` row line: current-state, re-emitted on every pass. */
export interface DevinSessionLine {
  type: 'session';
  ts: number | null;
  order: number;
  id: string;
  workingDirectory: string | null;
  backendType: string | null;
  model: string | null;
  agentMode: string | null;
  createdAt: number | null;
  lastActivityAt: number | null;
  title: string | null;
  mainChainId: string | null;
  cogsJson: string | null;
  workspaceDirs: string | null;
  hidden: number | null;
  metadata: string | null;
}

/**
 * Parsed shape of the `message_nodes.metadata` JSON column.
 *
 * This is a **different namespace** from `chat_message.metadata` — the
 * nested object embedded inside the `chat_message` column's own JSON (e.g.
 * carrying `generation_model`/token counts for a model invocation, or
 * `extensions['devin-rs/summary']` for a compaction's continuation node).
 * Never conflate the two: `DevinMessageNodeMetadata` describes the row-level
 * `message_nodes.metadata` column only.
 */
export interface DevinMessageNodeMetadata {
  /**
   * Non-null iff this node is a compaction-produced output node
   * summarizing an earlier conversation; the value is the `node_id` of the
   * last pre-compaction node (the compaction boundary anchor). `null` on
   * every ordinary (non-compaction) node.
   */
  summarizedFrom: number | null;
  /**
   * Context-size checkpoint, when populated. Not compaction-exclusive: seen
   * on ordinary turn nodes too, and `null` on a compaction's own output
   * nodes (a post-compaction token count is not derivable from this field).
   */
  numTokensPreceding: number | null;
  /** `true` on a synthetic system-prefix node (e.g. the Summarizer prompt). */
  isSystemPrefix: boolean | null;
  /**
   * Passthrough bag for any other keys under `metadata` (e.g.
   * `compact/prior_node_ids`, which is unrelated node-forest-rewrite
   * bookkeeping present throughout a session, not a compaction signal —
   * see `.agents/rules` discovery notes on DS-B27). Carried verbatim,
   * unclassified.
   */
  extensions?: Record<string, unknown>;
}

/**
 * Parsed shape of the four `subagent/*` extension keys Devin CLI stamps on a
 * sub-agent-related `message_nodes` row, read from
 * `chat_message.metadata.extensions` (NOT the row-level `message_nodes.metadata`
 * column parsed by `DevinMessageNodeMetadata` above — see that type's own
 * doc comment on the two-namespace distinction). Confirmed real, populated
 * data (DS-B28 (#294) finding #2); each field stays `null` when the source
 * extensions bag doesn't carry it, never a fabricated default
 * (`missing-is-never-zero`).
 */
export interface DevinSubagentExtensions {
  /** `subagent/agent_id` — the sub-agent invocation's opaque id. Confirmed
   * globally unique-in-practice across every sample checked during DS-B28's
   * research, but Devin gives no structural uniqueness guarantee (it's an
   * opaque short hex token) — this is a residual identity risk, not a
   * guarantee, per `.agents/rules/manifest-backed-classification.md`. */
  agentId: string | null;
  /** `subagent/profile_name` — a display LABEL (e.g. `"Explore"`), never an
   * identifier. Per `.agents/rules/component-identity-not-display-name.md`,
   * pair it with the real `rawInput.profile` value (e.g. `"subagent_explore"`,
   * already captured by DS-F11 (#288)) rather than keying on this alone. */
  profileName: string | null;
  /** `subagent/model` — always observed as a coarse label (e.g.
   * `"Subagent Default"`), never a resolved model id. Must never be
   * upgraded/guessed into a resolved model identifier
   * (`.agents/rules/missing-is-never-zero.md`). */
  model: string | null;
  /**
   * `subagent/chain_node_id`, captured raw. **Its exact semantics are NOT
   * confirmed** (DS-B28 (#294) finding #2): on a real observed foreground
   * result (node 178), this was `176` — neither the calling `run_subagent`
   * node's id (`177`) nor that node's own parent (`90`). Do not treat this
   * as a back-pointer, a parent reference, or any other load-bearing
   * correlation without dedicated further verification; it is surfaced here
   * as raw data only, per `missing-is-never-zero`'s spirit of never
   * presenting a guess as fact.
   */
  chainNodeId: number | null;
}

/** A parsed `message_nodes` row line. */
export interface DevinMessageLine {
  type: 'message';
  ts: number | null;
  order: number;
  rowId: number;
  sessionId: string;
  nodeId: number;
  parentNodeId: number | null;
  /** Normalized `chat_message.role`; `'unknown'` for an unrecognized value. */
  role: DevinNormalizedRole;
  /** The raw role string when present but unrecognized; `null` otherwise. */
  rawRole: string | null;
  /** The parsed `chat_message` JSON payload, or `null` if absent/unparseable. */
  chatMessage: unknown;
  createdAt: number | null;
  /** Raw, unparsed `message_nodes.metadata` JSON string. */
  metadata: string | null;
  /** `metadata`, parsed and typed; `null` if absent/unparseable/not an object. */
  parsedMetadata: DevinMessageNodeMetadata | null;
  /**
   * `chat_message.metadata.extensions`' four `subagent/*` keys, parsed
   * wherever present (DS-B28 (#294) design item 1) — `null` when this node
   * carries none of them (the overwhelming majority of ordinary nodes).
   */
  subagent: DevinSubagentExtensions | null;
}

/** A parsed `tool_call_state` row line: no timestamp column exists upstream. */
export interface DevinToolCallLine {
  type: 'tool_call';
  ts: null;
  order: number;
  rowId: number;
  sessionId: string;
  toolCallId: string;
  /** Parsed ACP `ToolCall` shape from `tool_call_json`; `null` if absent/unparseable. */
  call: AcpToolCall | null;
  /** Parsed status payload from `tool_call_update_json`; `null` if absent/unparseable. */
  update: AcpToolCallUpdate | null;
}

/** A parsed `prompt_history` row line. */
export interface DevinPromptLine {
  type: 'prompt';
  ts: number | null;
  order: number;
  id: number;
  sessionId: string;
  content: string | null;
  isShell: boolean | null;
}

export type DevinParsedLine =
  | DevinSessionLine
  | DevinMessageLine
  | DevinToolCallLine
  | DevinPromptLine;

/** One line that failed `JSON.parse` or shape validation: logged and skipped. */
export interface DevinJsonlParseWarning {
  lineNumber: number;
  reason: string;
  /** The raw source text of the offending line, truncated for diagnostics. */
  rawLine: string;
}

export interface DevinJsonlParseResult {
  lines: DevinParsedLine[];
  warnings: DevinJsonlParseWarning[];
}
