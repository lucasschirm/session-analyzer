import type {
  AssistantEntry,
  AttachmentEntry,
  ClaudeCodeEntry,
  ClaudeCodeSession,
  ContentBlock,
  PermissionModeEntry,
  ToolUseResult,
  UserEntry,
} from '@lucasschirm/sal-claude-session-parser';
import { isAgentTool, isSkillTool, splitMcpToolName } from '@lucasschirm/sal-claude-session-parser';
import type {
  NormalizedEvidenceRecord,
  Provenance,
  TransformContext,
  UnknownArtifactBundle,
} from '@lucasschirm/sal-transformer-shared';

type ToolUseBlock = Extract<ContentBlock, { type: 'tool_use' }>;
type ToolResultBlock = Extract<ContentBlock, { type: 'tool_result' }>;

// ---------------------------------------------------------------------------
// Registry for model capabilities and pricing.  This is intentionally a small
// static lookup: the parser gives exact token counts, but it has no notion of
// vendor pricing.  Unknown models still produce `model_capabilities` records
// with `exact: false`, but no `pricing_versions` record and no cost.
// ---------------------------------------------------------------------------

interface RegisteredModel {
  readonly provider: string;
  readonly contextWindow: number;
  readonly outputLimit: number;
  readonly supportsCache: boolean;
  readonly supportsReasoning: boolean;
  readonly exact: boolean;
  readonly inputTokenPrice: number;
  readonly outputTokenPrice: number;
  readonly cacheCreationTokenPrice: number;
  readonly cacheReadTokenPrice: number;
  readonly currency: string;
  readonly effectiveDate: string;
}

const MODEL_REGISTRY: Record<string, RegisteredModel> = {
  'claude-3-5-sonnet-20241022': {
    provider: 'anthropic',
    contextWindow: 200_000,
    outputLimit: 8_192,
    supportsCache: true,
    supportsReasoning: false,
    exact: true,
    inputTokenPrice: 0.000_003,
    outputTokenPrice: 0.000_015,
    cacheCreationTokenPrice: 0.000_003_75,
    cacheReadTokenPrice: 0.000_000_3,
    currency: 'USD',
    effectiveDate: '2024-10-01',
  },
  'claude-3-5-sonnet-20240620': {
    provider: 'anthropic',
    contextWindow: 200_000,
    outputLimit: 8_192,
    supportsCache: true,
    supportsReasoning: false,
    exact: true,
    inputTokenPrice: 0.000_003,
    outputTokenPrice: 0.000_015,
    cacheCreationTokenPrice: 0.000_003_75,
    cacheReadTokenPrice: 0.000_000_3,
    currency: 'USD',
    effectiveDate: '2024-06-01',
  },
  'claude-3-5-haiku-20241022': {
    provider: 'anthropic',
    contextWindow: 200_000,
    outputLimit: 4_096,
    supportsCache: true,
    supportsReasoning: false,
    exact: true,
    inputTokenPrice: 0.000_001,
    outputTokenPrice: 0.000_005,
    cacheCreationTokenPrice: 0.000_001_25,
    cacheReadTokenPrice: 0.000_000_1,
    currency: 'USD',
    effectiveDate: '2024-10-01',
  },
  'claude-3-opus-20240229': {
    provider: 'anthropic',
    contextWindow: 200_000,
    outputLimit: 4_096,
    supportsCache: true,
    supportsReasoning: true,
    exact: true,
    inputTokenPrice: 0.000_015,
    outputTokenPrice: 0.000_075,
    cacheCreationTokenPrice: 0.000_018_75,
    cacheReadTokenPrice: 0.000_001_5,
    currency: 'USD',
    effectiveDate: '2024-02-01',
  },
  'claude-3-haiku-20240307': {
    provider: 'anthropic',
    contextWindow: 200_000,
    outputLimit: 4_096,
    supportsCache: true,
    supportsReasoning: false,
    exact: true,
    inputTokenPrice: 0.000_000_25,
    outputTokenPrice: 0.000_001_25,
    cacheCreationTokenPrice: 0.000_000_312_5,
    cacheReadTokenPrice: 0.000_000_025,
    currency: 'USD',
    effectiveDate: '2024-03-01',
  },
};

function resolveModel(model: string | undefined): RegisteredModel | undefined {
  if (model === undefined) return undefined;
  const exact = MODEL_REGISTRY[model];
  if (exact) return exact;
  const lower = model.toLowerCase();
  if (lower.startsWith('claude-3-5-sonnet')) {
    return { ...MODEL_REGISTRY['claude-3-5-sonnet-20241022'], exact: false };
  }
  if (lower.startsWith('claude-3-5-haiku')) {
    return { ...MODEL_REGISTRY['claude-3-5-haiku-20241022'], exact: false };
  }
  if (lower.startsWith('claude-3-opus')) {
    return { ...MODEL_REGISTRY['claude-3-opus-20240229'], exact: false };
  }
  if (lower.startsWith('claude-3-haiku')) {
    return { ...MODEL_REGISTRY['claude-3-haiku-20240307'], exact: false };
  }
  return undefined;
}

