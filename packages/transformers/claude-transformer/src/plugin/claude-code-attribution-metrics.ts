import type { ClaudeCodeSession } from '@lucasschirm/sal-claude-session-parser';
import { detectClaudeCodeArtifact, parseSession } from '@lucasschirm/sal-claude-session-parser';
import {
  type ComparabilityGroupSpec,
  deriveComparabilityGroupId,
  type MetricCapability,
  type MetricUnavailableReason,
  type NormalizedEvidenceRecord,
  type Provenance,
  type TransformContext,
  type UnknownArtifactBundle,
} from '@lucasschirm/sal-transformer-shared';
import type {
  ClaudeMetricsResult,
  ClaudeMetricValue,
  MetricDefinition,
  MetricProvenance,
} from './claude-code-metrics.js';
import type { InvocationPayloadPayload } from './claude-code-usage.js';

// ---------------------------------------------------------------------------
// Versioning and policy references
// ---------------------------------------------------------------------------

export const CLAUDE_CODE_ATTRIBUTION_METRIC_DEFINITION_VERSION = '0.1.0';
const NATIVE_MAPPING_VERSION = 'claude-code-0.1.0';
const STATISTICAL_POLICY_ID = 'claude-default';
const ATTRIBUTION_POLICY_ID = 'claude-attribution-default';
const PROVENANCE_REQUIREMENT = 'source_artifact_event_field';

const KNOWN_INCLUSION_SEMANTICS = new Set(['subagent', 'child']);

// ---------------------------------------------------------------------------
// Local metric definition contract
// ---------------------------------------------------------------------------

export interface AttributionMetricDefinition extends MetricDefinition {
  readonly attributionPolicyId: string;
}

export interface AttributionReleaseMatrixEntry {
  readonly metricId: string;
  readonly label: string;
  readonly family: string;
  readonly requiredEvidence: readonly string[];
  readonly measurementClass: 'observed' | 'derived' | 'estimated' | 'heuristic';
  readonly aggregation: string;
  readonly allocationMethod: string;
  readonly attributionPolicyId: string;
  readonly statisticalPolicyId: string;
  readonly additive: boolean;
  readonly releaseReady: (
    session: ClaudeCodeSession,
    evidence: readonly NormalizedEvidenceRecord[],
    scope: 'root_only' | 'inclusive',
    ctx: AttributionEvidenceContext,
  ) => { readonly ready: boolean; readonly reason?: string };
}

// ---------------------------------------------------------------------------
// Evidence context
// ---------------------------------------------------------------------------

interface AttributionEvidenceContext {
  readonly rootSessionId: string;
  readonly childSessionIds: ReadonlySet<string>;
  readonly missingSubagent: boolean;
  readonly unknownInclusion: boolean;
}

interface SessionInterval {
  readonly startMs: number;
  readonly endMs: number;
  readonly recordId: string;
}

// ---------------------------------------------------------------------------
// Stable identity and provenance helpers
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

