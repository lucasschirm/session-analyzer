export const CANONICAL_INVARIANTS = {
  toolSkillAgentSubAgentDistinct: 'Tool, Skill, Agent, and Sub Agent remain distinct',
  unknownIsNotZero: 'unknown is not zero',
  exactAndEstimatedSeparable: 'exact and estimated values remain separable',
  rootOnlyAndInclusiveNoDoubleCount:
    'root-only and inclusive values cannot double-count descendants',
  startsAndResultsCorrelateBySourceId: 'starts and results correlate by source ID',
  replayedEventsDeduplicate: 'replayed source events deduplicate deterministically',
  partialSnapshotsDoNotImplyRemovals: 'partial snapshots do not imply removals',
  unavailableMetricsIncludeReason: 'unavailable metrics include a reason',
  outputIsDeterministic: 'output is deterministic for the same bundle and versions',
  everyAggregateRetainsProvenance: 'every aggregate retains evidence/provenance links',
  turnOrdinalsAreSequential: 'turn and message evidence is delivered in conversation order',
  sessionAggregateUsageIsNotTurnScoped:
    'session-level usage aggregates are never attributed to a single turn',
  turnContextDoesNotExceedSessionTotal:
    'a turn-scoped context volume cannot exceed the session total',
} as const;

export type CanonicalInvariant = keyof typeof CANONICAL_INVARIANTS;

export interface CanonicalInvariantContract {
  readonly code: CanonicalInvariant;
  readonly description: string;
}

export function listCanonicalInvariants(): readonly CanonicalInvariantContract[] {
  return (Object.keys(CANONICAL_INVARIANTS) as CanonicalInvariant[]).map((code) => ({
    code,
    description: CANONICAL_INVARIANTS[code],
  }));
}