function resolveProvider(model: string | undefined): string {
  const registered = resolveModel(model);
  if (registered) return registered.provider;
  if (model === undefined) return 'unknown';
  const lower = model.toLowerCase();
  if (lower.startsWith('claude') || lower.startsWith('anthropic')) return 'anthropic';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Payload shapes exported for consumers.
// ---------------------------------------------------------------------------

export interface ModelUsagePayload {
  readonly requestId?: string;
  readonly requestRecordId: string;
  readonly turnRecordId: string;
  readonly model: string;
  readonly provider: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheCreationTokens: number;
  readonly cacheReadTokens: number;
  readonly thinkingTokens?: number;
  readonly tokenValuesExact: boolean;
  readonly cost?: number;
  readonly costExact: boolean;
  readonly pricingVersionId?: string;
  readonly currency?: string;
  readonly rootSessionId: string;
  readonly parentSessionId?: string;
}

export interface ModelCapabilityPayload {
  readonly model: string;
  readonly provider: string;
  readonly contextWindow?: number;
  readonly contextWindowExact: boolean;
  readonly outputLimit?: number;
  readonly outputLimitExact: boolean;
  readonly supportsCache: boolean;
  readonly supportsReasoning: boolean;
  readonly rootSessionId: string;
}

export interface PricingVersionPayload {
  readonly versionId: string;
  readonly provider: string;
  readonly model: string;
  readonly currency: string;
  readonly effectiveDate: string;
  readonly inputTokenPrice: number;
  readonly outputTokenPrice: number;
  readonly cacheCreationTokenPrice: number;
  readonly cacheReadTokenPrice: number;
  readonly rootSessionId: string;
}

export interface InvocationPayload {
  readonly kind: 'tool' | 'skill' | 'agent';
  readonly name: string;
  readonly startId: string;
  readonly resultId?: string;
  readonly status: 'success' | 'error' | 'incomplete' | 'unknown';
  readonly latencyMs?: number;
  readonly origin: 'root' | 'subagent';
  readonly rootSessionId: string;
  readonly parentSessionId?: string;
  readonly childSessionId?: string;
  readonly componentVersion?: string;
  readonly cliVersion?: string;
  readonly mcpServer?: string;
  readonly mcpToolName?: string;
  readonly skillName?: string;
  readonly agentType?: string;
  readonly inputSummary: {
    readonly keys: string[];
    readonly bytes: number;
    readonly tokenEstimate: number;
  };
  readonly resultSummary: {
    readonly bytes: number;
    readonly tokenEstimate: number;
    readonly type: 'text' | 'structured' | 'error' | 'unknown';
    readonly truncation?: { readonly kind: string; readonly droppedChars?: number };
  };
}

export interface PayloadRecordPayload {
  readonly payloadType: 'input' | 'result' | 'injection' | 'prompt';
  readonly toolUseId?: string;
  readonly sourceEventId: string;
  readonly bytes: number;
  readonly tokens: number;
  readonly tokenSource: 'exact' | 'estimated';
  readonly mediaCount: number;
  readonly structureCount: number;
  readonly truncation?: { readonly kind: string; readonly droppedChars?: number };
  readonly contentKind?: 'json' | 'text' | 'markdown' | 'unknown';
  readonly skillName?: string;
}

export interface InvocationPayloadPayload {
  readonly invocationId: string;
  readonly payloadId: string;
  readonly attributionType: 'input' | 'result' | 'context';
  readonly tokenAttribution: number;
  readonly tokenSource: 'exact' | 'estimated';
  readonly additive: boolean;
}

export interface PermissionEventPayload {
  readonly prompt?: string;
  readonly promptLength: number;
  readonly promptIsTruncated: boolean;
  readonly decision: 'approval' | 'denial' | 'cancellation' | 'unknown';
  readonly mode: string;
  readonly toolPatterns?: string[];
  readonly toolUseId?: string;
  readonly waitIntervalMs?: number;
}

export interface ModeEventPayload {
  readonly mode: string;
  readonly previousMode: string;
  readonly nextMode?: string;
  readonly modeType: 'permission' | 'session';
  readonly trigger: string;
  readonly effectiveFromMs?: number;
  readonly effectiveToMs?: number;
  readonly effectiveFromLine: number;
  readonly effectiveToLine?: number;
}

export interface HookExecutionPayload {
  readonly hookName: string;
  readonly hookEvent: string;
  readonly command?: string;
  readonly status: 'success' | 'error' | 'message' | 'context';
  readonly durationMs?: number;
  readonly exitCode?: number;
  readonly stdoutLength: number;
  readonly stderrLength: number;
  readonly outputBytes?: number;
  readonly injectedContextCount?: number;
  readonly injectedContextLengths?: number[];
  readonly contextTotalBytes?: number;
  readonly pluginIdentity: {
    readonly hookName: string;
    readonly hookEvent: string;
    readonly command?: string;
  };
}

// ---------------------------------------------------------------------------
// Deterministic identity helpers.
// ---------------------------------------------------------------------------

function stableId(namespace: string, parts: Record<string, unknown>): string {
  const ordered: Record<string, unknown> = {};
  for (const key of Object.keys(parts).sort()) {
    const value = parts[key];
    if (value !== undefined) ordered[key] = value;
  }
  return `${namespace}:${JSON.stringify(ordered)}`;
}

function sourceIdentityFor(
  bundle: UnknownArtifactBundle | undefined,
  context: TransformContext,
): {
  readonly ingestionSourceId: string;
  readonly environmentId: string;
  readonly projectId: string;
  readonly sourceSessionId: string;
} {
  return {
    ingestionSourceId:
      bundle?.sourceIdentity?.sourceId ?? context.sourceEnvironmentId ?? context.sourceFingerprint,
    environmentId:
      context.sourceEnvironmentId ?? bundle?.sourceIdentity?.environmentId ?? 'unknown',
    projectId: context.sourceProjectId ?? bundle?.sourceIdentity?.projectId ?? 'unknown',
    sourceSessionId: context.sourceSessionId ?? bundle?.sourceIdentity?.sessionId ?? 'unknown',
  };
}

interface SessionIdentity {
  readonly sessionId: string;
  readonly resolvedRootSessionId: string;
  readonly parentSessionId?: string;
}

function deriveRootSessionId(
  bundle: UnknownArtifactBundle | undefined,
  context: TransformContext,
  nativeSessionId: string,
): string {
  const source = sourceIdentityFor(bundle, context);
  return stableId('session', {
    source: source.ingestionSourceId,
    env: source.environmentId,
    project: source.projectId,
    session: nativeSessionId,
  });
}

function deriveChildSessionId(
  bundle: UnknownArtifactBundle | undefined,
  context: TransformContext,
  parentSessionId: string,
  agentId: string,
  childNativeSessionId: string,
): string {
  const source = sourceIdentityFor(bundle, context);
  return stableId('subagent', {
    source: source.ingestionSourceId,
    env: source.environmentId,
    project: source.projectId,
    parentSession: parentSessionId,
    agentId,
    session: childNativeSessionId,
  });
}

function resolveSessionIdentity(
  session: ClaudeCodeSession,
  bundle: UnknownArtifactBundle | undefined,
  context: TransformContext,
  parentSessionId?: string,
  resolvedRootSessionIdParam?: string,
): SessionIdentity {
  const nativeSessionId = session.sessionId ?? 'unknown';
  const sessionId = parentSessionId
    ? deriveChildSessionId(
        bundle,
        context,
        parentSessionId,
        session.agentId ?? 'unknown',
        nativeSessionId,
      )
    : deriveRootSessionId(bundle, context, nativeSessionId);
  const resolvedRootSessionId = resolvedRootSessionIdParam ?? sessionId;
  return { sessionId, resolvedRootSessionId, parentSessionId };
}

function* visitSessions(
  session: ClaudeCodeSession,
  bundle: UnknownArtifactBundle | undefined,
  context: TransformContext,
  parentSessionId?: string,
  resolvedRootSessionIdParam?: string,
): Generator<{ readonly session: ClaudeCodeSession; readonly identity: SessionIdentity }> {
  const identity = resolveSessionIdentity(
    session,
    bundle,
    context,
    parentSessionId,
    resolvedRootSessionIdParam,
  );
  yield { session, identity };

  const subagentSessions = session.subagentSessions ?? {};
  for (const [, subSession] of Object.entries(subagentSessions)) {
    yield* visitSessions(
      subSession,
      bundle,
      context,
      identity.sessionId,
      identity.resolvedRootSessionId,
    );
  }
}

// ---------------------------------------------------------------------------
// Entry, content, and provenance helpers.
// ---------------------------------------------------------------------------

function entryTimestampMs(entry: ClaudeCodeEntry): number | undefined {
  if (
    'timestampMs' in entry &&
    typeof (entry as { timestampMs?: unknown }).timestampMs === 'number'
  ) {
    return (entry as { timestampMs: number }).timestampMs;
  }
  if ('timestamp' in entry && typeof (entry as { timestamp?: unknown }).timestamp === 'string') {
    const parsed = Date.parse((entry as { timestamp: string }).timestamp);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

function entrySourceId(entry: ClaudeCodeEntry): string {
  if ('uuid' in entry && typeof (entry as { uuid?: unknown }).uuid === 'string') {
    return (entry as { uuid: string }).uuid;
  }
  return `line-${entry.lineNumber}`;
}

function provenanceFor(
  artifactId: string,
  sourceEventId?: string,
  sourceField?: string,
): Provenance {
  return { artifactId, sourceEventId, sourceField, path: artifactId };
}

function makeRecord(
  recordType: string,
  recordId: string,
  sessionId: string,
  sourceEventId: string,
  provenance: Provenance,
  payload: unknown,
  parentId?: string,
): NormalizedEvidenceRecord {
  return { recordId, recordType, sessionId, parentId, sourceEventId, provenance, payload };
}

function isAssistantEntry(entry: ClaudeCodeEntry): entry is AssistantEntry {
  return entry.type === 'assistant' && 'message' in entry;
}

function isUserEntry(entry: ClaudeCodeEntry): entry is UserEntry {
  return entry.type === 'user' && 'message' in entry;
}

function isAttachmentEntry(entry: ClaudeCodeEntry): entry is AttachmentEntry {
  return entry.type === 'attachment' && 'attachment' in entry;
}

function isToolUseBlock(block: ContentBlock): block is ToolUseBlock {
  return (
    block.type === 'tool_use' &&
    'name' in block &&
    typeof (block as { name?: unknown }).name === 'string' &&
    'id' in block &&
    typeof (block as { id?: unknown }).id === 'string'
  );
}

function isToolResultBlock(block: ContentBlock): block is ToolResultBlock {
  return (
    block.type === 'tool_result' &&
    'tool_use_id' in block &&
    typeof (block as { tool_use_id?: unknown }).tool_use_id === 'string'
  );
}

function buildResultIndexByToolUseId(session: ClaudeCodeSession): Map<string, UserEntry> {
  const map = new Map<string, UserEntry>();
  for (const entry of session.entries) {
    if (!isUserEntry(entry)) continue;
    if (entry.sourceToolUseID) map.set(entry.sourceToolUseID, entry);
    const content = entry.message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (isToolResultBlock(block) && !map.has(block.tool_use_id)) {
        map.set(block.tool_use_id, entry);
      }
    }
  }
  return map;
}

function findResultBlock(user: UserEntry, toolUseId: string): ToolResultBlock | undefined {
  const content = user.message.content;
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    if (isToolResultBlock(block) && block.tool_use_id === toolUseId) return block;
  }
  return undefined;
}

function safeStringify(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function estimateTokens(text: string | undefined): number {
  if (!text || text.length === 0) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

function topLevelKeys(value: unknown): string[] {
  if (value && typeof value === 'object' && !Array.isArray(value)) return Object.keys(value);
  return [];
}

function structureCount(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === 'object') return Object.keys(value).length;
  if (typeof value === 'string') return value.split('\n').length || 1;
  return 0;
}

function inputMediaCount(input: Record<string, unknown>): number {
  let count = 0;
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'string' && ['file_path', 'path', 'filename', 'file'].includes(key)) {
      count += 1;
    }
    if (Array.isArray(value) && ['files', 'filenames'].includes(key)) {
      count += value.length;
    }
  }
  return count;
}

