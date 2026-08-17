# Parser Type Reference

This document catalogs every return type for each public function exported by `@lucasschirm/sal-claude-session-parser`.

All parsers are pure, synchronous, and **never throw**. Malformed input is reported in the `parseErrors: ParseError[]` array on the result. Config parsers additionally use a `kind` discriminant string so consumers can safely branch on the returned object.

The runtime package has zero dependencies and zero filesystem access, so all signatures take already-loaded `string` content.

---

## Common primitives

These types appear in many of the result shapes below.

```ts
interface ParseError {
  line?: number;
  uuid?: string;
  code: string;
  message: string;
  rawSnippet?: string;
}

interface ParseOptions {
  retainRaw?: boolean;
  maxBlobBytes?: number;
  skipTimelines?: boolean;
}

type ClaudeScope = 'user' | 'project' | 'local' | 'managed' | 'plugin' | 'unknown';

interface AvailabilityEvent<A extends string> {
  action: A;
  entryUuid?: string;
  lineNumber: number;
  timestampMs?: number;
  isInitial?: boolean;
}
```

---

## Detection

### `detectClaudeCode`

```ts
detectClaudeCode(content: string): boolean
```

Returns `true` if the bounded prefix of `content` looks like a Claude Code JSONL transcript, `false` otherwise.

### `detectClaudeCodeArtifact`

```ts
detectClaudeCodeArtifact(input: {
  content: string;
  fileName?: string;
  relativePath?: string;
}): ClaudeCodeArtifactKind

type ClaudeCodeArtifactKind =
  | 'session-transcript'
  | 'subagent-transcript'
  | 'subagent-meta'
  | 'settings'
  | 'mcp-config'
  | 'agent-definition'
  | 'skill-definition'
  | 'rule-definition'
  | 'plugin-marketplace'
  | 'unknown';
```

Returns the classified artifact kind. Classification is schema-based; `fileName`/`relativePath` are only used as tiebreakers.

---

## Session transcript

### `parseSessionTranscript`

```ts
parseSessionTranscript(content: string, options?: ParseOptions): ClaudeCodeSession
```

The main transcript parser. It returns a fully-typed, folded view of one Claude Code `session.jsonl` or `subagents/agent-<id>.jsonl` file.

```ts
interface ClaudeCodeSession {
  sessionId?: string;
  aiTitle?: string;
  slug?: string;
  agentName?: string;
  cwd?: string;
  gitBranch?: string;
  cliVersions: string[];
  isSidechain: boolean;
  agentId?: string; // only on subagent transcripts

  entries: ClaudeCodeEntry[];

  aggregateUsage: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    models: Record<string, {
      inputTokens: number;
      outputTokens: number;
      cacheCreationTokens: number;
      cacheReadTokens: number;
    }>;
  };

  tools: ToolAvailabilityRecord[];
  skills: SkillAvailabilityRecord[];
  agents: AgentAvailabilityRecord[];
  rules: RuleRecord[];
  mcpServers: McpServerRecord[];
  permissionModes: PermissionModeChange[];
  hooks: HookEventRecord[];
  compactions: CompactionRecord[];
  prLinks: PrLinkRecord[];
  subagentLaunches: SubagentLaunchRecord[];

  parseErrors: ParseError[];
  unknownTypes: Record<string, number>;

  // Populated only by the builder (see below)
  settings?: ClaudeCodeSettings[];
  subagentSessions?: Record<string, ClaudeCodeSession>;
}
```

`ClaudeCodeEntry` is a discriminated union of the native transcript entry kinds:

```ts
type ClaudeCodeEntry =
  | AssistantEntry
  | UserEntry
  | SystemEntry
  | AttachmentEntry
  | ModeEntry
  | PermissionModeEntry
  | AiTitleEntry
  | LastPromptEntry
  | AgentNameEntry
  | PrLinkEntry
  | BridgeSessionEntry
  | QueueOperationEntry
  | FileHistorySnapshotEntry
  | FileHistoryDeltaEntry
  | RelocatedEntry
  | WorktreeStateEntry
  | SummaryEntry
  | UnknownEntry;
```

