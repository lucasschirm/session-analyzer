import type { ClaudeCodeSession } from '@lucasschirm/sal-claude-session-parser';
import { detectClaudeCodeArtifact, parseSession } from '@lucasschirm/sal-claude-session-parser';
import type { UnknownArtifactBundle } from '../bundle.js';
import { type ComparabilityGroupSpec, deriveComparabilityGroupId } from '../comparability.js';
import type { TransformContext } from '../context.js';
import type { NormalizedEvidenceRecord } from '../evidence.js';
import type { MetricCapability, MetricUnavailableReason } from '../metric.js';
import type { Provenance } from '../provenance.js';
import type {
  ClaudeMetricsResult,
  ClaudeMetricValue,
  MetricDefinition,
  MetricProvenance,
} from './claude-code-metrics.js';
import type {
  ClaudeCodeEvidenceContext,
  FileOperationRecordPayload,
  NormalizedEventRecordPayload,
  ValidationRecordPayload,
} from './claude-code-tasks.js';
import {
  normalizeFileOperations,
  normalizeNormalizedEvents,
  normalizeValidations,
} from './claude-code-tasks.js';
import type {
  InvocationPayload,
  ModelUsagePayload,
  PayloadRecordPayload,
} from './claude-code-usage.js';

export const CLAUDE_CODE_OPTIMIZATION_METRIC_DEFINITION_VERSION = '0.1.0';
const NATIVE_MAPPING_VERSION = 'claude-code-0.1.0';
const STATISTICAL_POLICY_ID = 'claude-default';
const PROVENANCE_REQUIREMENT = 'source_artifact_event_field';

// ---------------------------------------------------------------------------
// Local metric definition contract (§9)
// ---------------------------------------------------------------------------

interface DefinitionOptions {
  readonly allocationMethod?: string;
  readonly missingDataBehavior?: 'unknown' | 'not_applicable';
  readonly denominator?: string;
}

function metricDefinition(
  metricId: string,
  label: string,
  description: string,
  family: string,
  unit: string,
  valueType: 'integer' | 'real' | 'currency' | 'ratio' | 'text',
  measurementClass: 'observed' | 'derived' | 'estimated' | 'heuristic',
  dimensions: readonly string[],
  rootInclusion: 'root_only' | 'inclusive',
  aggregation: string,
  populationRule: string,
  statusRule: string,
  options: DefinitionOptions = {},
): MetricDefinition {
  return {
    metricId,
    version: 1,
    label,
    description,
    family,
    measurementClass,
    unit,
    valueType,
    grain: 'session',
    dimensions,
    denominator: options.denominator,
    populationRule,
    statusRule,
    aggregation,
    allocationMethod: options.allocationMethod,
    statisticalPolicyId: STATISTICAL_POLICY_ID,
    comparabilityGroupInputs: [
      'metricId',
      'definitionVersion',
      'unit',
      'grain',
      'dimensions',
      'denominator',
      'observationUnit',
      'populationRule',
      'sessionFinalityRules',
      'measurementClass',
      'nativeMappingVersion',
      'rootOnlyInclusive',
      'statusThresholdCensoringMissingDataRules',
      'aggregationStatisticalAttributionMethod',
    ],
    missingDataBehavior: options.missingDataBehavior ?? 'unknown',
    rootInclusion,
    distributionPolicy: undefined,
    provenanceRequirement: PROVENANCE_REQUIREMENT,
  };
}

// ---------------------------------------------------------------------------
// Evidence requirement helpers
// ---------------------------------------------------------------------------

type EvidenceRequirement =
  | 'always'
  | 'assistant_requests'
  | 'compactions'
  | 'invocations'
  | 'validations'
  | 'edit_cycles';

const requiredEvidenceByMetricId = new Map<string, EvidenceRequirement>();

interface BaseMetricSpec {
  readonly metricId: string;
  readonly label: string;
  readonly description: string;
  readonly family: string;
  readonly unit: string;
  readonly valueType: 'integer' | 'real' | 'ratio';
  readonly measurementClass: 'observed' | 'derived';
  readonly dimensions: readonly string[];
  readonly aggregation: string;
  readonly populationRule: string;
  readonly statusRule: string;
  readonly requiredEvidence: EvidenceRequirement;
}