function resultMediaCount(
  resultBlock: ToolResultBlock | undefined,
  toolUseResult?: ToolUseResult,
): number {
  let count = 0;
  if (toolUseResult) {
    if (toolUseResult.file) count += 1;
    if (Array.isArray(toolUseResult.filenames)) count += toolUseResult.filenames.length;
    if (typeof toolUseResult.numFiles === 'number') count += toolUseResult.numFiles;
  }
  const content = resultBlock?.content;
  if (content && typeof content === 'object' && !Array.isArray(content)) {
    if ('filePath' in content) count += 1;
    if ('numFiles' in content && typeof (content as { numFiles?: number }).numFiles === 'number') {
      count += (content as { numFiles: number }).numFiles;
    }
    if ('filenames' in content && Array.isArray((content as { filenames?: unknown }).filenames)) {
      count += (content as { filenames: unknown[] }).filenames.length;
    }
  }
  return count;
}

function resultContentType(
  resultBlock: ToolResultBlock | undefined,
  toolUseResult?: ToolUseResult,
): 'text' | 'structured' | 'error' | 'unknown' {
  if (resultBlock?.is_error === true) return 'error';
  if (toolUseResult?.interrupted === true) return 'error';
  if (typeof toolUseResult?.exitCode === 'number' && toolUseResult.exitCode !== 0) return 'error';
  if (toolUseResult && Object.keys(toolUseResult).length > 0) return 'structured';
  const content = resultBlock?.content;
  if (typeof content === 'string') return 'text';
  if (typeof content === 'object' && content !== null) return 'structured';
  return 'unknown';
}

function resultStatus(
  resultBlock: ToolResultBlock | undefined,
  toolUseResult?: ToolUseResult,
): 'success' | 'error' | 'incomplete' | 'unknown' {
  if (!resultBlock && !toolUseResult) return 'incomplete';
  if (resultBlock?.is_error === true) return 'error';
  if (toolUseResult?.interrupted === true) return 'error';
  if (typeof toolUseResult?.exitCode === 'number' && toolUseResult.exitCode !== 0) return 'error';
  const status = toolUseResult?.status;
  if (typeof status === 'string') {
    const lower = status.toLowerCase();
    if (['success', 'completed', 'done', 'ok'].includes(lower)) return 'success';
    if (['error', 'failed', 'failure', 'interrupted', 'cancelled', 'canceled'].includes(lower)) {
      return 'error';
    }
    return 'unknown';
  }
  return 'success';
}

function latencyMs(start: ClaudeCodeEntry, end?: ClaudeCodeEntry): number | undefined {
  const startMs = entryTimestampMs(start);
  const endMs = end ? entryTimestampMs(end) : undefined;
  if (startMs !== undefined && endMs !== undefined && endMs >= startMs) return endMs - startMs;
  return undefined;
}

