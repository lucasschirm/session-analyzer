/**
 * Shared metric metadata (label + description) for the Session Analyzer
 * dashboard.
 *
 * This is the single source of truth for the display label and hover-tooltip
 * text shown on {@link MetricsCard} and in chart legends/axes.  Every metric
 * card in the dashboard — portfolio, project behavior, session evidence,
 * component ecosystem, and artifact diff — resolves its label through
 * {@link metricLabel} and its description through {@link metricDescription}.
 *
 * Metric IDs follow the convention `<harness>:<category>:<subcategory>:<scope>`
 * (e.g. `claude:tokens:total:root_only`, `devin:duration:wall_ms:inclusive`).
 * Labels and descriptions are matched on the **domain segments** (everything
 * after the harness prefix) so the same entry applies to every harness's
 * variant of a logically equivalent metric.  Synthetic portfolio/component
 * metrics that don't follow the convention are matched by their full ID.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MetricMeta {
  readonly label: string;
  readonly description: string;
}

// ---------------------------------------------------------------------------
// Exact-match metadata for synthetic / non-conventional metric IDs
// ---------------------------------------------------------------------------

const EXACT_METRICS: ReadonlyMap<string, MetricMeta> = new Map([
  [
    'portfolio-project-count',
    {
      label: 'Project count',
      description:
        'Total number of projects in the portfolio. Counted from the projects table after applying the current portfolio filters.',
    },
  ],
  [
    'portfolio-session-count',
    {
      label: 'Session count',
      description:
        'Total number of sessions across all projects in the portfolio, after applying the current filters (time range, harness, model, mode, etc.).',
    },
  ],
  [
    'portfolio-component-count',
    {
      label: 'Component count',
      description:
        'Total number of offered artifacts (tools, skills, agents) across all projects in the portfolio.',
    },
  ],
  [
    'portfolio-unused-components',
    {
      label: 'Unused offered components',
      description:
        'Number of offered artifacts that were never invoked in any session. An artifact is "unused" when it is available in the project configuration but has zero invocations across all sessions.',
    },
  ],
  [
    'total-components',
    {
      label: 'Total components',
      description:
        'Total number of distinct artifacts (tools, skills, agents) known to the portfolio, summed across all kinds.',
    },
  ],
  [
    'total-load-rate',
    {
      label: 'Load rate',
      description:
        'Percentage of offered artifacts that were actually used in at least one session. Calculated as (used artifacts / offered artifacts) × 100.',
    },
  ],
  [
    'total-invoke-rate',
    {
      label: 'Invoke rate',
      description:
        'Average number of invocations per session for the selected artifact. Calculated as total invocations / total sessions that had the artifact available.',
    },
  ],
  [
    'total-overhead',
    {
      label: 'Overhead',
      description:
        'Ratio of artifact-related turns to total turns, measuring how much of the session was spent on artifact interactions versus other activity.',
    },
  ],
]);

// ---------------------------------------------------------------------------
// Domain-segment metadata
//
// Keyed by the domain path (category:subcategory) extracted from the metric
// ID.  Works for any harness prefix.
// ---------------------------------------------------------------------------

const DOMAIN_METRICS: ReadonlyMap<string, MetricMeta> = new Map([
  // Token metrics
  [
    'tokens:input',
    {
      label: 'Input tokens',
      description:
        'Input tokens reported by the model provider. Aggregated as a sum across all sessions in scope.',
    },
  ],
  [
    'tokens:output',
    {
      label: 'Output tokens',
      description:
        'Output tokens reported by the model provider. Aggregated as a sum across all sessions in scope.',
    },
  ],
  [
    'tokens:cache_creation',
    {
      label: 'Cache write tokens',
      description:
        'Cache-creation (cache-write) tokens reported by the provider. Aggregated as a sum across all sessions in scope.',
    },
  ],
  [
    'tokens:cache_read',
    {
      label: 'Cache-read tokens',
      description:
        'Cache-read tokens reported by the provider. Aggregated as a sum across all sessions in scope.',
    },
  ],
  [
    'tokens:prompt',
    {
      label: 'Prompt tokens',
      description:
        'Prompt tokens reported by the model provider. Aggregated as a sum across all sessions in scope.',
    },
  ],
  [
    'tokens:completion',
    {
      label: 'Completion tokens',
      description:
        'Completion tokens reported by the model provider. Aggregated as a sum across all sessions in scope.',
    },
  ],
  [
    'tokens:cached',
    {
      label: 'Cached tokens',
      description:
        'Cached tokens reported by the model provider (a subset of prompt tokens, never re-added to the total). Aggregated as a sum across all sessions in scope.',
    },
  ],
  [
    'tokens:total',
    {
      label: 'Total tokens',
      description:
        'Sum of all token classes (input + output + cache creation + cache read, or prompt + completion for Devin). Aggregated as a sum across all sessions in scope.',
    },
  ],

  // Cost metrics
  [
    'cost:total',
    {
      label: 'Total cost',
      description:
        'Estimated cost from provider pricing and observed token classes. Excludes sessions with incomplete token usage. Aggregated as a sum across all sessions in scope.',
    },
  ],

  // Duration metrics
  [
    'duration:wall_ms',
    {
      label: 'Session duration',
      description:
        'Wall-clock session duration in minutes, measured from the first to the last observed event. Aggregated as a sum across all sessions in scope.',
    },
  ],

  // Session shape metrics
  [
    'turns:count',
    {
      label: 'Turn count',
      description:
        'Number of logical turns (human + assistant message pairs). Aggregated as a sum across all sessions in scope.',
    },
  ],
  [
    'steps:count',
    {
      label: 'Step count',
      description:
        'Number of steps from the session transcript. Aggregated as a sum across all sessions in scope.',
    },
  ],

  // Invocation metrics
  [
    'invocations:tool',
    {
      label: 'Tool invocations',
      description:
        'Count of tool invocations. Skill and Agent invocations are excluded from this count. Aggregated as a sum across all sessions in scope.',
    },
  ],
  [
    'invocations:skill',
    {
      label: 'Skill invocations',
      description: 'Count of skill invocations. Aggregated as a sum across all sessions in scope.',
    },
  ],
  [
    'invocations:agent',
    {
      label: 'Agent invocations',
      description: 'Count of agent invocations. Aggregated as a sum across all sessions in scope.',
    },
  ],

  // File operations
  [
    'file_operations:count',
    {
      label: 'File operation count',
      description:
        'Count of file operations (read, write, edit, create, delete, rename, revert). Aggregated as a sum across all sessions in scope.',
    },
  ],

  // Commands
  [
    'commands:count',
    {
      label: 'Command count',
      description:
        'Count of executed shell and hook commands. Aggregated as a sum across all sessions in scope.',
    },
  ],

  // Validations
  [
    'validations:count',
    {
      label: 'Validation count',
      description:
        'Count of validation executions (test, lint, build, typecheck, custom). Aggregated as a sum across all sessions in scope.',
    },
  ],

  // Effort
  [
    'effort:changes',
    {
      label: 'Effort-level changes',
      description:
        'Count of reasoning-effort tier transitions across model request records. Aggregated as a sum across all sessions in scope.',
    },
  ],
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extracts the domain segments from a metric ID (everything after the harness
 * prefix).  e.g. `claude:tokens:total:root_only` → `['tokens', 'total',
 * 'root_only']`.
 */