function provenanceForRecord(record: NormalizedEvidenceRecord, artifactId: string): Provenance {
  return {
    artifactId: record.provenance.artifactId ?? artifactId,
    path: record.provenance.path ?? artifactId,
    sourceEventId: record.provenance.sourceEventId ?? record.sourceEventId,
    sourceField: record.provenance.sourceField ?? record.sourceField,
  };
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
        // continue trying other artifacts
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

function* visitAllSessions(session: ClaudeCodeSession): Generator<ClaudeCodeSession> {
  yield session;
  for (const [, sub] of Object.entries(session.subagentSessions ?? {})) {
    yield* visitAllSessions(sub);
  }
}

function entryTimestampMs(entry: unknown): number | undefined {
  if (typeof entry !== 'object' || entry === null) return undefined;
  const e = entry as { timestampMs?: unknown; timestamp?: unknown };
  if (typeof e.timestampMs === 'number' && Number.isFinite(e.timestampMs)) {
    return e.timestampMs;
  }
  if (typeof e.timestamp === 'string') {
    const parsed = Date.parse(e.timestamp);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

function sessionTimestampsMs(session: ClaudeCodeSession): { first?: number; last?: number } {
  const values: number[] = [];
  for (const s of visitAllSessions(session)) {
    for (const entry of s.entries) {
      const ms = entryTimestampMs(entry);
      if (ms !== undefined) values.push(ms);
    }
  }
  if (values.length === 0) return {};
  values.sort((a, b) => a - b);
  return { first: values[0], last: values[values.length - 1] };
}

function hasToolInvocationEvidence(session: ClaudeCodeSession): boolean {
  for (const s of visitAllSessions(session)) {
    for (const entry of s.entries) {
      if (entry.type !== 'assistant') continue;
      const content = (entry as { message?: { content?: unknown } }).message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (
            typeof block === 'object' &&
            block !== null &&
            (block as { type?: unknown }).type === 'tool_use'
          ) {
            return true;
          }
        }
      }
    }
  }
  return false;
}

function buildAttributionEvidenceContext(
  session: ClaudeCodeSession,
  evidence: readonly NormalizedEvidenceRecord[],
  bundle: UnknownArtifactBundle,
  context: TransformContext,
): AttributionEvidenceContext {
  const rootSessionId = deriveRootSessionId(bundle, context, session.sessionId ?? 'unknown');
  const childSessionIds = new Set<string>();
  let unknownInclusion = false;

  for (const record of evidence) {
    if (record.recordType !== 'session_relation') continue;
    const payload = record.payload as {
      rootSessionId?: string;
      parentSessionId?: string;
      nativeInclusionSemantics?: string;
    };
    if (payload.rootSessionId !== rootSessionId || payload.parentSessionId !== rootSessionId) {
      continue;
    }
    const semantics = payload.nativeInclusionSemantics;
    if (!semantics || !KNOWN_INCLUSION_SEMANTICS.has(semantics)) {
      unknownInclusion = true;
    } else {
      childSessionIds.add(record.sessionId);
    }
  }

  return {
    rootSessionId,
    childSessionIds,
    missingSubagent: hasMissingSubagentTranscript(session, bundle),
    unknownInclusion,
  };
}

function isRootRecord(record: NormalizedEvidenceRecord, ctx: AttributionEvidenceContext): boolean {
  return record.sessionId === ctx.rootSessionId;
}

function inSessionTree(record: NormalizedEvidenceRecord, ctx: AttributionEvidenceContext): boolean {
  return record.sessionId === ctx.rootSessionId || ctx.childSessionIds.has(record.sessionId);
}

// ---------------------------------------------------------------------------
// Metric definitions
// ---------------------------------------------------------------------------

function attributionMetricDefinition(
  metricId: string,
  label: string,
  description: string,
  family: string,
  unit: string,
  valueType: 'integer' | 'ratio',
  measurementClass: 'derived',
  dimensions: readonly string[],
  rootInclusion: 'root_only' | 'inclusive',
  aggregation: string,
  allocationMethod: string,
  attributionPolicyId: string,
): AttributionMetricDefinition {
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
    populationRule: 'all_complete_and_partial_sessions',
    statusRule: 'include_partial_censored',
    aggregation,
    allocationMethod,
    statisticalPolicyId: STATISTICAL_POLICY_ID,
    attributionPolicyId,
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
      'allocationMethod',
      'attributionPolicyId',
    ],
    missingDataBehavior: 'unknown',
    rootInclusion,
    provenanceRequirement: PROVENANCE_REQUIREMENT,
  };
}

interface AttributionBaseMetricSpec {
  readonly metricId: string;
  readonly label: string;
  readonly family: string;
  readonly unit: string;
  readonly valueType: 'integer' | 'ratio';
  readonly measurementClass: 'derived';
  readonly dimensions: readonly string[];
  readonly aggregation: string;
  readonly allocationMethod: string;
  readonly attributionPolicyId: string;
  readonly description: (scope: 'root_only' | 'inclusive') => string;
}