function extractTruncation(
  resultBlock: ToolResultBlock | undefined,
  toolUseResult?: ToolUseResult,
): { readonly kind: string; readonly droppedChars?: number } | undefined {
  const truncated = resultBlock?.truncated;
  if (truncated && typeof truncated === 'object' && 'kind' in truncated) {
    const signal = truncated as { kind: string; droppedChars?: number };
    return { kind: signal.kind, droppedChars: signal.droppedChars };
  }
  if (toolUseResult?.file?.truncatedByTokenCap === true) {
    return { kind: 'file_token_cap' };
  }
  if (toolUseResult?.truncated === true) {
    return { kind: 'search_truncated' };
  }
  return undefined;
}

function userText(user: UserEntry): string | undefined {
  const content = user.message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    if (block.type === 'text' && typeof (block as { text?: unknown }).text === 'string') {
      return (block as { text: string }).text;
    }
  }
  return undefined;
}

function truncatePrompt(text: string | undefined): {
  readonly text: string;
  readonly length: number;
  readonly truncated: boolean;
} {
  if (!text) return { text: '', length: 0, truncated: false };
  const max = 120;
  if (text.length <= max) return { text, length: text.length, truncated: false };
  return { text: text.slice(0, max), length: text.length, truncated: true };
}

// ---------------------------------------------------------------------------
// model_usage
// ---------------------------------------------------------------------------

export function normalizeModelUsage(
  session: ClaudeCodeSession,
  bundle: UnknownArtifactBundle | undefined,
  context: TransformContext,
  artifactId: string,
  parentSessionId?: string,
  resolvedRootSessionId?: string,
): NormalizedEvidenceRecord[] {
  const records: NormalizedEvidenceRecord[] = [];
  for (const { session: s, identity } of visitSessions(
    session,
    bundle,
    context,
    parentSessionId,
    resolvedRootSessionId,
  )) {
    for (const entry of s.entries) {
      if (!isAssistantEntry(entry)) continue;
      const model = entry.message.model;
      const usage = entry.message.usage;
      if (!model || !usage) continue;
      const turnId = stableId('turn', { session: identity.sessionId, uuid: entry.uuid });
      const requestRecordId = stableId('model_request', {
        session: identity.sessionId,
        uuid: entry.uuid,
      });
      const recordId = stableId('model_usage', {
        session: identity.sessionId,
        uuid: entry.uuid,
        model,
      });
      const registered = resolveModel(model);
      const inputTokens = usage.input_tokens ?? 0;
      const outputTokens = usage.output_tokens ?? 0;
      const cacheCreationTokens = usage.cache_creation_input_tokens ?? 0;
      const cacheReadTokens = usage.cache_read_input_tokens ?? 0;
      const thinkingTokens = usage.output_tokens_details?.thinking_tokens;
      let cost: number | undefined;
      let pricingVersionId: string | undefined;
      let currency: string | undefined;
      if (registered) {
        cost =
          inputTokens * registered.inputTokenPrice +
          outputTokens * registered.outputTokenPrice +
          cacheCreationTokens * registered.cacheCreationTokenPrice +
          cacheReadTokens * registered.cacheReadTokenPrice;
        pricingVersionId = stableId('pricing_version', {
          session: identity.resolvedRootSessionId,
          provider: registered.provider,
          model,
          version: registered.effectiveDate,
          currency: registered.currency,
        });
        currency = registered.currency;
      }
      const payload: ModelUsagePayload = {
        requestId: entry.requestId,
        requestRecordId,
        turnRecordId: turnId,
        model,
        provider: resolveProvider(model),
        inputTokens,
        outputTokens,
        cacheCreationTokens,
        cacheReadTokens,
        thinkingTokens,
        tokenValuesExact: true,
        cost,
        costExact: false,
        pricingVersionId,
        currency,
        rootSessionId: identity.resolvedRootSessionId,
        parentSessionId: identity.parentSessionId,
      };
      records.push(
        makeRecord(
          'model_usage',
          recordId,
          identity.sessionId,
          entry.uuid,
          provenanceFor(artifactId, entry.uuid, 'usage'),
          payload,
          turnId,
        ),
      );
    }
  }
  return records;
}

// ---------------------------------------------------------------------------
// model_capabilities
// ---------------------------------------------------------------------------

export function normalizeModelCapabilities(
  session: ClaudeCodeSession,
  bundle: UnknownArtifactBundle | undefined,
  context: TransformContext,
  artifactId: string,
  parentSessionId?: string,
  resolvedRootSessionId?: string,
): NormalizedEvidenceRecord[] {
  const rootIdentity = resolveSessionIdentity(
    session,
    bundle,
    context,
    parentSessionId,
    resolvedRootSessionId,
  );
  const models = new Set<string>();
  for (const { session: s } of visitSessions(
    session,
    bundle,
    context,
    parentSessionId,
    resolvedRootSessionId,
  )) {
    for (const entry of s.entries) {
      if (isAssistantEntry(entry) && entry.message.model) models.add(entry.message.model);
    }
  }
  const records: NormalizedEvidenceRecord[] = [];
  for (const model of Array.from(models).sort()) {
    const registered = resolveModel(model);
    const recordId = stableId('model_capability', {
      root: rootIdentity.resolvedRootSessionId,
      model,
    });
    const payload: ModelCapabilityPayload = {
      model,
      provider: resolveProvider(model),
      contextWindow: registered?.contextWindow,
      contextWindowExact: registered?.exact ?? false,
      outputLimit: registered?.outputLimit,
      outputLimitExact: registered?.exact ?? false,
      supportsCache: registered?.supportsCache ?? false,
      supportsReasoning: registered?.supportsReasoning ?? false,
      rootSessionId: rootIdentity.resolvedRootSessionId,
    };
    records.push(
      makeRecord(
        'model_capabilities',
        recordId,
        rootIdentity.sessionId,
        rootIdentity.sessionId,
        provenanceFor(artifactId),
        payload,
      ),
    );
  }
  return records;
}

// ---------------------------------------------------------------------------
// pricing_versions
// ---------------------------------------------------------------------------

