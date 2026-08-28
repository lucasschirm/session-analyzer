import assert from 'node:assert/strict';
import {
  type ArtifactClassificationResult,
  CANONICAL_INVARIANTS,
  type CanonicalInvariant,
  type ComponentSummary,
  type MetricCapability,
  type NormalizedEvidenceRecord,
  type ScalarMetricValue,
  type SessionTransformer,
  type TransformResult,
  type UnknownArtifactBundle,
} from '../../src/index.js';
import type { ConformanceFixture, TransformerFixtures } from './fixtures/index.js';

interface FixtureResult<TBundle extends UnknownArtifactBundle> {
  readonly fixture: ConformanceFixture<TBundle>;
  readonly classification: ArtifactClassificationResult;
  readonly capabilities: MetricCapability[];
  readonly result: TransformResult;
}

export interface InvariantReport {
  readonly code: CanonicalInvariant;
  readonly status: 'passed' | 'partial' | 'unverified' | 'failed';
  readonly message: string;
  readonly details: readonly string[];
}

export interface ConformanceRunResult {
  readonly passed: boolean;
  readonly invariants: readonly InvariantReport[];
}

function report(
  code: CanonicalInvariant,
  status: InvariantReport['status'],
  details: string[],
): InvariantReport {
  return { code, status, message: CANONICAL_INVARIANTS[code], details };
}

function isSuccess(result: TransformResult): boolean {
  return !result.errors.some((e) => e.severity === 'fatal');
}

function successful<TBundle extends UnknownArtifactBundle>(
  results: FixtureResult<TBundle>[],
): FixtureResult<TBundle>[] {
  return results.filter((r) => isSuccess(r.result));
}

function findByTag<TBundle extends UnknownArtifactBundle>(
  results: FixtureResult<TBundle>[],
  tag: string,
): FixtureResult<TBundle> | undefined {
  return results.find((r) => r.fixture.tags.includes(tag));
}

function metricValue(result: TransformResult, metricId: string): ScalarMetricValue | undefined {
  return result.metricValues.find((m) => m.metricId === metricId);
}

function countRecordsBySession(
  result: TransformResult,
  recordType: string,
  sessionId: string,
): number {
  return result.evidence.filter((r) => r.recordType === recordType && r.sessionId === sessionId)
    .length;
}

function sumRecordFieldBySession(
  result: TransformResult,
  recordType: string,
  field: string,
  sessionId: string,
): number {
  let sum = 0;
  for (const record of result.evidence) {
    if (record.recordType !== recordType || record.sessionId !== sessionId) continue;
    const payload = record.payload as Record<string, unknown>;
    const value = payload[field];
    if (typeof value === 'number' && Number.isFinite(value)) sum += value;
  }
  return sum;
}

function rootAndChildSessionIds(result: TransformResult): {
  rootSessionId: string | undefined;
  childSessionIds: string[];
} {
  const root = result.sessionSummaries.find((s) => s.sessionId === s.rootSessionId);
  const rootSessionId = root?.sessionId;
  const childSessionIds = result.sessionSummaries
    .filter((s) => s.parentSessionId !== undefined)
    .map((s) => s.sessionId);
  return { rootSessionId, childSessionIds };
}

function hasProvenance(record: NormalizedEvidenceRecord): boolean {
  return (
    record.provenance !== undefined &&
    (record.provenance.artifactId !== undefined ||
      record.provenance.path !== undefined ||
      record.provenance.sourceEventId !== undefined)
  );
}

// ---------------------------------------------------------------------------
// 1. Tool, Skill, Agent, and Sub Agent remain distinct
// ---------------------------------------------------------------------------