Relevant sub-shapes:

```ts
interface ClaudeCodeEntryBase {
  uuid: string;
  parentUuid: string | null;
  timestamp: string;
  timestampMs: number;
  isSidechain: boolean;
  sessionId: string;
  session_id?: string;
  cwd?: string;
  version?: string;
  gitBranch?: string;
  slug?: string;
  userType?: string;
  entrypoint?: string;
  agentId?: string;
  lineNumber: number;
  raw?: Record<string, unknown>;
}

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking?: string; signature?: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: unknown; is_error?: boolean; truncated?: TruncationSignal }
  | { type: string; [k: string]: unknown };

interface AssistantEntry extends ClaudeCodeEntryBase {
  type: 'assistant';
  requestId?: string;
  effort?: string;
  message: {
    id?: string;
    model?: string;
    role: 'assistant';
    content: ContentBlock[];
    usage?: {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens: number;
      cache_read_input_tokens: number;
      cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number };
      output_tokens_details?: { thinking_tokens?: number };
      iterations?: Array<Record<string, unknown>>;
    };
    stop_reason?: string;
    diagnostics?: { cache_miss_reason?: { type?: string; cache_missed_input_tokens?: number } };
  };
  attributionSkill?: string;
  attributionPlugin?: string;
  attributionMcpServer?: string;
  attributionMcpTool?: string;
  attributionAgent?: string;
  error?: unknown;
  isApiErrorMessage?: boolean;
  apiErrorStatus?: number;
}

interface UserEntry extends ClaudeCodeEntryBase {
  type: 'user';
  message: { role: 'user'; content: string | ContentBlock[] };
  isMeta?: boolean;
  promptId?: string;
  promptSource?: string;
  origin?: string;
  permissionMode?: string;
  toolUseResult?: ToolUseResult;
  sourceToolUseID?: string;
  sourceToolAssistantUUID?: string;
  toolDenialKind?: string;
  toolEndsTurn?: boolean;
  isCompactSummary?: boolean;
  isVisibleInTranscriptOnly?: boolean;
  interruptedByShutdown?: boolean;
  interruptedMessageId?: string;
  userFeedback?: unknown;
  queuePriority?: unknown;
  classifierMetaLines?: unknown;
}

interface SystemEntry extends ClaudeCodeEntryBase {
  type: 'system';
  subtype:
    | 'turn_duration'
    | 'stop_hook_summary'
    | 'away_summary'
    | 'local_command'
    | 'bridge_status'
    | 'compact_boundary'
    | 'scheduled_task_fire'
    | 'agents_killed'
    | 'model_refusal_fallback'
    | (string & {});
  content?: string;
  level?: string;
  isMeta?: boolean;
  toolUseID?: string;
  requestId?: string;
  durationMs?: number;
  messageCount?: number;
  hookCount?: number;
  hookInfos?: Array<{ command: string; durationMs?: number }>;
  hookErrors?: unknown[];
  hookAdditionalContext?: unknown[];
  preventedContinuation?: boolean;
  stopReason?: string;
  hasOutput?: boolean;
  url?: string;
  logicalParentUuid?: string;
  compactMetadata?: CompactMetadata;
  pendingBackgroundAgentCount?: number;
  modelRefusalFallback?: ModelRefusalFallback;
}

interface ModelRefusalFallback {
  originalModel: string;
  fallbackModel: string;
  direction?: string;
  scope?: string;
  trigger?: string;
  apiRefusalCategory?: string;
  apiRefusalExplanation?: string;
  retractedMessageUuids?: string[];
  refusedUserMessageUuid?: string;
}

interface ToolUseResult {
  file?: { filePath: string; content: string; numLines: number; totalLines: number; startLine?: number; truncatedByTokenCap?: boolean };
  truncated?: boolean;
  countIsComplete?: boolean;
  numFiles?: number;
  totalMatches?: number;
  filenames?: string[];
  gitOperation?: { commit?: { sha: string; kind: string }; push?: { branch: string }; pr?: { number: number; url: string; action: string } };
  stdout?: string;
  stderr?: string;
  interrupted?: boolean;
  isAsync?: boolean;
  status?: string;
  agentId?: string;
  description?: string;
  prompt?: string;
  resolvedModel?: string;
  totalTokens?: number;
  usage?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
  structuredContent?: unknown;
  [k: string]: unknown;
}
```

