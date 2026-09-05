import type { ClaudeCodeEntry, ClaudeCodeSession } from '@lucasschirm/sal-claude-session-parser';
import {
  detectClaudeCodeArtifact,
  parseSession,
  parseSessionTranscript,
} from '@lucasschirm/sal-claude-session-parser';
import {
  type ComparabilityGroupSpec,
  deriveComparabilityGroupId,
  type MetricCapability,
  type MetricDefinition,
  type MetricUnavailableReason,
  type NormalizedEvidenceRecord,
  type Provenance,
  type ScalarMetricValue,
  type TransformContext,
  type UnknownArtifactBundle,
} from '@lucasschirm/sal-transformer-shared';
import type { ClaudeCodeEvidenceContext } from './claude-code-tasks.js';
import {
  normalizeCommandExecutions,
  normalizeFileOperations,
  normalizeValidations,
} from './claude-code-tasks.js';
import type { InvocationPayload, ModelUsagePayload } from './claude-code-usage.js';

// ---------------------------------------------------------------------------
// Versioning
// ---------------------------------------------------------------------------

export const CLAUDE_CODE_METRIC_DEFINITION_VERSION = '0.1.0';
const NATIVE_MAPPING_VERSION = 'claude-code-0.1.0';
const STATISTICAL_POLICY_ID = 'claude-default';
const PROVENANCE_REQUIREMENT = 'source_artifact_event_field';

// ---------------------------------------------------------------------------
// Metric definition contract (§9)
//
// `MetricDefinition` is a shared, harness-agnostic type now defined in
// transformer-shared/src/metric.ts. It is re-exported here so existing
// imports from this module (this package's other claude-code-*.ts files)
// keep working unchanged.
// ---------------------------------------------------------------------------

export type { MetricDefinition };

// ---------------------------------------------------------------------------
// Extended metric value type (§8.6 / §9)
// ---------------------------------------------------------------------------

export interface ClaudeMetricValue extends ScalarMetricValue {
  readonly grain: string;
  readonly dimensions: Readonly<Record<string, string>>;
  readonly class: 'observed' | 'derived' | 'estimated' | 'heuristic';
  readonly confidence: number;
  readonly rootScope: 'root_only' | 'inclusive';
  readonly unavailableReason?: string;
  readonly partialReason?: string;
  readonly evidenceRecordIds: readonly string[];
  readonly provenance: readonly Provenance[];
  readonly estimationMethod?: string;
  readonly allocationMethod?: string;
  readonly definition: MetricDefinition;
}

export interface MetricProvenance extends Provenance {
  readonly metricId: string;
  readonly recordId: string;
  readonly estimationMethod: string;
}

export interface ClaudeMetricsResult {
  readonly metricValues: readonly ClaudeMetricValue[];
  readonly metricProvenance: readonly MetricProvenance[];
  readonly unavailableReasons: readonly MetricUnavailableReason[];
  readonly capabilities: readonly MetricCapability[];
}

// ---------------------------------------------------------------------------
// Helpers
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

function sessionTimestampsMs(session: ClaudeCodeSession): { first?: number; last?: number } {
  const values: number[] = [];
  for (const entry of session.entries) {
    const ms = entryTimestampMs(entry);
    if (ms !== undefined) values.push(ms);
  }
  if (values.length === 0) return {};
  values.sort((a, b) => a - b);
  return { first: values[0], last: values[values.length - 1] };
}

function entryTimestampMs(entry: ClaudeCodeEntry): number | undefined {
  const withTs = entry as { timestampMs?: number; timestamp?: string };
  if (typeof withTs.timestampMs === 'number' && Number.isFinite(withTs.timestampMs)) {
    return withTs.timestampMs;
  }
  if (typeof withTs.timestamp === 'string') {
    const parsed = Date.parse(withTs.timestamp);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

function isRecognizedForCost(model: string | undefined): boolean {
  if (!model) return false;
  const lower = model.toLowerCase();
  if (lower.startsWith('claude-3-5-sonnet')) return true;
  if (lower.startsWith('claude-3-5-haiku')) return true;
  if (lower.startsWith('claude-3-opus')) return true;
  if (lower.startsWith('claude-3-haiku')) return true;
  return false;
}

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
): { relativePath: string; content: string } | undefined {
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
    const artifact = findSubagentArtifact(bundle, agentId);
    if (!artifact) return true;
  }
  return false;
}