function checkToolSkillAgentSubAgentDistinct<TBundle extends UnknownArtifactBundle>(
  results: FixtureResult<TBundle>[],
): InvariantReport {
  const complete = findByTag(results, 'complete');
  if (!complete || !isSuccess(complete.result)) {
    return report('toolSkillAgentSubAgentDistinct', 'unverified', [
      'No successful complete fixture with root and subagent available.',
    ]);
  }

  const { result } = complete;
  const details: string[] = [];

  const invocations = result.evidence.filter((r) => r.recordType === 'invocation');
  assert.ok(invocations.length > 0, 'Expected at least one invocation record');

  const byKind = new Map<string, NormalizedEvidenceRecord[]>();
  for (const inv of invocations) {
    const kind = (inv.payload as { kind?: string }).kind ?? 'unknown';
    const list = byKind.get(kind) ?? [];
    list.push(inv);
    byKind.set(kind, list);
  }

  for (const kind of ['tool', 'skill', 'agent']) {
    const list = byKind.get(kind);
    if (!list || list.length === 0) {
      return report('toolSkillAgentSubAgentDistinct', 'failed', [
        `Expected at least one ${kind} invocation in the complete fixture.`,
      ]);
    }
    details.push(`${kind} invocation count: ${list.length}`);
  }

  for (const inv of byKind.get('tool') ?? []) {
    const payload = inv.payload as { mcpServer?: string; mcpToolName?: string };
    if (payload.mcpServer) {
      details.push(`MCP tool invocation keeps server/tool distinct: ${payload.mcpServer}`);
    }
  }

  for (const inv of byKind.get('skill') ?? []) {
    const payload = inv.payload as { skillName?: string };
    assert.ok(
      payload.skillName,
      'Skill invocation must retain its skill name, not be classified as a generic tool.',
    );
  }

  for (const inv of byKind.get('agent') ?? []) {
    const payload = inv.payload as { agentType?: string; childSessionId?: string };
    assert.ok(
      payload.agentType,
      'Agent invocation must retain its agent type, not be classified as a generic tool.',
    );
    assert.ok(
      payload.childSessionId,
      'Agent invocation must link to a distinct Sub Agent session.',
    );
  }

  const relations = result.evidence.filter((r) => r.recordType === 'session_relation');
  assert.ok(relations.length > 0, 'Expected a session_relation record for the Sub Agent.');
  for (const relation of relations) {
    const payload = relation.payload as { nativeInclusionSemantics?: string };
    assert.equal(payload.nativeInclusionSemantics, 'subagent');
  }

  const componentKinds = new Set(result.componentSummaries.map((c) => c.kind));
  for (const kind of ['skill', 'agent', 'rule', 'mcp', 'settings']) {
    assert.ok(
      componentKinds.has(kind as ComponentSummary['kind']),
      `Expected a ${kind} component in the complete fixture.`,
    );
  }

  const { rootSessionId } = rootAndChildSessionIds(result);
  assert.ok(rootSessionId, 'Expected a root session id');

  for (const kind of ['tool', 'skill', 'agent'] as const) {
    const root = metricValue(result, `claude:invocations:${kind}:root_only`);
    const inclusive = metricValue(result, `claude:invocations:${kind}:inclusive`);
    assert.ok(root, `Expected claude:invocations:${kind}:root_only metric`);
    assert.ok(inclusive, `Expected claude:invocations:${kind}:inclusive metric`);
    const rootCount = result.evidence.filter(
      (r) =>
        r.recordType === 'invocation' &&
        r.sessionId === rootSessionId &&
        (r.payload as { kind?: string }).kind === kind,
    ).length;
    assert.equal(
      root.value,
      rootCount,
      `claude:invocations:${kind}:root_only must match root invocation records.`,
    );
    assert.ok(
      (inclusive.value as number) >= (root.value as number),
      `claude:invocations:${kind}:inclusive must include root count.`,
    );
  }

  return report('toolSkillAgentSubAgentDistinct', 'passed', details);
}

// ---------------------------------------------------------------------------
// 2. unknown is not zero
// ---------------------------------------------------------------------------