Attachment and remaining bookkeeping entry kinds are omitted here for brevity; they are fully typed in `src/types/session.ts`.

---

## Timeline records

These arrays are produced by `parseSessionTranscript` (when `skipTimelines` is not `true`) and describe what was available/used over the course of the session.

```ts
interface ToolAvailabilityRecord {
  tool: string;
  description?: string;
  availability: AvailabilityEvent<'deferred' | 'undeferred' | 'removed' | 'readded' | 'invoked'>[];
  alwaysAvailable: boolean;
  mcpServer?: string;
  mcpToolName?: string;
  invocationCount: number;
  firstInvokedAtMs?: number;
  lastInvokedAtMs?: number;
}

interface SkillAvailabilityRecord {
  name: string;
  pluginPrefix?: string;
  bareName: string;
  description?: string;
  availability: AvailabilityEvent<'listed' | 'delisted' | 'discovered' | 'invoked' | 'expanded'>[];
  sourceDir?: string;
  displayPath?: string;
  qualifiedPath?: string;
  injectedContent?: string;
  invocationCount: number;
  invocations: Array<{ entryUuid: string; toolUseId: string; args?: string; timestampMs: number; launched: boolean }>;
  attributedTurnCount: number;
}

interface AgentAvailabilityRecord {
  agentType: string;
  pluginPrefix?: string;
  availability: AvailabilityEvent<'listed' | 'delisted' | 'mentioned' | 'invoked'>[];
  listingDescription?: string;
  listingTools?: string;
  definition?: AgentDefinition;
  invocations: SubagentLaunchRecord[];
  attributedTurnCount: number;
}

interface SubagentLaunchRecord {
  toolUseId: string;
  entryUuid: string;
  resultEntryUuid?: string;
  agentType: string;
  description?: string;
  prompt?: string;
  model?: string;
  agentId?: string;
  isAsync?: boolean;
  runInBackground?: boolean;
  timestampMs: number;
  totalTokens?: number;
}

type RuleScope = 'Project' | 'User' | 'Local' | 'Managed' | 'Unknown';
type RuleInjectionStatus = 'injected' | 'available' | 'unknown';

interface RuleRecord {
  path: string;
  displayPath?: string;
  title?: string;
  scope: RuleScope;
  injectionStatus: RuleInjectionStatus;
  availability: AvailabilityEvent<'available' | 'injected' | 'referenced'>[];
  injectedContent?: string;
  rawContent?: string;
  frontmatter?: RuleFrontmatter;
  globs?: string[];
  contentDiffersFromDisk?: boolean;
  origin: 'nested_memory' | 'compact_file_reference' | 'config_inventory';
}

interface RuleFrontmatter {
  description?: string;
  globs?: string[];
  [k: string]: unknown;
}

interface McpServerRecord {
  server: string;
  toolNamespace?: string;
  availability: AvailabilityEvent<'instructions_added' | 'instructions_removed' | 'tools_offered' | 'tools_removed' | 'pending' | 'needs_auth' | 'invoked'>[];
  instructions?: string;
  offeredTools: string[];
  invokedTools: Array<{ tool: string; count: number }>;
  pending: boolean;
  needsAuth: boolean;
  config?: McpServerConfig;
}

interface PermissionModeChange {
  mode: string;
  lineNumber: number;
  timestampMs?: number;
}

interface HookEventRecord {
  hookName: string;
  hookEvent: string;
  command?: string;
  outcome: 'success' | 'non_blocking_error' | 'system_message' | 'additional_context';
  exitCode?: number;
  durationMs?: number;
  stdout?: string;
  stderr?: string;
  injectedContext?: string[];
  entryUuid: string;
  timestampMs: number;
}

interface CompactionRecord {
  entryUuid: string;
  timestampMs: number;
  metadata: CompactMetadata;
}

interface PrLinkRecord {
  prNumber: number;
  prUrl: string;
  prRepository: string;
  timestampMs: number;
}
```