function hasUnrecognizedModelCost(
  session: ClaudeCodeSession,
  bundle: UnknownArtifactBundle,
): boolean {
  for (const model of Object.keys(session.aggregateUsage.models ?? {})) {
    if (!isRecognizedForCost(model)) return true;
  }
  for (const launch of session.subagentLaunches) {
    const agentId = launch.agentId;
    if (!agentId) continue;
    const artifact = findSubagentArtifact(bundle, agentId);
    if (!artifact) continue;
    try {
      const sub = parseSessionTranscript(artifact.content);
      for (const model of Object.keys(sub.aggregateUsage.models ?? {})) {
        if (!isRecognizedForCost(model)) return true;
      }
    } catch {
      // Ignore parse errors in capability-only path.
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Metric definitions
// ---------------------------------------------------------------------------

function metricDefinition(
  metricId: string,
  label: string,
  description: string,
  family: string,
  unit: string,
  valueType: 'integer' | 'real' | 'currency',
  measurementClass: 'observed' | 'derived' | 'estimated',
  dimensions: readonly string[],
  rootInclusion: 'root_only' | 'inclusive',
  aggregation: string,
  options: {
    readonly allocationMethod?: string;
    readonly missingDataBehavior?: 'unknown' | 'not_applicable';
    readonly denominator?: string;
    readonly version?: number;
  } = {},
): MetricDefinition {
  return {
    metricId,
    version: options.version ?? 1,
    label,
    description,
    family,
    measurementClass,
    unit,
    valueType,
    grain: 'session',
    dimensions,
    denominator: options.denominator ?? 'session',
    populationRule: 'all_complete_and_partial_sessions',
    statusRule: 'include_partial_censored',
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
    provenanceRequirement: PROVENANCE_REQUIREMENT,
  };
}

export function getClaudeCodeMetricDefinitions(): readonly MetricDefinition[] {
  const defs: MetricDefinition[] = [];
  for (const scope of ['root_only', 'inclusive'] as const) {
    const scopeLabel = scope === 'root_only' ? 'root-only' : 'inclusive';
    const tokenClasses = [
      ['input', 'Input tokens', 'Input tokens reported by the model provider.'],
      ['output', 'Output tokens', 'Output tokens reported by the model provider.'],
      [
        'cache_creation',
        'Cache write tokens',
        'Cache-creation (cache-write) tokens reported by the provider.',
      ],
      ['cache_read', 'Cache-read tokens', 'Cache-read tokens reported by the provider.'],
    ] as const;
    for (const [cls, label, desc] of tokenClasses) {
      defs.push(
        metricDefinition(
          `claude:tokens:${cls}:${scope}`,
          `${label} (${scopeLabel})`,
          `${desc} Scope: ${scopeLabel}.`,
          'tokens',
          'token',
          'integer',
          'observed',
          ['token_class'],
          scope,
          'sum',
        ),
      );
    }
    defs.push(
      metricDefinition(
        `claude:tokens:total:${scope}`,
        `Total tokens (${scopeLabel})`,
        `Sum of input, output, cache creation, and cache read tokens. Scope: ${scopeLabel}.`,
        'tokens',
        'token',
        'integer',
        'derived',
        ['token_class'],
        scope,
        'sum',
      ),
    );
    defs.push(
      metricDefinition(
        `claude:cost:total:${scope}`,
        `Total cost (${scopeLabel})`,
        `Estimated cost from provider pricing and observed token classes. Scope: ${scopeLabel}.`,
        'cost',
        'USD',
        'currency',
        'derived',
        ['currency'],
        scope,
        'sum',
        { allocationMethod: 'direct_sum' },
      ),
    );
    defs.push(
      metricDefinition(
        `claude:duration:wall_ms:${scope}`,
        `Session duration`,
        `Time between the first and last observed event, in minutes. Scope: ${scopeLabel}.`,
        'time',
        'minutes',
        'real',
        'derived',
        [],
        scope,
        'sum',
        // Version 2: unit changed from ms to minutes, valueType from integer to real.
        // Old v1 values (stored in ms) are a distinct comparability entity.
        { version: 2 },
      ),
    );
    defs.push(
      metricDefinition(
        `claude:turns:count:${scope}`,
        `Turn count (${scopeLabel})`,
        `Logical human plus assistant turns. Scope: ${scopeLabel}.`,
        'session_shape',
        'count',
        'integer',
        'observed',
        [],
        scope,
        'sum',
      ),
    );
    const invocationKinds = [
      ['tool', 'Tool'],
      ['skill', 'Skill'],
      ['agent', 'Agent'],
    ] as const;
    for (const [kind, label] of invocationKinds) {
      defs.push(
        metricDefinition(
          `claude:invocations:${kind}:${scope}`,
          `${label} invocations (${scopeLabel})`,
          `Count of ${label} invocations. Skill and Agent are excluded from the Tool count. Scope: ${scopeLabel}.`,
          'invocations',
          'count',
          'integer',
          'observed',
          ['invocation_kind'],
          scope,
          'sum',
        ),
      );
    }
    defs.push(
      metricDefinition(
        `claude:file_operations:count:${scope}`,
        `File operation count (${scopeLabel})`,
        `Count of file read, write, edit, create, delete, rename, and revert operations. Scope: ${scopeLabel}.`,
        'file_activity',
        'count',
        'integer',
        'observed',
        [],
        scope,
        'sum',
      ),
    );
    defs.push(
      metricDefinition(
        `claude:commands:count:${scope}`,
        `Command count (${scopeLabel})`,
        `Count of executed shell and hook commands. Scope: ${scopeLabel}.`,
        'command_activity',
        'count',
        'integer',
        'observed',
        [],
        scope,
        'sum',
      ),
    );
    defs.push(
      metricDefinition(
        `claude:validations:count:${scope}`,
        `Validation count (${scopeLabel})`,
        `Count of test, lint, build, typecheck, and custom validation executions. Scope: ${scopeLabel}.`,
        'validation',
        'count',
        'integer',
        'observed',
        [],
        scope,
        'sum',
      ),
    );
    defs.push(
      metricDefinition(
        `claude:effort:changes:${scope}`,
        `Effort-level changes (${scopeLabel})`,
        `Count of reasoning-effort tier transitions across per-message model_request records, ` +
          `walked in requestOrder order. Scope: ${scopeLabel}.`,
        'effort',
        'count',
        'integer',
        'derived',
        [],
        scope,
        'sum',
      ),
    );
  }
  return defs;
}

const DEFINITIONS = new Map<string, MetricDefinition>(
  getClaudeCodeMetricDefinitions().map((d) => [d.metricId, d]),
);

function definitionFor(metricId: string): MetricDefinition {
  const def = DEFINITIONS.get(metricId);
  if (!def) throw new Error(`Missing metric definition for ${metricId}`);
  return def;
}

// ---------------------------------------------------------------------------
// Comparability and value construction
// ---------------------------------------------------------------------------

function dimensionsFor(
  definition: MetricDefinition,
  dimensionValue?: string,
): Record<string, string> {
  if (definition.dimensions.length === 0 || !dimensionValue) return {};
  return { [definition.dimensions[0]]: dimensionValue };
}

function comparabilityGroupFor(
  definition: MetricDefinition,
  dimensions: Readonly<Record<string, string>>,
  currencyPricingVersion?: string,
): string {
  const spec: ComparabilityGroupSpec = {
    metricId: definition.metricId,
    metricDefinitionVersion: CLAUDE_CODE_METRIC_DEFINITION_VERSION,
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
    definitionVersion: CLAUDE_CODE_METRIC_DEFINITION_VERSION,
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

function metricProvenanceFor(value: ClaudeMetricValue, recordId: string): MetricProvenance {
  const firstEvidence = value.evidenceRecordIds[0];
  const firstProvenance = value.provenance[0];
  return {
    artifactId: value.provenanceArtifactId,
    path: value.provenanceArtifactId,
    sourceEventId: firstEvidence,
    sourceField: firstProvenance?.sourceField ?? value.metricId,
    metricId: value.metricId,
    recordId,
    estimationMethod: value.estimationMethod ?? 'direct_observation',
  };
}

// ---------------------------------------------------------------------------
// Evidence grouping
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
  // Iterate subagentSessions directly (matching visitSessions and
  // normalizeSessionSpine) so childSessionIds includes every subagent
  // session, not just those whose launch has agentId.
  const subagentSessions = session.subagentSessions ?? {};
  for (const [, sub] of Object.entries(subagentSessions)) {
    childSessionIds.add(
      deriveChildSessionId(
        bundle,
        context,
        rootSessionId,
        sub.agentId ?? 'unknown',
        sub.sessionId ?? 'unknown',
      ),
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

// ---------------------------------------------------------------------------
// Sub-agent task evidence
// ---------------------------------------------------------------------------

function subagentTaskEvidence(
  session: ClaudeCodeSession,
  bundle: UnknownArtifactBundle,
  context: TransformContext,
  rootSessionId: string,
  rootArtifactId: string,
): {
  fileOps: number;
  commands: number;
  validations: number;
  recordIds: string[];
  provenance: Provenance[];
} {
  let fileOps = 0;
  let commands = 0;
  let validations = 0;
  const recordIds: string[] = [];
  const provenance: Provenance[] = [];

  // Iterate subagentSessions directly (matching visitSessions) so all
  // subagent sessions are included, not just those whose launch has agentId.
  for (const [, sub] of Object.entries(session.subagentSessions ?? {})) {
    const childSessionId = deriveChildSessionId(
      bundle,
      context,
      rootSessionId,
      sub.agentId ?? 'unknown',
      sub.sessionId ?? 'unknown',
    );
    const subContext: ClaudeCodeEvidenceContext = {
      ...context,
      artifactId: rootArtifactId,
      sessionId: childSessionId,
      rootSessionId,
      parentSessionId: rootSessionId,
      includeRawContent: false,
    };
    const subFileOps = normalizeFileOperations(sub, subContext);
    const subCommands = normalizeCommandExecutions(sub, subContext);
    const subValidations = normalizeValidations(sub, subContext);
    fileOps += subFileOps.length;
    commands += subCommands.length;
    validations += subValidations.length;
    for (const r of subFileOps) recordIds.push(r.recordId);
    for (const r of subCommands) recordIds.push(r.recordId);
    for (const r of subValidations) recordIds.push(r.recordId);
    for (const r of subFileOps) provenance.push(r.provenance);
    for (const r of subCommands) provenance.push(r.provenance);
    for (const r of subValidations) provenance.push(r.provenance);
  }

  return { fileOps, commands, validations, recordIds, provenance };
}

// ---------------------------------------------------------------------------
// Derivation helpers
// ---------------------------------------------------------------------------

function provenanceForRecord(record: NormalizedEvidenceRecord, artifactId: string): Provenance {
  return {
    artifactId: record.provenance.artifactId ?? artifactId,
    path: record.provenance.path ?? artifactId,
    sourceEventId: record.provenance.sourceEventId ?? record.sourceEventId,
    sourceField: record.provenance.sourceField ?? record.sourceField,
  };
}

function collectModelUsageRecords(
  evidence: readonly NormalizedEvidenceRecord[],
  ctx: EvidenceContext,
): {
  root: NormalizedEvidenceRecord[];
  inclusive: NormalizedEvidenceRecord[];
} {
  const root: NormalizedEvidenceRecord[] = [];
  const inclusive: NormalizedEvidenceRecord[] = [];
  for (const record of evidence) {
    if (record.recordType !== 'model_usage') continue;
    if (!inSessionTree(record, ctx)) continue;
    inclusive.push(record);
    if (isRootRecord(record, ctx)) root.push(record);
  }
  return { root, inclusive };
}

function sumTokenClass(
  records: NormalizedEvidenceRecord[],
  field: keyof ModelUsagePayload,
): number {
  let sum = 0;
  for (const record of records) {
    const payload = record.payload as ModelUsagePayload;
    const value = payload[field];
    if (typeof value === 'number' && Number.isFinite(value)) sum += value;
  }
  return sum;
}

function countInvocationsByKind(
  evidence: readonly NormalizedEvidenceRecord[],
  ctx: EvidenceContext,
): {
  tool: number;
  skill: number;
  agent: number;
  root: { tool: number; skill: number; agent: number };
} {
  const totals = { tool: 0, skill: 0, agent: 0 };
  const root = { tool: 0, skill: 0, agent: 0 };
  for (const record of evidence) {
    if (record.recordType !== 'invocation') continue;
    const payload = record.payload as InvocationPayload;
    if (!inSessionTree(record, ctx)) continue;
    if (payload.kind === 'tool' || payload.kind === 'skill' || payload.kind === 'agent') {
      totals[payload.kind] += 1;
      if (isRootRecord(record, ctx)) root[payload.kind] += 1;
    }
  }
  return { ...totals, root };
}

function countRecordType(
  evidence: readonly NormalizedEvidenceRecord[],
  type: string,
  ctx: EvidenceContext,
): { root: number; inclusive: number } {
  let root = 0;
  let inclusive = 0;
  for (const record of evidence) {
    if (record.recordType !== type) continue;
    if (!inSessionTree(record, ctx)) continue;
    inclusive += 1;
    if (isRootRecord(record, ctx)) root += 1;
  }
  return { root, inclusive };
}

function hasModelRequestRecords(
  evidence: readonly NormalizedEvidenceRecord[],
  ctx: EvidenceContext,
): boolean {
  for (const record of evidence) {
    if (record.recordType === 'model_request' && inSessionTree(record, ctx)) return true;
  }
  return false;
}

function collectModelRequestRecords(
  evidence: readonly NormalizedEvidenceRecord[],
  ctx: EvidenceContext,
): {
  root: NormalizedEvidenceRecord[];
  inclusive: NormalizedEvidenceRecord[];
} {
  const root: NormalizedEvidenceRecord[] = [];
  const inclusive: NormalizedEvidenceRecord[] = [];
  for (const record of evidence) {
    if (record.recordType !== 'model_request') continue;
    if (!inSessionTree(record, ctx)) continue;
    inclusive.push(record);
    if (isRootRecord(record, ctx)) root.push(record);
  }
  return { root, inclusive };
}

interface ModelRequestEffortPayload {
  readonly requestOrder?: number;
  readonly normalizedEffort?: string | null;
}

/**
 * Walks `model_request` records in `requestOrder` order, carrying forward
 * the last-seen non-null `normalizedEffort` and incrementing a transition
 * counter whenever the current non-null value differs from the carried
 * value. Records with a null/unresolved `normalizedEffort` are skipped for
 * comparison (they neither end nor start a "known" streak) but are also
 * never counted toward `contributing` (the sample, `n`).
 */
function computeEffortTransitions(records: readonly NormalizedEvidenceRecord[]): {
  readonly transitions: number;
  readonly contributing: readonly NormalizedEvidenceRecord[];
} {
  const sorted = [...records].sort((a, b) => {
    const orderA = (a.payload as ModelRequestEffortPayload).requestOrder ?? 0;
    const orderB = (b.payload as ModelRequestEffortPayload).requestOrder ?? 0;
    return orderA - orderB;
  });

  const contributing: NormalizedEvidenceRecord[] = [];
  let transitions = 0;
  let carried: string | undefined;
  for (const record of sorted) {
    const value = (record.payload as ModelRequestEffortPayload).normalizedEffort;
    if (value === null || value === undefined) continue;
    contributing.push(record);
    if (carried !== undefined && value !== carried) transitions += 1;
    carried = value;
  }
  return { transitions, contributing };
}

function groupBySessionId(
  records: readonly NormalizedEvidenceRecord[],
): Map<string, NormalizedEvidenceRecord[]> {
  const groups = new Map<string, NormalizedEvidenceRecord[]>();
  for (const record of records) {
    const list = groups.get(record.sessionId);
    if (list) {
      list.push(record);
    } else {
      groups.set(record.sessionId, [record]);
    }
  }
  return groups;
}

/**
 * Sums effort-level transitions across the root session and its subagent
 * sessions independently. `requestOrder` is a per-session ordinal (each
 * subagent session restarts its own turn counter from 1), so records must
 * be grouped by `sessionId` and walked separately with
 * `computeEffortTransitions` before summing — merging raw records across
 * sessions and sorting by the shared, per-session-relative ordinal would
 * interleave unrelated sessions and fabricate transitions that never
 * happened adjacently. This mirrors how the token-total metrics above
 * aggregate root + subagent contributions without conflating their
 * internal orderings.
 */
function computeInclusiveEffortTransitions(records: readonly NormalizedEvidenceRecord[]): {
  readonly transitions: number;
  readonly contributing: readonly NormalizedEvidenceRecord[];
} {
  let transitions = 0;
  const contributing: NormalizedEvidenceRecord[] = [];
  for (const sessionRecords of groupBySessionId(records).values()) {
    const result = computeEffortTransitions(sessionRecords);
    transitions += result.transitions;
    contributing.push(...result.contributing);
  }
  return { transitions, contributing };
}

// ---------------------------------------------------------------------------
// Main metric derivation
// ---------------------------------------------------------------------------

export function deriveClaudeCodeMetrics(
  session: ClaudeCodeSession,
  evidence: readonly NormalizedEvidenceRecord[],
  bundle: UnknownArtifactBundle,
  context: TransformContext,
  rootArtifactId: string,
): ClaudeMetricsResult {
  const ctx = buildEvidenceContext(session, bundle, context);
  const rootSessionId = ctx.rootSessionId;
  const missingSubagent = hasMissingSubagentTranscript(session, bundle);

  const metricValues: ClaudeMetricValue[] = [];
  const metricProvenance: MetricProvenance[] = [];
  const unavailableReasons: MetricUnavailableReason[] = [];

  function pushValue(value: ClaudeMetricValue): void {
    const scope = value.rootScope;
    let recordIds = value.evidenceRecordIds;
    let provenance = value.provenance;
    if (recordIds.length === 0) {
      const sessionRecords = evidence.filter(
        (r) =>
          r.recordType === 'session' &&
          (scope === 'root_only' ? isRootRecord(r, ctx) : inSessionTree(r, ctx)),
      );
      if (sessionRecords.length > 0) {
        recordIds = sessionRecords.map((r) => r.recordId);
        provenance = sessionRecords.map((r) => provenanceForRecord(r, rootArtifactId));
      }
    }
    if (provenance.length === 0) {
      provenance = [
        { artifactId: rootArtifactId, path: rootArtifactId, sourceField: value.metricId },
      ];
    }
    const finalValue: ClaudeMetricValue = { ...value, evidenceRecordIds: recordIds, provenance };
    metricValues.push(finalValue);
    const recordId = stableId('metric_provenance', {
      metricId: finalValue.metricId,
      session: rootSessionId,
      artifact: rootArtifactId,
    });
    metricProvenance.push(metricProvenanceFor(finalValue, recordId));
    if (finalValue.value === null && finalValue.unavailableReason) {
      unavailableReasons.push({
        metricId: finalValue.metricId,
        definitionVersion: CLAUDE_CODE_METRIC_DEFINITION_VERSION,
        reason: finalValue.unavailableReason,
      });
    }
  }

  // Token and cost metrics -------------------------------------------------
  const modelUsage = collectModelUsageRecords(evidence, ctx);
  const tokenClassMap: Record<string, keyof ModelUsagePayload> = {
    input: 'inputTokens',
    output: 'outputTokens',
    cache_creation: 'cacheCreationTokens',
    cache_read: 'cacheReadTokens',
  };

  for (const scope of ['root_only', 'inclusive'] as const) {
    const records = scope === 'root_only' ? modelUsage.root : modelUsage.inclusive;
    const isInclusive = scope === 'inclusive';
    const unavailable =
      isInclusive && missingSubagent ? 'one or more subagent transcripts missing' : undefined;

    let total = 0;
    for (const [label, field] of Object.entries(tokenClassMap)) {
      const def = definitionFor(`claude:tokens:${label}:${scope}`);
      let value: number | null = null;
      let exact = false;
      let reason: string | undefined;

      const hasRequests = hasModelRequestRecords(evidence, ctx);
      if (records.length === 0 && !hasRequests) {
        value = 0;
        exact = true;
      } else if (records.length === 0) {
        reason = 'model usage records missing for observed requests';
      } else {
        value = sumTokenClass(records, field);
        exact = records.every((r) => (r.payload as ModelUsagePayload).tokenValuesExact === true);
        total += value;
      }

      if (unavailable && value === null) {
        reason = unavailable;
      }

      const recordIds = records.map((r) => r.recordId);
      const provenance = records.map((r) => provenanceForRecord(r, rootArtifactId));
      const tokenValue = createMetricValue({
        definition: def,
        value,
        exact,
        evidenceRecordIds: recordIds,
        provenance: provenance.length > 0 ? provenance : [{ path: rootArtifactId }],
        dimensionValue: label,
        estimationMethod: 'sum_of_provider_reported_usage',
        unavailableReason: reason,
      });
      pushValue(tokenValue);
    }

    // Total tokens
    const totalDef = definitionFor(`claude:tokens:total:${scope}`);
    const totalExact =
      records.length > 0 &&
      records.every((r) => (r.payload as ModelUsagePayload).tokenValuesExact === true);
    let totalValue: number | null = null;
    let totalReason: string | undefined;
    if (records.length === 0 && !hasModelRequestRecords(evidence, ctx)) {
      totalValue = 0;
    } else if (records.length > 0) {
      totalValue = total;
    } else {
      totalReason = 'model usage records missing for observed requests';
    }
    if (unavailable && totalValue === null) {
      totalReason = unavailable;
    }
    pushValue(
      createMetricValue({
        definition: totalDef,
        value: totalValue,
        exact: totalExact,
        evidenceRecordIds: records.map((r) => r.recordId),
        provenance: records.map((r) => provenanceForRecord(r, rootArtifactId)),
        dimensionValue: 'total',
        estimationMethod: 'sum_of_token_classes',
        unavailableReason: totalReason,
      }),
    );

    // Cost
    const costDef = definitionFor(`claude:cost:total:${scope}`);
    let costValue: number | null = null;
    let costExact = false;
    let costReason: string | undefined;
    let costRecordIds: string[] = [];

    if (records.length === 0 && !hasModelRequestRecords(evidence, ctx)) {
      costValue = 0;
      costExact = true;
    } else if (records.length > 0) {
      let sum = 0;
      let anyMissing = false;
      let allPriced = true;
      costRecordIds = records.map((r) => r.recordId);
      for (const record of records) {
        const payload = record.payload as ModelUsagePayload;
        if (payload.cost === undefined || payload.cost === null) {
          anyMissing = true;
          if (!isRecognizedForCost(payload.model)) {
            allPriced = false;
          }
        } else {
          sum += payload.cost;
        }
      }
      if (!allPriced) {
        costReason = 'some model usage records have no pricing';
      } else if (anyMissing) {
        costReason = 'some model usage records have an unrecognized model';
      } else {
        costValue = sum;
        costExact = false; // pricing is external, not observed from provider
      }
    } else {
      costReason = 'model usage records missing for observed requests';
    }
    if (unavailable && costValue === null) {
      costReason = unavailable;
    }
    pushValue(
      createMetricValue({
        definition: costDef,
        value: costValue,
        exact: costExact,
        evidenceRecordIds: costRecordIds,
        provenance: records.map((r) => provenanceForRecord(r, rootArtifactId)),
        dimensionValue: 'USD',
        currencyPricingVersion: NATIVE_MAPPING_VERSION,
        estimationMethod: 'pricing_registry_sum',
        allocationMethod: 'direct_sum',
        unavailableReason: costReason,
        partialReason:
          costValue !== null
            ? 'cost is calculated from external pricing, not observed directly'
            : undefined,
      }),
    );
  }

  // Effort-level changes --------------------------------------------------
  const modelRequests = collectModelRequestRecords(evidence, ctx);
  for (const scope of ['root_only', 'inclusive'] as const) {
    const def = definitionFor(`claude:effort:changes:${scope}`);
    const records = scope === 'root_only' ? modelRequests.root : modelRequests.inclusive;
    const { transitions, contributing } =
      scope === 'root_only'
        ? computeEffortTransitions(records)
        : computeInclusiveEffortTransitions(records);
    const n = contributing.length;

    let value: number | null = n === 0 ? null : transitions;
    let reason: string | undefined =
      n === 0 ? 'no recognized effort signal observed for this session' : undefined;

    if (scope === 'inclusive' && missingSubagent) {
      value = null;
      reason = 'one or more subagent transcripts missing';
    }

    pushValue(
      createMetricValue({
        definition: def,
        value,
        exact: value !== null,
        evidenceRecordIds: contributing.map((r) => r.recordId),
        provenance: contributing.map((r) => provenanceForRecord(r, rootArtifactId)),
        estimationMethod: 'count_of_effort_level_transitions',
        unavailableReason: reason,
      }),
    );
  }

  // Duration ------------------------------------------------------------
  const timestamps = sessionTimestampsMs(session);
  const subagentTimestamps = collectSubagentTimestamps(session);
  for (const scope of ['root_only', 'inclusive'] as const) {
    const def = definitionFor(`claude:duration:wall_ms:${scope}`);
    let first = timestamps.first;
    let last = timestamps.last;
    if (scope === 'inclusive') {
      if (
        subagentTimestamps.first !== undefined &&
        (first === undefined || subagentTimestamps.first < first)
      ) {
        first = subagentTimestamps.first;
      }
      if (
        subagentTimestamps.last !== undefined &&
        (last === undefined || subagentTimestamps.last > last)
      ) {
        last = subagentTimestamps.last;
      }
    }
    let value: number | null = null;
    let reason: string | undefined;
    if (first !== undefined && last !== undefined) {
      value = (last - first) / 60_000;
    } else {
      reason = 'no event timestamps';
    }
    if (scope === 'inclusive' && missingSubagent) {
      reason = 'one or more subagent transcripts missing';
      value = null;
    }
    const recordIds = evidence
      .filter((r) => r.recordType === 'session' && inSessionTree(r, ctx))
      .map((r) => r.recordId);
    const provenance = evidence
      .filter((r) => r.recordType === 'session' && inSessionTree(r, ctx))
      .map((r) => provenanceForRecord(r, rootArtifactId));
    pushValue(
      createMetricValue({
        definition: def,
        value,
        exact: value !== null,
        evidenceRecordIds: recordIds,
        provenance: provenance.length > 0 ? provenance : [{ path: rootArtifactId }],
        estimationMethod: 'wall_clock_difference_of_session_events',
        unavailableReason: reason,
        partialReason:
          value !== null
            ? 'wall duration reflects observed events; session may continue'
            : undefined,
      }),
    );
  }

  // Turn count ----------------------------------------------------------
  const turnCounts = countRecordType(evidence, 'turn', ctx);
  for (const scope of ['root_only', 'inclusive'] as const) {
    const def = definitionFor(`claude:turns:count:${scope}`);
    const count = scope === 'root_only' ? turnCounts.root : turnCounts.inclusive;
    let value: number | null = count;
    let exact = true;
    let reason: string | undefined;
    if (count === 0 && !hasSessionRecord(evidence, ctx, scope)) {
      value = null;
      reason = 'no session record';
      exact = false;
    }
    if (scope === 'inclusive' && missingSubagent) {
      value = null;
      reason = 'one or more subagent transcripts missing';
      exact = false;
    }
    const records = evidence.filter(
      (r) =>
        r.recordType === 'turn' &&
        (scope === 'root_only' ? isRootRecord(r, ctx) : inSessionTree(r, ctx)),
    );
    pushValue(
      createMetricValue({
        definition: def,
        value,
        exact,
        evidenceRecordIds: records.map((r) => r.recordId),
        provenance: records.map((r) => provenanceForRecord(r, rootArtifactId)),
        estimationMethod: 'count_of_normalized_turn_records',
        unavailableReason: reason,
      }),
    );
  }

  // Invocations ---------------------------------------------------------
  const invocationCounts = countInvocationsByKind(evidence, ctx);
  const invocationKinds = ['tool', 'skill', 'agent'] as const;
  for (const scope of ['root_only', 'inclusive'] as const) {
    for (const kind of invocationKinds) {
      const def = definitionFor(`claude:invocations:${kind}:${scope}`);
      const count = scope === 'root_only' ? invocationCounts.root[kind] : invocationCounts[kind];
      let value: number | null = count;
      let exact = true;
      let reason: string | undefined;
      if (scope === 'inclusive' && missingSubagent) {
        value = null;
        reason = 'one or more subagent transcripts missing';
        exact = false;
      }
      const records = evidence.filter((r) => {
        if (r.recordType !== 'invocation') return false;
        const payload = r.payload as InvocationPayload;
        if (payload.kind !== kind) return false;
        return scope === 'root_only' ? isRootRecord(r, ctx) : inSessionTree(r, ctx);
      });
      pushValue(
        createMetricValue({
          definition: def,
          value,
          exact,
          evidenceRecordIds: records.map((r) => r.recordId),
          provenance: records.map((r) => provenanceForRecord(r, rootArtifactId)),
          dimensionValue: kind,
          estimationMethod: 'count_of_normalized_invocation_records',
          unavailableReason: reason,
        }),
      );
    }
  }

  // File operations, commands, validations -------------------------------
  const subagentEvidence = missingSubagent
    ? undefined
    : subagentTaskEvidence(session, bundle, context, rootSessionId, rootArtifactId);

  const activityTypes = ['file_operation', 'command_execution', 'validation'] as const;
  const activityMetrics = [
    'claude:file_operations:count',
    'claude:commands:count',
    'claude:validations:count',
  ] as const;
  for (let i = 0; i < activityTypes.length; i++) {
    const type = activityTypes[i];
    const metricPrefix = activityMetrics[i];
    const rootCounts = countRecordType(evidence, type, ctx);
    for (const scope of ['root_only', 'inclusive'] as const) {
      const def = definitionFor(`${metricPrefix}:${scope}`);
      let count = scope === 'root_only' ? rootCounts.root : rootCounts.inclusive;
      let recordIds = evidence
        .filter(
          (r) =>
            r.recordType === type &&
            (scope === 'root_only' ? isRootRecord(r, ctx) : inSessionTree(r, ctx)),
        )
        .map((r) => r.recordId);
      let provenance = evidence
        .filter(
          (r) =>
            r.recordType === type &&
            (scope === 'root_only' ? isRootRecord(r, ctx) : inSessionTree(r, ctx)),
        )
        .map((r) => provenanceForRecord(r, rootArtifactId));
      let exact = true;
      let reason: string | undefined;
      let partialReason: string | undefined;

      if (scope === 'inclusive') {
        if (missingSubagent) {
          count = 0;
          exact = false;
          reason = 'one or more subagent transcripts missing';
        } else if (subagentEvidence) {
          if (type === 'file_operation') {
            count += subagentEvidence.fileOps;
          } else if (type === 'command_execution') {
            count += subagentEvidence.commands;
          } else {
            count += subagentEvidence.validations;
          }
          recordIds = recordIds.concat(subagentEvidence.recordIds);
          provenance = provenance.concat(subagentEvidence.provenance);
          partialReason = 'inclusive total includes subagent counts from replayed normalizers';
        }
      }

      let value: number | null = count;
      if (count === 0 && !hasSessionRecord(evidence, ctx, scope)) {
        value = null;
        reason = 'no session record';
        exact = false;
      } else if (scope === 'inclusive' && missingSubagent) {
        value = null;
      }

      pushValue(
        createMetricValue({
          definition: def,
          value,
          exact,
          evidenceRecordIds: recordIds,
          provenance: provenance.length > 0 ? provenance : [{ path: rootArtifactId }],
          estimationMethod:
            scope === 'inclusive' && subagentEvidence
              ? 'sum_of_root_and_subagent_records'
              : 'count_of_normalized_records',
          unavailableReason: reason,
          partialReason,
        }),
      );
    }
  }

  const capabilities = deriveCapabilitiesFromValues(metricValues);

  return { metricValues, metricProvenance, unavailableReasons, capabilities };
}

// ---------------------------------------------------------------------------
// Capability derivation
// ---------------------------------------------------------------------------

function hasSessionRecord(
  evidence: readonly NormalizedEvidenceRecord[],
  ctx: EvidenceContext,
  scope: 'root_only' | 'inclusive',
): boolean {
  for (const record of evidence) {
    if (record.recordType !== 'session') continue;
    if (scope === 'root_only' ? isRootRecord(record, ctx) : inSessionTree(record, ctx)) return true;
  }
  return false;
}

function collectSubagentTimestamps(session: ClaudeCodeSession): { first?: number; last?: number } {
  let first: number | undefined;
  let last: number | undefined;
  for (const launch of session.subagentLaunches) {
    const agentId = launch.agentId;
    if (!agentId) continue;
    const sub = session.subagentSessions?.[agentId];
    if (!sub) continue;
    const ts = sessionTimestampsMs(sub);
    if (ts.first !== undefined && (first === undefined || ts.first < first)) first = ts.first;
    if (ts.last !== undefined && (last === undefined || ts.last > last)) last = ts.last;
  }
  return { first, last };
}

function deriveCapabilitiesFromValues(values: readonly ClaudeMetricValue[]): MetricCapability[] {
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

// ---------------------------------------------------------------------------
// Public capability inspection
// ---------------------------------------------------------------------------

export function getClaudeCodeMetricCapabilities(
  bundle?: UnknownArtifactBundle,
): MetricCapability[] {
  const definitions = getClaudeCodeMetricDefinitions();
  if (!bundle) {
    return definitions.map((d) => ({
      metricId: d.metricId,
      definitionVersion: CLAUDE_CODE_METRIC_DEFINITION_VERSION,
      state: 'partial' as const,
      reason: 'no bundle supplied to evaluate evidence',
      comparabilityGroupId: comparabilityGroupFor(d, {}),
    }));
  }

  const session = extractRootSession(bundle);
  if (!session) {
    return definitions.map((d) => ({
      metricId: d.metricId,
      definitionVersion: CLAUDE_CODE_METRIC_DEFINITION_VERSION,
      state: 'unavailable' as const,
      reason: 'no root transcript artifact found',
      comparabilityGroupId: comparabilityGroupFor(d, {}),
    }));
  }

  const missingSubagent = hasMissingSubagentTranscript(session, bundle);
  const hasUnknownModelCost = hasUnrecognizedModelCost(session, bundle);
  const ts = sessionTimestampsMs(session);
  const hasTimestamps = ts.first !== undefined && ts.last !== undefined;

  return definitions.map((d) => {
    let state: 'available' | 'partial' | 'unavailable' | 'incompatible' = 'available';
    let reason: string | undefined;

    if (d.family === 'cost' && hasUnknownModelCost) {
      state = 'unavailable';
      reason = 'some model usage records have no pricing';
    } else if (d.family === 'time' && !hasTimestamps) {
      state = 'unavailable';
      reason = 'no event timestamps';
    } else if (d.rootInclusion === 'inclusive' && missingSubagent) {
      state = 'unavailable';
      reason = 'one or more subagent transcripts missing';
    } else if (d.measurementClass === 'derived' || d.measurementClass === 'estimated') {
      state = 'partial';
      reason = 'derived or estimated from observed evidence';
    }

    return {
      metricId: d.metricId,
      definitionVersion: CLAUDE_CODE_METRIC_DEFINITION_VERSION,
      state,
      reason,
      comparabilityGroupId: comparabilityGroupFor(
        d,
        {},
        d.family === 'cost' ? NATIVE_MAPPING_VERSION : undefined,
      ),
    };
  });
}
