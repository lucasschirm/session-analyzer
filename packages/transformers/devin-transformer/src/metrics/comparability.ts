import type { MetricDefinition } from '@lucasschirm/sal-transformer-shared';
import {
  type ComparabilityGroupSpec,
  deriveComparabilityGroupId,
} from '@lucasschirm/sal-transformer-shared';

/**
 * Bumped 0.1.0 -> 0.2.0 for DS-B28 (#294): `devin:turns:count` (and every
 * other metric sharing this harness-wide definition-version stamp, per
 * `.agents/rules/metric-meaning-versioning.md`) changed POPULATION —
 * `orderMessages` (`parse-bundle.ts`) now dedups duplicate `message_nodes`
 * pairs (finding #4) and excludes orphaned sub-agent trees (finding #5)
 * from `orderedMessages`, both of which `devin:turns:count` derives from
 * directly. A session containing either pattern now reports a genuinely
 * different (correct, non-inflated) value than a pre-fix generation would
 * have — the two must never be aggregated together, hence the bump rather
 * than a silent in-place correction.
 */
/**
 * Bumped 0.2.0 -> 0.3.0 for #323: `devin:tokens:total:*` FORMULA changed
 * from prompt + completion + cached to prompt + completion. `cached` is a
 * subset of prompt in every sourcing tier (ATIF spec: "Subset of
 * prompt_tokens that were cache hits"; tier 3 constructs prompt as
 * input + cached, #322), so the old formula double-counted cache-heavy
 * sessions by up to ~2x. Pre-fix totals are genuinely different values —
 * per `.agents/rules/metric-meaning-versioning.md` they must never be
 * aggregated with post-fix totals, hence the bump.
 */
export const DEVIN_METRIC_DEFINITION_VERSION = '0.3.0';
export const DEVIN_NATIVE_MAPPING_VERSION = 'devin-0.1.0';
export const DEVIN_STATISTICAL_POLICY_ID = 'devin-default';
export const DEVIN_PROVENANCE_REQUIREMENT = 'source_artifact_event_field';

/**
 * Devin metric semantics differ from Claude in several ways; each divergence is
 * recorded in the comparability group inputs so the two harnesses never mix
 * values with different meanings:
 *
 * - Token population: Devin ATIF `final_metrics` are session-level totals, not
 *   per-request provider usage. Prompt/completion/cached classes are reported
 *   as totals, so they are a different observation unit from Claude per-request
 *   token class fields.
 * - Timestamp source: Devin `message_nodes.created_at` is unreliable (all rows
 *   share `sessions.last_activity_at` in the observed schema), so duration is
 *   derived from session start/end or ATIF step timestamps, not per-message.
 * - Tool domain: ACP `tool_call_json.kind` values (`edit|execute|search`) map
 *   only to the Tool domain. Skill/Agent invocations are sourced from
 *   `tool_call_state`'s `functions.skill:*`/`functions.run_subagent:*` ACP
 *   calls (DS-F11 (#288)), not `plugins/discovered.json` (which is never
 *   captured and is not needed for invocation counts).
 * - Cost: per-session cost requires the `sessions.model` -> `models.json`
 *   `variants[].model_uid` join planned for DS-F4; it is unavailable here.
 */

export function comparabilityGroupFor(
  definition: MetricDefinition,
  dimensions: Readonly<Record<string, string>>,
  currencyPricingVersion?: string,
): string {
  const spec: ComparabilityGroupSpec = {
    metricId: definition.metricId,
    metricDefinitionVersion: DEVIN_METRIC_DEFINITION_VERSION,
    unit: definition.unit,
    currencyPricingVersion,
    grain: definition.grain,
    dimensions,
    denominator: definition.denominator,
    observationUnit: 'session',
    population: definition.populationRule,
    sessionFinalityRules: definition.statusRule,
    measurementClass: definition.measurementClass,
    nativeMappingVersion: DEVIN_NATIVE_MAPPING_VERSION,
    rootOnlyInclusive: definition.rootInclusion === 'root_only' ? 'root_only' : 'inclusive',
    statusThresholdCensoringMissingDataRules: definition.missingDataBehavior,
    aggregationStatisticalAttributionMethod: definition.aggregation,
  };
  return deriveComparabilityGroupId(spec);
}