function metricDomainSegments(metricId: string): string[] {
  return metricId.split(':').slice(1);
}

/**
 * Strips the trailing scope suffix (" (root-only)" / " (inclusive)") from a
 * metric label. The scope is already conveyed by the Sessions filter, so the
 * suffix is redundant in chart legends and axis labels.
 */
export function stripScopeSuffix(label: string): string {
  return label.replace(/\s*\((root-only|inclusive)\)\s*$/, '');
}

function scopeSuffix(metricId: string): string {
  if (metricId.endsWith(':root_only')) {
    return ' Scope: root-only (main session, excluding sub-agent contributions).';
  }
  if (metricId.endsWith(':inclusive')) {
    return ' Scope: inclusive (main session plus all sub-agent contributions).';
  }
  return '';
}

/** Whether the metric is the wall-clock duration metric, for any harness. */
function isDurationMetric(metricId: string): boolean {
  const [category, subcategory] = metricDomainSegments(metricId);
  return category === 'duration' && subcategory === 'wall_ms';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns the human-readable display label for a metric ID.
 *
 * Lookup order:
 * 1. Exact match on the full metric ID (synthetic portfolio/component metrics).
 * 2. Domain-segment match on `category:subcategory` (works for any harness).
 * 3. The provided fallback, with the scope suffix stripped.
 * 4. The raw metric ID.
 *
 * Duration metrics always return "Session duration (min)" since the stored
 * value is in minutes.
 */
export function metricLabel(metricId: string, fallback?: string): string {
  const exact = EXACT_METRICS.get(metricId);
  if (exact) return exact.label;

  const segments = metricDomainSegments(metricId);
  if (segments.length >= 2) {
    const domainKey = `${segments[0]}:${segments[1]}`;
    const domain = DOMAIN_METRICS.get(domainKey);
    if (domain) {
      if (isDurationMetric(metricId)) return 'Session duration (min)';
      return domain.label;
    }
  }

  const raw = fallback ?? metricId;
  return stripScopeSuffix(raw);
}

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
  const exact = EXACT_METRICS.get(metricId);
  if (exact) return exact.description;

  const segments = metricDomainSegments(metricId);
  if (segments.length >= 2) {
    const domainKey = `${segments[0]}:${segments[1]}`;
    const domain = DOMAIN_METRICS.get(domainKey);
    if (domain) return domain.description + scopeSuffix(metricId);
  }

  return 'This metric is derived from session analytics. See the indicator details page for more information.';
}