---

## Session builder

### `parseSession`

```ts
parseSession(content: string, options?: ParseOptions): ClaudeSessionBuilder

interface ClaudeSessionBuilder {
  appendSubAgent(agentId: string, subSession: ClaudeCodeSession, meta?: SubagentMeta): this;
  appendMcp(config: McpConfig): this;
  appendSettings(settings: ClaudeCodeSettings): this;
  appendAgent(def: AgentDefinition): this;
  appendAgents(defs: AgentDefinition[]): this;
  appendSkill(def: SkillDefinition): this;
  appendSkills(defs: SkillDefinition[]): this;
  appendRule(def: RuleDefinition): this;
  appendRules(defs: RuleDefinition[]): this;
  toSession(): ClaudeCodeSession;
}
```

`parseSession` is the same as `parseSessionTranscript` but wrapped in a fluent, **immutable** builder. Every `appendX` call returns a new builder; the original `ClaudeCodeSession` is never mutated.

### `parseSubagentMeta`

```ts
parseSubagentMeta(content: string): SubagentMeta

interface SubagentMeta {
  agentType?: string;
  description?: string;
  toolUseId?: string;
  spawnDepth?: number;
  model?: string;
  parseErrors: ParseError[];
}
```

Parses the `subagents/agent-<id>.meta.json` sidecar that matches a subagent transcript.

---

## Config-surface parsers

All config parsers take a raw `content` string and return a typed object with a `kind` discriminant and a `parseErrors` array (except `PluginMarketplace`, which degrades silently on malformed input).

### `parseSettings`

```ts
parseSettings(content: string, scope: ClaudeScope, sourcePath?: string): ClaudeCodeSettings

interface ClaudeCodeSettings {
  kind: 'settings';
  scope: ClaudeScope;
  sourcePath?: string;
  model?: string;
  effortLevel?: string;
  permissions?: { defaultMode?: string; allow?: string[]; deny?: string[]; ask?: string[] };
  env?: Record<string, string>;
  hooks?: Record<string, HookMatcherGroup[]>;
  enabledPlugins?: Record<string, boolean>;
  extraKnownMarketplaces?: Record<string, { source: { source: string; repo?: string; path?: string } }>;
  sandbox?: { enabled?: boolean; network?: { allowedDomains?: string[] } };
  tui?: string;
  statusLine?: unknown;
  raw: Record<string, unknown>;
  parseErrors: ParseError[];
}

interface HookMatcherGroup {
  matcher?: string;
  hooks: Array<{ type: 'command' | 'agent' | (string & {}); command?: string; prompt?: string; timeout?: number; statusMessage?: string }>;
}
```

### `parseMcp`

```ts
parseMcp(content: string, scope?: ClaudeScope, sourcePath?: string): McpConfig

interface McpConfig {
  kind: 'mcp-config';
  sourcePath?: string;
  scope: ClaudeScope;
  servers: McpServerConfig[];
  parseErrors: ParseError[];
}

interface McpServerConfig {
  name: string;
  toolNamespace: string;
  transport: 'stdio' | 'sse' | 'http' | 'unknown';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  raw: Record<string, unknown>;
}
```

### `parseAgentDefinition`

```ts
parseAgentDefinition(content: string, sourcePath?: string, scope?: ClaudeScope): AgentDefinition

interface AgentDefinition {
  kind: 'agent-definition';
  sourcePath?: string;
  scope: ClaudeScope;
  name: string;
  description?: string;
  model?: string;
  memory?: 'user' | 'project' | (string & {});
  tools?: string[];
  color?: string;
  frontmatter: Record<string, unknown>;
  body: string;
  parseErrors: ParseError[];
}
```