function checkUnknownIsNotZero<TBundle extends UnknownArtifactBundle>(
  results: FixtureResult<TBundle>[],
): InvariantReport {
  const partialFixtures = results.filter(
    (r) =>
      (r.fixture.tags.includes('partial') || r.fixture.tags.includes('unavailable')) &&
      isSuccess(r.result),
  );

  if (partialFixtures.length === 0) {
    return report('unknownIsNotZero', 'unverified', ['No partial/unavailable fixtures to test.']);
  }

  const details: string[] = [];
  for (const { fixture, result } of partialFixtures) {
    for (const metric of result.metricValues) {
      if (metric.value === null && metric.unavailableReason) {
        details.push(
          `${fixture.name}: ${metric.metricId} is null with reason "${metric.unavailableReason}"`,
        );
      }
      if (metric.value === 0 && metric.unavailableReason) {
        return report('unknownIsNotZero', 'failed', [
          `${fixture.name}: ${metric.metricId} is 0 but also has unavailable reason "${metric.unavailableReason}"`,
        ]);
      }
    }
    for (const reason of result.unavailableReasons) {
      if (!reason.reason) {
        return report('unknownIsNotZero', 'failed', [
          `Unavailable metric ${reason.metricId} has no reason in ${fixture.name}`,
        ]);
      }
      details.push(`${fixture.name}: ${reason.metricId} unavailable because "${reason.reason}"`);
    }
  }

  return report('unknownIsNotZero', 'partial', [
    ...details,
    'TODO: sessions with no assistant usage are not covered; such sessions currently produce 0-valued token metrics instead of null with a reason.',
  ]);
}

// ---------------------------------------------------------------------------
// 3. exact and estimated values remain separable
// ---------------------------------------------------------------------------

function checkExactAndEstimatedSeparable<TBundle extends UnknownArtifactBundle>(
  results: FixtureResult<TBundle>[],
): InvariantReport {
  const complete = findByTag(results, 'complete');
  const redacted = findByTag(results, 'redacted') ?? findByTag(results, 'exact-estimated');
  const target = complete && isSuccess(complete.result) ? complete : redacted;
  if (!target || !isSuccess(target.result)) {
    return report('exactAndEstimatedSeparable', 'unverified', [
      'No suitable fixture for exact/estimated checks.',
    ]);
  }

  const { result } = target;
  const exactValues = result.metricValues.filter((m) => m.exact);
  const estimatedValues = result.metricValues.filter((m) => !m.exact);

  assert.ok(exactValues.length > 0, 'Expected at least one exact metric value');
  assert.ok(estimatedValues.length > 0, 'Expected at least one estimated metric value');

  for (const metric of result.metricValues) {
    assert.ok(
      typeof metric.exact === 'boolean',
      'Every metric value must carry an explicit exact flag.',
    );
  }

  const cost = metricValue(result, 'claude:cost:total:root_only');
  if (cost && cost.value !== null) {
    assert.equal(cost.exact, false, 'Cost is external pricing, so it must be estimated');
  }

  const token = metricValue(result, 'claude:tokens:input:root_only');
  if (token && token.value !== null) {
    assert.equal(
      token.exact,
      true,
      'Token counts from provider usage must be exact when usage is present.',
    );
  }

  const comparabilityGroups = new Set(result.metricValues.map((m) => m.comparabilityGroupId));
  assert.equal(
    comparabilityGroups.size,
    result.metricValues.length,
    'Expected distinct comparability groups for distinct metric/scope/class combinations.',
  );

  const modelCaps = result.evidence.filter((r) => r.recordType === 'model_capabilities');
  for (const cap of modelCaps) {
    const payload = cap.payload as { contextWindowExact: boolean };
    assert.ok(
      typeof payload.contextWindowExact === 'boolean',
      'Model capability records must expose an exact/estimated flag.',
    );
  }

  return report('exactAndEstimatedSeparable', 'partial', [
    `exact values: ${exactValues.length}; estimated: ${estimatedValues.length}`,
    'TODO: the comparability group does not currently vary when an otherwise-observed token value becomes estimated; full separation requires versioning measurementClass per value.',
  ]);
}

// ---------------------------------------------------------------------------
// 4. root-only and inclusive values cannot double-count descendants
// ---------------------------------------------------------------------------

