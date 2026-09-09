import type { MetricDefinition } from '@lucasschirm/sal-transformer-shared';
import { getClaudeCodeAttributionMetricDefinitions } from './claude-code-attribution-metrics.js';
import { getClaudeCodeMetricDefinitions } from './claude-code-metrics.js';
import { getClaudeCodeOptimizationMetricDefinitions } from './claude-code-optimization-metrics.js';

// ---------------------------------------------------------------------------
// Metric ID -> label lookup, built from an injected set of definitions
//
// This factory accepts definitions as a parameter (rather than a hardcoded
// getter list) so that any transformer plugin package can build its own
// label lookup from whatever `MetricDefinition[]` it derives, without
// depending on claude-code-specific getters.
// ---------------------------------------------------------------------------

export interface MetricLabelLookup {
  readonly tryMetricIdToLabel: (metricId: string) => string | undefined;
  readonly metricIdToLabel: (metricId: string) => string;
}

export function createMetricLabelLookup(
  definitions: readonly MetricDefinition[],
): MetricLabelLookup {
  const labels = new Map<string, string>(definitions.map((d) => [d.metricId, d.label]));
  return {
    tryMetricIdToLabel: (metricId: string) => labels.get(metricId),
    metricIdToLabel: (metricId: string) => labels.get(metricId) ?? metricId,
  };
}

// ---------------------------------------------------------------------------
// This package's combined Claude metric label lookup
//
// Includes attribution metric definitions (fixes DS-B3 / #141, which
// previously omitted getClaudeCodeAttributionMetricDefinitions() here,
// causing attribution metric IDs to render raw in site chart helpers).
// ---------------------------------------------------------------------------

const claudeMetricLabelLookup = createMetricLabelLookup([
  ...getClaudeCodeMetricDefinitions(),
  ...getClaudeCodeOptimizationMetricDefinitions(),
  ...getClaudeCodeAttributionMetricDefinitions(),
]);

/**
 * Returns the human-readable label for a known Claude metric ID, or
 * `undefined` if no definition is found. Use {@link metricIdToLabel} when
 * you need a fallback to the raw metric ID.
 */
export const tryMetricIdToLabel: (metricId: string) => string | undefined =
  claudeMetricLabelLookup.tryMetricIdToLabel;

/**
 * Returns the human-readable label for a Claude metric ID, or the metric ID
 * itself if no definition is found. This is the single source of truth for
 * metric-id-to-label conversion and can be used as a fallback when the
 * database has not yet been updated with the latest labels.
 */
export const metricIdToLabel: (metricId: string) => string =
  claudeMetricLabelLookup.metricIdToLabel;