const BASE_SPECS: readonly BaseMetricSpec[] = [
  {
    metricId: 'claude:context:first_request_tokens',
    label: 'First request tokens',
    description: 'Total input tokens in the chronologically first assistant request.',
    family: 'context',
    unit: 'token',
    valueType: 'integer',
    measurementClass: 'observed',
    dimensions: [],
    aggregation: 'mean',
    populationRule: 'sessions_with_assistant_requests',
    statusRule: 'include_partial_censored',
    requiredEvidence: 'assistant_requests',
  },
  {
    metricId: 'claude:context:growth_max_tokens',
    label: 'Context growth max tokens',
    description:
      'Maximum positive delta of total input tokens across assistant requests relative to the first request anchor. Negative deltas are never subtracted from the first-request anchor.',
    family: 'context',
    unit: 'token',
    valueType: 'integer',
    measurementClass: 'derived',
    dimensions: [],
    aggregation: 'max',
    populationRule: 'sessions_with_assistant_requests',
    statusRule: 'right_censored_partial',
    requiredEvidence: 'assistant_requests',
  },
  {
    metricId: 'claude:context:growth_mean_tokens',
    label: 'Context growth mean tokens',
    description:
      'Mean positive delta of total input tokens across assistant requests relative to the first request anchor.',
    family: 'context',
    unit: 'token',
    valueType: 'real',
    measurementClass: 'derived',
    dimensions: [],
    aggregation: 'mean',
    populationRule: 'sessions_with_assistant_requests',
    statusRule: 'right_censored_partial',
    requiredEvidence: 'assistant_requests',
  },
  {
    metricId: 'claude:cache:hit_rate',
    label: 'Cache read rate',
    description: 'Cache read tokens divided by total input tokens.',
    family: 'cache',
    unit: 'fraction',
    valueType: 'ratio',
    measurementClass: 'derived',
    dimensions: [],
    aggregation: 'non-additive',
    populationRule: 'sessions_with_input_tokens',
    statusRule: 'right_censored_partial',
    requiredEvidence: 'assistant_requests',
  },
  {
    metricId: 'claude:cache:write_rate',
    label: 'Cache creation rate',
    description: 'Cache creation tokens divided by total input tokens.',
    family: 'cache',
    unit: 'fraction',
    valueType: 'ratio',
    measurementClass: 'derived',
    dimensions: [],
    aggregation: 'non-additive',
    populationRule: 'sessions_with_input_tokens',
    statusRule: 'right_censored_partial',
    requiredEvidence: 'assistant_requests',
  },
  {
    metricId: 'claude:compaction:count',
    label: 'Compaction count',
    description: 'Number of observed context compaction events.',
    family: 'compaction',
    unit: 'count',
    valueType: 'integer',
    measurementClass: 'observed',
    dimensions: [],
    aggregation: 'sum',
    populationRule: 'all_sessions',
    statusRule: 'include_partial_censored',
    requiredEvidence: 'always',
  },
  {
    metricId: 'claude:compaction:dropped_tokens',
    label: 'Compaction dropped tokens',
    description: 'Sum of tokens dropped across compaction events (preTokens - postTokens).',
    family: 'compaction',
    unit: 'token',
    valueType: 'integer',
    measurementClass: 'observed',
    dimensions: [],
    aggregation: 'sum',
    populationRule: 'all_sessions',
    statusRule: 'include_partial_censored',
    requiredEvidence: 'always',
  },
  {
    metricId: 'claude:compaction:retention_ratio',
    label: 'Compaction retention ratio',
    description:
      'Ratio of post-compaction tokens to pre-compaction tokens, computed as total post / total pre.',
    family: 'compaction',
    unit: 'fraction',
    valueType: 'ratio',
    measurementClass: 'derived',
    dimensions: [],
    aggregation: 'non-additive',
    populationRule: 'sessions_with_compactions',
    statusRule: 'right_censored_partial',
    requiredEvidence: 'compactions',
  },
  {
    metricId: 'claude:payload:count',
    label: 'Payload count',
    description: 'Count of normalized payload records by payload type.',
    family: 'payload',
    unit: 'count',
    valueType: 'integer',
    measurementClass: 'observed',
    dimensions: ['payload_type'],
    aggregation: 'sum',
    populationRule: 'all_sessions',
    statusRule: 'right_censored_partial',
    requiredEvidence: 'always',
  },
  {
    metricId: 'claude:payload:max_bytes',
    label: 'Payload max bytes',
    description: 'Maximum byte size of normalized payload records by payload type.',
    family: 'payload',
    unit: 'byte',
    valueType: 'integer',
    measurementClass: 'observed',
    dimensions: ['payload_type'],
    aggregation: 'max',
    populationRule: 'all_sessions',
    statusRule: 'right_censored_partial',
    requiredEvidence: 'invocations',
  },
  {
    metricId: 'claude:payload:mean_bytes',
    label: 'Payload mean bytes',
    description: 'Mean byte size of normalized payload records by payload type.',
    family: 'payload',
    unit: 'byte',
    valueType: 'real',
    measurementClass: 'derived',
    dimensions: ['payload_type'],
    aggregation: 'mean',
    populationRule: 'all_sessions',
    statusRule: 'right_censored_partial',
    requiredEvidence: 'invocations',
  },
  {
    metricId: 'claude:latency:max_invocation_ms',
    label: 'Max invocation latency',
    description: 'Maximum observed tool invocation latency in milliseconds.',
    family: 'latency',
    unit: 'ms',
    valueType: 'integer',
    measurementClass: 'observed',
    dimensions: [],
    aggregation: 'max',
    populationRule: 'sessions_with_completed_invocations',
    statusRule: 'right_censored_partial',
    requiredEvidence: 'invocations',
  },
  {
    metricId: 'claude:latency:mean_invocation_ms',
    label: 'Mean invocation latency',
    description: 'Mean observed tool invocation latency in milliseconds.',
    family: 'latency',
    unit: 'ms',
    valueType: 'real',
    measurementClass: 'derived',
    dimensions: [],
    aggregation: 'mean',
    populationRule: 'sessions_with_completed_invocations',
    statusRule: 'right_censored_partial',
    requiredEvidence: 'invocations',
  },
  {
    metricId: 'claude:parallelism:max_concurrent_invocations',
    label: 'Max concurrent invocations',
    description: 'Maximum number of tool invocations issued in a single assistant turn.',
    family: 'parallelism',
    unit: 'count',
    valueType: 'integer',
    measurementClass: 'derived',
    dimensions: [],
    aggregation: 'max',
    populationRule: 'all_sessions',
    statusRule: 'right_censored_partial',
    requiredEvidence: 'always',
  },
  {
    metricId: 'claude:validation:success_rate',
    label: 'Validation success rate',
    description: 'Proportion of validation executions with a successful or warning outcome.',
    family: 'validation',
    unit: 'fraction',
    valueType: 'ratio',
    measurementClass: 'derived',
    dimensions: [],
    aggregation: 'non-additive',
    populationRule: 'sessions_with_validations',
    statusRule: 'right_censored_partial',
    requiredEvidence: 'validations',
  },
  {
    metricId: 'claude:validation:failure_rate',
    label: 'Validation failure rate',
    description: 'Proportion of validation executions with a failure outcome.',
    family: 'validation',
    unit: 'fraction',
    valueType: 'ratio',
    measurementClass: 'derived',
    dimensions: [],
    aggregation: 'non-additive',
    populationRule: 'sessions_with_validations',
    statusRule: 'right_censored_partial',
    requiredEvidence: 'validations',
  },
  {
    metricId: 'claude:edit_cycle:count',
    label: 'Edit cycle count',
    description:
      'Number of file write/edit/create operations followed by a validation on the same target.',
    family: 'edit_cycle',
    unit: 'count',
    valueType: 'integer',
    measurementClass: 'derived',
    dimensions: [],
    aggregation: 'sum',
    populationRule: 'sessions_with_edit_cycles',
    statusRule: 'right_censored_partial',
    requiredEvidence: 'edit_cycles',
  },
  {
    metricId: 'claude:edit_cycle:success_rate',
    label: 'Edit cycle success rate',
    description: 'Proportion of edit cycles where the follow-up validation succeeded or warned.',
    family: 'edit_cycle',
    unit: 'fraction',
    valueType: 'ratio',
    measurementClass: 'derived',
    dimensions: [],
    aggregation: 'non-additive',
    populationRule: 'sessions_with_edit_cycles',
    statusRule: 'right_censored_partial',
    requiredEvidence: 'edit_cycles',
  },
];

export function getClaudeCodeOptimizationMetricDefinitions(): readonly MetricDefinition[] {
  const definitions: MetricDefinition[] = [];
  for (const scope of ['root_only', 'inclusive'] as const) {
    const scopeLabel = scope === 'root_only' ? 'root-only' : 'inclusive';
    for (const spec of BASE_SPECS) {
      const metricId = `${spec.metricId}:${scope}`;
      definitions.push(
        metricDefinition(
          metricId,
          `${spec.label} (${scopeLabel})`,
          `${spec.description} Scope: ${scopeLabel}.`,
          spec.family,
          spec.unit,
          spec.valueType,
          spec.measurementClass,
          spec.dimensions,
          scope,
          spec.aggregation,
          spec.populationRule,
          spec.statusRule,
        ),
      );
      requiredEvidenceByMetricId.set(metricId, spec.requiredEvidence);
    }
  }
  return definitions;
}