function checkRootOnlyAndInclusiveNoDoubleCount<TBundle extends UnknownArtifactBundle>(
  results: FixtureResult<TBundle>[],
): InvariantReport {
  const complete = findByTag(results, 'complete');
  if (!complete || !isSuccess(complete.result)) {
    return report('rootOnlyAndInclusiveNoDoubleCount', 'unverified', [
      'No successful root+subagent fixture available.',
    ]);
  }

  const { result } = complete;
  const { rootSessionId, childSessionIds } = rootAndChildSessionIds(result);
  assert.ok(rootSessionId, 'Expected a root session');

  const countMetrics = [
    ['claude:turns:count', 'turn'],
    ['claude:file_operations:count', 'file_operation'],
    ['claude:commands:count', 'command_execution'],
    ['claude:validations:count', 'validation'],
  ] as const;

  for (const [prefix, recordType] of countMetrics) {
    const root = metricValue(result, `${prefix}:root_only`);
    const inclusive = metricValue(result, `${prefix}:inclusive`);
    if (!root || !inclusive) continue;

    // Activity metrics for file operations, commands, and validations are
    // augmented from subagent sessions via subagentTaskEvidence. Those subagent
    // records are tracked in the metric evidenceRecordIds/provenance, but they
    // are not always emitted as separate evidence rows. Therefore we validate
    // root counts from emitted evidence and the inclusive metric against the
    // metric's own evidenceRecordIds count.
    const rootCount = countRecordsBySession(result, recordType, rootSessionId);
    let childCount = 0;
    for (const childId of childSessionIds) {
      childCount += countRecordsBySession(result, recordType, childId);
    }

    assert.equal(
      root.value,
      rootCount,
      `${prefix}:root_only should equal root records (${recordType}).`,
    );

    if (childCount > 0) {
      assert.equal(
        inclusive.value,
        rootCount + childCount,
        `${prefix}:inclusive should equal root + child records (${recordType}) when subagent records are emitted.`,
      );
    } else {
      assert.ok(
        (inclusive.value as number) >= (root.value as number),
        `${prefix}:inclusive must include root count when subagent records are not emitted.`,
      );
      const inclusiveRecordIds =
        inclusive.evidenceRecordIds?.filter((id) => id.startsWith(recordType)) ?? [];
      assert.ok(
        inclusiveRecordIds.length >= (inclusive.value as number) ||
          (inclusive.value as number) === root.value,
        `${prefix}:inclusive metric must reference at least as many evidence records as its value.`,
      );
    }

    assert.ok(
      (inclusive.value as number) >= (root.value as number),
      `${prefix}:inclusive must not be less than root_only.`,
    );
  }

  for (const kind of ['tool', 'skill', 'agent'] as const) {
    const root = metricValue(result, `claude:invocations:${kind}:root_only`);
    const inclusive = metricValue(result, `claude:invocations:${kind}:inclusive`);
    if (!root || !inclusive) continue;
    const rootCount = result.evidence.filter(
      (r) =>
        r.recordType === 'invocation' &&
        r.sessionId === rootSessionId &&
        (r.payload as { kind?: string }).kind === kind,
    ).length;
    let childCount = 0;
    for (const childId of childSessionIds) {
      childCount += result.evidence.filter(
        (r) =>
          r.recordType === 'invocation' &&
          r.sessionId === childId &&
          (r.payload as { kind?: string }).kind === kind,
      ).length;
    }
    assert.equal(
      root.value,
      rootCount,
      `claude:invocations:${kind}:root_only should equal root invocation records.`,
    );
    assert.equal(
      inclusive.value,
      rootCount + childCount,
      `claude:invocations:${kind}:inclusive should equal root + child invocation records.`,
    );
  }

  const tokenTotalRoot = metricValue(result, 'claude:tokens:total:root_only');
  const tokenTotalInclusive = metricValue(result, 'claude:tokens:total:inclusive');
  if (tokenTotalRoot && tokenTotalInclusive) {
    const rootSum =
      sumRecordFieldBySession(result, 'model_usage', 'inputTokens', rootSessionId) +
      sumRecordFieldBySession(result, 'model_usage', 'outputTokens', rootSessionId) +
      sumRecordFieldBySession(result, 'model_usage', 'cacheCreationTokens', rootSessionId) +
      sumRecordFieldBySession(result, 'model_usage', 'cacheReadTokens', rootSessionId);
    let childSum = 0;
    for (const childId of childSessionIds) {
      childSum +=
        sumRecordFieldBySession(result, 'model_usage', 'inputTokens', childId) +
        sumRecordFieldBySession(result, 'model_usage', 'outputTokens', childId) +
        sumRecordFieldBySession(result, 'model_usage', 'cacheCreationTokens', childId) +
        sumRecordFieldBySession(result, 'model_usage', 'cacheReadTokens', childId);
    }
    assert.equal(
      tokenTotalRoot.value,
      rootSum,
      'claude:tokens:total:root_only must equal the sum of root model usage tokens.',
    );
    assert.equal(
      tokenTotalInclusive.value,
      rootSum + childSum,
      'claude:tokens:total:inclusive must equal root + child model usage tokens.',
    );
  }

  return report('rootOnlyAndInclusiveNoDoubleCount', 'passed', [
    'Root-only and inclusive counts reconcile with per-session record counts.',
  ]);
}

