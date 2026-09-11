/**
 * Shared metric descriptions for the Session Analyzer dashboard.
 *
 * This is the single source of truth for the hover-tooltip text shown on
 * {@link MetricsCard}.  Every metric card in the dashboard — portfolio,
 * project behavior, session evidence, component ecosystem, and artifact
 * diff — resolves its description through {@link metricDescription}.
 *
 * Metric IDs follow the convention `<harness>:<category>:<subcategory>:<scope>`
 * (e.g. `claude:tokens:total:root_only`, `devin:duration:wall_ms:inclusive`).
 * Descriptions are matched on the **domain segments** (everything after the
 * harness prefix) so the same description applies to every harness's variant
 * of a logically equivalent metric.  Synthetic portfolio/component metrics
 * that don't follow the convention are matched by their full ID.
 */

// ---------------------------------------------------------------------------
// Exact-match descriptions for synthetic / non-conventional metric IDs
// ---------------------------------------------------------------------------

const EXACT_DESCRIPTIONS: ReadonlyMap<string, string> = new Map([
  [
    'portfolio-project-count',
    'Total number of projects in the portfolio. Counted from the projects table after applying the current portfolio filters.',
  ],
  [
    'portfolio-session-count',
    'Total number of sessions across all projects in the portfolio, after applying the current filters (time range, harness, model, mode, etc.).',
  ],
  [
    'portfolio-component-count',
    'Total number of offered artifacts (tools, skills, agents) across all projects in the portfolio.',
  ],
  [
    'portfolio-unused-components',
    'Number of offered artifacts that were never invoked in any session. An artifact is "unused" when it is available in the project configuration but has zero invocations across all sessions.',
  ],
  [
    'total-components',
    'Total number of distinct artifacts (tools, skills, agents) known to the portfolio, summed across all kinds.',
  ],
  [
    'total-load-rate',
    'Percentage of offered artifacts that were actually used in at least one session. Calculated as (used artifacts / offered artifacts) × 100.',
  ],
  [
    'total-invoke-rate',
    'Average number of invocations per session for the selected artifact. Calculated as total invocations / total sessions that had the artifact available.',
  ],
  [
    'total-overhead',
    'Ratio of artifact-related turns to total turns, measuring how much of the session was spent on artifact interactions versus other activity.',
  ],
]);

// ---------------------------------------------------------------------------
// Domain-segment descriptions
//
// Keyed by the domain path (category:subcategory) extracted from the metric
// ID.  Works for any harness prefix.
// ---------------------------------------------------------------------------

const DOMAIN_DESCRIPTIONS: ReadonlyMap<string, string> = new Map([
  // Token metrics
  [
    'tokens:input',
    'Input tokens reported by the model provider. Aggregated as a sum across all sessions in scope.',
  ],
  [
    'tokens:output',
    'Output tokens reported by the model provider. Aggregated as a sum across all sessions in scope.',
  ],
  [
    'tokens:cache_creation',
    'Cache-creation (cache-write) tokens reported by the provider. Aggregated as a sum across all sessions in scope.',
  ],
  [
    'tokens:cache_read',
    'Cache-read tokens reported by the provider. Aggregated as a sum across all sessions in scope.',
  ],
  [
    'tokens:prompt',
    'Prompt tokens reported by the model provider. Aggregated as a sum across all sessions in scope.',
  ],
  [
    'tokens:completion',
    'Completion tokens reported by the model provider. Aggregated as a sum across all sessions in scope.',
  ],
  [
    'tokens:cached',
    'Cached tokens reported by the model provider (a subset of prompt tokens, never re-added to the total). Aggregated as a sum across all sessions in scope.',
  ],
  [
    'tokens:total',
    'Sum of all token classes (input + output + cache creation + cache read, or prompt + completion for Devin). Aggregated as a sum across all sessions in scope.',
  ],

  // Cost metrics
  [
    'cost:total',
    'Estimated cost from provider pricing and observed token classes. Excludes sessions with incomplete token usage. Aggregated as a sum across all sessions in scope.',
  ],

  // Duration metrics
  [
    'duration:wall_ms',
    'Wall-clock session duration in minutes, measured from the first to the last observed event. Aggregated as a sum across all sessions in scope.',
  ],

  // Session shape metrics
  [
    'turns:count',
    'Number of logical turns (human + assistant message pairs). Aggregated as a sum across all sessions in scope.',
  ],
  [
    'steps:count',
    'Number of steps from the session transcript. Aggregated as a sum across all sessions in scope.',
  ],

  // Invocation metrics
  [
    'invocations:tool',
    'Count of tool invocations. Skill and Agent invocations are excluded from this count. Aggregated as a sum across all sessions in scope.',
  ],
  [
    'invocations:skill',
    'Count of skill invocations. Aggregated as a sum across all sessions in scope.',
  ],
  [
    'invocations:agent',
    'Count of agent invocations. Aggregated as a sum across all sessions in scope.',
  ],

  // File operations
  [
    'file_operations:count',
    'Count of file operations (read, write, edit, create, delete, rename, revert). Aggregated as a sum across all sessions in scope.',
  ],

  // Commands
  [
    'commands:count',
    'Count of executed shell and hook commands. Aggregated as a sum across all sessions in scope.',
  ],

  // Validations
  [
    'validations:count',
    'Count of validation executions (test, lint, build, typecheck, custom). Aggregated as a sum across all sessions in scope.',
  ],

  // Effort
  [
    'effort:changes',
    'Count of reasoning-effort tier transitions across model request records. Aggregated as a sum across all sessions in scope.',
  ],
]);

// ---------------------------------------------------------------------------
// Scope suffix for descriptions
// ---------------------------------------------------------------------------

function scopeSuffix(metricId: string): string {
  if (metricId.endsWith(':root_only')) {
    return ' Scope: root-only (main session, excluding sub-agent contributions).';
  }
  if (metricId.endsWith(':inclusive')) {
    return ' Scope: inclusive (main session plus all sub-agent contributions).';
  }
  return '';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns a human-readable description of how a metric is calculated,
 * suitable for a hover tooltip on a metrics card.
 *
 * Lookup order:
 * 1. Exact match on the full metric ID (synthetic portfolio/component metrics).
 * 2. Domain-segment match on `category:subcategory` (works for any harness).
 * 3. Fallback to a generic string.
 */
export function metricDescription(metricId: string): string {
  const exact = EXACT_DESCRIPTIONS.get(metricId);
  if (exact) return exact;

  const segments = metricId.split(':').slice(1);
  if (segments.length >= 2) {
    const domainKey = `${segments[0]}:${segments[1]}`;
    const domainDesc = DOMAIN_DESCRIPTIONS.get(domainKey);
    if (domainDesc) return domainDesc + scopeSuffix(metricId);
  }

  return 'This metric is derived from session analytics. See the indicator details page for more information.';
}
