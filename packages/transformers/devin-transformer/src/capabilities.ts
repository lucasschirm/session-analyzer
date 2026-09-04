import type { MetricCapability, UnknownArtifactBundle } from '@lucasschirm/sal-transformer-shared';
import { comparabilityGroupFor } from './metrics/comparability.js';
import { definitionFor, getDevinMetricDefinitions } from './metrics/definitions.js';
import { type DevinParsedBundle, parseDevinBundle } from './parse-bundle.js';

function hasAnyTokenSource(parsed: DevinParsedBundle): boolean {
  if (parsed.atif?.finalMetrics) {
    const fm = parsed.atif.finalMetrics;
    return (
      fm.totalPromptTokens !== null ||
      fm.totalCompletionTokens !== null ||
      fm.totalCachedTokens !== null
    );
  }
  if (parsed.sessionLine?.metadata) {
    try {
      const meta: unknown = JSON.parse(parsed.sessionLine.metadata);
      if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
        const dimensions = (meta as Record<string, unknown>).response_dimensions;
        return Array.isArray(dimensions) && dimensions.length > 0;
      }
    } catch {
      /* ignore */
    }
  }
  return false;
}

function hasStepsSource(parsed: DevinParsedBundle): 'available' | 'partial' | false {
  if (typeof parsed.atif?.finalMetrics?.totalSteps === 'number') return 'available';
  if (parsed.orderedMessages.length > 0) return 'partial';
  return false;
}

function hasTimestamps(parsed: DevinParsedBundle): boolean {
  if (parsed.atif?.steps.some((s) => s.timestamp !== null)) return true;
  if (parsed.sessionLine?.createdAt !== null && parsed.sessionLine?.createdAt !== undefined)
    return true;
  if (
    parsed.sessionLine?.lastActivityAt !== null &&
    parsed.sessionLine?.lastActivityAt !== undefined
  )
    return true;
  return false;
}

function capabilityStateFor(
  metricId: string,
  parsed: DevinParsedBundle,
): { state: 'available' | 'partial' | 'unavailable'; reason?: string } {
  if (metricId.startsWith('devin:tokens:')) {
    if (hasAnyTokenSource(parsed)) return { state: 'available' };
    return {
      state: 'unavailable',
      reason: 'token counts not reported by ATIF final_metrics or response_dimensions',
    };
  }
  if (metricId.startsWith('devin:steps:')) {
    const steps = hasStepsSource(parsed);
    if (steps === 'available') return { state: 'available' };
    if (steps === 'partial')
      return {
        state: 'partial',
        reason: 'steps estimated from message count; ATIF total_steps not available',
      };
    return { state: 'unavailable', reason: 'no message or step evidence' };
  }
  if (metricId.startsWith('devin:turns:')) {
    if (parsed.orderedMessages.length > 0) return { state: 'available' };
    return { state: 'unavailable', reason: 'no message_nodes on main chain' };
  }
  // Tool/Skill/Agent invocation counts are always available once a root
  // transcript exists: metrics/derive.ts computes these as a real, exact
  // integer (`exact: true`, `value` never null) regardless of whether any
  // tool_call_state records are present — a session with zero matching
  // calls still gets a real, exact 0 count, never 'unavailable'
  // (`.agents/rules/missing-is-never-zero.md`). Gating this standalone
  // preview on `parsed.toolCalls.length > 0` would report 'unavailable'
  // here while `transform(bundle, ctx).capabilities` reports 'available'
  // for the very same bundle — this branch must mirror that unconditional
  // availability, not just approximate it, to keep the two paths
  // consistent for DS-F11 (#288) acceptance criteria.
  if (
    metricId === 'devin:invocations:tool:root_only' ||
    metricId === 'devin:invocations:tool:inclusive' ||
    metricId.startsWith('devin:invocations:skill:') ||
    metricId.startsWith('devin:invocations:agent:')
  ) {
    return { state: 'available' };
  }
  if (metricId.startsWith('devin:duration:')) {
    if (hasTimestamps(parsed))
      return {
        state: 'partial',
        reason:
          'per-message timestamps are unreliable; duration is coarse from session or ATIF timestamps',
      };
    return { state: 'unavailable', reason: 'no session or ATIF timestamps' };
  }
  if (metricId.startsWith('devin:cost:')) {
    return {
      state: 'unavailable',
      reason:
        'per-session cost requires sessions.model -> models.json model_uid join planned for DS-F4',
    };
  }
  return { state: 'unavailable', reason: 'unknown metric' };
}

export function getDevinMetricCapabilities(bundle?: UnknownArtifactBundle): MetricCapability[] {
  const definitions = getDevinMetricDefinitions();
  if (!bundle) {
    return definitions.map((d) => ({
      metricId: d.metricId,
      definitionVersion: '0.1.0',
      state: 'partial' as const,
      reason: 'no bundle supplied to evaluate evidence',
      comparabilityGroupId: comparabilityGroupFor(d, {}),
    }));
  }

  const parsed = parseDevinBundle(bundle);
  if (!parsed.rootTranscriptText) {
    return definitions.map((d) => ({
      metricId: d.metricId,
      definitionVersion: '0.1.0',
      state: 'unavailable' as const,
      reason: 'no root transcript artifact found',
      comparabilityGroupId: comparabilityGroupFor(d, {}),
    }));
  }

  return definitions.map((d) => {
    const { state, reason } = capabilityStateFor(d.metricId, parsed);
    return {
      metricId: d.metricId,
      definitionVersion: '0.1.0',
      state,
      reason,
      comparabilityGroupId: comparabilityGroupFor(d, {}),
    };
  });
}

export function getMetricDefinition(metricId: string) {
  return definitionFor(metricId);
}