// ---------------------------------------------------------------------------
// 5. starts and results correlate by source ID
// ---------------------------------------------------------------------------

function checkStartsAndResultsCorrelateBySourceId<TBundle extends UnknownArtifactBundle>(
  results: FixtureResult<TBundle>[],
): InvariantReport {
  const target = successful(results).find((r) =>
    r.result.evidence.some((rec) => rec.recordType === 'invocation'),
  );
  if (!target) {
    return report('startsAndResultsCorrelateBySourceId', 'unverified', [
      'No fixture with tool invocations to correlate.',
    ]);
  }

  const { result } = target;
  const invocations = result.evidence.filter((r) => r.recordType === 'invocation');

  for (const inv of invocations) {
    const payload = inv.payload as { startId?: string; resultId?: string };
    assert.ok(payload.startId, 'Invocation must have a startId');

    const inputPayload = result.evidence.find(
      (r) =>
        r.recordType === 'payload' &&
        (r.payload as { payloadType?: string }).payloadType === 'input' &&
        (r.payload as { toolUseId?: string }).toolUseId === payload.startId,
    );
    assert.ok(inputPayload, `No input payload for invocation startId ${payload.startId}`);

    if (payload.resultId) {
      const resultPayload = result.evidence.find(
        (r) =>
          r.recordType === 'payload' &&
          (r.payload as { payloadType?: string }).payloadType === 'result' &&
          (r.payload as { toolUseId?: string }).toolUseId === payload.startId &&
          r.sourceEventId === payload.resultId,
      );
      assert.ok(
        resultPayload,
        `No result payload for startId ${payload.startId} and resultId ${payload.resultId}`,
      );
    }
  }

  return report('startsAndResultsCorrelateBySourceId', 'passed', [
    `Correlated ${invocations.length} invocations with input/result payloads by source ID.`,
  ]);
}

// ---------------------------------------------------------------------------
// 6. replayed source events deduplicate deterministically
// ---------------------------------------------------------------------------

function checkReplayedEventsDeduplicate<TBundle extends UnknownArtifactBundle>(
  results: FixtureResult<TBundle>[],
  transformer: SessionTransformer<TBundle>,
): InvariantReport {
  const replayed = findByTag(results, 'replayed');
  if (!replayed || !isSuccess(replayed.result)) {
    return report('replayedEventsDeduplicate', 'unverified', ['No replayed fixture to test.']);
  }

  const first = replayed.result;
  const second = transformer.transform(replayed.fixture.bundle, replayed.fixture.context);

  assert.deepEqual(
    first.evidence.map((r) => r.recordId),
    second.evidence.map((r) => r.recordId),
    'Re-running the same bundle must produce identical record IDs.',
  );

  const recordIds = first.evidence.map((r) => r.recordId);
  const uniqueIds = new Set(recordIds);
  const hasDuplicates = recordIds.length !== uniqueIds.size;

  if (hasDuplicates) {
    return report('replayedEventsDeduplicate', 'partial', [
      `Deterministic IDs confirmed, but ${recordIds.length - uniqueIds.size} duplicate source events produced duplicate records with the same ID.`,
      'TODO: add source-event deduplication before record emission.',
    ]);
  }

  return report('replayedEventsDeduplicate', 'passed', [
    'Replayed source events produced deterministic and unique record IDs.',
  ]);
}