const ATTRIBUTION_BASE_SPECS: readonly AttributionBaseMetricSpec[] = [
  {
    metricId: 'claude:attribution:context_retention',
    label: 'Context retention attribution',
    family: 'attribution',
    unit: 'fraction',
    valueType: 'ratio',
    measurementClass: 'derived',
    dimensions: [],
    aggregation: 'non-additive',
    allocationMethod: 'proportional',
    attributionPolicyId: ATTRIBUTION_POLICY_ID,
    description: (scope) =>
      `Share of invocation payload tokens attributed to retained context. ` +
      `Concurrent invocation attribution is non-additive. Scope: ${scope === 'root_only' ? 'root-only' : 'inclusive'}.`,
  },
  {
    metricId: 'claude:attribution:subagent_overlap_ms',
    label: 'Sub Agent overlap',
    family: 'attribution',
    unit: 'ms',
    valueType: 'integer',
    measurementClass: 'derived',
    dimensions: [],
    aggregation: 'non-additive',
    allocationMethod: 'overlap-window',
    attributionPolicyId: ATTRIBUTION_POLICY_ID,
    description: (scope) =>
      `Total time in which the root session overlaps with one or more Sub Agent ` +
      `sessions. Concurrent overlap is not double-counted. Scope: ${scope === 'root_only' ? 'root-only' : 'inclusive'}.`,
  },
  {
    metricId: 'claude:attribution:critical_path_ms',
    label: 'Sub Agent critical path',
    family: 'attribution',
    unit: 'ms',
    valueType: 'integer',
    measurementClass: 'derived',
    dimensions: [],
    aggregation: 'non-additive',
    allocationMethod: 'critical-path',
    attributionPolicyId: ATTRIBUTION_POLICY_ID,
    description: (scope) =>
      `Wall-clock span from the first session start to the last session end in ` +
      `the Sub Agent tree. Overlapping work does not extend the path. Scope: ${scope === 'root_only' ? 'root-only' : 'inclusive'}.`,
  },
];

export function getClaudeCodeAttributionMetricDefinitions(): readonly AttributionMetricDefinition[] {
  const definitions: AttributionMetricDefinition[] = [];
  for (const spec of ATTRIBUTION_BASE_SPECS) {
    for (const scope of ['root_only', 'inclusive'] as const) {
      const scopeLabel = scope === 'root_only' ? 'root-only' : 'inclusive';
      definitions.push(
        attributionMetricDefinition(
          `${spec.metricId}:${scope}`,
          `${spec.label} (${scopeLabel})`,
          spec.description(scope),
          spec.family,
          spec.unit,
          spec.valueType,
          spec.measurementClass,
          spec.dimensions,
          scope,
          spec.aggregation,
          spec.allocationMethod,
          spec.attributionPolicyId,
        ),
      );
    }
  }
  return definitions;
}

// ---------------------------------------------------------------------------
// Release matrix
// ---------------------------------------------------------------------------

function releaseReadyContextRetention(
  _session: ClaudeCodeSession,
  evidence: readonly NormalizedEvidenceRecord[],
  scope: 'root_only' | 'inclusive',
  ctx: AttributionEvidenceContext,
): { readonly ready: boolean; readonly reason?: string } {
  if (scope === 'inclusive' && ctx.missingSubagent) {
    return { ready: false, reason: 'one or more subagent transcripts missing' };
  }
  if (scope === 'inclusive' && ctx.unknownInclusion) {
    return { ready: false, reason: 'unknown parent inclusion semantics' };
  }
  const hasPayloads = evidence.some(
    (r) => r.recordType === 'invocation_payload' && inSessionTree(r, ctx),
  );
  if (!hasPayloads) {
    return { ready: false, reason: 'no invocation_payload records for attribution' };
  }
  return { ready: true };
}

function releaseReadySubagentOverlap(
  session: ClaudeCodeSession,
  evidence: readonly NormalizedEvidenceRecord[],
  scope: 'root_only' | 'inclusive',
  ctx: AttributionEvidenceContext,
): { readonly ready: boolean; readonly reason?: string } {
  if (scope === 'inclusive' && ctx.missingSubagent) {
    return { ready: false, reason: 'one or more subagent transcripts missing' };
  }
  if (scope === 'inclusive' && ctx.unknownInclusion) {
    return { ready: false, reason: 'unknown parent inclusion semantics' };
  }
  const intervals = collectSessionIntervals(evidence, scope, ctx);
  if (intervals.length === 0 || !intervals[0]) {
    return { ready: false, reason: 'no session timing evidence' };
  }
  if (scope === 'inclusive' && intervals.length < 2 && session.subagentLaunches.length > 0) {
    return { ready: false, reason: 'subagent timing evidence missing' };
  }
  return { ready: true };
}