export function normalizePricingVersions(
  session: ClaudeCodeSession,
  bundle: UnknownArtifactBundle | undefined,
  context: TransformContext,
  artifactId: string,
  parentSessionId?: string,
  resolvedRootSessionId?: string,
): NormalizedEvidenceRecord[] {
  const rootIdentity = resolveSessionIdentity(
    session,
    bundle,
    context,
    parentSessionId,
    resolvedRootSessionId,
  );
  const models = new Set<string>();
  for (const { session: s } of visitSessions(
    session,
    bundle,
    context,
    parentSessionId,
    resolvedRootSessionId,
  )) {
    for (const entry of s.entries) {
      if (isAssistantEntry(entry) && entry.message.model) models.add(entry.message.model);
    }
  }
  const records: NormalizedEvidenceRecord[] = [];
  for (const model of Array.from(models).sort()) {
    const registered = resolveModel(model);
    if (!registered) continue;
    const recordId = stableId('pricing_version', {
      session: rootIdentity.sessionId,
      provider: registered.provider,
      model,
      version: registered.effectiveDate,
      currency: registered.currency,
    });
    const payload: PricingVersionPayload = {
      versionId: recordId,
      provider: registered.provider,
      model,
      currency: registered.currency,
      effectiveDate: registered.effectiveDate,
      inputTokenPrice: registered.inputTokenPrice,
      outputTokenPrice: registered.outputTokenPrice,
      cacheCreationTokenPrice: registered.cacheCreationTokenPrice,
      cacheReadTokenPrice: registered.cacheReadTokenPrice,
      rootSessionId: rootIdentity.resolvedRootSessionId,
    };
    records.push(
      makeRecord(
        'pricing_versions',
        recordId,
        rootIdentity.sessionId,
        rootIdentity.sessionId,
        provenanceFor(artifactId),
        payload,
      ),
    );
  }
  return records;
}

// ---------------------------------------------------------------------------
// invocations
// ---------------------------------------------------------------------------

export function normalizeInvocations(
  session: ClaudeCodeSession,
  bundle: UnknownArtifactBundle | undefined,
  context: TransformContext,
  artifactId: string,
  parentSessionId?: string,
  resolvedRootSessionId?: string,
): NormalizedEvidenceRecord[] {
  const records: NormalizedEvidenceRecord[] = [];
  for (const { session: s, identity } of visitSessions(
    session,
    bundle,
    context,
    parentSessionId,
    resolvedRootSessionId,
  )) {
    const resultIndex = buildResultIndexByToolUseId(s);
    for (const entry of s.entries) {
      if (!isAssistantEntry(entry)) continue;
      const turnId = stableId('turn', { session: identity.sessionId, uuid: entry.uuid });
      for (const rawBlock of entry.message.content) {
        if (!isToolUseBlock(rawBlock)) continue;
        const block = rawBlock;
        const toolUseId = block.id;
        const resultEntry = resultIndex.get(toolUseId);
        const toolUseResult = resultEntry?.toolUseResult;
        const resultBlock = resultEntry ? findResultBlock(resultEntry, toolUseId) : undefined;

        let kind: 'tool' | 'skill' | 'agent';
        let name: string;
        let skillName: string | undefined;
        let agentType: string | undefined;
        let mcpServer: string | undefined;
        let mcpToolName: string | undefined;

        if (isAgentTool(block.name)) {
          kind = 'agent';
          agentType =
            typeof block.input.subagent_type === 'string'
              ? (block.input.subagent_type as string)
              : 'unknown';
          name = agentType;
        } else if (isSkillTool(block.name)) {
          kind = 'skill';
          skillName =
            typeof block.input.skill === 'string' ? (block.input.skill as string) : 'unknown';
          name = skillName;
        } else {
          kind = 'tool';
          name = block.name;
          const split = splitMcpToolName(block.name);
          if (split) {
            mcpServer = split.server;
            mcpToolName = split.tool;
          }
        }

        const recordId = stableId('invocation', {
          session: identity.sessionId,
          uuid: entry.uuid,
          toolUseId,
          name,
        });

        const resultId = resultEntry?.uuid;
        const status = resultStatus(resultBlock, toolUseResult);
        const latency = resultEntry ? latencyMs(entry, resultEntry) : undefined;
        const origin: 'root' | 'subagent' = identity.parentSessionId ? 'subagent' : 'root';
        const cliVersion = entry.version ?? s.cliVersions[0];

        let childSessionId: string | undefined;
        if (kind === 'agent') {
          const launch = s.subagentLaunches?.find((l) => l.toolUseId === toolUseId);
          const agentId = launch?.agentId ?? toolUseResult?.agentId;
          const subagentSession = agentId ? s.subagentSessions?.[agentId] : undefined;
          if (agentId && subagentSession) {
            childSessionId = deriveChildSessionId(
              bundle,
              context,
              identity.sessionId,
              agentId,
              subagentSession.sessionId ?? 'unknown',
            );
          }
        }

        const inputString = safeStringify(block.input);
        const inputSummary = {
          keys: topLevelKeys(block.input),
          bytes: inputString.length,
          tokenEstimate: estimateTokens(inputString),
        };

        const resultString = safeStringify(resultBlock?.content ?? toolUseResult);
        const resultSummary = {
          bytes: resultString.length,
          tokenEstimate: estimateTokens(resultString),
          type: resultContentType(resultBlock, toolUseResult),
          truncation: extractTruncation(resultBlock, toolUseResult),
        };

        const payload: InvocationPayload = {
          kind,
          name,
          startId: toolUseId,
          resultId,
          status,
          latencyMs: latency,
          origin,
          rootSessionId: identity.resolvedRootSessionId,
          parentSessionId: identity.parentSessionId,
          childSessionId,
          componentVersion: cliVersion,
          cliVersion,
          mcpServer,
          mcpToolName,
          skillName,
          agentType,
          inputSummary,
          resultSummary,
        };

        records.push(
          makeRecord(
            'invocation',
            recordId,
            identity.sessionId,
            toolUseId,
            provenanceFor(artifactId, entry.uuid, 'message.content.tool_use'),
            payload,
            turnId,
          ),
        );
      }
    }
  }
  return records;
}

// ---------------------------------------------------------------------------
// payloads
// ---------------------------------------------------------------------------

function payloadRecordId(
  sessionId: string,
  payloadType: string,
  sourceEventId: string,
  toolUseId?: string,
): string {
  return stableId('payload', {
    session: sessionId,
    type: payloadType,
    sourceEventId,
    toolUseId,
  });
}

function inputPayload(
  identity: SessionIdentity,
  entry: AssistantEntry,
  block: ToolUseBlock,
  artifactId: string,
): NormalizedEvidenceRecord {
  const inputString = safeStringify(block.input);
  const recordId = payloadRecordId(identity.sessionId, 'input', block.id, block.id);
  const payload: PayloadRecordPayload = {
    payloadType: 'input',
    toolUseId: block.id,
    sourceEventId: block.id,
    bytes: inputString.length,
    tokens: estimateTokens(inputString),
    tokenSource: 'estimated',
    mediaCount: inputMediaCount(block.input),
    structureCount: structureCount(block.input),
    contentKind: typeof block.input === 'object' && block.input !== null ? 'json' : 'unknown',
  };
  return makeRecord(
    'payload',
    recordId,
    identity.sessionId,
    block.id,
    provenanceFor(artifactId, entry.uuid, 'message.content.tool_use.input'),
    payload,
  );
}