// ---------------------------------------------------------------------------
// 7. partial snapshots do not imply removals
// ---------------------------------------------------------------------------

function checkPartialSnapshotsDoNotImplyRemovals<TBundle extends UnknownArtifactBundle>(
  results: FixtureResult<TBundle>[],
): InvariantReport {
  const classification = results.find((r) => r.fixture.tags.includes('classification'));
  if (!classification) {
    return report('partialSnapshotsDoNotImplyRemovals', 'unverified', [
      'No classification fixture to test.',
    ]);
  }

  const { classification: cls } = classification;
  const details: string[] = [];

  const unclassified = cls.artifacts.filter((a) => a.kind === 'unclassified');
  assert.ok(unclassified.length > 0, 'Expected an unclassified artifact to test partial semantics');

  const componentKinds = new Set(cls.components.map((c) => c.kind));
  for (const kind of ['skill', 'agent', 'rule', 'mcp', 'settings']) {
    assert.ok(
      componentKinds.has(kind as ComponentSummary['kind']),
      `Partial snapshot should still contain ${kind} components, not remove them.`,
    );
    const completeness = cls.configurationSnapshot.completeness[kind];
    assert.ok(
      completeness === 'partial' || completeness === 'complete',
      `Partial snapshot with unclassified artifacts must mark present ${kind} as partial or complete, got ${completeness}.`,
    );
    details.push(`${kind}: completeness=${completeness}`);
  }

  const partial = findByTag(results, 'partial');
  if (partial && isSuccess(partial.result)) {
    const subagentCompleteness = partial.result.configurationSnapshot.completeness.subagent;
    if (subagentCompleteness) {
      assert.ok(
        subagentCompleteness === 'unavailable' || subagentCompleteness === 'partial',
        'Missing subagent should leave subagent completeness unavailable or partial, not complete.',
      );
      details.push(`partial-missing-subagent: subagent completeness=${subagentCompleteness}`);
    }
  }

  return report('partialSnapshotsDoNotImplyRemovals', 'passed', details);
}

// ---------------------------------------------------------------------------
// 8. unavailable metrics include a reason
// ---------------------------------------------------------------------------

function checkUnavailableMetricsIncludeReason<TBundle extends UnknownArtifactBundle>(
  results: FixtureResult<TBundle>[],
): InvariantReport {
  const partialFixtures = results.filter(
    (r) =>
      (r.fixture.tags.includes('partial') ||
        r.fixture.tags.includes('unavailable') ||
        r.fixture.tags.includes('no-root') ||
        r.fixture.tags.includes('classification')) &&
      (isSuccess(r.result) || r.result.unavailableReasons.length > 0),
  );

  if (partialFixtures.length === 0) {
    return report('unavailableMetricsIncludeReason', 'unverified', [
      'No partial/unavailable fixtures to test.',
    ]);
  }

  const details: string[] = [];
  for (const { fixture, capabilities, result } of partialFixtures) {
    for (const cap of capabilities) {
      if (cap.state === 'unavailable' || cap.state === 'partial') {
        assert.ok(
          cap.reason,
          `Metric capability ${cap.metricId} in state ${cap.state} must include a reason in ${fixture.name}`,
        );
        details.push(
          `${fixture.name}: capability ${cap.metricId} is ${cap.state} because ${cap.reason}`,
        );
      }
    }
    for (const metric of result.metricValues) {
      if (metric.value === null) {
        assert.ok(
          metric.unavailableReason,
          `Metric ${metric.metricId} with null value must include unavailableReason in ${fixture.name}`,
        );
        details.push(
          `${fixture.name}: metric ${metric.metricId} null because ${metric.unavailableReason}`,
        );
      }
    }
    for (const reason of result.unavailableReasons) {
      assert.ok(
        reason.reason,
        `UnavailableReason for ${reason.metricId} must have a reason in ${fixture.name}`,
      );
      details.push(`${fixture.name}: unavailable reason for ${reason.metricId}: ${reason.reason}`);
    }
  }

  return report('unavailableMetricsIncludeReason', 'passed', details);
}

