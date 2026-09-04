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

function tokenRecordIdFromEvidence(
  evidence: readonly NormalizedEvidenceRecord[],
  sessionId: string,
): string {
  for (const record of evidence) {
    if (record.recordType === 'model_usage' && record.sessionId === sessionId)
      return record.recordId;
  }
  return stableId('model_usage', { session: sessionId });
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

  const tokenRecordId = tokenRecordIdFromEvidence(evidence, rootSessionId);
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
        evidenceRecordIds: [tokenRecordId],
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
      evidenceRecordIds: [tokenRecordId],
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
      evidenceRecordIds: [tokenRecordId],
      provenance: tokenProvenance,
      estimationMethod: exact ? 'provider_reported_total' : 'missing_step_count',
      unavailableReason: reason,
    });
  });

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
