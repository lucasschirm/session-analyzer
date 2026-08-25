import type {
  AgentDefinition,
  ClaudeCodeEntry,
  ClaudeCodeSession,
  ClaudeCodeSettings,
  McpConfig,
  RuleDefinition,
  SkillDefinition,
} from '@lucasschirm/sal-claude-session-parser';
import {
  detectClaudeCodeArtifact,
  parseAgentDefinition,
  parseMcp,
  parseRuleDefinition,
  parseSession,
  parseSessionTranscript,
  parseSettings,
  parseSkillDefinition,
  parseSubagentMeta,
} from '@lucasschirm/sal-claude-session-parser';
import type {
  ArtifactBundle,
  ArtifactScope,
  ArtifactStatus,
  UnknownArtifactBundle,
} from '../bundle.js';
import type {
  ArtifactClassificationResult,
  ArtifactKind,
  ClassifiedArtifact,
  ClassifierConfidence,
} from '../classification.js';
import type {
  ComponentCompleteness,
  ComponentIdentity,
  ComponentKind,
  ComponentSummary,
  ConfigurationSnapshot,
} from '../component.js';
import type { TransformContext } from '../context.js';
import type { NormalizedEvidenceRecord } from '../evidence.js';
import type { Issue } from '../issue.js';
import type { MetricCapability } from '../metric.js';
import type { Provenance, SourcePointer } from '../provenance.js';
import type { SessionSummary } from '../session.js';
import {
  deriveClaudeCodeAttributionMetrics,
  getClaudeCodeAttributionMetricCapabilities,
} from './claude-code-attribution-metrics.js';
import {
  CLAUDE_CODE_METRIC_DEFINITION_VERSION,
  deriveClaudeCodeMetrics,
  getClaudeCodeMetricCapabilities,
} from './claude-code-metrics.js';
import {
  deriveClaudeCodeOptimizationMetrics,
  getClaudeCodeOptimizationMetricCapabilities,
} from './claude-code-optimization-metrics.js';
import {
  type ClaudeCodeEvidenceContext,
  normalizeCommandExecutions,
  normalizeComponentEvidenceLinks,
  normalizeFileOperations,
  normalizeNormalizedEvents,
  normalizeTasks,
  normalizeValidations,
} from './claude-code-tasks.js';
import {
  normalizeHookExecutions,
  normalizeInvocationPayloads,
  normalizeInvocations,
  normalizeModeEvents,
  normalizeModelCapabilities,
  normalizeModelUsage,
  normalizePayloads,
  normalizePermissionEvents,
  normalizePricingVersions,
} from './claude-code-usage.js';
import type { DetectionResult, SessionTransformer, TransformResult } from './contract.js';

export const CLAUDE_CODE_TRANSFORMER_ID = 'claude-code';
export const CLAUDE_CODE_TRANSFORMER_VERSION = '0.1.0';
export const CLAUDE_CODE_ONTOLOGY_VERSION = '0.1.0';

export interface ClaudeCodeBundle extends ArtifactBundle<string> {
  /** Manifest-supplied harness identity. Takes precedence over schema detection. */
  readonly harness?: 'claude-code' | (string & {});
}

const SUPPORTED_PARSER_KINDS = new Set<string>([
  'session-transcript',
  'subagent-transcript',
  'subagent-meta',
  'settings',
  'mcp-config',
  'agent-definition',
  'skill-definition',
  'rule-definition',
  'plugin-marketplace',
]);

function isClaudeArtifactKind(kind: string): boolean {
  return SUPPORTED_PARSER_KINDS.has(kind);
}

function toTextContent(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (content === null || content === undefined) return undefined;
  if (typeof content === 'object') {
    try {
      return JSON.stringify(content);
    } catch {
      return String(content);
    }
  }
  return String(content);
}

function normalizeSlashes(input: string): string {
  return input.replace(/\\/g, '/');
}

function deriveArtifactScope(relativePath: string, kind: ArtifactKind): ArtifactScope {
  const normalized = normalizeSlashes(relativePath);
  if (kind === 'transcript' || kind === 'subagent' || /(^|\/)subagents\//.test(normalized)) {
    return 'session';
  }
  if (
    /^~\/\.claude\//.test(normalized) ||
    /(^|\/)(Users|home)\/[^/]+\/\.claude\//.test(normalized) ||
    /(^|\/)\.claude\.json$/i.test(normalized)
  ) {
    return 'global';
  }
  if (
    /(^|\/)\.claude\//.test(normalized) ||
    /\.mcp\.json$/i.test(normalized) ||
    /(^|\/)(CLAUDE|AGENTS)\.md$/i.test(normalized)
  ) {
    return 'workspace';
  }
  return 'runtime';
}