export function getAttributionReleaseMatrix(): readonly AttributionReleaseMatrixEntry[] {
  const entries: AttributionReleaseMatrixEntry[] = [];
  for (const spec of ATTRIBUTION_BASE_SPECS) {
    const requiredEvidence: string[] =
      spec.metricId === 'claude:attribution:context_retention'
        ? ['invocation_payload']
        : ['session', 'session_relation'];
    entries.push({
      metricId: spec.metricId,
      label: spec.label,
      family: spec.family,
      requiredEvidence,
      measurementClass: spec.measurementClass,
      aggregation: spec.aggregation,
      allocationMethod: spec.allocationMethod,
      attributionPolicyId: spec.attributionPolicyId,
      statisticalPolicyId: STATISTICAL_POLICY_ID,
      additive: false,
      releaseReady:
        spec.metricId === 'claude:attribution:context_retention'
          ? releaseReadyContextRetention
          : releaseReadySubagentOverlap,
    });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Comparability and value construction
// ---------------------------------------------------------------------------

function dimensionsFor(
  definition: AttributionMetricDefinition,
  dimensionValue?: string,
): Record<string, string> {
  if (definition.dimensions.length === 0 || !dimensionValue) return {};
  return { [definition.dimensions[0]]: dimensionValue };
}

function comparabilityGroupFor(
  definition: AttributionMetricDefinition,
  dimensions: Readonly<Record<string, string>>,
  currencyPricingVersion?: string,
): string {
  const spec: ComparabilityGroupSpec = {
    metricId: definition.metricId,
    metricDefinitionVersion: CLAUDE_CODE_ATTRIBUTION_METRIC_DEFINITION_VERSION,
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
    aggregationStatisticalAttributionMethod: definition.allocationMethod
      ? `${definition.aggregation}:${definition.allocationMethod}`
      : definition.aggregation,
  };
  return deriveComparabilityGroupId(spec);
}

function createMetricValue(input: {
  readonly definition: AttributionMetricDefinition;
  readonly value: number | null;
  readonly exact: boolean;
  readonly evidenceRecordIds: readonly string[];
  readonly provenance: readonly Provenance[];
  readonly dimensionValue?: string;
  readonly estimationMethod: string;
  readonly unavailableReason?: string;
  readonly partialReason?: string;
}): ClaudeMetricValue {
  const dimensions = dimensionsFor(input.definition, input.dimensionValue);
  return {
    metricId: input.definition.metricId,
    definitionVersion: CLAUDE_CODE_ATTRIBUTION_METRIC_DEFINITION_VERSION,
    value: input.value,
    exact: input.exact,
    unit: input.definition.unit,
    comparabilityGroupId: comparabilityGroupFor(input.definition, dimensions),
    provenanceArtifactId: input.provenance[0]?.path,
    grain: input.definition.grain,
    dimensions,
    class: input.definition.measurementClass,
    confidence: input.value === null ? 0 : input.exact ? 1 : 0.75,
    rootScope: input.definition.rootInclusion === 'root_only' ? 'root_only' : 'inclusive',
    evidenceRecordIds: input.evidenceRecordIds,
    provenance: input.provenance,
    estimationMethod: input.estimationMethod,
    allocationMethod: input.definition.allocationMethod,
    unavailableReason: input.unavailableReason,
    partialReason: input.partialReason,
    definition: input.definition,
  } as ClaudeMetricValue;
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
  } as MetricProvenance;
}

// ---------------------------------------------------------------------------
// Computation helpers
// ---------------------------------------------------------------------------

function collectSessionIntervals(
  evidence: readonly NormalizedEvidenceRecord[],
  scope: 'root_only' | 'inclusive',
  ctx: AttributionEvidenceContext,
): SessionInterval[] {
  const intervals: SessionInterval[] = [];
  const inScope =
    scope === 'root_only'
      ? (record: NormalizedEvidenceRecord) => isRootRecord(record, ctx)
      : (record: NormalizedEvidenceRecord) => inSessionTree(record, ctx);

  for (const record of evidence) {
    if (record.recordType !== 'session') continue;
    if (!inScope(record)) continue;
    const payload = record.payload as {
      startTime?: string;
      endTime?: string;
    };
    if (!payload.startTime || !payload.endTime) continue;
    const startMs = Date.parse(payload.startTime);
    const endMs = Date.parse(payload.endTime);
    if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs < startMs) continue;
    intervals.push({ startMs, endMs, recordId: record.recordId });
  }
  return intervals;
}