function resultPayload(
  identity: SessionIdentity,
  block: ToolUseBlock,
  resultEntry: UserEntry | undefined,
  artifactId: string,
): NormalizedEvidenceRecord | undefined {
  if (!resultEntry) return undefined;
  const resultBlock = findResultBlock(resultEntry, block.id);
  const toolUseResult = resultEntry.toolUseResult;
  const content = resultBlock?.content ?? toolUseResult;
  const resultString = safeStringify(content);
  const recordId = payloadRecordId(identity.sessionId, 'result', resultEntry.uuid, block.id);
  const contentKind: PayloadRecordPayload['contentKind'] =
    typeof content === 'string'
      ? 'text'
      : content && typeof content === 'object'
        ? 'json'
        : 'unknown';
  const payload: PayloadRecordPayload = {
    payloadType: 'result',
    toolUseId: block.id,
    sourceEventId: resultEntry.uuid,
    bytes: resultString.length,
    tokens: estimateTokens(resultString),
    tokenSource: 'estimated',
    mediaCount: resultMediaCount(resultBlock, toolUseResult),
    structureCount: structureCount(content),
    truncation: extractTruncation(resultBlock, toolUseResult),
    contentKind,
  };
  return makeRecord(
    'payload',
    recordId,
    identity.sessionId,
    resultEntry.uuid,
    provenanceFor(artifactId, resultEntry.uuid, 'message.content.tool_result'),
    payload,
  );
}

const SKILL_EXPANSION_PREFIX = 'Base directory for this skill: ';