function deriveClaudeScope(relativePath: string, artifactScope: ArtifactScope): string {
  const normalized = normalizeSlashes(relativePath);
  if (/(^|\/)\.claude\/settings\.local\.json$/i.test(normalized)) return 'local';
  if (/(^|\/)\.mcp\.json$/i.test(normalized)) return 'project';
  if (/(^|\/)\.claude\.json$/i.test(normalized)) return 'user';
  if (/(^|\/)plugins\//.test(normalized)) return 'plugin';
  if (artifactScope === 'global') return 'user';
  if (artifactScope === 'workspace') return 'project';
  return 'unknown';
}

function detectByPath(relativePath: string): { kind: ArtifactKind; role?: string } | undefined {
  const normalized = normalizeSlashes(relativePath).toLowerCase();
  if (/(^|\/)subagents\/[^/]+\.meta\.json$/.test(normalized)) {
    return { kind: 'subagent', role: 'metadata' };
  }
  if (/(^|\/)subagents\/[^/]+\.jsonl$/.test(normalized)) {
    return { kind: 'subagent', role: 'transcript' };
  }
  if (/(^|\/)\.claude\/skills\/[^/]+\/skill\.md$/.test(normalized)) {
    return { kind: 'skill' };
  }
  if (/(^|\/)\.claude\/agents\/[^/]+\.md$/.test(normalized)) {
    return { kind: 'agent' };
  }
  if (/(^|\/)\.claude\/rules\/.*\.md$/.test(normalized)) {
    return { kind: 'rule' };
  }
  if (/(^|\/)(claude|agents)\.md$/.test(normalized)) {
    return { kind: 'rule' };
  }
  if (/(^|\/)\.claude\/settings\.json$/.test(normalized)) {
    return { kind: 'settings' };
  }
  if (/(^|\/)\.claude\/settings\.local\.json$/.test(normalized)) {
    return { kind: 'settings' };
  }
  if (/(^|\/)\.mcp\.json$/.test(normalized)) {
    return { kind: 'mcp' };
  }
  if (/(^|\/)\.claude\.json$/.test(normalized)) {
    return { kind: 'mcp' };
  }
  if (/(^|\/)\.claude\/.*\.json$/.test(normalized)) {
    return { kind: 'settings' };
  }
  return undefined;
}

function parserKindToArtifactKind(
  parserKind: string,
  pathFallback: { kind: ArtifactKind; role?: string },
): { kind: ArtifactKind; role?: string } {
  switch (parserKind) {
    case 'session-transcript':
      return { kind: 'transcript' };
    case 'subagent-transcript':
      return { kind: 'subagent', role: 'transcript' };
    case 'subagent-meta':
      return { kind: 'subagent', role: 'metadata' };
    case 'settings':
      return { kind: 'settings' };
    case 'mcp-config':
      return { kind: 'mcp' };
    case 'agent-definition':
      return { kind: 'agent' };
    case 'skill-definition':
      return { kind: 'skill' };
    case 'rule-definition':
      return { kind: 'rule' };
    case 'plugin-marketplace':
      return { kind: 'unclassified' };
    default:
      return pathFallback;
  }
}

function inferMediaType(relativePath: string, fallback: string): string {
  const normalized = normalizeSlashes(relativePath).toLowerCase();
  if (normalized.endsWith('.jsonl')) return 'application/jsonl';
  if (normalized.endsWith('.json')) return 'application/json';
  if (normalized.endsWith('.md')) return 'text/markdown';
  if (fallback && fallback !== 'application/octet-stream') return fallback;
  return 'text/plain';
}

function artifactIdFor(artifact: { relativePath: string; sha256?: string }): string {
  return artifact.sha256 ? `sha256:${artifact.sha256}` : `path:${artifact.relativePath}`;
}

function stableId(
  namespace: string,
  parts: Record<string, string | number | boolean | undefined>,
): string {
  const ordered: Record<string, unknown> = {};
  for (const key of Object.keys(parts).sort()) {
    if (parts[key] !== undefined) ordered[key] = parts[key];
  }
  return `${namespace}:${JSON.stringify(ordered)}`;
}

function sourceIdentityFor(
  bundle: UnknownArtifactBundle,
  context: TransformContext,
): {
  ingestionSourceId: string;
  environmentId: string;
  projectId: string;
  sourceSessionId: string;
} {
  return {
    ingestionSourceId:
      bundle.sourceIdentity?.sourceId ?? context.sourceEnvironmentId ?? context.sourceFingerprint,
    environmentId: context.sourceEnvironmentId ?? bundle.sourceIdentity?.environmentId ?? 'unknown',
    projectId: context.sourceProjectId ?? bundle.sourceIdentity?.projectId ?? 'unknown',
    sourceSessionId: context.sourceSessionId ?? bundle.sourceIdentity?.sessionId ?? 'unknown',
  };
}

function deriveRootSessionId(
  bundle: UnknownArtifactBundle,
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
  bundle: UnknownArtifactBundle,
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

function makeIssue(
  code: string,
  message: string,
  severity: 'warning' | 'fatal' | 'recoverable',
  path?: string,
): Issue {
  return {
    code,
    severity,
    message,
    provenance: path ? { path } : undefined,
  };
}

function componentIdentity(
  componentId: string,
  nativeId: string,
  displayName: string,
  provider?: string,
): ComponentIdentity {
  return {
    canonicalId: componentId,
    nativeId,
    displayName,
    provider,
    integration: 'claude-code',
  };
}

function makeComponent(
  componentId: string,
  kind: ComponentKind,
  identity: ComponentIdentity,
  sourceArtifactIds: readonly string[],
  sourcePointer?: SourcePointer,
): ComponentSummary {
  return {
    componentId,
    kind,
    identity,
    sourceArtifactIds,
    sourcePointer,
  };
}

function sourcePointerForArtifact(
  artifactId: string,
  jsonPointer?: string,
  start?: number,
  end?: number,
): SourcePointer {
  const pointer: SourcePointer = { path: artifactId };
  if (jsonPointer && start !== undefined && end !== undefined) {
    return { path: artifactId, jsonPointer, range: { start, end } };
  }
  if (jsonPointer) {
    return { path: artifactId, jsonPointer };
  }
  if (start !== undefined && end !== undefined) {
    return { path: artifactId, range: { start, end } };
  }
  return pointer;
}

function extractSkillComponent(
  artifact: { relativePath: string; sha256?: string },
  content: string,
  source: ReturnType<typeof sourceIdentityFor>,
): ComponentSummary[] {
  const scope = deriveClaudeScope(
    artifact.relativePath,
    deriveArtifactScope(artifact.relativePath, 'skill'),
  );
  const def = parseSkillDefinition(
    content,
    artifact.relativePath,
    scope as SkillDefinition['scope'],
  );
  const qualified = def.pluginPrefix ? `${def.pluginPrefix}:${def.name}` : def.name;
  const componentId = stableId('skill', {
    source: source.ingestionSourceId,
    path: normalizeSlashes(artifact.relativePath),
    name: qualified,
  });
  return [
    makeComponent(
      componentId,
      'skill',
      componentIdentity(componentId, qualified, def.name, def.pluginPrefix),
      [artifactIdFor(artifact)],
      sourcePointerForArtifact(artifactIdFor(artifact), '/frontmatter/name'),
    ),
  ];
}

function extractAgentComponent(
  artifact: { relativePath: string; sha256?: string },
  content: string,
  source: ReturnType<typeof sourceIdentityFor>,
): ComponentSummary[] {
  const scope = deriveClaudeScope(
    artifact.relativePath,
    deriveArtifactScope(artifact.relativePath, 'agent'),
  );
  const def = parseAgentDefinition(
    content,
    artifact.relativePath,
    scope as AgentDefinition['scope'],
  );
  const componentId = stableId('agent', {
    source: source.ingestionSourceId,
    path: normalizeSlashes(artifact.relativePath),
    name: def.name,
  });
  return [
    makeComponent(
      componentId,
      'agent',
      componentIdentity(componentId, def.name, def.name),
      [artifactIdFor(artifact)],
      sourcePointerForArtifact(artifactIdFor(artifact), '/frontmatter/name'),
    ),
  ];
}

function extractRuleComponent(
  artifact: { relativePath: string; sha256?: string },
  content: string,
  source: ReturnType<typeof sourceIdentityFor>,
): ComponentSummary[] {
  const scope = deriveClaudeScope(
    artifact.relativePath,
    deriveArtifactScope(artifact.relativePath, 'rule'),
  );
  const def = parseRuleDefinition(content, artifact.relativePath, scope as RuleDefinition['scope']);
  const title = def.title ?? def.sourcePath;
  const componentId = stableId('rule', {
    source: source.ingestionSourceId,
    path: normalizeSlashes(artifact.relativePath),
    title,
  });
  return [
    makeComponent(
      componentId,
      'rule',
      componentIdentity(componentId, def.sourcePath, title, def.scope),
      [artifactIdFor(artifact)],
      sourcePointerForArtifact(artifactIdFor(artifact), '/frontmatter/globs'),
    ),
  ];
}

function extractMcpComponents(
  artifact: { relativePath: string; sha256?: string },
  content: string,
  source: ReturnType<typeof sourceIdentityFor>,
): ComponentSummary[] {
  const scope = deriveClaudeScope(
    artifact.relativePath,
    deriveArtifactScope(artifact.relativePath, 'mcp'),
  );
  const config = parseMcp(content, scope as McpConfig['scope'], artifact.relativePath);
  return config.servers.map((server, index) => {
    const componentId = stableId('mcp', {
      source: source.ingestionSourceId,
      path: normalizeSlashes(artifact.relativePath),
      server: server.name,
    });
    return makeComponent(
      componentId,
      'mcp',
      componentIdentity(componentId, server.name, server.name, server.toolNamespace),
      [artifactIdFor(artifact)],
      sourcePointerForArtifact(artifactIdFor(artifact), `/mcpServers/${index}`),
    );
  });
}

function extractSettingsComponents(
  artifact: { relativePath: string; sha256?: string },
  content: string,
  source: ReturnType<typeof sourceIdentityFor>,
): ComponentSummary[] {
  const scope = deriveClaudeScope(
    artifact.relativePath,
    deriveArtifactScope(artifact.relativePath, 'settings'),
  );
  const settings = parseSettings(
    content,
    scope as ClaudeCodeSettings['scope'],
    artifact.relativePath,
  );
  const settingsComponentId = stableId('settings', {
    source: source.ingestionSourceId,
    path: normalizeSlashes(artifact.relativePath),
    scope,
  });
  const components: ComponentSummary[] = [
    makeComponent(
      settingsComponentId,
      'settings',
      componentIdentity(settingsComponentId, 'settings', 'Settings', settings.scope),
      [artifactIdFor(artifact)],
      sourcePointerForArtifact(artifactIdFor(artifact)),
    ),
  ];

  if (settings.hooks) {
    for (const [event, groups] of Object.entries(settings.hooks)) {
      if (!Array.isArray(groups)) continue;
      for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
        const group = groups[groupIndex];
        if (!group || !Array.isArray(group.hooks)) continue;
        for (let hookIndex = 0; hookIndex < group.hooks.length; hookIndex++) {
          const hook = group.hooks[hookIndex];
          const hookComponentId = stableId('hook', {
            source: source.ingestionSourceId,
            path: normalizeSlashes(artifact.relativePath),
            event,
            group: groupIndex,
            hook: hookIndex,
          });
          components.push(
            makeComponent(
              hookComponentId,
              'tool',
              componentIdentity(
                hookComponentId,
                hook.type,
                `${hook.type} hook for ${event}`,
                hook.command,
              ),
              [artifactIdFor(artifact)],
              sourcePointerForArtifact(
                artifactIdFor(artifact),
                `/hooks/${event}/${groupIndex}/${hookIndex}`,
              ),
            ),
          );
        }
      }
    }
  }

  return components;
}

function extractComponents(
  artifact: { relativePath: string; sha256?: string; content: unknown },
  kind: ArtifactKind,
  source: ReturnType<typeof sourceIdentityFor>,
): { components: ComponentSummary[]; issues: Issue[] } {
  const content = toTextContent(artifact.content);
  if (content === undefined) {
    return {
      components: [],
      issues: [
        makeIssue('missing_content', `No content for artifact ${artifact.relativePath}`, 'warning'),
      ],
    };
  }
  try {
    switch (kind) {
      case 'skill':
        return { components: extractSkillComponent(artifact, content, source), issues: [] };
      case 'agent':
        return { components: extractAgentComponent(artifact, content, source), issues: [] };
      case 'rule':
        return { components: extractRuleComponent(artifact, content, source), issues: [] };
      case 'mcp':
        return { components: extractMcpComponents(artifact, content, source), issues: [] };
      case 'settings':
        return { components: extractSettingsComponents(artifact, content, source), issues: [] };
      default:
        return { components: [], issues: [] };
    }
  } catch (err) {
    return {
      components: [],
      issues: [
        makeIssue(
          'component_extraction_failed',
          `Failed to extract components from ${artifact.relativePath}: ${err instanceof Error ? err.message : String(err)}`,
          'warning',
        ),
      ],
    };
  }
}

function completenessFromComponents(
  components: ComponentSummary[],
  unclassifiedCount: number,
): ConfigurationSnapshot['completeness'] {
  const allKinds: ComponentKind[] = [
    'tool',
    'skill',
    'agent',
    'subagent',
    'rule',
    'mcp',
    'settings',
  ];
  const counts = new Map<ComponentKind, number>();
  for (const c of components) {
    counts.set(c.kind, (counts.get(c.kind) ?? 0) + 1);
  }
  const completeness: Record<string, ComponentCompleteness> = {};
  for (const kind of allKinds) {
    if ((counts.get(kind) ?? 0) > 0) {
      completeness[kind] = unclassifiedCount > 0 ? 'partial' : 'complete';
    } else {
      completeness[kind] = 'unavailable';
    }
  }
  return completeness;
}

function classifySingleArtifact(artifact: {
  relativePath: string;
  content: unknown;
  sha256?: string;
  size?: number;
  status?: ArtifactStatus;
  mediaType: string;
}): { classified: ClassifiedArtifact; detectedKind: string } {
  const content = toTextContent(artifact.content) ?? '';
  const pathFallback = detectByPath(artifact.relativePath) ?? {
    kind: 'unclassified' as ArtifactKind,
  };
  const parserKind = detectClaudeCodeArtifact({
    content,
    relativePath: artifact.relativePath,
  });
  const mapped = isClaudeArtifactKind(parserKind)
    ? parserKindToArtifactKind(parserKind, pathFallback)
    : pathFallback;

  let reason: string | undefined;
  if (mapped.kind === 'unclassified') {
    reason = 'path and content do not match any supported Claude artifact pattern';
  }
  const confidence: ClassifierConfidence =
    mapped.kind === 'unclassified'
      ? 'unclassified'
      : parserKind === 'unknown'
        ? 'inferred'
        : 'exact';

  const classified: ClassifiedArtifact = {
    relativePath: artifact.relativePath,
    kind: mapped.kind,
    scope: deriveArtifactScope(artifact.relativePath, mapped.kind),
    role: mapped.role,
    mediaType: inferMediaType(artifact.relativePath, artifact.mediaType),
    sha256: artifact.sha256,
    confidence,
    reason,
  };
  return { classified, detectedKind: parserKind };
}

function hasManifestHarness(bundle: UnknownArtifactBundle): 'claude-code' | undefined | string {
  const withHarness = bundle as UnknownArtifactBundle & { harness?: string };
  return withHarness.harness;
}

function isAssistantEntry(
  entry: ClaudeCodeEntry,
): entry is import('@lucasschirm/sal-claude-session-parser').AssistantEntry {
  return entry.type === 'assistant';
}

function isUserEntry(
  entry: ClaudeCodeEntry,
): entry is import('@lucasschirm/sal-claude-session-parser').UserEntry {
  return entry.type === 'user';
}

function entryTimestamp(entry: ClaudeCodeEntry): string | undefined {
  if ('timestamp' in entry && typeof entry.timestamp === 'string') {
    return entry.timestamp;
  }
  return undefined;
}

function sessionStartAndEnd(session: ClaudeCodeSession): { start?: string; end?: string } {
  const timestamps: string[] = [];
  for (const entry of session.entries) {
    const ts = entryTimestamp(entry);
    if (ts) timestamps.push(ts);
  }
  if (timestamps.length === 0) return {};
  timestamps.sort();
  return { start: timestamps[0], end: timestamps[timestamps.length - 1] };
}

function normalizeSessionSpine(
  session: ClaudeCodeSession,
  bundle: UnknownArtifactBundle,
  context: TransformContext,
  artifactId: string,
  parentSessionId?: string,
  resolvedRootSessionIdParam?: string,
  launch?: { toolUseId?: string; spawnDepth?: number } | undefined,
): {
  records: NormalizedEvidenceRecord[];
  summaries: SessionSummary[];
  warnings: Issue[];
} {
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

  const records: NormalizedEvidenceRecord[] = [];
  const warnings: Issue[] = [];
  const summaries: SessionSummary[] = [];

  const { start, end } = sessionStartAndEnd(session);

  records.push({
    recordId: stableId('session', { session: sessionId }),
    recordType: 'session',
    sessionId,
    sourceEventId: nativeSessionId,
    provenance: { artifactId, path: artifactId },
    payload: {
      harness: 'claude-code',
      nativeSessionId,
      aiTitle: session.aiTitle,
      slug: session.slug,
      agentName: session.agentName,
      cwd: session.cwd,
      gitBranch: session.gitBranch,
      cliVersions: session.cliVersions,
      isSidechain: session.isSidechain,
      agentId: session.agentId,
      startTime: start,
      endTime: end,
      finality: 'partial',
    },
  });

  if (parentSessionId) {
    records.push({
      recordId: stableId('session_relation', { child: sessionId }),
      recordType: 'session_relation',
      sessionId,
      parentId: parentSessionId,
      sourceEventId: launch?.toolUseId ?? sessionId,
      provenance: { artifactId, path: artifactId },
      payload: {
        rootSessionId: resolvedRootSessionId,
        parentSessionId,
        spawnInvocation: launch?.toolUseId,
        depth: launch?.spawnDepth ?? 1,
        nativeInclusionSemantics: 'subagent',
      },
    });
  }

  const turnIndexByUuid = new Map<string, string>();
  let userTurnId: string | undefined;
  let assistantTurnId: string | undefined;
  let turnOrdinal = 0;

  for (const entry of session.entries) {
    if (!isUserEntry(entry) && !isAssistantEntry(entry)) continue;

    const entryId =
      'uuid' in entry && typeof entry.uuid === 'string' ? entry.uuid : `line-${entry.lineNumber}`;
    const role = isUserEntry(entry) ? 'human' : 'assistant';
    const parentId = isUserEntry(entry)
      ? assistantTurnId
      : ('parentUuid' in entry &&
          typeof entry.parentUuid === 'string' &&
          turnIndexByUuid.get(entry.parentUuid)) ||
        userTurnId;

    const turnId = stableId('turn', { session: sessionId, uuid: entryId });
    turnIndexByUuid.set(entryId, turnId);
    turnOrdinal++;

    if (isUserEntry(entry)) {
      userTurnId = turnId;
    } else {
      assistantTurnId = turnId;
    }

    records.push({
      recordId: turnId,
      recordType: 'turn',
      sessionId,
      parentId,
      sourceEventId: entryId,
      sourceField: 'type',
      provenance: { artifactId, sourceEventId: entryId, path: artifactId },
      payload: {
        role,
        ordinal: turnOrdinal,
        entryType: entry.type,
        timestamp: entryTimestamp(entry),
      },
    });

    records.push({
      recordId: stableId('message', { session: sessionId, uuid: entryId }),
      recordType: 'message',
      sessionId,
      parentId: turnId,
      sourceEventId: entryId,
      sourceField: 'message',
      provenance: { artifactId, sourceEventId: entryId, path: artifactId },
      payload: {
        role,
        uuid: entryId,
        parentUuid: 'parentUuid' in entry ? entry.parentUuid : null,
        timestamp: entryTimestamp(entry),
        content: isAssistantEntry(entry)
          ? entry.message.content
          : isUserEntry(entry)
            ? entry.message.content
            : undefined,
        model: isAssistantEntry(entry) ? entry.message.model : undefined,
      },
    });

    if (isAssistantEntry(entry)) {
      const usage = entry.message.usage;
      records.push({
        recordId: stableId('model_request', { session: sessionId, uuid: entryId }),
        recordType: 'model_request',
        sessionId,
        parentId: turnId,
        sourceEventId: entryId,
        sourceField: 'usage',
        provenance: { artifactId, sourceEventId: entryId, sourceField: 'usage', path: artifactId },
        payload: {
          requestOrder: turnOrdinal,
          requestId: entry.requestId,
          model: entry.message.model,
          provider: 'anthropic',
          inputTokens: usage?.input_tokens,
          outputTokens: usage?.output_tokens,
          cacheCreationTokens: usage?.cache_creation_input_tokens,
          cacheReadTokens: usage?.cache_read_input_tokens,
          thinkingTokens: usage?.output_tokens_details?.thinking_tokens,
          timestamp: entryTimestamp(entry),
        },
      });
    }
  }

  for (const launch of session.subagentLaunches) {
    if (!launch.agentId) continue;
    const child = session.subagentSessions?.[launch.agentId];
    if (!child) {
      warnings.push(
        makeIssue(
          'missing_subagent_transcript',
          `Subagent launch references ${launch.agentId} but no transcript was supplied`,
          'warning',
          artifactId,
        ),
      );
      continue;
    }
    const childResult = normalizeSessionSpine(
      child,
      bundle,
      context,
      artifactId,
      sessionId,
      resolvedRootSessionId,
      { toolUseId: launch.toolUseId, spawnDepth: 1 },
    );
    records.push(...childResult.records);
    warnings.push(...childResult.warnings);
    summaries.push(...childResult.summaries);
  }

  const summary: SessionSummary = {
    sessionId,
    rootSessionId: resolvedRootSessionId,
    parentSessionId,
    harness: 'claude-code',
    startTime: start,
    endTime: end,
    finality: 'partial',
  };
  summaries.push(summary);

  return { records, summaries, warnings };
}

function buildSessionFromBundle(
  bundle: UnknownArtifactBundle,
  classification: ArtifactClassificationResult,
  warnings: Issue[],
  errors: Issue[],
): { session: ClaudeCodeSession | undefined; provenance: Provenance[] } {
  const classified = classification.artifacts;
  const transcriptArtifacts = classified.filter(
    (a) => a.kind === 'transcript' && a.role !== 'metadata',
  );
  if (transcriptArtifacts.length === 0) {
    errors.push(makeIssue('missing_root_transcript', 'No root transcript artifact found', 'fatal'));
    return { session: undefined, provenance: [] };
  }

  const rootArtifact = transcriptArtifacts[0];
  const rootContent = bundle.artifacts.find((a) => a.relativePath === rootArtifact.relativePath);
  if (!rootContent) {
    errors.push(
      makeIssue('missing_root_content', 'Root transcript artifact has no content', 'fatal'),
    );
    return { session: undefined, provenance: [] };
  }

  const content = toTextContent(rootContent.content);
  if (content === undefined) {
    errors.push(makeIssue('missing_root_content', 'Root transcript content is not text', 'fatal'));
    return { session: undefined, provenance: [] };
  }

  let builder = parseSession(content);
  const provenance: Provenance[] = [
    { artifactId: artifactIdFor(rootContent), path: rootArtifact.relativePath },
  ];

  const subagentArtifacts = classified.filter(
    (a) => a.kind === 'subagent' && a.role === 'transcript',
  );
  for (const subArtifact of subagentArtifacts) {
    const subContent = bundle.artifacts.find((a) => a.relativePath === subArtifact.relativePath);
    if (!subContent) continue;
    const subText = toTextContent(subContent.content);
    if (subText === undefined) continue;
    const subSession = parseSessionTranscript(subText);
    const agentId = subSession.agentId ?? subAgentIdFromPath(subArtifact.relativePath);
    if (!agentId) {
      warnings.push(
        makeIssue(
          'subagent_id_missing',
          `Could not determine subagent id for ${subArtifact.relativePath}`,
          'warning',
        ),
      );
      continue;
    }
    const metaArtifact = findSubagentMetaArtifact(bundle, classified, agentId);
    const meta = metaArtifact
      ? parseSubagentMeta(toTextContent(metaArtifact.content) ?? '')
      : undefined;
    builder = builder.appendSubAgent(agentId, subSession, meta);
    provenance.push({ artifactId: artifactIdFor(subContent), path: subArtifact.relativePath });
  }

  for (const artifact of bundle.artifacts) {
    const classifiedArtifact = classified.find((a) => a.relativePath === artifact.relativePath);
    if (!classifiedArtifact) continue;
    const text = toTextContent(artifact.content);
    if (text === undefined) continue;
    const scope = deriveClaudeScope(artifact.relativePath, classifiedArtifact.scope);
    try {
      switch (classifiedArtifact.kind) {
        case 'skill':
          builder = builder.appendSkill(
            parseSkillDefinition(text, artifact.relativePath, scope as SkillDefinition['scope']),
          );
          break;
        case 'agent':
          builder = builder.appendAgent(
            parseAgentDefinition(text, artifact.relativePath, scope as AgentDefinition['scope']),
          );
          break;
        case 'rule':
          builder = builder.appendRule(
            parseRuleDefinition(text, artifact.relativePath, scope as RuleDefinition['scope']),
          );
          break;
        case 'mcp':
          builder = builder.appendMcp(
            parseMcp(text, scope as McpConfig['scope'], artifact.relativePath),
          );
          break;
        case 'settings':
          builder = builder.appendSettings(
            parseSettings(text, scope as ClaudeCodeSettings['scope'], artifact.relativePath),
          );
          break;
      }
    } catch (err) {
      warnings.push(
        makeIssue(
          'append_config_failed',
          `Could not append config from ${artifact.relativePath}: ${err instanceof Error ? err.message : String(err)}`,
          'warning',
        ),
      );
    }
  }

  return { session: builder.toSession(), provenance };
}

function subAgentIdFromPath(relativePath: string): string | undefined {
  const normalized = normalizeSlashes(relativePath);
  const match = /(^|\/)subagents\/(?:agent-)?([^/]+)\.jsonl$/.exec(normalized);
  return match ? match[2] : undefined;
}

function findSubagentMetaArtifact(
  bundle: UnknownArtifactBundle,
  classified: readonly ClassifiedArtifact[],
  agentId: string,
): { relativePath: string; content: unknown } | undefined {
  const normalizedId = normalizeSlashes(agentId);
  const candidatePaths = [
    `subagents/agent-${normalizedId}.meta.json`,
    `subagents/${normalizedId}.meta.json`,
  ];
  for (const artifact of bundle.artifacts) {
    const classifiedArtifact = classified.find((a) => a.relativePath === artifact.relativePath);
    if (classifiedArtifact?.kind === 'subagent' && classifiedArtifact.role === 'metadata') {
      if (candidatePaths.includes(normalizeSlashes(artifact.relativePath))) {
        return artifact as { relativePath: string; content: unknown };
      }
    }
  }
  return undefined;
}

function makeProvenanceFromArtifacts(
  bundle: UnknownArtifactBundle,
  classification: ArtifactClassificationResult,
): Provenance[] {
  return classification.artifacts.map((a) => {
    const original = bundle.artifacts.find((art) => art.relativePath === a.relativePath);
    return {
      artifactId: original ? artifactIdFor(original) : a.relativePath,
      path: a.relativePath,
    };
  });
}

export const ClaudeCodeTransformer: SessionTransformer<UnknownArtifactBundle> = {
  id: CLAUDE_CODE_TRANSFORMER_ID,
  harnesses: [CLAUDE_CODE_TRANSFORMER_ID],
  transformerVersion: CLAUDE_CODE_TRANSFORMER_VERSION,
  ontologyVersion: CLAUDE_CODE_ONTOLOGY_VERSION,

  detect(bundle: UnknownArtifactBundle): DetectionResult {
    const manifestHarness = hasManifestHarness(bundle);
    if (manifestHarness === CLAUDE_CODE_TRANSFORMER_ID) {
      return {
        kind: 'matched',
        harness: CLAUDE_CODE_TRANSFORMER_ID,
        confidence: 1,
        reason: 'manifest harness identity',
      };
    }
    if (manifestHarness !== undefined && manifestHarness.length > 0) {
      return {
        kind: 'unmatched',
        reason: `manifest harness is ${manifestHarness}`,
      };
    }

    const artifacts = bundle.artifacts ?? [];
    if (artifacts.length === 0) {
      return { kind: 'unmatched', reason: 'bundle contains no artifacts' };
    }

    const detectedKinds = new Set<string>();
    const recognizedArtifacts = new Set<string>();
    let rootTranscriptCount = 0;
    for (const artifact of artifacts) {
      const content = toTextContent(artifact.content);
      const parserKind = detectClaudeCodeArtifact({
        content: content ?? '',
        relativePath: artifact.relativePath,
      });
      if (isClaudeArtifactKind(parserKind)) {
        detectedKinds.add(parserKind);
        recognizedArtifacts.add(artifact.relativePath);
        if (parserKind === 'session-transcript') {
          rootTranscriptCount++;
        }
      } else {
        const byPath = detectByPath(artifact.relativePath);
        if (byPath) {
          recognizedArtifacts.add(artifact.relativePath);
          if (byPath.kind === 'transcript') {
            rootTranscriptCount++;
          }
        }
      }
    }

    if (recognizedArtifacts.size === 0) {
      return { kind: 'unmatched', reason: 'no recognized Claude Code artifacts' };
    }

    if (rootTranscriptCount > 1) {
      return {
        kind: 'unmatched',
        reason: 'ambiguous: multiple root transcripts without a manifest main transcript path',
      };
    }

    return {
      kind: 'matched',
      harness: CLAUDE_CODE_TRANSFORMER_ID,
      confidence: Math.max(0.5, 0.5 + recognizedArtifacts.size / (artifacts.length * 2)),
      reason:
        recognizedArtifacts.size === artifacts.length
          ? 'all artifacts recognized as Claude Code'
          : 'some artifacts recognized as Claude Code',
    };
  },

  classifyArtifacts(bundle: UnknownArtifactBundle): ArtifactClassificationResult {
    const source = {
      ingestionSourceId: bundle.sourceIdentity?.sourceId ?? 'manual',
      environmentId: bundle.sourceIdentity?.environmentId ?? 'unknown',
      projectId: bundle.sourceIdentity?.projectId ?? 'unknown',
      sourceSessionId: bundle.sourceIdentity?.sessionId ?? 'unknown',
    };

    const classifiedArtifacts: ClassifiedArtifact[] = [];
    const components: ComponentSummary[] = [];
    const warnings: Issue[] = [];
    let unclassifiedCount = 0;

    for (const artifact of bundle.artifacts) {
      const { classified, detectedKind } = classifySingleArtifact(artifact);
      classifiedArtifacts.push(classified);

      if (classified.kind === 'unclassified') {
        unclassifiedCount++;
        warnings.push(
          makeIssue(
            'unclassified_artifact',
            `${artifact.relativePath} is unclassified (detected kind: ${detectedKind})`,
            'warning',
            artifact.relativePath,
          ),
        );
        continue;
      }

      const extracted = extractComponents(artifact, classified.kind, source);
      components.push(...extracted.components);
      warnings.push(...extracted.issues);

      if (extracted.components.length > 0 && classified.sourcePointers === undefined) {
        (classified as ClassifiedArtifact & { sourcePointers: SourcePointer[] }).sourcePointers =
          extracted.components
            .map((c) => c.sourcePointer)
            .filter((p): p is SourcePointer => p !== undefined);
      }
    }

    const configurationSnapshot: ConfigurationSnapshot = {
      completeness: completenessFromComponents(components, unclassifiedCount),
      components,
    };

    return {
      artifacts: classifiedArtifacts,
      configurationSnapshot,
      components,
      warnings,
    };
  },

  getCapabilities(bundle?: UnknownArtifactBundle): MetricCapability[] {
    return [
      ...getClaudeCodeMetricCapabilities(bundle),
      ...getClaudeCodeOptimizationMetricCapabilities(bundle),
      ...getClaudeCodeAttributionMetricCapabilities(bundle),
    ];
  },

  transform(bundle: UnknownArtifactBundle, context: TransformContext): TransformResult {
    const classification = this.classifyArtifacts(bundle);
    const warnings: Issue[] = [...(classification.warnings ?? [])];
    const errors: Issue[] = [];

    const { session, provenance } = buildSessionFromBundle(
      bundle,
      classification,
      warnings,
      errors,
    );
    if (session) {
      const rootContent = bundle.artifacts.find(
        (a) =>
          a.relativePath ===
          classification.artifacts.find((ca) => ca.kind === 'transcript')?.relativePath,
      );
      const rootArtifactId = rootContent ? artifactIdFor(rootContent) : context.sourceFingerprint;
      const spine = normalizeSessionSpine(session, bundle, context, rootArtifactId);
      warnings.push(...spine.warnings);

      const rootSessionId = deriveRootSessionId(bundle, context, session.sessionId ?? 'unknown');
      const evidenceContext: ClaudeCodeEvidenceContext = {
        ...context,
        sessionId: rootSessionId,
        rootSessionId,
        artifactId: rootArtifactId,
      };

      const usageRecords = [
        ...normalizeModelUsage(session, bundle, context, rootArtifactId),
        ...normalizeModelCapabilities(session, bundle, context, rootArtifactId),
        ...normalizePricingVersions(session, bundle, context, rootArtifactId),
        ...normalizeInvocations(session, bundle, context, rootArtifactId),
        ...normalizePayloads(session, bundle, context, rootArtifactId),
        ...normalizeInvocationPayloads(session, bundle, context, rootArtifactId),
        ...normalizePermissionEvents(session, bundle, context, rootArtifactId),
        ...normalizeModeEvents(session, bundle, context, rootArtifactId),
        ...normalizeHookExecutions(session, bundle, context, rootArtifactId),
      ];

      const taskRecords = [
        ...normalizeTasks(session, evidenceContext),
        ...normalizeFileOperations(session, evidenceContext),
        ...normalizeCommandExecutions(session, evidenceContext),
        ...normalizeValidations(session, evidenceContext),
        ...normalizeNormalizedEvents(session, evidenceContext),
      ];
      const evidenceLinkRecords = normalizeComponentEvidenceLinks(
        session,
        classification.components,
        [...spine.records, ...usageRecords, ...taskRecords],
        evidenceContext,
      );

      const allEvidence = [
        ...spine.records,
        ...usageRecords,
        ...taskRecords,
        ...evidenceLinkRecords,
      ];

      const metrics = deriveClaudeCodeMetrics(
        session,
        allEvidence,
        bundle,
        context,
        rootArtifactId,
      );
      const optimizationMetrics = deriveClaudeCodeOptimizationMetrics(
        session,
        allEvidence,
        bundle,
        context,
        rootArtifactId,
      );
      const attributionMetrics = deriveClaudeCodeAttributionMetrics(
        session,
        allEvidence,
        bundle,
        context,
        rootArtifactId,
      );

      const allMetricValues = [
        ...metrics.metricValues,
        ...optimizationMetrics.metricValues,
        ...attributionMetrics.metricValues,
      ];
      const allMetricProvenance = [
        ...metrics.metricProvenance,
        ...optimizationMetrics.metricProvenance,
        ...attributionMetrics.metricProvenance,
      ];
      const allCapabilities = [
        ...metrics.capabilities,
        ...optimizationMetrics.capabilities,
        ...attributionMetrics.capabilities,
      ];
      const allUnavailableReasons = [
        ...metrics.unavailableReasons,
        ...optimizationMetrics.unavailableReasons,
        ...attributionMetrics.unavailableReasons,
      ];

      const allProvenance = [
        ...provenance,
        ...makeProvenanceFromArtifacts(bundle, classification),
        ...allMetricProvenance,
      ];

      return {
        bundleHash: context.sourceFingerprint,
        parserId: context.parserId,
        parserVersion: context.parserVersion,
        transformerId: CLAUDE_CODE_TRANSFORMER_ID,
        transformerVersion: CLAUDE_CODE_TRANSFORMER_VERSION,
        ontologyVersion: CLAUDE_CODE_ONTOLOGY_VERSION,
        metricDefinitionVersion: CLAUDE_CODE_METRIC_DEFINITION_VERSION,
        evidence: allEvidence,
        sessionSummaries: spine.summaries,
        componentSummaries: classification.components,
        metricValues: allMetricValues,
        distributions: [],
        configurationSnapshot: classification.configurationSnapshot,
        capabilities: allCapabilities,
        unavailableReasons: allUnavailableReasons,
        provenance: allProvenance,
        warnings,
        errors,
      };
    }

    const failureCaps = [
      ...getClaudeCodeMetricCapabilities(bundle),
      ...getClaudeCodeOptimizationMetricCapabilities(bundle),
      ...getClaudeCodeAttributionMetricCapabilities(bundle),
    ];
    return {
      bundleHash: context.sourceFingerprint,
      parserId: context.parserId,
      parserVersion: context.parserVersion,
      transformerId: CLAUDE_CODE_TRANSFORMER_ID,
      transformerVersion: CLAUDE_CODE_TRANSFORMER_VERSION,
      ontologyVersion: CLAUDE_CODE_ONTOLOGY_VERSION,
      metricDefinitionVersion: CLAUDE_CODE_METRIC_DEFINITION_VERSION,
      evidence: [],
      sessionSummaries: [],
      componentSummaries: classification.components,
      metricValues: [],
      distributions: [],
      configurationSnapshot: classification.configurationSnapshot,
      capabilities: failureCaps,
      unavailableReasons: failureCaps
        .filter((c) => c.state === 'unavailable')
        .map((c) => ({
          metricId: c.metricId,
          definitionVersion: c.definitionVersion,
          reason: c.reason ?? 'unavailable',
        })),
      provenance: makeProvenanceFromArtifacts(bundle, classification),
      warnings,
      errors,
    };
  },
};