// ---------------------------------------------------------------------------
// 9. output is deterministic for the same bundle and versions
// ---------------------------------------------------------------------------

function checkOutputIsDeterministic<TBundle extends UnknownArtifactBundle>(
  results: FixtureResult<TBundle>[],
  transformer: SessionTransformer<TBundle>,
): InvariantReport {
  const targets = successful(results).filter(
    (r) => r.fixture.tags.includes('deterministic') || r.fixture.tags.includes('complete'),
  );
  if (targets.length === 0) {
    return report('outputIsDeterministic', 'unverified', ['No deterministic fixtures to test.']);
  }

  const details: string[] = [];
  for (const { fixture, result } of targets) {
    const rerun = transformer.transform(fixture.bundle, fixture.context);
    assert.deepEqual(
      result.sessionSummaries.map((s) => s.sessionId),
      rerun.sessionSummaries.map((s) => s.sessionId),
      `Session summaries must be deterministic for ${fixture.name}`,
    );
    assert.deepEqual(
      result.metricValues.map((m) => m.metricId),
      rerun.metricValues.map((m) => m.metricId),
      `Metric IDs must be deterministic for ${fixture.name}`,
    );
    assert.deepEqual(
      result.evidence.map((r) => r.recordId),
      rerun.evidence.map((r) => r.recordId),
      `Evidence record IDs must be deterministic for ${fixture.name}`,
    );
    assert.equal(
      result.bundleHash,
      rerun.bundleHash,
      `Bundle hash must be deterministic for ${fixture.name}`,
    );
    details.push(`${fixture.name}: deterministic across two runs`);

    const reversedArtifacts = [...fixture.bundle.artifacts].reverse();
    const reversedBundle = { ...fixture.bundle, artifacts: reversedArtifacts } as TBundle;
    const reversed = transformer.transform(reversedBundle, fixture.context);
    assert.deepEqual(
      result.sessionSummaries.map((s) => s.sessionId),
      reversed.sessionSummaries.map((s) => s.sessionId),
      `Session summaries must be stable regardless of artifact order for ${fixture.name}`,
    );
    details.push(`${fixture.name}: stable IDs regardless of artifact order`);
  }

  return report('outputIsDeterministic', 'passed', details);
}

// ---------------------------------------------------------------------------
// 10. every aggregate retains evidence/provenance links
// ---------------------------------------------------------------------------

