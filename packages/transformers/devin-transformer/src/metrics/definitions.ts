import type { MetricDefinition } from '@lucasschirm/sal-transformer-shared';
import {
  DEVIN_METRIC_DEFINITION_VERSION,
  DEVIN_NATIVE_MAPPING_VERSION,
  DEVIN_PROVENANCE_REQUIREMENT,
  DEVIN_STATISTICAL_POLICY_ID,
} from './comparability.js';

interface DefinitionOptions {
  readonly allocationMethod?: string;
  readonly missingDataBehavior?: 'unknown' | 'not_applicable';
  readonly denominator?: string;
}

function metricDefinition(
  metricId: string,
  label: string,
  description: string,
  family: string,
  unit: string,
  valueType: 'integer' | 'real' | 'currency',
  measurementClass: 'observed' | 'derived' | 'estimated' | 'heuristic',
  dimensions: readonly string[],
  rootInclusion: 'root_only' | 'inclusive',
  aggregation: string,
  options: DefinitionOptions = {},
): MetricDefinition {
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
    denominator: options.denominator ?? 'session',
    populationRule: 'all_complete_and_partial_sessions',
    statusRule: 'include_partial_censored',
    aggregation,
    allocationMethod: options.allocationMethod,
    statisticalPolicyId: DEVIN_STATISTICAL_POLICY_ID,
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
    ],
    missingDataBehavior: options.missingDataBehavior ?? 'unknown',
    rootInclusion,
    provenanceRequirement: DEVIN_PROVENANCE_REQUIREMENT,
  };
}

export function getDevinMetricDefinitions(): readonly MetricDefinition[] {
  const defs: MetricDefinition[] = [];
  for (const scope of ['root_only', 'inclusive'] as const) {
    const scopeLabel = scope === 'root_only' ? 'root-only' : 'inclusive';

    const tokenClasses = [
      [
        'prompt',
        'Prompt tokens',
        'Prompt tokens reported by ATIF final_metrics or response_dimensions.',
      ],
      [
        'completion',
        'Completion tokens',
        'Completion tokens reported by ATIF final_metrics or response_dimensions.',
      ],
      [
        'cached',
        'Cached tokens',
        'Cached tokens reported by ATIF final_metrics or response_dimensions.',
      ],
    ] as const;
    for (const [cls, label, desc] of tokenClasses) {
      defs.push(
        metricDefinition(
          `devin:tokens:${cls}:${scope}`,
          `${label} (${scopeLabel})`,
          `${desc} Scope: ${scopeLabel}.`,
          'tokens',
          'token',
          'integer',
          'observed',
          ['token_class'],
          scope,
          'sum',
        ),
      );
    }
    defs.push(
      metricDefinition(
        `devin:tokens:total:${scope}`,
        `Total tokens (${scopeLabel})`,
        `Sum of prompt, completion, and cached tokens from ATIF final_metrics. Scope: ${scopeLabel}.`,
        'tokens',
        'token',
        'integer',
        'derived',
        ['token_class'],
        scope,
        'sum',
      ),
    );

    defs.push(
      metricDefinition(
        `devin:steps:count:${scope}`,
        `Step count (${scopeLabel})`,
        `Count of steps from ATIF final_metrics.total_steps. Scope: ${scopeLabel}.`,
        'session_shape',
        'count',
        'integer',
        'observed',
        [],
        scope,
        'sum',
      ),
    );
    defs.push(
      metricDefinition(
        `devin:turns:count:${scope}`,
        `Turn count (${scopeLabel})`,
        `Count of turns derived from the message_nodes main chain. Scope: ${scopeLabel}.`,
        'session_shape',
        'count',
        'integer',
        'observed',
        [],
        scope,
        'sum',
      ),
    );

    defs.push(
      metricDefinition(
        `devin:invocations:tool:${scope}`,
        `Tool invocations (${scopeLabel})`,
        `Count of ACP tool calls with kind edit/execute/search. Skill and Agent invocations are excluded. Scope: ${scopeLabel}.`,
        'invocations',
        'count',
        'integer',
        'observed',
        ['invocation_kind'],
        scope,
        'sum',
      ),
    );
    defs.push(
      metricDefinition(
        `devin:invocations:skill:${scope}`,
        `Skill invocations (${scopeLabel})`,
        `Count of Skill invocations from plugins/discovered.json. Scope: ${scopeLabel}.`,
        'invocations',
        'count',
        'integer',
        'observed',
        ['invocation_kind'],
        scope,
        'sum',
      ),
    );
    defs.push(
      metricDefinition(
        `devin:invocations:agent:${scope}`,
        `Agent invocations (${scopeLabel})`,
        `Count of Agent invocations from plugins/discovered.json. Scope: ${scopeLabel}.`,
        'invocations',
        'count',
        'integer',
        'observed',
        ['invocation_kind'],
        scope,
        'sum',
      ),
    );

    defs.push(
      metricDefinition(
        `devin:duration:wall_ms:${scope}`,
        `Session duration (${scopeLabel})`,
        `Time between the first and last observed session event, in minutes. Scope: ${scopeLabel}.`,
        'time',
        'minutes',
        'real',
        'derived',
        [],
        scope,
        'sum',
      ),
    );

    defs.push(
      metricDefinition(
        `devin:cost:total:${scope}`,
        `Total cost (${scopeLabel})`,
        `Estimated cost from Devin model pricing and observed token classes. Scope: ${scopeLabel}.`,
        'cost',
        'USD',
        'currency',
        'derived',
        ['currency'],
        scope,
        'sum',
        { allocationMethod: 'direct_sum' },
      ),
    );
  }
  return defs;
}

const DEFINITIONS = new Map<string, MetricDefinition>(
  getDevinMetricDefinitions().map((d) => [d.metricId, d]),
);

export function definitionFor(metricId: string): MetricDefinition {
  const def = DEFINITIONS.get(metricId);
  if (!def) throw new Error(`Missing metric definition for ${metricId}`);
  return def;
}

export { DEVIN_METRIC_DEFINITION_VERSION, DEVIN_NATIVE_MAPPING_VERSION };
