import { getClaudeCodeMetricDefinitions } from './claude-code-metrics.js';
import { getClaudeCodeOptimizationMetricDefinitions } from './claude-code-optimization-metrics.js';

// ---------------------------------------------------------------------------
// Shared metric ID → label lookup (reusable across packages)
// ---------------------------------------------------------------------------

const ALL_METRIC_LABELS: ReadonlyMap<string, string> = new Map<string, string>(
  [...getClaudeCodeMetricDefinitions(), ...getClaudeCodeOptimizationMetricDefinitions()].map(
    (d) => [d.metricId, d.label],
  ),
);

/**
 * Returns the human-readable label for a known metric ID, or `undefined` if
 * no definition is found. Use {@link metricIdToLabel} when you need a
 * fallback to the raw metric ID.
 */
export function tryMetricIdToLabel(metricId: string): string | undefined {
  return ALL_METRIC_LABELS.get(metricId);
}

/**
 * Returns the human-readable label for a metric ID, or the metric ID itself
 * if no definition is found. This is the single source of truth for
 * metric-id-to-label conversion and can be used as a fallback when the
 * database has not yet been updated with the latest labels.
 */
export function metricIdToLabel(metricId: string): string {
  return ALL_METRIC_LABELS.get(metricId) ?? metricId;
}
