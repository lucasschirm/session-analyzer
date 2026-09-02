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
  if (
    metricId === 'devin:invocations:tool:root_only' ||
    metricId === 'devin:invocations:tool:inclusive'
  ) {
    if (parsed.toolCalls.length > 0) return { state: 'available' };
    return { state: 'unavailable', reason: 'no tool_call_state records' };
  }
  if (
    metricId.startsWith('devin:invocations:skill:') ||
    metricId.startsWith('devin:invocations:agent:')
  ) {
    return {
      state: 'unavailable',
      reason:
        'Skill/Agent invocations require plugins/discovered.json mapping, not implemented in this version',
    };
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