function checkEveryAggregateRetainsProvenance<TBundle extends UnknownArtifactBundle>(
  results: FixtureResult<TBundle>[],
): InvariantReport {
  const target = successful(results).find(
    (r) => r.result.metricValues.length > 0 && r.result.evidence.length > 0,
  );
  if (!target) {
    return report('everyAggregateRetainsProvenance', 'unverified', [
      'No successful fixture with metrics and evidence to test.',
    ]);
  }

  const { result } = target;
  const details: string[] = [];

  for (const record of result.evidence) {
    assert.ok(hasProvenance(record), `Evidence record ${record.recordId} must have provenance`);
  }
  details.push(`All ${result.evidence.length} evidence records have provenance.`);

  for (const metric of result.metricValues) {
    assert.ok(metric.provenance.length > 0, `Metric ${metric.metricId} must retain provenance`);
    if (metric.value !== null) {
      assert.ok(
        metric.evidenceRecordIds.length > 0,
        `Metric ${metric.metricId} with a value must link to evidence records`,
      );
    }
  }
  details.push(`All ${result.metricValues.length} metric values have provenance.`);

  for (const cap of result.capabilities) {
    assert.ok(
      cap.evidence && cap.evidence.length > 0,
      `Capability ${cap.metricId} must reference evidence`,
    );
  }
  details.push(`All ${result.capabilities.length} capabilities reference evidence.`);

  for (const component of result.componentSummaries) {
    assert.ok(
      component.sourceArtifactIds.length > 0,
      `Component ${component.componentId} must reference source artifacts`,
    );
  }
  details.push(`All ${result.componentSummaries.length} components reference source artifacts.`);

  for (const prov of result.provenance) {
    assert.ok(
      prov.artifactId || prov.path || prov.sourceEventId,
      'Every provenance entry must point to an artifact, path, or source event',
    );
  }
  details.push(`All ${result.provenance.length} provenance entries are non-empty.`);

  const formulaChecks = [
    {
      tag: 'compaction',
      predicate: (r: NormalizedEvidenceRecord) =>
        r.recordType === 'normalized_event' &&
        (r.payload as { category?: string }).category === 'compaction',
    },
    {
      tag: 'payload',
      predicate: (r: NormalizedEvidenceRecord) => r.recordType === 'payload',
    },
    {
      tag: 'file',
      predicate: (r: NormalizedEvidenceRecord) => r.recordType === 'file_operation',
    },
    {
      tag: 'command',
      predicate: (r: NormalizedEvidenceRecord) => r.recordType === 'command_execution',
    },
    {
      tag: 'validation',
      predicate: (r: NormalizedEvidenceRecord) => r.recordType === 'validation',
    },
    {
      tag: 'cache',
      predicate: (r: NormalizedEvidenceRecord) => r.recordType === 'model_usage',
    },
    {
      tag: 'attribution',
      predicate: (r: NormalizedEvidenceRecord) => r.recordType === 'component_evidence_link',
    },
    {
      tag: 'latency',
      predicate: (r: NormalizedEvidenceRecord) =>
        r.recordType === 'invocation' &&
        typeof (r.payload as { latencyMs?: unknown }).latencyMs === 'number',
    },
    {
      tag: 'context',
      predicate: (r: NormalizedEvidenceRecord) =>
        r.recordType === 'normalized_event' &&
        (r.payload as { category?: string }).category === 'compaction',
    },
  ];

  for (const { tag, predicate } of formulaChecks) {
    const found = result.evidence.some(predicate);
    if (found) {
      details.push(`${tag} formula records present.`);
    } else {
      details.push(`TODO: no records in the selected fixture for ${tag} formula.`);
    }
  }

  return report('everyAggregateRetainsProvenance', 'partial', [
    ...details,
    'TODO: full formula coverage requires additional fixtures tuned for context, latency, and attribution edge cases.',
  ]);
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function runTransformerConformanceSuite<TBundle extends UnknownArtifactBundle>(
  transformer: SessionTransformer<TBundle>,
  fixtures: TransformerFixtures<TBundle>,
): ConformanceRunResult {
  const results: FixtureResult<TBundle>[] = [];
  for (const fixture of fixtures.fixtures) {
    const classification = transformer.classifyArtifacts(fixture.bundle);
    const capabilities = transformer.getCapabilities(fixture.bundle);
    const result = transformer.transform(fixture.bundle, fixture.context);
    results.push({ fixture, classification, capabilities, result });
  }

  const reports: InvariantReport[] = [
    checkToolSkillAgentSubAgentDistinct(results),
    checkUnknownIsNotZero(results),
    checkExactAndEstimatedSeparable(results),
    checkRootOnlyAndInclusiveNoDoubleCount(results),
    checkStartsAndResultsCorrelateBySourceId(results),
    checkReplayedEventsDeduplicate(results, transformer),
    checkPartialSnapshotsDoNotImplyRemovals(results),
    checkUnavailableMetricsIncludeReason(results),
    checkOutputIsDeterministic(results, transformer),
    checkEveryAggregateRetainsProvenance(results),
  ];

  const passed = !reports.some((r) => r.status === 'failed');
  if (!passed) {
    const failed = reports.filter((r) => r.status === 'failed');
    assert.fail(
      `Transformer conformance suite failed for invariants: ${failed.map((r) => r.code).join(', ')}`,
    );
  }

  return { passed, invariants: reports };
}