function skillInjectionPayload(
  identity: SessionIdentity,
  metaEntry: UserEntry,
  parentEntry: UserEntry,
  artifactId: string,
): { readonly record: NormalizedEvidenceRecord; readonly toolUseId: string } | undefined {
  const text = userText(metaEntry);
  if (!text?.startsWith(SKILL_EXPANSION_PREFIX)) return undefined;
  if (!metaEntry.isMeta) return undefined;

  let toolUseId: string | undefined;
  const parentContent = parentEntry.message.content;
  if (parentEntry.sourceToolUseID) toolUseId = parentEntry.sourceToolUseID;
  if (!toolUseId && Array.isArray(parentContent)) {
    for (const block of parentContent) {
      if (isToolResultBlock(block)) {
        toolUseId = block.tool_use_id;
        break;
      }
    }
  }
  if (!toolUseId) return undefined;

  const skillTitleMatch = text.match(/\n\n# (.+)$/m);
  const skillName = skillTitleMatch?.[1]?.trim();
  const recordId = payloadRecordId(identity.sessionId, 'injection', metaEntry.uuid, toolUseId);
  const payload: PayloadRecordPayload = {
    payloadType: 'injection',
    toolUseId,
    sourceEventId: metaEntry.uuid,
    bytes: text.length,
    tokens: estimateTokens(text),
    tokenSource: 'estimated',
    mediaCount: 0,
    structureCount: 0,
    contentKind: 'markdown',
    skillName,
  };
  return {
    record: makeRecord(
      'payload',
      recordId,
      identity.sessionId,
      metaEntry.uuid,
      provenanceFor(artifactId, metaEntry.uuid, 'message.content'),
      payload,
    ),
    toolUseId,
  };
}

export function normalizePayloads(
  session: ClaudeCodeSession,
  bundle: UnknownArtifactBundle | undefined,
  context: TransformContext,
  artifactId: string,
  parentSessionId?: string,
  resolvedRootSessionId?: string,
): NormalizedEvidenceRecord[] {
  const records: NormalizedEvidenceRecord[] = [];
  for (const { session: s, identity } of visitSessions(
    session,
    bundle,
    context,
    parentSessionId,
    resolvedRootSessionId,
  )) {
    const resultIndex = buildResultIndexByToolUseId(s);
    const entryByUuid = new Map<string, ClaudeCodeEntry>();
    for (const entry of s.entries) {
      entryByUuid.set(entrySourceId(entry), entry);
    }

    for (const entry of s.entries) {
      if (!isAssistantEntry(entry)) continue;
      for (const rawBlock of entry.message.content) {
        if (!isToolUseBlock(rawBlock)) continue;
        const block = rawBlock;
        records.push(inputPayload(identity, entry, block, artifactId));
        const resultPayloadRecord = resultPayload(
          identity,
          block,
          resultIndex.get(block.id),
          artifactId,
        );
        if (resultPayloadRecord) records.push(resultPayloadRecord);
      }
    }

    for (const entry of s.entries) {
      if (!isUserEntry(entry)) continue;
      if (!entry.isMeta) continue;
      if (!entry.parentUuid) continue;
      const parent = entryByUuid.get(entry.parentUuid);
      if (!parent || !isUserEntry(parent)) continue;
      const injection = skillInjectionPayload(identity, entry, parent, artifactId);
      if (injection) records.push(injection.record);
    }
  }
  return records;
}

// ---------------------------------------------------------------------------
// invocation_payloads
// ---------------------------------------------------------------------------

export function normalizeInvocationPayloads(
  session: ClaudeCodeSession,
  bundle: UnknownArtifactBundle | undefined,
  context: TransformContext,
  artifactId: string,
  parentSessionId?: string,
  resolvedRootSessionId?: string,
): NormalizedEvidenceRecord[] {
  const records: NormalizedEvidenceRecord[] = [];
  for (const { session: s, identity } of visitSessions(
    session,
    bundle,
    context,
    parentSessionId,
    resolvedRootSessionId,
  )) {
    const resultIndex = buildResultIndexByToolUseId(s);
    const entryByUuid = new Map<string, ClaudeCodeEntry>();
    for (const entry of s.entries) entryByUuid.set(entrySourceId(entry), entry);

    for (const entry of s.entries) {
      if (!isAssistantEntry(entry)) continue;
      for (const rawBlock of entry.message.content) {
        if (!isToolUseBlock(rawBlock)) continue;
        const block = rawBlock;
        const toolUseId = block.id;
        let name: string;
        if (isAgentTool(block.name)) {
          name =
            typeof block.input.subagent_type === 'string'
              ? (block.input.subagent_type as string)
              : 'unknown';
        } else if (isSkillTool(block.name)) {
          name = typeof block.input.skill === 'string' ? (block.input.skill as string) : 'unknown';
        } else {
          name = block.name;
        }
        const invocationRecordId = stableId('invocation', {
          session: identity.sessionId,
          uuid: entry.uuid,
          toolUseId,
          name,
        });
        const inputRecordId = payloadRecordId(identity.sessionId, 'input', toolUseId, toolUseId);
        const inputString = safeStringify(block.input);
        records.push(
          makeRecord(
            'invocation_payload',
            stableId('invocation_payload', {
              session: identity.sessionId,
              invocation: invocationRecordId,
              payload: inputRecordId,
              type: 'input',
            }),
            identity.sessionId,
            inputRecordId,
            provenanceFor(artifactId, entry.uuid, 'message.content.tool_use.input'),
            {
              invocationId: invocationRecordId,
              payloadId: inputRecordId,
              attributionType: 'input',
              tokenAttribution: estimateTokens(inputString),
              tokenSource: 'estimated',
              additive: false,
            } satisfies InvocationPayloadPayload,
            invocationRecordId,
          ),
        );

        const resultEntry = resultIndex.get(toolUseId);
        if (resultEntry) {
          const resultRecordId = payloadRecordId(
            identity.sessionId,
            'result',
            resultEntry.uuid,
            toolUseId,
          );
          const content =
            findResultBlock(resultEntry, toolUseId)?.content ?? resultEntry.toolUseResult;
          const resultString = safeStringify(content);
          records.push(
            makeRecord(
              'invocation_payload',
              stableId('invocation_payload', {
                session: identity.sessionId,
                invocation: invocationRecordId,
                payload: resultRecordId,
                type: 'result',
              }),
              identity.sessionId,
              resultRecordId,
              provenanceFor(artifactId, resultEntry.uuid, 'message.content.tool_result'),
              {
                invocationId: invocationRecordId,
                payloadId: resultRecordId,
                attributionType: 'result',
                tokenAttribution: estimateTokens(resultString),
                tokenSource: 'estimated',
                additive: false,
              } satisfies InvocationPayloadPayload,
              invocationRecordId,
            ),
          );
        }
      }
    }

    for (const entry of s.entries) {
      if (!isUserEntry(entry)) continue;
      if (!entry.isMeta || !entry.parentUuid) continue;
      const parent = entryByUuid.get(entry.parentUuid);
      if (!parent || !isUserEntry(parent)) continue;
      const injection = skillInjectionPayload(identity, entry, parent, artifactId);
      if (!injection) continue;

      const toolUseId = injection.toolUseId;
      // Find the assistant tool_use that owns this toolUseId.
      const assistant = s.entries.find((e): e is AssistantEntry => {
        if (!isAssistantEntry(e)) return false;
        return e.message.content.some((b) => isToolUseBlock(b) && b.id === toolUseId);
      });
      if (!assistant) continue;
      const name =
        typeof assistant.message.content.find(
          (b): b is ToolUseBlock => isToolUseBlock(b) && b.id === toolUseId,
        )?.input?.skill === 'string'
          ? (assistant.message.content.find(
              (b): b is ToolUseBlock => isToolUseBlock(b) && b.id === toolUseId,
            )?.input?.skill as string)
          : 'unknown';
      const invocationRecordId = stableId('invocation', {
        session: identity.sessionId,
        uuid: assistant.uuid,
        toolUseId,
        name,
      });
      records.push(
        makeRecord(
          'invocation_payload',
          stableId('invocation_payload', {
            session: identity.sessionId,
            invocation: invocationRecordId,
            payload: injection.record.recordId,
            type: 'context',
          }),
          identity.sessionId,
          injection.record.recordId,
          provenanceFor(artifactId, entry.uuid, 'message.content'),
          {
            invocationId: invocationRecordId,
            payloadId: injection.record.recordId,
            attributionType: 'context',
            tokenAttribution: estimateTokens(userText(entry) ?? ''),
            tokenSource: 'estimated',
            additive: false,
          } satisfies InvocationPayloadPayload,
          invocationRecordId,
        ),
      );
    }
  }
  return records;
}

// ---------------------------------------------------------------------------
// permission_events
// ---------------------------------------------------------------------------

interface ModePoint {
  readonly lineNumber: number;
  readonly timestampMs?: number;
  readonly mode: string;
  readonly previousMode: string;
  readonly modeType: 'permission' | 'session';
  readonly trigger: string;
}

function buildPermissionModeTimeline(session: ClaudeCodeSession): ModePoint[] {
  return buildModeTimeline(session).filter((p) => p.modeType === 'permission');
}

function buildModeTimeline(session: ClaudeCodeSession): ModePoint[] {
  const points: ModePoint[] = [];
  let lastPermissionMode = '';
  let lastSessionMode = '';
  for (const entry of session.entries) {
    if (entry.type === 'permission-mode') {
      const permission = (entry as PermissionModeEntry).permissionMode;
      if (permission !== lastPermissionMode) {
        points.push({
          lineNumber: entry.lineNumber,
          timestampMs: entryTimestampMs(entry),
          mode: permission,
          previousMode: lastPermissionMode || 'unknown',
          modeType: 'permission',
          trigger: 'permission-mode',
        });
        lastPermissionMode = permission;
      }
      continue;
    }

    if (entry.type === 'mode') {
      const modeEntry = entry as { mode: string };
      const mode = modeEntry.mode;
      if (mode !== lastSessionMode) {
        points.push({
          lineNumber: entry.lineNumber,
          timestampMs: entryTimestampMs(entry),
          mode,
          previousMode: lastSessionMode || 'unknown',
          modeType: 'session',
          trigger: 'mode',
        });
        lastSessionMode = mode;
      }
      continue;
    }

    if (isUserEntry(entry)) {
      if (entry.permissionMode && entry.permissionMode !== lastPermissionMode) {
        points.push({
          lineNumber: entry.lineNumber,
          timestampMs: entryTimestampMs(entry),
          mode: entry.permissionMode,
          previousMode: lastPermissionMode || 'unknown',
          modeType: 'permission',
          trigger: 'user',
        });
        lastPermissionMode = entry.permissionMode;
      }
      continue;
    }

    if (isAttachmentEntry(entry)) {
      const attachment = entry.attachment;
      if (attachment.type === 'plan_mode') {
        if ('plan' !== lastPermissionMode) {
          points.push({
            lineNumber: entry.lineNumber,
            timestampMs: entryTimestampMs(entry),
            mode: 'plan',
            previousMode: lastPermissionMode || 'unknown',
            modeType: 'permission',
            trigger: 'plan_mode',
          });
          lastPermissionMode = 'plan';
        }
        continue;
      }
      if (attachment.type === 'auto_mode') {
        if ('auto' !== lastPermissionMode) {
          points.push({
            lineNumber: entry.lineNumber,
            timestampMs: entryTimestampMs(entry),
            mode: 'auto',
            previousMode: lastPermissionMode || 'unknown',
            modeType: 'permission',
            trigger: 'auto_mode',
          });
          lastPermissionMode = 'auto';
        }
      }
    }
  }
  return points;
}

function effectivePermissionMode(session: ClaudeCodeSession, lineNumber: number): string {
  const points = buildPermissionModeTimeline(session);
  let mode = 'unknown';
  for (const point of points) {
    if (point.lineNumber <= lineNumber) mode = point.mode;
  }
  return mode;
}

function mapToolDenialKind(kind: string): 'approval' | 'denial' | 'cancellation' | 'unknown' {
  const lower = kind.toLowerCase();
  if (['deny', 'denied', 'rejected', 'refused'].includes(lower)) return 'denial';
  if (['cancel', 'cancelled', 'canceled'].includes(lower)) return 'cancellation';
  if (['approve', 'approved', 'allow', 'allowed'].includes(lower)) return 'approval';
  return 'unknown';
}

export function normalizePermissionEvents(
  session: ClaudeCodeSession,
  bundle: UnknownArtifactBundle | undefined,
  context: TransformContext,
  artifactId: string,
  parentSessionId?: string,
  resolvedRootSessionId?: string,
): NormalizedEvidenceRecord[] {
  const records: NormalizedEvidenceRecord[] = [];
  for (const { session: s, identity } of visitSessions(
    session,
    bundle,
    context,
    parentSessionId,
    resolvedRootSessionId,
  )) {
    for (const entry of s.entries) {
      if (isAttachmentEntry(entry)) {
        const attachment = entry.attachment;
        if (attachment.type !== 'command_permissions') continue;
        const allowedTools = Array.isArray(attachment.allowedTools)
          ? (attachment.allowedTools as unknown[]).filter((t): t is string => typeof t === 'string')
          : [];
        if (allowedTools.length === 0) continue;
        const recordId = stableId('permission_event', {
          session: identity.sessionId,
          line: entry.lineNumber,
          source: entry.uuid,
          decision: 'approval',
        });
        const payload: PermissionEventPayload = {
          decision: 'approval',
          mode: effectivePermissionMode(s, entry.lineNumber),
          toolPatterns: allowedTools,
          promptLength: 0,
          promptIsTruncated: false,
        };
        records.push(
          makeRecord(
            'permission_event',
            recordId,
            identity.sessionId,
            entry.uuid,
            provenanceFor(artifactId, entry.uuid, 'attachment.command_permissions'),
            payload,
            identity.sessionId,
          ),
        );
        continue;
      }

      if (isUserEntry(entry) && entry.toolDenialKind) {
        const decision = mapToolDenialKind(entry.toolDenialKind);
        const prompt = truncatePrompt(userText(entry));
        const recordId = stableId('permission_event', {
          session: identity.sessionId,
          line: entry.lineNumber,
          source: entry.uuid,
          decision,
        });
        const payload: PermissionEventPayload = {
          prompt: prompt.text,
          promptLength: prompt.length,
          promptIsTruncated: prompt.truncated,
          decision,
          mode: effectivePermissionMode(s, entry.lineNumber),
          toolUseId: entry.sourceToolUseID,
        };
        records.push(
          makeRecord(
            'permission_event',
            recordId,
            identity.sessionId,
            entry.uuid,
            provenanceFor(artifactId, entry.uuid, 'toolDenialKind'),
            payload,
            identity.sessionId,
          ),
        );
      }
    }
  }
  return records;
}

// ---------------------------------------------------------------------------
// mode_events
// ---------------------------------------------------------------------------

export function normalizeModeEvents(
  session: ClaudeCodeSession,
  bundle: UnknownArtifactBundle | undefined,
  context: TransformContext,
  artifactId: string,
  parentSessionId?: string,
  resolvedRootSessionId?: string,
): NormalizedEvidenceRecord[] {
  const records: NormalizedEvidenceRecord[] = [];
  for (const { session: s, identity } of visitSessions(
    session,
    bundle,
    context,
    parentSessionId,
    resolvedRootSessionId,
  )) {
    const points = buildModeTimeline(s);
    for (let i = 0; i < points.length; i++) {
      const point = points[i];
      const next = points[i + 1];
      const recordId = stableId('mode_event', {
        session: identity.sessionId,
        line: point.lineNumber,
        mode: point.mode,
        type: point.modeType,
        trigger: point.trigger,
      });
      const payload: ModeEventPayload = {
        mode: point.mode,
        previousMode: point.previousMode,
        nextMode: next?.mode,
        modeType: point.modeType,
        trigger: point.trigger,
        effectiveFromMs: point.timestampMs,
        effectiveToMs: next?.timestampMs,
        effectiveFromLine: point.lineNumber,
        effectiveToLine: next?.lineNumber,
      };
      records.push(
        makeRecord(
          'mode_event',
          recordId,
          identity.sessionId,
          `line-${point.lineNumber}`,
          provenanceFor(artifactId, `line-${point.lineNumber}`),
          payload,
          identity.sessionId,
        ),
      );
    }
  }
  return records;
}

// ---------------------------------------------------------------------------
// hook_executions
// ---------------------------------------------------------------------------

export function normalizeHookExecutions(
  session: ClaudeCodeSession,
  bundle: UnknownArtifactBundle | undefined,
  context: TransformContext,
  artifactId: string,
  parentSessionId?: string,
  resolvedRootSessionId?: string,
): NormalizedEvidenceRecord[] {
  const records: NormalizedEvidenceRecord[] = [];
  for (const { session: s, identity } of visitSessions(
    session,
    bundle,
    context,
    parentSessionId,
    resolvedRootSessionId,
  )) {
    for (const hook of s.hooks) {
      const status: HookExecutionPayload['status'] =
        hook.outcome === 'success'
          ? 'success'
          : hook.outcome === 'non_blocking_error'
            ? 'error'
            : hook.outcome === 'system_message'
              ? 'message'
              : 'context';

      const stdout = hook.stdout ?? '';
      const stderr = hook.stderr ?? '';
      const stdoutLength = stdout.length;
      const stderrLength = stderr.length;
      const outputBytes =
        status === 'success' || status === 'error' ? stdoutLength + stderrLength : undefined;

      const injectedContext = hook.injectedContext ?? [];
      const injectedContextCount = status === 'context' ? injectedContext.length : undefined;
      const injectedContextLengths =
        status === 'context' ? injectedContext.map((c) => c.length) : undefined;
      const contextTotalBytes =
        status === 'context' ? injectedContext.reduce((sum, c) => sum + c.length, 0) : undefined;

      const recordId = stableId('hook_execution', {
        session: identity.sessionId,
        uuid: hook.entryUuid,
        hookName: hook.hookName,
        hookEvent: hook.hookEvent,
        ts: hook.timestampMs,
      });

      const payload: HookExecutionPayload = {
        hookName: hook.hookName,
        hookEvent: hook.hookEvent,
        command: hook.command,
        status,
        durationMs: hook.durationMs,
        exitCode: hook.exitCode,
        stdoutLength,
        stderrLength,
        outputBytes,
        injectedContextCount,
        injectedContextLengths,
        contextTotalBytes,
        pluginIdentity: {
          hookName: hook.hookName,
          hookEvent: hook.hookEvent,
          command: hook.command,
        },
      };

      records.push(
        makeRecord(
          'hook_execution',
          recordId,
          identity.sessionId,
          hook.entryUuid,
          provenanceFor(artifactId, hook.entryUuid, 'hook'),
          payload,
          identity.sessionId,
        ),
      );
    }
  }
  return records;
}