### `parseSkillDefinition`

```ts
parseSkillDefinition(content: string, sourcePath?: string, scope?: ClaudeScope): SkillDefinition

interface SkillDefinition {
  kind: 'skill-definition';
  sourcePath?: string;
  scope: ClaudeScope;
  name: string;
  description?: string;
  pluginPrefix?: string;
  allowedTools?: string[];
  frontmatter: Record<string, unknown>;
  body: string;
  supportingFiles?: string[];
  parseErrors: ParseError[];
}
```

### `parseRuleDefinition`

```ts
parseRuleDefinition(content: string, sourcePath: string, scope?: ClaudeScope): RuleDefinition

interface RuleDefinition {
  kind: 'rule-definition';
  sourcePath: string;
  scope: ClaudeScope;
  title?: string;
  ruleKind: 'memory' | 'rule';
  frontmatter: RuleFrontmatter;
  globs: string[];
  body: string;
  parseErrors: ParseError[];
}
```

### `parsePluginMarketplace`

```ts
parsePluginMarketplace(content: string, sourcePath?: string): PluginMarketplace

interface PluginMarketplace {
  kind: 'plugin-marketplace';
  sourcePath?: string;
  name: string;
  description?: string;
  owner?: { name?: string };
  plugins: Array<{ name: string; source: string; description?: string }>;
}
```

### `buildConfigSnapshot`

```ts
buildConfigSnapshot(
  parsed: Array<AgentDefinition | SkillDefinition | RuleDefinition | McpConfig | ClaudeCodeSettings | PluginMarketplace>,
  scope?: ClaudeScope,
): ClaudeConfigSnapshot

interface ClaudeConfigSnapshot {
  inventories: ClaudeFolderInventory[];
  effectiveSettings: ClaudeCodeSettings;
  agentsByName: Record<string, AgentDefinition>;
  skillsByName: Record<string, SkillDefinition>;
  mcpServersByName: Record<string, McpServerConfig>;
}

interface ClaudeFolderInventory {
  scope: ClaudeScope;
  rootPath?: string;
  settings?: ClaudeCodeSettings;
  localSettings?: ClaudeCodeSettings;
  mcp?: McpConfig;
  agents: AgentDefinition[];
  skills: SkillDefinition[];
  rules: RuleDefinition[];
  hooks: Array<{ path: string; event?: string }>;
  marketplace?: PluginMarketplace;
  unrecognized: string[];
  parseErrors: ParseError[];
}
```

`buildConfigSnapshot` buckets an already-parsed, mixed array of config files into a per-root inventory and an effective merged settings object.

---

## Utility helpers

These small functions are also exported because they are useful to downstream transformers.

```ts
parseFrontmatter(markdown: string): ParsedFrontmatter

interface ParsedFrontmatter {
  frontmatter: Record<string, unknown>;
  body: string;
}

normalizeGlobs(fm: RuleFrontmatter | Record<string, unknown> | null | undefined): string[]

splitMcpToolName(toolName: string): { server?: string; tool: string }

mcpServerNameToNamespace(serverName: string): string

isSkillTool(name: string): boolean

isAgentTool(name: string): boolean

const ALWAYS_AVAILABLE_TOOLS: readonly string[]
```

---

## Type index

For the full, exhaustive source of truth see `src/types/index.ts` and its re-exports:

- `src/types/common.ts` — `ParseError`, `ParseOptions`, `ClaudeScope`, `AvailabilityEvent`
- `src/types/session.ts` — `ClaudeCodeSession`, `ClaudeCodeEntry` union, attachments, bookkeeping entries
- `src/types/timeline.ts` — availability records for tools, skills, agents, rules, MCP, hooks, compactions, PR links
- `src/types/config.ts` — settings, MCP, definitions, marketplace, inventory, snapshot, `SubagentMeta`