// ---------------------------------------------------------------------------
// Stable identity and provenance
// ---------------------------------------------------------------------------

function stableId(namespace: string, parts: Record<string, unknown>): string {
  const ordered: Record<string, unknown> = {};
  for (const key of Object.keys(parts).sort()) {
    const value = parts[key];
    if (value !== undefined) ordered[key] = value;
  }
  return `${namespace}:${JSON.stringify(ordered)}`;
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

function sourceIdentityFor(
  bundle: UnknownArtifactBundle,
  context: TransformContext,
): {
  readonly ingestionSourceId: string;
  readonly environmentId: string;
  readonly projectId: string;
  readonly sourceSessionId: string;
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

function provenanceForRecord(record: NormalizedEvidenceRecord, artifactId: string): Provenance {
  return {
    artifactId: record.provenance.artifactId ?? artifactId,
    path: record.provenance.path ?? artifactId,
    sourceEventId: record.provenance.sourceEventId ?? record.sourceEventId,
    sourceField: record.provenance.sourceField ?? record.sourceField,
  };
}

function comparabilityGroupFor(
  definition: MetricDefinition,
  dimensions: Readonly<Record<string, string>>,
  currencyPricingVersion?: string,
): string {
  const spec: ComparabilityGroupSpec = {
    metricId: definition.metricId,
    metricDefinitionVersion: CLAUDE_CODE_OPTIMIZATION_METRIC_DEFINITION_VERSION,
    unit: definition.unit,
    currencyPricingVersion,
    grain: definition.grain,
    dimensions,
    denominator: definition.denominator,
    observationUnit: 'session',
    population: definition.populationRule,
    sessionFinalityRules: definition.statusRule,
    measurementClass: definition.measurementClass,
    nativeMappingVersion: NATIVE_MAPPING_VERSION,
    rootOnlyInclusive: definition.rootInclusion === 'root_only' ? 'root_only' : 'inclusive',
    statusThresholdCensoringMissingDataRules: definition.missingDataBehavior,
    aggregationStatisticalAttributionMethod: definition.aggregation,
  };
  return deriveComparabilityGroupId(spec);
}

function dimensionsFor(
  definition: MetricDefinition,
  dimensionValue?: string,
): Record<string, string> {
  if (definition.dimensions.length === 0 || !dimensionValue) return {};
  return { [definition.dimensions[0]]: dimensionValue };
}

function createMetricValue(input: {
  readonly definition: MetricDefinition;
  readonly value: number | null;
  readonly exact: boolean;
  readonly evidenceRecordIds: readonly string[];
  readonly provenance: readonly Provenance[];
  readonly dimensionValue?: string;
  readonly currencyPricingVersion?: string;
  readonly estimationMethod?: string;
  readonly allocationMethod?: string;
  readonly unavailableReason?: string;
  readonly partialReason?: string;
}): ClaudeMetricValue {
  const dimensions = dimensionsFor(input.definition, input.dimensionValue);
  return {
    metricId: input.definition.metricId,
    definitionVersion: CLAUDE_CODE_OPTIMIZATION_METRIC_DEFINITION_VERSION,
    value: input.value,
    exact: input.exact,
    unit: input.definition.unit,
    comparabilityGroupId: comparabilityGroupFor(
      input.definition,
      dimensions,
      input.currencyPricingVersion,
    ),
    provenanceArtifactId: input.provenance[0]?.path,
    grain: input.definition.grain,
    dimensions,
    class: input.definition.measurementClass,
    confidence: input.value === null ? 0 : input.exact ? 1 : 0.75,
    rootScope: input.definition.rootInclusion === 'root_only' ? 'root_only' : 'inclusive',
    evidenceRecordIds: input.evidenceRecordIds,
    provenance: input.provenance,
    estimationMethod: input.estimationMethod,
    allocationMethod: input.allocationMethod ?? input.definition.allocationMethod,
    unavailableReason: input.unavailableReason,
    partialReason: input.partialReason,
    definition: input.definition,
  };
}

// ---------------------------------------------------------------------------
// Evidence context
// ---------------------------------------------------------------------------

interface EvidenceContext {
  readonly rootSessionId: string;
  readonly childSessionIds: ReadonlySet<string>;
}

function buildEvidenceContext(
  session: ClaudeCodeSession,
  bundle: UnknownArtifactBundle,
  context: TransformContext,
): EvidenceContext {
  const rootSessionId = deriveRootSessionId(bundle, context, session.sessionId ?? 'unknown');
  const childSessionIds = new Set<string>();
  for (const launch of session.subagentLaunches) {
    const agentId = launch.agentId;
    if (!agentId) continue;
    const sub = session.subagentSessions?.[agentId];
    if (!sub) continue;
    childSessionIds.add(
      deriveChildSessionId(bundle, context, rootSessionId, agentId, sub.sessionId ?? 'unknown'),
    );
  }
  return { rootSessionId, childSessionIds };
}

function isRootRecord(record: NormalizedEvidenceRecord, ctx: EvidenceContext): boolean {
  return record.sessionId === ctx.rootSessionId;
}

function inSessionTree(record: NormalizedEvidenceRecord, ctx: EvidenceContext): boolean {
  return record.sessionId === ctx.rootSessionId || ctx.childSessionIds.has(record.sessionId);
}

function* visitAllSessions(session: ClaudeCodeSession): Generator<ClaudeCodeSession> {
  yield session;
  for (const launch of session.subagentLaunches) {
    const agentId = launch.agentId;
    if (!agentId) continue;
    const sub = session.subagentSessions?.[agentId];
    if (sub) yield* visitAllSessions(sub);
  }
}

function buildSubagentContexts(
  session: ClaudeCodeSession,
  bundle: UnknownArtifactBundle,
  context: TransformContext,
  rootArtifactId: string,
): { readonly session: ClaudeCodeSession; readonly context: ClaudeCodeEvidenceContext }[] {
  const ctx = buildEvidenceContext(session, bundle, context);
  const contexts: {
    readonly session: ClaudeCodeSession;
    readonly context: ClaudeCodeEvidenceContext;
  }[] = [];
  for (const launch of session.subagentLaunches) {
    const agentId = launch.agentId;
    if (!agentId) continue;
    const sub = session.subagentSessions?.[agentId];
    if (!sub) continue;
    const childSessionId = deriveChildSessionId(
      bundle,
      context,
      ctx.rootSessionId,
      agentId,
      sub.sessionId ?? 'unknown',
    );
    contexts.push({
      session: sub,
      context: {
        ...context,
        sessionId: childSessionId,
        rootSessionId: ctx.rootSessionId,
        parentSessionId: ctx.rootSessionId,
        artifactId: rootArtifactId,
        includeRawContent: false,
      },
    });
  }
  return contexts;
}

function collectByScope<T extends NormalizedEvidenceRecord>(
  records: readonly T[],
  recordType: string,
  ctx: EvidenceContext,
): { readonly root: T[]; readonly inclusive: T[] } {
  const root: T[] = [];
  const inclusive: T[] = [];
  for (const record of records) {
    if (record.recordType !== recordType) continue;
    if (!inSessionTree(record, ctx)) continue;
    inclusive.push(record);
    if (isRootRecord(record, ctx)) root.push(record);
  }
  return { root, inclusive };
}

function buildTurnMap(
  evidence: readonly NormalizedEvidenceRecord[],
): Map<string, { readonly timestamp?: number }> {
  const map = new Map<string, { readonly timestamp?: number }>();
  for (const record of evidence) {
    if (record.recordType !== 'turn') continue;
    const payload = record.payload as { timestamp?: string; ordinal?: number };
    const parsed = typeof payload.timestamp === 'string' ? Date.parse(payload.timestamp) : NaN;
    map.set(record.recordId, { timestamp: Number.isNaN(parsed) ? undefined : parsed });
  }
  return map;
}

function sortModelUsage(
  records: NormalizedEvidenceRecord[],
  turnMap: Map<string, { readonly timestamp?: number }>,
): NormalizedEvidenceRecord[] {
  return [...records].sort((a, b) => {
    const ta = turnMap.get((a.payload as ModelUsagePayload).turnRecordId)?.timestamp;
    const tb = turnMap.get((b.payload as ModelUsagePayload).turnRecordId)?.timestamp;
    if (ta !== undefined && tb !== undefined) return ta - tb;
    if (ta !== undefined) return -1;
    if (tb !== undefined) return 1;
    return 0;
  });
}

// ---------------------------------------------------------------------------
// Session extraction and censoring detection
// ---------------------------------------------------------------------------

function extractRootSession(bundle: UnknownArtifactBundle): ClaudeCodeSession | undefined {
  for (const artifact of bundle.artifacts) {
    const text = toTextContent(artifact.content);
    if (text === undefined) continue;
    const kind = detectClaudeCodeArtifact({ content: text, relativePath: artifact.relativePath });
    if (kind === 'session-transcript') {
      try {
        return parseSession(text).toSession();
      } catch {
        return undefined;
      }
    }
  }
  for (const artifact of bundle.artifacts) {
    const text = toTextContent(artifact.content);
    if (!text) continue;
    if (artifact.relativePath.endsWith('.jsonl') || artifact.mediaType?.includes('jsonl')) {
      try {
        return parseSession(text).toSession();
      } catch {
        /* continue trying other artifacts */
      }
    }
  }
  return undefined;
}

function findSubagentArtifact(
  bundle: UnknownArtifactBundle,
  agentId: string,
): { readonly relativePath: string; readonly content: string } | undefined {
  const candidates = [`subagents/agent-${agentId}.jsonl`, `subagents/${agentId}.jsonl`];
  for (const artifact of bundle.artifacts) {
    const normalized = artifact.relativePath.replace(/\\/g, '/').toLowerCase();
    if (!candidates.includes(normalized)) continue;
    const text = toTextContent(artifact.content);
    if (text) return { relativePath: artifact.relativePath, content: text };
  }
  return undefined;
}

function hasMissingSubagentTranscript(
  session: ClaudeCodeSession,
  bundle: UnknownArtifactBundle,
): boolean {
  for (const launch of session.subagentLaunches) {
    const agentId = launch.agentId;
    if (!agentId) continue;
    if (session.subagentSessions?.[agentId]) continue;
    if (!findSubagentArtifact(bundle, agentId)) return true;
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSessionCensored(session: ClaudeCodeSession): boolean {
  for (const entry of session.entries) {
    if ((entry as { isAbortedMidStream?: boolean }).isAbortedMidStream) return true;
  }
  const entries = [...session.entries].sort((a, b) => a.lineNumber - b.lineNumber);
  const last = entries[entries.length - 1];
  if (!last) return false;
  if (last.type === 'assistant') {
    const assistant = last as { message?: { content?: unknown } };
    const content = assistant.message?.content;
    if (Array.isArray(content)) {
      const toolIds = new Set<string>();
      for (const block of content) {
        if (isRecord(block) && block.type === 'tool_use' && typeof block.id === 'string') {
          toolIds.add(block.id);
        }
      }
      if (toolIds.size > 0) {
        for (let i = entries.length - 1; i >= 0; i--) {
          const e = entries[i];
          if (e === last) continue;
          if (e.lineNumber < last.lineNumber) break;
          if (e.type === 'user') {
            const user = e as { sourceToolUseID?: string; message?: { content?: unknown } };
            if (user.sourceToolUseID && toolIds.has(user.sourceToolUseID)) return false;
            const ucontent = user.message?.content;
            if (Array.isArray(ucontent)) {
              for (const block of ucontent) {
                if (
                  isRecord(block) &&
                  block.type === 'tool_result' &&
                  typeof block.tool_use_id === 'string' &&
                  toolIds.has(block.tool_use_id)
                ) {
                  return false;
                }
              }
            }
          }
        }
        return true;
      }
    }
  }
  if (last.type === 'user') {
    const user = last as { interruptedByShutdown?: boolean; interruptedMessageId?: string };
    if (user.interruptedByShutdown || user.interruptedMessageId) return true;
  }
  return false;
}

function anySessionCensored(session: ClaudeCodeSession): boolean {
  for (const s of visitAllSessions(session)) {
    if (isSessionCensored(s)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Evidence sufficiency flags
// ---------------------------------------------------------------------------

interface SessionEvidenceFlags {
  readonly hasAssistantRequests: boolean;
  readonly hasCompactions: boolean;
  readonly hasInvocations: boolean;
  readonly hasValidations: boolean;
  readonly hasEditOperations: boolean;
  readonly hasEditCycles: boolean;
}

const EDIT_OPERATION_TOOLS = new Set([
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'StrReplace',
  'ApplyPatch',
  'Insert',
  'Create',
]);

function isValidationLikeCommand(command: string | undefined): boolean {
  if (!command) return false;
  const lower = command.toLowerCase();
  return (
    lower.includes('test') ||
    lower.includes('lint') ||
    lower.includes('build') ||
    lower.includes('typecheck')
  );
}

function sessionEvidenceFlags(session: ClaudeCodeSession): SessionEvidenceFlags {
  let hasAssistantRequests = false;
  let hasCompactions = false;
  let hasInvocations = false;
  let hasValidations = false;
  let hasEditOperations = false;
  for (const s of visitAllSessions(session)) {
    if (s.compactions.length > 0) hasCompactions = true;
    for (const entry of s.entries) {
      if (entry.type === 'assistant') {
        const assistant = entry as { message?: { usage?: unknown; content?: unknown } };
        if (assistant.message?.usage) hasAssistantRequests = true;
        const content = assistant.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (!isRecord(block) || block.type !== 'tool_use') continue;
            const name = typeof block.name === 'string' ? block.name : '';
            hasInvocations = true;
            if (EDIT_OPERATION_TOOLS.has(name)) hasEditOperations = true;
            if (name === 'Bash') {
              const input = block.input as Record<string, unknown> | undefined;
              const command = typeof input?.command === 'string' ? input.command : '';
              if (isValidationLikeCommand(command)) hasValidations = true;
            }
          }
        }
      }
    }
    for (const hook of s.hooks) {
      if (isValidationLikeCommand(hook.command)) hasValidations = true;
    }
  }
  return {
    hasAssistantRequests,
    hasCompactions,
    hasInvocations,
    hasValidations,
    hasEditOperations,
    hasEditCycles: hasEditOperations && hasValidations,
  };
}

function hasRequiredEvidence(
  requirement: EvidenceRequirement,
  flags: SessionEvidenceFlags,
): boolean {
  switch (requirement) {
    case 'always':
      return true;
    case 'assistant_requests':
      return flags.hasAssistantRequests;
    case 'compactions':
      return flags.hasCompactions;
    case 'invocations':
      return flags.hasInvocations;
    case 'validations':
      return flags.hasValidations;
    case 'edit_cycles':
      return flags.hasEditCycles;
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Capability inspection
// ---------------------------------------------------------------------------

export function getClaudeCodeOptimizationMetricCapabilities(
  bundle?: UnknownArtifactBundle,
): MetricCapability[] {
  const definitions = getClaudeCodeOptimizationMetricDefinitions();
  if (!bundle) {
    return definitions.map((d) => ({
      metricId: d.metricId,
      definitionVersion: CLAUDE_CODE_OPTIMIZATION_METRIC_DEFINITION_VERSION,
      state: 'partial' as const,
      reason: 'no bundle supplied to evaluate evidence',
      comparabilityGroupId: comparabilityGroupFor(d, {}),
    }));
  }
  const session = extractRootSession(bundle);
  if (!session) {
    return definitions.map((d) => ({
      metricId: d.metricId,
      definitionVersion: CLAUDE_CODE_OPTIMIZATION_METRIC_DEFINITION_VERSION,
      state: 'unavailable' as const,
      reason: 'no root transcript artifact found',
      comparabilityGroupId: comparabilityGroupFor(d, {}),
    }));
  }
  const flags = sessionEvidenceFlags(session);
  const missingSubagent = hasMissingSubagentTranscript(session, bundle);
  const rootCensored = isSessionCensored(session);
  const anyCensored = anySessionCensored(session);
  return definitions.map((d) => {
    const isInclusive = d.rootInclusion === 'inclusive';
    const censored = isInclusive ? anyCensored : rootCensored;
    const requirement = requiredEvidenceByMetricId.get(d.metricId);
    let state: 'available' | 'partial' | 'unavailable' | 'incompatible' = 'available';
    let reason: string | undefined;
    if (requirement && !hasRequiredEvidence(requirement, flags)) {
      state = 'unavailable';
      reason = 'required evidence not present in transcript';
    } else if (isInclusive && missingSubagent) {
      state = 'unavailable';
      reason = 'one or more subagent transcripts missing';
    } else if (censored && d.statusRule !== 'include_partial_censored') {
      state = 'partial';
      reason = 'right-censored session; final outcomes may be missing';
    } else if (d.measurementClass === 'derived') {
      state = 'partial';
      reason = 'derived from observed evidence';
    }
    return {
      metricId: d.metricId,
      definitionVersion: CLAUDE_CODE_OPTIMIZATION_METRIC_DEFINITION_VERSION,
      state,
      reason,
      comparabilityGroupId: comparabilityGroupFor(d, {}),
    };
  });
}

// ---------------------------------------------------------------------------
// Metric derivation
// ---------------------------------------------------------------------------

export function deriveClaudeCodeOptimizationMetrics(
  session: ClaudeCodeSession,
  evidence: readonly NormalizedEvidenceRecord[],
  bundle: UnknownArtifactBundle,
  context: TransformContext,
  rootArtifactId: string,
): ClaudeMetricsResult {
  const definitions = getClaudeCodeOptimizationMetricDefinitions();
  const definitionById = new Map<string, MetricDefinition>(definitions.map((d) => [d.metricId, d]));
  const definitionFor = (metricId: string): MetricDefinition => {
    const def = definitionById.get(metricId);
    if (!def) throw new Error(`Missing metric definition for ${metricId}`);
    return def;
  };

  const ctx = buildEvidenceContext(session, bundle, context);
  const rootSessionId = ctx.rootSessionId;
  const missingSubagent = hasMissingSubagentTranscript(session, bundle);
  const rootCensored = isSessionCensored(session);
  const anyCensored = anySessionCensored(session);

  const turnMap = buildTurnMap(evidence);
  const modelUsageByScope = collectByScope(evidence, 'model_usage', ctx);
  const invocationByScope = collectByScope(evidence, 'invocation', ctx);
  const payloadByScope = collectByScope(evidence, 'payload', ctx);

  const rootValidationRecords = evidence.filter(
    (r) => r.recordType === 'validation' && isRootRecord(r, ctx),
  );
  const rootFileOpRecords = evidence.filter(
    (r) => r.recordType === 'file_operation' && isRootRecord(r, ctx),
  );
  const rootCompactionRecords = evidence.filter(
    (r) =>
      r.recordType === 'normalized_event' &&
      (r.payload as NormalizedEventRecordPayload).category === 'compaction' &&
      isRootRecord(r, ctx),
  );

  const subagentValidationRecords: NormalizedEvidenceRecord[] = [];
  const subagentFileOpRecords: NormalizedEvidenceRecord[] = [];
  const subagentCompactionRecords: NormalizedEvidenceRecord[] = [];
  if (!missingSubagent) {
    for (const { session: sub, context: subContext } of buildSubagentContexts(
      session,
      bundle,
      context,
      rootArtifactId,
    )) {
      subagentValidationRecords.push(...normalizeValidations(sub, subContext));
      subagentFileOpRecords.push(...normalizeFileOperations(sub, subContext));
      subagentCompactionRecords.push(
        ...normalizeNormalizedEvents(sub, subContext).filter(
          (r) => (r.payload as NormalizedEventRecordPayload).category === 'compaction',
        ),
      );
    }
  }

  const metricValues: ClaudeMetricValue[] = [];
  const metricProvenance: MetricProvenance[] = [];
  const unavailableReasons: MetricUnavailableReason[] = [];

  function addMetric(value: ClaudeMetricValue): void {
    let recordIds = value.evidenceRecordIds;
    let provenance = value.provenance;
    if (recordIds.length === 0) {
      const sessionRecords = evidence.filter(
        (r) =>
          r.recordType === 'session' &&
          (value.rootScope === 'root_only' ? isRootRecord(r, ctx) : inSessionTree(r, ctx)),
      );
      if (sessionRecords.length > 0) {
        recordIds = sessionRecords.map((r) => r.recordId);
        provenance = sessionRecords.map((r) => provenanceForRecord(r, rootArtifactId));
      }
    }
    if (provenance.length === 0) {
      provenance = [{ path: rootArtifactId, sourceField: value.metricId }];
    }
    const finalValue: ClaudeMetricValue = { ...value, evidenceRecordIds: recordIds, provenance };
    metricValues.push(finalValue);
    const recordId = stableId('metric_provenance', {
      metricId: finalValue.metricId,
      session: rootSessionId,
      artifact: rootArtifactId,
    });
    metricProvenance.push({
      artifactId: finalValue.provenanceArtifactId,
      path: finalValue.provenanceArtifactId,
      sourceEventId: recordIds[0],
      sourceField: finalValue.metricId,
      metricId: finalValue.metricId,
      recordId,
      estimationMethod: finalValue.estimationMethod ?? 'direct_observation',
    });
    if (finalValue.value === null && finalValue.unavailableReason) {
      unavailableReasons.push({
        metricId: finalValue.metricId,
        definitionVersion: finalValue.definitionVersion,
        reason: finalValue.unavailableReason,
      });
    }
  }

  function pushMetric(
    definition: MetricDefinition,
    value: number | null,
    exact: boolean,
    evidenceRecordIds: readonly string[],
    provenance: readonly Provenance[],
    estimationMethod: string,
    unavailableReason?: string,
    partialReason?: string,
    dimensionValue?: string,
  ): void {
    addMetric(
      createMetricValue({
        definition,
        value,
        exact,
        evidenceRecordIds,
        provenance,
        estimationMethod,
        unavailableReason,
        partialReason,
        dimensionValue,
      }),
    );
  }

  for (const scope of ['root_only', 'inclusive'] as const) {
    const isInclusive = scope === 'inclusive';
    const censored = isInclusive ? anyCensored : rootCensored;
    if (isInclusive && missingSubagent) {
      for (const def of definitions) {
        if (def.rootInclusion !== 'inclusive') continue;
        pushMetric(
          def,
          null,
          false,
          [],
          [],
          'subagent_transcripts_missing',
          'one or more subagent transcripts missing',
        );
      }
      continue;
    }

    const modelUsageRecords = isInclusive ? modelUsageByScope.inclusive : modelUsageByScope.root;
    const invocationRecords = isInclusive ? invocationByScope.inclusive : invocationByScope.root;
    const payloadRecords = isInclusive ? payloadByScope.inclusive : payloadByScope.root;
    const validationRecords = isInclusive
      ? [...rootValidationRecords, ...subagentValidationRecords]
      : rootValidationRecords;
    const fileOpRecords = isInclusive
      ? [...rootFileOpRecords, ...subagentFileOpRecords]
      : rootFileOpRecords;
    const compactionRecords = isInclusive
      ? [...rootCompactionRecords, ...subagentCompactionRecords]
      : rootCompactionRecords;

    // Context and cache
    const sorted = sortModelUsage(modelUsageRecords, turnMap);
    const allTokenExact = sorted.every(
      (r) => (r.payload as ModelUsagePayload).tokenValuesExact === true,
    );
    const firstDef = definitionFor(`claude:context:first_request_tokens:${scope}`);
    const growthMaxDef = definitionFor(`claude:context:growth_max_tokens:${scope}`);
    const growthMeanDef = definitionFor(`claude:context:growth_mean_tokens:${scope}`);
    const hitDef = definitionFor(`claude:cache:hit_rate:${scope}`);
    const writeDef = definitionFor(`claude:cache:write_rate:${scope}`);

    if (sorted.length === 0) {
      pushMetric(
        firstDef,
        null,
        false,
        [],
        [],
        'no_assistant_requests_with_usage',
        'no assistant requests with token usage',
      );
      pushMetric(
        growthMaxDef,
        null,
        false,
        [],
        [],
        'fewer_than_two_requests',
        'fewer than two assistant requests with token usage',
      );
      pushMetric(
        growthMeanDef,
        null,
        false,
        [],
        [],
        'fewer_than_two_requests',
        'fewer than two assistant requests with token usage',
      );
      pushMetric(
        hitDef,
        null,
        false,
        [],
        [],
        'no_assistant_requests_with_usage',
        'no assistant requests with token usage',
      );
      pushMetric(
        writeDef,
        null,
        false,
        [],
        [],
        'no_assistant_requests_with_usage',
        'no assistant requests with token usage',
      );
    } else {
      const totalInputs = sorted.map((r) => {
        const p = r.payload as ModelUsagePayload;
        return p.inputTokens + p.cacheCreationTokens + p.cacheReadTokens;
      });
      const anchor = totalInputs[0] as number;
      const deltas = totalInputs.map((t) => Math.max(0, t - anchor));
      const growthMax = Math.max(...deltas);
      const growthMean = deltas.reduce((a, b) => a + b, 0) / totalInputs.length;
      const contextRecordIds = sorted.map((r) => r.recordId);
      const contextProvenance = sorted.map((r) => provenanceForRecord(r, rootArtifactId));
      const contextPartialReason = censored
        ? 'right-censored session; further assistant requests may occur'
        : undefined;

      pushMetric(
        firstDef,
        anchor,
        allTokenExact,
        contextRecordIds,
        contextProvenance,
        'first_request_total_input_tokens',
      );
      pushMetric(
        growthMaxDef,
        growthMax,
        allTokenExact,
        contextRecordIds,
        contextProvenance,
        'max_delta_from_first_request_anchor',
        undefined,
        contextPartialReason,
      );
      pushMetric(
        growthMeanDef,
        growthMean,
        false,
        contextRecordIds,
        contextProvenance,
        'mean_delta_from_first_request_anchor',
        undefined,
        contextPartialReason,
      );

      let totalInput = 0;
      let cacheRead = 0;
      let cacheCreation = 0;
      for (const r of sorted) {
        const p = r.payload as ModelUsagePayload;
        totalInput += p.inputTokens + p.cacheCreationTokens + p.cacheReadTokens;
        cacheRead += p.cacheReadTokens;
        cacheCreation += p.cacheCreationTokens;
      }
      if (totalInput === 0) {
        pushMetric(
          hitDef,
          null,
          false,
          contextRecordIds,
          contextProvenance,
          'zero_total_input_tokens',
          'total input tokens are zero',
        );
        pushMetric(
          writeDef,
          null,
          false,
          contextRecordIds,
          contextProvenance,
          'zero_total_input_tokens',
          'total input tokens are zero',
        );
      } else {
        pushMetric(
          hitDef,
          cacheRead / totalInput,
          false,
          contextRecordIds,
          contextProvenance,
          'cache_read_to_total_input_ratio',
          undefined,
          contextPartialReason,
        );
        pushMetric(
          writeDef,
          cacheCreation / totalInput,
          false,
          contextRecordIds,
          contextProvenance,
          'cache_creation_to_total_input_ratio',
          undefined,
          contextPartialReason,
        );
      }
    }

    // Compaction
    const compactionRecordIds = compactionRecords.map((r) => r.recordId);
    const compactionProvenance = compactionRecords.map((r) =>
      provenanceForRecord(r, rootArtifactId),
    );
    let dropped = 0;
    let pre = 0;
    let post = 0;
    for (const r of compactionRecords) {
      const p = r.payload as NormalizedEventRecordPayload;
      if (typeof p.preTokens === 'number') pre += p.preTokens;
      if (typeof p.postTokens === 'number') post += p.postTokens;
      if (typeof p.preTokens === 'number' && typeof p.postTokens === 'number')
        dropped += p.preTokens - p.postTokens;
    }
    const countDef = definitionFor(`claude:compaction:count:${scope}`);
    const droppedDef = definitionFor(`claude:compaction:dropped_tokens:${scope}`);
    const retentionDef = definitionFor(`claude:compaction:retention_ratio:${scope}`);
    pushMetric(
      countDef,
      compactionRecords.length,
      true,
      compactionRecordIds,
      compactionProvenance,
      'count_of_compaction_events',
    );
    pushMetric(
      droppedDef,
      dropped,
      true,
      compactionRecordIds,
      compactionProvenance,
      'sum_of_pre_minus_post_tokens',
    );
    if (pre > 0) {
      const compactionPartialReason = censored
        ? 'right-censored session; further compactions may occur'
        : undefined;
      pushMetric(
        retentionDef,
        post / pre,
        false,
        compactionRecordIds,
        compactionProvenance,
        'total_post_to_total_pre_token_ratio',
        undefined,
        compactionPartialReason,
      );
    } else {
      pushMetric(
        retentionDef,
        null,
        false,
        [],
        [],
        'no_compaction_events',
        'no compaction events observed',
      );
    }

    // Payload size distribution
    const payloadPartialReason = censored
      ? 'right-censored session; further payloads may be recorded'
      : undefined;
    for (const payloadType of ['input', 'result', 'injection'] as const) {
      const filtered = payloadRecords.filter(
        (r) => (r.payload as PayloadRecordPayload).payloadType === payloadType,
      );
      const countDef = definitionFor(`claude:payload:count:${scope}`);
      const maxDef = definitionFor(`claude:payload:max_bytes:${scope}`);
      const meanDef = definitionFor(`claude:payload:mean_bytes:${scope}`);
      const typeRecordIds = filtered.map((r) => r.recordId);
      const typeProvenance = filtered.map((r) => provenanceForRecord(r, rootArtifactId));
      let total = 0;
      let max = 0;
      for (const r of filtered) {
        const p = r.payload as PayloadRecordPayload;
        total += p.bytes;
        if (p.bytes > max) max = p.bytes;
      }
      const count = filtered.length;
      pushMetric(
        countDef,
        count,
        true,
        typeRecordIds,
        typeProvenance,
        'count_of_payload_records',
        undefined,
        payloadPartialReason,
        payloadType,
      );
      if (count > 0) {
        pushMetric(
          maxDef,
          max,
          true,
          typeRecordIds,
          typeProvenance,
          'max_payload_bytes',
          undefined,
          payloadPartialReason,
          payloadType,
        );
        pushMetric(
          meanDef,
          total / count,
          false,
          typeRecordIds,
          typeProvenance,
          'mean_payload_bytes',
          undefined,
          payloadPartialReason,
          payloadType,
        );
      } else {
        pushMetric(
          maxDef,
          null,
          true,
          [],
          [],
          'no_payload_records_of_type',
          `no ${payloadType} payload records observed`,
          payloadPartialReason,
          payloadType,
        );
        pushMetric(
          meanDef,
          null,
          false,
          [],
          [],
          'no_payload_records_of_type',
          `no ${payloadType} payload records observed`,
          payloadPartialReason,
          payloadType,
        );
      }
    }

    // Latency and parallelism
    const latencies: number[] = [];
    const latRecordIds: string[] = [];
    const latProvenance: Provenance[] = [];
    for (const r of invocationRecords) {
      const p = r.payload as InvocationPayload;
      if (typeof p.latencyMs === 'number' && Number.isFinite(p.latencyMs) && p.latencyMs >= 0) {
        latencies.push(p.latencyMs);
        latRecordIds.push(r.recordId);
        latProvenance.push(provenanceForRecord(r, rootArtifactId));
      }
    }
    const invocationRecordIds = invocationRecords.map((r) => r.recordId);
    const invocationProvenance = invocationRecords.map((r) =>
      provenanceForRecord(r, rootArtifactId),
    );
    const latencyPartialReason = censored
      ? 'right-censored session; further invocations may complete'
      : undefined;
    const maxLatencyDef = definitionFor(`claude:latency:max_invocation_ms:${scope}`);
    const meanLatencyDef = definitionFor(`claude:latency:mean_invocation_ms:${scope}`);
    if (latencies.length === 0) {
      pushMetric(
        maxLatencyDef,
        null,
        false,
        [],
        [],
        'no_completed_invocations_with_latency',
        'no completed invocations with latency measurements',
      );
      pushMetric(
        meanLatencyDef,
        null,
        false,
        [],
        [],
        'no_completed_invocations_with_latency',
        'no completed invocations with latency measurements',
      );
    } else {
      pushMetric(
        maxLatencyDef,
        Math.max(...latencies),
        true,
        latRecordIds,
        latProvenance,
        'max_of_invocation_latency_observations',
        undefined,
        latencyPartialReason,
      );
      pushMetric(
        meanLatencyDef,
        latencies.reduce((a, b) => a + b, 0) / latencies.length,
        false,
        latRecordIds,
        latProvenance,
        'mean_of_invocation_latency_observations',
        undefined,
        latencyPartialReason,
      );
    }

    const byTurn = new Map<string, number>();
    for (const r of invocationRecords) {
      const parent = r.parentId ?? r.recordId;
      byTurn.set(parent, (byTurn.get(parent) ?? 0) + 1);
    }
    const maxConcurrent = byTurn.size > 0 ? Math.max(...byTurn.values()) : 0;
    const parallelDef = definitionFor(`claude:parallelism:max_concurrent_invocations:${scope}`);
    pushMetric(
      parallelDef,
      maxConcurrent,
      true,
      invocationRecordIds,
      invocationProvenance,
      'max_tool_use_count_per_assistant_turn',
      undefined,
      latencyPartialReason,
    );

    // Validation rates
    let success = 0;
    let failure = 0;
    for (const r of validationRecords) {
      const p = r.payload as ValidationRecordPayload;
      if (p.resultStatus === 'success' || p.resultStatus === 'warning') success += 1;
      else if (p.resultStatus === 'failure') failure += 1;
    }
    const validationTotal = success + failure;
    const validationRecordIds = validationRecords.map((r) => r.recordId);
    const validationProvenance = validationRecords.map((r) =>
      provenanceForRecord(r, rootArtifactId),
    );
    const validationPartialReason = censored
      ? 'right-censored session; further validations may occur'
      : undefined;
    const successRateDef = definitionFor(`claude:validation:success_rate:${scope}`);
    const failureRateDef = definitionFor(`claude:validation:failure_rate:${scope}`);
    if (validationTotal === 0) {
      pushMetric(
        successRateDef,
        null,
        false,
        [],
        [],
        'no_validation_records',
        'no validation executions with known success or failure outcomes',
      );
      pushMetric(
        failureRateDef,
        null,
        false,
        [],
        [],
        'no_validation_records',
        'no validation executions with known success or failure outcomes',
      );
    } else {
      pushMetric(
        successRateDef,
        success / validationTotal,
        false,
        validationRecordIds,
        validationProvenance,
        'successful_validations_over_total_known',
        undefined,
        validationPartialReason,
      );
      pushMetric(
        failureRateDef,
        failure / validationTotal,
        false,
        validationRecordIds,
        validationProvenance,
        'failed_validations_over_total_known',
        undefined,
        validationPartialReason,
      );
    }

    // Edit cycle
    const editFiles = fileOpRecords
      .filter((r) => {
        const op = (r.payload as FileOperationRecordPayload).operationType;
        return op === 'write' || op === 'edit' || op === 'create';
      })
      .sort(
        (a, b) =>
          (a.payload as FileOperationRecordPayload).timestampMs -
          (b.payload as FileOperationRecordPayload).timestampMs,
      );
    let editCycles = 0;
    let successfulCycles = 0;
    for (const v of validationRecords) {
      const vp = v.payload as ValidationRecordPayload;
      if (!vp.editCycleTarget) continue;
      if (
        vp.resultStatus !== 'success' &&
        vp.resultStatus !== 'warning' &&
        vp.resultStatus !== 'failure'
      )
        continue;
      for (let i = editFiles.length - 1; i >= 0; i--) {
        const fp = editFiles[i].payload as FileOperationRecordPayload;
        if (
          fp.normalizedPath === vp.editCycleTarget &&
          fp.timestampMs <= (vp.timestampMs ?? Number.POSITIVE_INFINITY)
        ) {
          editCycles += 1;
          if (vp.resultStatus === 'success' || vp.resultStatus === 'warning') successfulCycles += 1;
          break;
        }
      }
    }
    const editCycleRecordIds =
      editCycles > 0
        ? [...validationRecords.map((r) => r.recordId), ...fileOpRecords.map((r) => r.recordId)]
        : [];
    const editCycleProvenance =
      editCycles > 0
        ? [
            ...validationRecords.map((r) => provenanceForRecord(r, rootArtifactId)),
            ...fileOpRecords.map((r) => provenanceForRecord(r, rootArtifactId)),
          ]
        : [];
    const editCyclePartialReason = censored
      ? 'right-censored session; further edit/validate cycles may occur'
      : undefined;
    const editCountDef = definitionFor(`claude:edit_cycle:count:${scope}`);
    const editSuccessDef = definitionFor(`claude:edit_cycle:success_rate:${scope}`);
    if (editCycles === 0) {
      pushMetric(
        editCountDef,
        null,
        true,
        [],
        [],
        'no_edit_cycles',
        'no file operation followed by a validation on the same target',
      );
      pushMetric(
        editSuccessDef,
        null,
        false,
        [],
        [],
        'no_edit_cycles',
        'no file operation followed by a validation on the same target',
      );
    } else {
      pushMetric(
        editCountDef,
        editCycles,
        true,
        editCycleRecordIds,
        editCycleProvenance,
        'paired_file_operation_and_validation',
        undefined,
        editCyclePartialReason,
      );
      pushMetric(
        editSuccessDef,
        successfulCycles / editCycles,
        false,
        editCycleRecordIds,
        editCycleProvenance,
        'successful_edit_cycles_over_total',
        undefined,
        editCyclePartialReason,
      );
    }
  }

  const capabilities = deriveOptimizationCapabilitiesFromValues(metricValues);
  return { metricValues, metricProvenance, unavailableReasons, capabilities };
}

function deriveOptimizationCapabilitiesFromValues(
  values: readonly ClaudeMetricValue[],
): MetricCapability[] {
  return values.map((v) => {
    let state: 'available' | 'partial' | 'unavailable' | 'incompatible';
    let reason: string | undefined;
    if (v.value === null) {
      state = 'unavailable';
      reason = v.unavailableReason ?? 'evidence insufficient';
    } else if (!v.exact || v.partialReason) {
      state = 'partial';
      reason = v.partialReason ?? 'value is estimated or partial';
    } else {
      state = 'available';
    }
    return {
      metricId: v.metricId,
      definitionVersion: v.definitionVersion,
      state,
      reason,
      evidence: v.evidenceRecordIds,
      comparabilityGroupId: v.comparabilityGroupId,
    };
  });
}