function computeOverlapAndCriticalPath(intervals: SessionInterval[]): {
  readonly overlapMs: number;
  readonly criticalPathMs: number;
} {
  if (intervals.length === 0) {
    return { overlapMs: 0, criticalPathMs: 0 };
  }

  let minStart = Number.POSITIVE_INFINITY;
  let maxEnd = Number.NEGATIVE_INFINITY;
  const events: { readonly time: number; readonly delta: number }[] = [];
  for (const interval of intervals) {
    if (interval.startMs < minStart) minStart = interval.startMs;
    if (interval.endMs > maxEnd) maxEnd = interval.endMs;
    events.push({ time: interval.startMs, delta: 1 });
    events.push({ time: interval.endMs, delta: -1 });
  }

  events.sort((a, b) => {
    if (a.time !== b.time) return a.time - b.time;
    return a.delta - b.delta; // ends (-1) before starts (+1)
  });

  let active = 0;
  let prevTime: number | undefined;
  let overlapMs = 0;
  for (const event of events) {
    if (prevTime !== undefined && active > 1) {
      overlapMs += event.time - prevTime;
    }
    active += event.delta;
    prevTime = event.time;
  }

  const criticalPathMs = maxEnd - minStart;
  return { overlapMs, criticalPathMs };
}

function contextRetentionFromRecords(
  evidence: readonly NormalizedEvidenceRecord[],
  ctx: AttributionEvidenceContext,
): { readonly value: number | null; readonly exact: boolean; readonly reason?: string } {
  const records = evidence.filter(
    (r) => r.recordType === 'invocation_payload' && inSessionTree(r, ctx),
  );
  if (records.length === 0) {
    return { value: null, exact: false, reason: 'no invocation_payload records for attribution' };
  }

  let contextTokens = 0;
  let totalTokens = 0;
  let allExact = true;
  for (const record of records) {
    const payload = record.payload as InvocationPayloadPayload;
    const tokens = typeof payload.tokenAttribution === 'number' ? payload.tokenAttribution : 0;
    totalTokens += tokens;
    if (payload.attributionType === 'context') contextTokens += tokens;
    if (payload.tokenSource !== 'exact') allExact = false;
  }

  if (totalTokens === 0) {
    return { value: 0, exact: allExact };
  }
  return { value: contextTokens / totalTokens, exact: allExact };
}

// ---------------------------------------------------------------------------
// Main derivation
// ---------------------------------------------------------------------------

