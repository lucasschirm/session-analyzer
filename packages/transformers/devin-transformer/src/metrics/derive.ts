import type {
  AtifTranscript,
  DevinMessageLine,
  DevinSessionLine,
} from '@lucasschirm/sal-devin-session-parser';
import type {
  MetricCapability,
  MetricDefinition,
  MetricUnavailableReason,
  NormalizedEvidenceRecord,
  Provenance,
  ScalarMetricValue,
} from '@lucasschirm/sal-transformer-shared';
import { stableId } from '../session-spine.js';
import { comparabilityGroupFor } from './comparability.js';
import {
  DEVIN_METRIC_DEFINITION_VERSION,
  definitionFor,
  getDevinMetricDefinitions,
} from './definitions.js';

export interface DevinMetricValue extends ScalarMetricValue {
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

export interface DevinMetricsResult {
  readonly metricValues: readonly DevinMetricValue[];
  readonly metricProvenance: readonly MetricProvenance[];
  readonly unavailableReasons: readonly MetricUnavailableReason[];
  readonly capabilities: readonly MetricCapability[];
}

interface DevinTokenUsage {
  readonly prompt: number | null;
  readonly completion: number | null;
  readonly cached: number | null;
  readonly total: number | null;
  readonly steps: number | null;
  readonly exact: boolean;
  readonly recordId: string;
}

function dimensionsFor(
  definition: MetricDefinition,
  dimensionValue?: string,
): Record<string, string> {
  if (definition.dimensions.length === 0 || !dimensionValue) return {};
  return { [definition.dimensions[0]]: dimensionValue };
}

/**
 * Every `model_usage` record for the session — DS-B25 (#285) made this
 * possibly-plural (one per ATIF agent-generation step). Aggregate metrics
 * derived from `tokenUsage` (token classes, total, step count) must cite
 * every contributing record, not just the first, or a mid-session model
 * switch's second-and-later steps become invisible in the evidence trail
 * even though their token counts are summed into the aggregate value.
 */
function tokenRecordIdsFromEvidence(
  evidence: readonly NormalizedEvidenceRecord[],
  sessionId: string,
): string[] {
  const ids = evidence
    .filter((record) => record.recordType === 'model_usage' && record.sessionId === sessionId)
    .map((record) => record.recordId);
  return ids.length > 0 ? ids : [stableId('model_usage', { session: sessionId })];
}

function modelUsageRecords(
  evidence: readonly NormalizedEvidenceRecord[],
  sessionId: string,
): NormalizedEvidenceRecord[] {
  return evidence.filter(
    (record) => record.recordType === 'model_usage' && record.sessionId === sessionId,
  );
}

interface ModelUsageEffortPayload {
  readonly requestOrder?: number;
  readonly normalizedEffort?: string | null;
}

/**
 * Walks `model_usage` records in `requestOrder` order, carrying forward the
 * last-seen non-null `normalizedEffort` and incrementing a transition
 * counter whenever the current non-null value differs from the carried
 * value. Records with a null/unresolved `normalizedEffort` are skipped for
 * comparison (they neither end nor start a "known" streak) but are also
 * never counted toward `contributing` (the sample, `n`) — mirrors
 * `claude-code-metrics.ts`'s `computeEffortTransitions` exactly, since Devin
 * has only one per-request evidence type (`model_usage`, no `model_request`).
 */
function computeDevinEffortTransitions(records: readonly NormalizedEvidenceRecord[]): {
  readonly transitions: number;
  readonly contributing: readonly NormalizedEvidenceRecord[];
} {
  const sorted = [...records].sort((a, b) => {
    const orderA = (a.payload as ModelUsageEffortPayload).requestOrder ?? 0;
    const orderB = (b.payload as ModelUsageEffortPayload).requestOrder ?? 0;
    return orderA - orderB;
  });

  const contributing: NormalizedEvidenceRecord[] = [];
  let transitions = 0;
  let carried: string | undefined;
  for (const record of sorted) {
    const value = (record.payload as ModelUsageEffortPayload).normalizedEffort;
    if (value === null || value === undefined) continue;
    contributing.push(record);
    if (carried !== undefined && value !== carried) transitions += 1;
    carried = value;
  }
  return { transitions, contributing };
}

/**
 * Builds the `devin:effort:changes:*` metric value from an already-computed
 * transition result (extracted out of `deriveDevinMetrics` to keep that
 * function within `workspace-rules.md`'s function-length cap). `n` is the
 * count of records with a recognized effort value (`contributing`), never
 * the raw `model_usage` record count — an unresolved-effort record neither
 * ends nor starts a "known" streak (see `computeDevinEffortTransitions`).
 */
function effortChangesMetricValue(
  definition: MetricDefinition,
  effortResult: ReturnType<typeof computeDevinEffortTransitions>,
  provenance: readonly Provenance[],
  fallbackEvidenceRecordIds: readonly string[],
): DevinMetricValue {
  const n = effortResult.contributing.length;
  const value = n === 0 ? null : effortResult.transitions;
  const reason = n === 0 ? 'no recognized effort signal observed for this session' : undefined;
  // Even when unavailable (n=0), the metric must still cite the model_usage
  // evidence it inspected (`aggregates-expose-sample-size`) — falls back to
  // every model_usage record for the session, mirroring `devin:turns:count`'s
  // `turnIds.length > 0 ? turnIds : [tokenRecordId]` fallback in
  // `deriveDevinMetrics`.
  const contributingIds = effortResult.contributing.map((r) => r.recordId);
  const evidenceRecordIds =
    contributingIds.length > 0 ? contributingIds : fallbackEvidenceRecordIds;
  return createMetricValue({
    definition,
    value,
    exact: value !== null,
    evidenceRecordIds,
    provenance,
    estimationMethod: 'count_of_effort_level_transitions',
    unavailableReason: reason,
  });
}

function turnRecordIds(evidence: readonly NormalizedEvidenceRecord[], sessionId: string): string[] {
  return evidence
    .filter((r) => r.recordType === 'turn' && r.sessionId === sessionId)
    .map((r) => r.recordId);
}

function invocationRecordIds(
  evidence: readonly NormalizedEvidenceRecord[],
  sessionId: string,
  kind: 'tool' | 'skill' | 'agent',
): string[] {
  return evidence
    .filter(
      (r) =>
        r.recordType === 'invocation' &&
        r.sessionId === sessionId &&
        (r.payload as { kind?: string }).kind === kind,
    )
    .map((r) => r.recordId);
}

function sessionRecordIds(
  evidence: readonly NormalizedEvidenceRecord[],
  sessionId: string,
): string[] {
  return evidence
    .filter((r) => r.recordType === 'session' && r.sessionId === sessionId)
    .map((r) => r.recordId);
}

function sessionTimestamps(
  session?: DevinSessionLine,
  atif?: AtifTranscript,
): { first?: number; last?: number } {
  const values: number[] = [];
  if (session?.createdAt !== null && typeof session?.createdAt === 'number')
    values.push(session.createdAt * 1000);
  if (session?.lastActivityAt !== null && typeof session?.lastActivityAt === 'number')
    values.push(session.lastActivityAt * 1000);
  if (atif) {
    for (const step of atif.steps) {
      if (step.timestamp) {
        const parsed = Date.parse(step.timestamp);
        if (!Number.isNaN(parsed)) values.push(parsed);
      }
    }
  }
  if (values.length === 0) return {};
  values.sort((a, b) => a - b);
  return { first: values[0], last: values[values.length - 1] };
}

function createMetricValue(input: {
  readonly definition: MetricDefinition;
  readonly value: number | null;
  readonly exact: boolean;
  readonly evidenceRecordIds: readonly string[];
  readonly provenance: readonly Provenance[];
  readonly dimensionValue?: string;
  readonly estimationMethod?: string;
  readonly allocationMethod?: string;
  readonly unavailableReason?: string;
  readonly partialReason?: string;
}): DevinMetricValue {
  const dimensions = dimensionsFor(input.definition, input.dimensionValue);
  return {
    metricId: input.definition.metricId,
    definitionVersion: DEVIN_METRIC_DEFINITION_VERSION,
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
    allocationMethod: input.allocationMethod ?? input.definition.allocationMethod,
    unavailableReason: input.unavailableReason,
    partialReason: input.partialReason,
    definition: input.definition,
  };
}

function metricProvenanceFor(value: DevinMetricValue, recordId: string): MetricProvenance {
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

export function deriveDevinMetrics(
  session: DevinSessionLine | undefined,
  atif: AtifTranscript | undefined,
  orderedMessages: readonly DevinMessageLine[],
  evidence: readonly NormalizedEvidenceRecord[],
  tokenUsage: DevinTokenUsage,
  rootArtifactId: string,
  rootSessionId: string,
): DevinMetricsResult {
  const metricValues: DevinMetricValue[] = [];
  const metricProvenance: MetricProvenance[] = [];
  const unavailableReasons: MetricUnavailableReason[] = [];

  function pushValue(value: DevinMetricValue): void {
    metricValues.push(value);
    const recordId = stableId('metric_provenance', {
      metricId: value.metricId,
      session: rootSessionId,
      artifact: rootArtifactId,
    });
    metricProvenance.push(metricProvenanceFor(value, recordId));
    if (value.value === null && value.unavailableReason) {
      unavailableReasons.push({
        metricId: value.metricId,
        definitionVersion: DEVIN_METRIC_DEFINITION_VERSION,
        reason: value.unavailableReason,
      });
    }
  }

  function pushForBothScopes(
    metricIdBase: string,
    build: (scope: 'root_only' | 'inclusive', def: MetricDefinition) => DevinMetricValue,
  ): void {
    for (const scope of ['root_only', 'inclusive'] as const) {
      const metricId = `${metricIdBase}:${scope}`;
      const def = definitionFor(metricId);
      pushValue(build(scope, def));
    }
  }

  const tokenRecordIds = tokenRecordIdsFromEvidence(evidence, rootSessionId);
  // A single representative pointer for metrics unrelated to token usage
  // that merely need to prove "some evidence exists for this session" when
  // their own specific evidence (turns/session/invocations) is empty — see
  // the fallback usages below. Not used for the token/step metrics
  // themselves, which cite every record via `tokenRecordIds`.
  const tokenRecordId = tokenRecordIds[0];
  const tokenProvenance: Provenance[] = [
    { artifactId: rootArtifactId, sourceField: 'final_metrics', path: rootArtifactId },
  ];

  // Token class metrics
  const tokenClasses: [string, number | null][] = [
    ['prompt', tokenUsage.prompt],
    ['completion', tokenUsage.completion],
    ['cached', tokenUsage.cached],
  ];
  for (const [label, count] of tokenClasses) {
    pushForBothScopes(`devin:tokens:${label}`, (_scope, def) => {
      const value = count;
      const exact = tokenUsage.exact && count !== null;
      const reason = count === null ? 'token count not reported by source' : undefined;
      return createMetricValue({
        definition: def,
        value,
        exact,
        evidenceRecordIds: tokenRecordIds,
        provenance: tokenProvenance,
        dimensionValue: label,
        estimationMethod: tokenUsage.exact ? 'provider_reported_total' : 'missing_token_source',
        unavailableReason: reason,
      });
    });
  }

  // Total tokens
  pushForBothScopes('devin:tokens:total', (_scope, def) => {
    const value = tokenUsage.total;
    const exact = tokenUsage.exact && value !== null;
    const reason = value === null ? 'token totals not reported by source' : undefined;
    return createMetricValue({
      definition: def,
      value,
      exact,
      evidenceRecordIds: tokenRecordIds,
      provenance: tokenProvenance,
      dimensionValue: 'total',
      estimationMethod: tokenUsage.exact ? 'sum_of_token_classes' : 'missing_token_source',
      unavailableReason: reason,
    });
  });

  // Steps
  pushForBothScopes('devin:steps:count', (_scope, def) => {
    const value = tokenUsage.steps;
    const exact = value !== null;
    const reason = value === null ? 'ATIF final_metrics.total_steps not available' : undefined;
    return createMetricValue({
      definition: def,
      value,
      exact,
      evidenceRecordIds: tokenRecordIds,
      provenance: tokenProvenance,
      estimationMethod: exact ? 'provider_reported_total' : 'missing_step_count',
      unavailableReason: reason,
    });
  });

  // Effort-level changes — same evidence pool for both scopes (Devin has no
  // session-tree/subagent model_usage evidence to distinguish root_only from
  // inclusive today), mirroring how devin:tokens:*/devin:steps:count:* above
  // already treat both scopes identically.
  const effortResult = computeDevinEffortTransitions(modelUsageRecords(evidence, rootSessionId));
  const effortProvenance: Provenance[] = [
    { artifactId: rootArtifactId, sourceField: 'model_usage', path: rootArtifactId },
  ];
  pushForBothScopes('devin:effort:changes', (_scope, def) =>
    effortChangesMetricValue(def, effortResult, effortProvenance, tokenRecordIds),
  );

  // Turns
  const turnIds = turnRecordIds(evidence, rootSessionId);
  pushForBothScopes('devin:turns:count', (_scope, def) => {
    const count = orderedMessages.length;
    const value = count > 0 ? count : null;
    const exact = value !== null;
    const reason = value === null ? 'no message_nodes on main chain' : undefined;
    return createMetricValue({
      definition: def,
      value,
      exact,
      evidenceRecordIds: turnIds.length > 0 ? turnIds : [tokenRecordId],
      provenance: [{ artifactId: rootArtifactId, path: rootArtifactId }],
      estimationMethod: exact ? 'count_of_message_nodes' : 'missing_message_nodes',
      unavailableReason: reason,
    });
  });

  const sessionIds = sessionRecordIds(evidence, rootSessionId);
  const fallbackEvidence = sessionIds.length > 0 ? sessionIds : [tokenRecordId];

  // Invocations
  const toolIds = invocationRecordIds(evidence, rootSessionId, 'tool');
  pushForBothScopes('devin:invocations:tool', (_scope, def) => {
    const count = toolIds.length;
    const value = count;
    const exact = true;
    return createMetricValue({
      definition: def,
      value,
      exact,
      evidenceRecordIds: toolIds,
      provenance: [{ artifactId: rootArtifactId, path: rootArtifactId }],
      dimensionValue: 'tool',
      estimationMethod: 'count_of_tool_call_records',
    });
  });

  // Skill/Agent invocations: sourced from tool_call_state (functions.skill:*/
  // functions.run_subagent:* ACP calls), not plugins/discovered.json — see
  // DS-F11 (#288). A session with zero matching calls still reports a real,
  // exact 0 here, never unavailable: tool_call_state parsing is mandatory
  // evidence for any successfully-transformed Devin session
  // (`.agents/rules/missing-is-never-zero.md`).
  // Evidence still traces to the session even at a real 0 (no skill/agent
  // calls to point at): falls back to session/token evidence, same pattern
  // duration/cost already use below, so `must reference evidence`
  // (conformance) always holds without pretending a call happened.
  const skillIds = invocationRecordIds(evidence, rootSessionId, 'skill');
  pushForBothScopes('devin:invocations:skill', (_scope, def) =>
    createMetricValue({
      definition: def,
      value: skillIds.length,
      exact: true,
      evidenceRecordIds: skillIds.length > 0 ? skillIds : fallbackEvidence,
      provenance: [{ artifactId: rootArtifactId, path: rootArtifactId }],
      dimensionValue: 'skill',
      estimationMethod: 'count_of_tool_call_records',
    }),
  );

  const agentIds = invocationRecordIds(evidence, rootSessionId, 'agent');
  pushForBothScopes('devin:invocations:agent', (_scope, def) =>
    createMetricValue({
      definition: def,
      value: agentIds.length,
      exact: true,
      evidenceRecordIds: agentIds.length > 0 ? agentIds : fallbackEvidence,
      provenance: [{ artifactId: rootArtifactId, path: rootArtifactId }],
      dimensionValue: 'agent',
      estimationMethod: 'count_of_tool_call_records',
    }),
  );

  // Duration
  const timestamps = sessionTimestamps(session, atif);
  pushForBothScopes('devin:duration:wall_ms', (_scope, def) => {
    let value: number | null = null;
    let exact = false;
    let reason: string | undefined;
    let partialReason: string | undefined;
    if (timestamps.first !== undefined && timestamps.last !== undefined) {
      value = (timestamps.last - timestamps.first) / 60_000;
      exact = true;
      partialReason =
        'duration is derived from session or ATIF timestamps; per-message timestamps are unreliable';
    } else {
      reason = 'no session or ATIF timestamps available';
    }
    return createMetricValue({
      definition: def,
      value,
      exact,
      evidenceRecordIds: sessionIds.length > 0 ? sessionIds : [tokenRecordId],
      provenance: [{ artifactId: rootArtifactId, path: rootArtifactId }],
      estimationMethod: 'wall_clock_difference_of_session_events',
      unavailableReason: reason,
      partialReason,
    });
  });

  // Cost
  pushForBothScopes('devin:cost:total', (_scope, def) =>
    createMetricValue({
      definition: def,
      value: null,
      exact: false,
      evidenceRecordIds: fallbackEvidence,
      provenance: [{ artifactId: rootArtifactId, path: rootArtifactId }],
      dimensionValue: 'USD',
      estimationMethod: 'unavailable',
      unavailableReason:
        'per-session cost requires sessions.model -> models.json model_uid join planned for DS-F4',
    }),
  );

  const capabilities = metricValues.map((v) => {
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

  return { metricValues, metricProvenance, unavailableReasons, capabilities };
}

export { getDevinMetricDefinitions };