export function deriveClaudeCodeAttributionMetrics(
  session: ClaudeCodeSession,
  evidence: readonly NormalizedEvidenceRecord[],
  bundle: UnknownArtifactBundle,
  context: TransformContext,
  rootArtifactId: string,
): ClaudeMetricsResult {
  const definitions = getClaudeCodeAttributionMetricDefinitions();
  const definitionById = new Map<string, AttributionMetricDefinition>(
    definitions.map((d) => [d.metricId, d]),
  );
  const definitionFor = (metricId: string): AttributionMetricDefinition => {
    const def = definitionById.get(metricId);
    if (!def) throw new Error(`Missing attribution metric definition for ${metricId}`);
    return def;
  };

  const ctx = buildAttributionEvidenceContext(session, evidence, bundle, context);
  const rootSessionId = ctx.rootSessionId;
  const releaseMatrix = getAttributionReleaseMatrix();
  const releaseById = new Map(releaseMatrix.map((e) => [e.metricId, e]));

  const metricValues: ClaudeMetricValue[] = [];
  const metricProvenance: MetricProvenance[] = [];
  const unavailableReasons: MetricUnavailableReason[] = [];

  function pushMetric(
    definition: AttributionMetricDefinition,
    value: number | null,
    exact: boolean,
    evidenceRecordIds: readonly string[],
    provenance: readonly Provenance[],
    estimationMethod: string,
    unavailableReason?: string,
    partialReason?: string,
  ): void {
    const finalRecordIds = evidenceRecordIds.length > 0 ? evidenceRecordIds : [rootArtifactId];
    const finalProvenance =
      provenance.length > 0
        ? provenance
        : [{ path: rootArtifactId, sourceField: definition.metricId }];
    const metric = createMetricValue({
      definition,
      value,
      exact,
      evidenceRecordIds: finalRecordIds,
      provenance: finalProvenance,
      estimationMethod,
      unavailableReason,
      partialReason,
    });
    metricValues.push(metric);
    const recordId = stableId('metric_provenance', {
      metricId: metric.metricId,
      session: rootSessionId,
      artifact: rootArtifactId,
    });
    metricProvenance.push(metricProvenanceFor(metric, recordId));
    if (metric.value === null && metric.unavailableReason) {
      unavailableReasons.push({
        metricId: metric.metricId,
        definitionVersion: CLAUDE_CODE_ATTRIBUTION_METRIC_DEFINITION_VERSION,
        reason: metric.unavailableReason,
      });
    }
  }

  for (const scope of ['root_only', 'inclusive'] as const) {
    const isInclusive = scope === 'inclusive';
    let scopeReason: string | undefined;
    if (isInclusive && ctx.missingSubagent) {
      scopeReason = 'one or more subagent transcripts missing';
    } else if (isInclusive && ctx.unknownInclusion) {
      scopeReason = 'unknown parent inclusion semantics';
    }

    // Context retention attribution
    const retentionDef = definitionFor(`claude:attribution:context_retention:${scope}`);
    const releaseRetention = releaseById.get('claude:attribution:context_retention');
    const retentionGate = releaseRetention?.releaseReady(session, evidence, scope, ctx) ?? {
      ready: true,
    };
    if (scopeReason || !retentionGate.ready) {
      pushMetric(
        retentionDef,
        null,
        false,
        [],
        [],
        'attribution_evidence_unavailable',
        scopeReason ?? retentionGate.reason,
      );
    } else {
      const retention = contextRetentionFromRecords(evidence, ctx);
      const retentionRecords = evidence
        .filter((r) => r.recordType === 'invocation_payload' && inSessionTree(r, ctx))
        .map((r) => r.recordId);
      const retentionProvenance = evidence
        .filter((r) => r.recordType === 'invocation_payload' && inSessionTree(r, ctx))
        .map((r) => provenanceForRecord(r, rootArtifactId));
      pushMetric(
        retentionDef,
        retention.value,
        retention.exact,
        retentionRecords,
        retentionProvenance,
        'context_token_share_of_invocation_payloads',
        retention.reason,
        retention.value !== null
          ? 'attribution shares are non-additive across concurrent invocations'
          : undefined,
      );
    }

    // Sub Agent overlap and critical path
    const overlapDef = definitionFor(`claude:attribution:subagent_overlap_ms:${scope}`);
    const criticalDef = definitionFor(`claude:attribution:critical_path_ms:${scope}`);
    const releaseSubagent = releaseById.get('claude:attribution:subagent_overlap_ms');
    const subagentGate = releaseSubagent?.releaseReady(session, evidence, scope, ctx) ?? {
      ready: true,
    };

    const intervals = collectSessionIntervals(evidence, scope, ctx);
    if (scopeReason || !subagentGate.ready || intervals.length === 0) {
      const reason = scopeReason ?? subagentGate.reason ?? 'no session timing evidence';
      pushMetric(overlapDef, null, false, [], [], 'session_timing_unavailable', reason);
      pushMetric(criticalDef, null, false, [], [], 'session_timing_unavailable', reason);
      continue;
    }

    const { overlapMs, criticalPathMs } = computeOverlapAndCriticalPath(intervals);
    const intervalRecordIds = intervals.map((i) => i.recordId);
    const intervalProvenance = evidence
      .filter(
        (r) =>
          r.recordType === 'session' &&
          (scope === 'root_only' ? isRootRecord(r, ctx) : inSessionTree(r, ctx)),
      )
      .map((r) => provenanceForRecord(r, rootArtifactId));
    const relationRecordIds = evidence
      .filter(
        (r) =>
          r.recordType === 'session_relation' &&
          (scope === 'root_only' ? isRootRecord(r, ctx) : inSessionTree(r, ctx)),
      )
      .map((r) => r.recordId);
    const allEvidenceIds = [...intervalRecordIds, ...relationRecordIds];
    const allProvenance = [...intervalProvenance]; // relations use same provenance if needed

    pushMetric(
      overlapDef,
      overlapMs,
      true,
      allEvidenceIds,
      allProvenance,
      'union_of_overlapping_session_intervals',
      undefined,
      'overlapping Sub Agent time is non-additive',
    );
    pushMetric(
      criticalDef,
      criticalPathMs,
      true,
      allEvidenceIds,
      allProvenance,
      'span_from_first_session_start_to_last_session_end',
      undefined,
      'overlapping work does not extend the critical path',
    );
  }

  const capabilities = deriveAttributionCapabilitiesFromValues(metricValues);
  return { metricValues, metricProvenance, unavailableReasons, capabilities };
}

function deriveAttributionCapabilitiesFromValues(
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
      reason = v.partialReason ?? 'value is estimated or non-additive';
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

export function getClaudeCodeAttributionMetricCapabilities(
  bundle?: UnknownArtifactBundle,
): MetricCapability[] {
  const definitions = getClaudeCodeAttributionMetricDefinitions();
  if (!bundle) {
    return definitions.map((d) => ({
      metricId: d.metricId,
      definitionVersion: CLAUDE_CODE_ATTRIBUTION_METRIC_DEFINITION_VERSION,
      state: 'partial' as const,
      reason: 'no bundle supplied to evaluate evidence',
      comparabilityGroupId: comparabilityGroupFor(d, {}),
    }));
  }

  const session = extractRootSession(bundle);
  if (!session) {
    return definitions.map((d) => ({
      metricId: d.metricId,
      definitionVersion: CLAUDE_CODE_ATTRIBUTION_METRIC_DEFINITION_VERSION,
      state: 'unavailable' as const,
      reason: 'no root transcript artifact found',
      comparabilityGroupId: comparabilityGroupFor(d, {}),
    }));
  }

  const missingSubagent = hasMissingSubagentTranscript(session, bundle);
  const ts = sessionTimestampsMs(session);
  const hasTimestamps = ts.first !== undefined && ts.last !== undefined;
  const hasInvocations = hasToolInvocationEvidence(session);
  const hasSubagents =
    session.subagentLaunches.length > 0 || Object.keys(session.subagentSessions ?? {}).length > 0;

  return definitions.map((d) => {
    const isInclusive = d.rootInclusion === 'inclusive';
    const family = d.metricId.split(':')[2];
    let state: 'available' | 'partial' | 'unavailable' | 'incompatible' = 'available';
    let reason: string | undefined;

    if (isInclusive && missingSubagent) {
      state = 'unavailable';
      reason = 'one or more subagent transcripts missing';
    } else if (!hasTimestamps) {
      state = 'unavailable';
      reason = 'no event timestamps for session timing';
    } else if (family === 'context_retention' && !hasInvocations) {
      state = 'unavailable';
      reason = 'no invocation payloads for attribution';
    } else if (
      (family === 'subagent_overlap_ms' || family === 'critical_path_ms') &&
      isInclusive &&
      !hasSubagents
    ) {
      state = 'unavailable';
      reason = 'no Sub Agent sessions for inclusive scope';
    } else if (d.measurementClass === 'derived' || d.measurementClass === 'estimated') {
      state = 'partial';
      reason = 'derived from observed evidence with non-additive attribution metadata';
    }

    return {
      metricId: d.metricId,
      definitionVersion: CLAUDE_CODE_ATTRIBUTION_METRIC_DEFINITION_VERSION,
      state,
      reason,
      comparabilityGroupId: comparabilityGroupFor(d, {}),
    };
  });
}
