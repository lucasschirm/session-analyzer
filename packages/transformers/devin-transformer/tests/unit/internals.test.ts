import type { DevinMessageLine, DevinToolCallLine } from '@lucasschirm/sal-devin-session-parser';
import { describe, expect, it } from 'vitest';
import { getDevinMetricCapabilities } from '../../src/capabilities.js';
import { classifyDevinArtifacts } from '../../src/classification.js';
import { definitionFor, getDevinMetricDefinitions } from '../../src/metrics/definitions.js';
import { parseDevinBundle } from '../../src/parse-bundle.js';
import { buildSessionSpine } from '../../src/session-spine.js';
import { buildTokenUsageRecords } from '../../src/token-usage.js';
import { buildToolInvocationRecords } from '../../src/tool-invocations.js';

describe('Internal token usage', () => {
  it('falls back to session metadata response_dimensions when ATIF is missing', () => {
    const session = {
      id: 's1',
      metadata: JSON.stringify({
        response_dimensions: [
          { prompt_tokens: 10, completion_tokens: 5, cached_tokens: 1 },
          { promptTokens: 20, completionTokens: 10, cachedTokens: 2 },
        ],
      }),
      model: 'devin-default',
    } as unknown as Parameters<typeof buildTokenUsageRecords>[1];
    const result = buildTokenUsageRecords('s1', session, undefined, [], 'artifact-1', []);
    expect(result.prompt).toBe(30);
    expect(result.completion).toBe(15);
    expect(result.cached).toBe(3);
    expect(result.exact).toBe(true);
  });

  it('handles malformed session metadata gracefully', () => {
    const session = {
      id: 's1',
      metadata: 'not-json',
      model: null,
    } as unknown as Parameters<typeof buildTokenUsageRecords>[1];
    const result = buildTokenUsageRecords('s1', session, undefined, [], 'artifact-1', []);
    expect(result.prompt).toBeNull();
    expect(result.exact).toBe(false);
  });

  it('resolves model by label when modelUid does not match', () => {
    const session = {
      id: 's1',
      metadata: null,
      model: 'Devin Default',
    } as unknown as Parameters<typeof buildTokenUsageRecords>[1];
    const models = [{ modelUid: 'devin-default', label: 'Devin Default' }] as unknown as Parameters<
      typeof buildTokenUsageRecords
    >[3];
    const result = buildTokenUsageRecords('s1', session, undefined, models, 'artifact-1', []);
    expect(result.records[0]?.payload).toMatchObject({ model: 'devin-default' });
  });

  // DS-B25 (#285) repro: the real `shadow-collar` session's steps[8]/steps[10]
  // shape (findings 3a/3b) — two agent-generation steps, `glm-5-2` then
  // `swe-1-7`, whose per-step metrics sum exactly to `final_metrics`.
  // Mid-session model switch must yield 2 distinct model_usage records, not
  // one last-write-wins record. Extended by DS-B31 (#290) to also assert the
  // per-step `effort`/`normalizedEffort` payload fields resolved from the
  // catalog's `label` (finding 3b: both are unsuffixed-uid, label-only tiers).
  it('emits one model_usage record per ATIF step when steps carry metrics (mid-session model switch)', () => {
    const session = {
      id: 's1',
      metadata: null,
      model: 'swe-1-7',
    } as unknown as Parameters<typeof buildTokenUsageRecords>[1];
    const atif = {
      finalMetrics: {
        totalPromptTokens: 35104,
        totalCompletionTokens: 96,
        totalCachedTokens: 23010,
        totalSteps: 11,
      },
      steps: [
        {
          timestamp: null,
          role: null,
          text: null,
          stepId: 9,
          generationModel: 'glm-5-2',
          metrics: { promptTokens: 18071, completionTokens: 59, cachedTokens: 11874 },
        },
        {
          timestamp: null,
          role: null,
          text: null,
          stepId: 11,
          generationModel: 'swe-1-7',
          metrics: { promptTokens: 17033, completionTokens: 37, cachedTokens: 11136 },
        },
      ],
    } as unknown as Parameters<typeof buildTokenUsageRecords>[2];
    const models = [
      { modelUid: 'glm-5-2', label: 'GLM-5.2 High' },
      { modelUid: 'swe-1-7', label: 'SWE-1.7 Max' },
    ] as unknown as Parameters<typeof buildTokenUsageRecords>[3];
    // Two ordered messages map to the two ATIF steps by index — the step
    // records' parentId must link to the corresponding turn so the
    // context-timing computation can attribute usage per message.
    const orderedMessages = [{ nodeId: 1 }, { nodeId: 2 }] as unknown as Parameters<
      typeof buildTokenUsageRecords
    >[5];
    const result = buildTokenUsageRecords(
      's1',
      session,
      atif,
      models,
      'artifact-1',
      orderedMessages,
    );

    expect(result.records.length).toBe(2);
    expect(result.records[0]?.payload).toMatchObject({
      model: 'glm-5-2',
      requestOrder: 9,
      // ATIF `promptTokens` (18071) is cache-inclusive; the shared payload
      // contract is cache-EXCLUSIVE `inputTokens` (18071 - 11874).
      inputTokens: 6197,
      outputTokens: 59,
      cacheReadTokens: 11874,
      tokenValuesExact: true,
      effort: 'High',
      normalizedEffort: 'high',
    });
    expect(result.records[1]?.payload).toMatchObject({
      model: 'swe-1-7',
      requestOrder: 11,
      // Cache-exclusive input: 17033 prompt - 11136 cached.
      inputTokens: 5897,
      outputTokens: 37,
      cacheReadTokens: 11136,
      tokenValuesExact: true,
      effort: 'Max',
      normalizedEffort: 'max',
    });
    // Each record's provenance must independently identify its own step —
    // not collapse to one shared session-level pointer (mirrors
    // claude-code-usage.ts's per-turn `entry.uuid` provenance).
    expect(result.records[0]?.sourceEventId).not.toBe(result.records[1]?.sourceEventId);
    expect(result.records[0]?.provenance.sourceEventId).toBe(result.records[0]?.sourceEventId);
    // Each step record is linked to its corresponding turn via parentId.
    expect(result.records[0]?.parentId).toBeDefined();
    expect(result.records[1]?.parentId).toBeDefined();
    expect(result.records[0]?.parentId).not.toBe(result.records[1]?.parentId);
    expect(result.prompt).toBe(35104);
    expect(result.completion).toBe(96);
    expect(result.cached).toBe(23010);
  });

  // DS-B31 (#290): a step whose `generationModel` has no catalog match (or no
  // catalog at all) must attach a null effort — never guessed.
  it('attaches a null effort when the step model has no catalog match', () => {
    const session = { id: 's1', metadata: null, model: null } as unknown as Parameters<
      typeof buildTokenUsageRecords
    >[1];
    const atif = {
      finalMetrics: {
        totalPromptTokens: 10,
        totalCompletionTokens: 5,
        totalCachedTokens: 1,
        totalSteps: 1,
      },
      steps: [
        {
          timestamp: null,
          role: null,
          text: null,
          stepId: 1,
          generationModel: 'compactor',
          metrics: { promptTokens: 10, completionTokens: 5, cachedTokens: 1 },
        },
      ],
    } as unknown as Parameters<typeof buildTokenUsageRecords>[2];
    const result = buildTokenUsageRecords('s1', session, atif, [], 'artifact-1', [
      { nodeId: 1 },
    ] as unknown as Parameters<typeof buildTokenUsageRecords>[5]);
    expect(result.records[0]?.payload).toMatchObject({ effort: null, normalizedEffort: null });
  });

  // DS-B31 (#290): tiers 2/3 (no per-step metrics) must still attach a
  // session-level effort resolved from the same model the payload's own
  // `model` field already resolves, without crashing.
  it('attaches a session-level effort in the tier-2/3 fallback path', () => {
    const session = {
      id: 's1',
      metadata: null,
      model: 'glm-5-3-low',
    } as unknown as Parameters<typeof buildTokenUsageRecords>[1];
    const models = [{ modelUid: 'glm-5-3-low', label: 'GLM-5.3 Low' }] as unknown as Parameters<
      typeof buildTokenUsageRecords
    >[3];
    const result = buildTokenUsageRecords('s1', session, undefined, models, 'artifact-1', [
      { nodeId: 1 },
    ] as unknown as Parameters<typeof buildTokenUsageRecords>[5]);
    expect(result.records.length).toBe(1);
    expect(result.records[0]?.payload).toMatchObject({
      model: 'glm-5-3-low',
      effort: 'Low',
      normalizedEffort: 'low',
    });
    // Tier-3/4 fallback: the single session-level aggregate is deliberately
    // NOT linked to any turn. It carries whole-session cumulative totals; a
    // turn parent would attribute the entire session's context volume to
    // message #1 and fabricate a matching compaction on message #2.
    expect(result.records[0]?.parentId).toBeUndefined();
  });

  it('marks a step record inexact when any individual metrics field is missing', () => {
    const session = {
      id: 's1',
      metadata: null,
      model: 'swe-1-7',
    } as unknown as Parameters<typeof buildTokenUsageRecords>[1];
    const atif = {
      finalMetrics: {
        totalPromptTokens: 100,
        totalCompletionTokens: 50,
        totalCachedTokens: 10,
        totalSteps: 1,
      },
      steps: [
        {
          timestamp: null,
          role: null,
          text: null,
          stepId: 1,
          generationModel: 'glm-5-2',
          // cachedTokens individually missing — the whole `metrics` object
          // is still present, so this step is NOT skipped, but it must not
          // be certified `tokenValuesExact: true` (missing-is-never-zero).
          metrics: { promptTokens: 100, completionTokens: 50, cachedTokens: null },
        },
      ],
    } as unknown as Parameters<typeof buildTokenUsageRecords>[2];
    const result = buildTokenUsageRecords('s1', session, atif, [], 'artifact-1', [
      { nodeId: 1 },
    ] as unknown as Parameters<typeof buildTokenUsageRecords>[5]);

    expect(result.records.length).toBe(1);
    expect(result.records[0]?.payload).toMatchObject({
      cacheReadTokens: null,
      tokenValuesExact: false,
    });
  });

  it('falls back to a single aggregate record when no ATIF step has metrics', () => {
    const session = {
      id: 's1',
      metadata: null,
      model: 'devin-default',
    } as unknown as Parameters<typeof buildTokenUsageRecords>[1];
    const atif = {
      finalMetrics: {
        totalPromptTokens: 100,
        totalCompletionTokens: 50,
        totalCachedTokens: 10,
        totalSteps: 2,
      },
      steps: [
        {
          timestamp: null,
          role: null,
          text: null,
          stepId: 1,
          generationModel: null,
          metrics: null,
        },
        {
          timestamp: null,
          role: null,
          text: null,
          stepId: 2,
          generationModel: null,
          metrics: null,
        },
      ],
    } as unknown as Parameters<typeof buildTokenUsageRecords>[2];
    const result = buildTokenUsageRecords('s1', session, atif, [], 'artifact-1', [
      { nodeId: 1 },
    ] as unknown as Parameters<typeof buildTokenUsageRecords>[5]);

    expect(result.records.length).toBe(1);
    expect(result.records[0]?.payload).toMatchObject({ model: 'devin-default' });
    // No per-message `requestOrder`: a numeric order would let the
    // context-timing `byOrder` fallback bind this session total to message #1.
    const aggregatePayload = (result.records[0]?.payload ?? {}) as { requestOrder?: unknown };
    expect(aggregatePayload.requestOrder).toBeUndefined();
    expect(result.prompt).toBe(100);
  });

  it('passes an unrecognized generation_model like compactor through unmodified', () => {
    const session = { id: 's1', metadata: null, model: 'swe-1-7' } as unknown as Parameters<
      typeof buildTokenUsageRecords
    >[1];
    const atif = {
      finalMetrics: {
        totalPromptTokens: 10,
        totalCompletionTokens: 5,
        totalCachedTokens: 1,
        totalSteps: 1,
      },
      steps: [
        {
          timestamp: null,
          role: null,
          text: null,
          stepId: 1,
          generationModel: 'compactor',
          metrics: { promptTokens: 10, completionTokens: 5, cachedTokens: 1 },
        },
      ],
    } as unknown as Parameters<typeof buildTokenUsageRecords>[2];
    const result = buildTokenUsageRecords('s1', session, atif, [], 'artifact-1', [
      { nodeId: 1 },
    ] as unknown as Parameters<typeof buildTokenUsageRecords>[5]);
    expect(result.records[0]?.payload).toMatchObject({ model: 'compactor' });
  });

  // Guards the index-alignment assumption in buildStepRecords: when some
  // ATIF steps lack `metrics` (skipped) and the steps array is longer than
  // orderedMessages, the step-to-message mapping must degrade gracefully —
  // steps beyond the messages array get no parentId (fall back to byOrder),
  // while steps within range still link correctly.
  it('links parentId by step index even when some steps lack metrics and steps exceed messages', () => {
    const session = { id: 's1', metadata: null, model: 'glm-5-2' } as unknown as Parameters<
      typeof buildTokenUsageRecords
    >[1];
    const atif = {
      finalMetrics: {
        totalPromptTokens: 200,
        totalCompletionTokens: 80,
        totalCachedTokens: 50,
        totalSteps: 4,
      },
      steps: [
        // Step 0: no metrics — skipped entirely.
        {
          timestamp: null,
          role: null,
          text: null,
          stepId: 1,
          generationModel: null,
          metrics: null,
        },
        // Step 1: has metrics — should link to orderedMessages[1].
        {
          timestamp: null,
          role: null,
          text: null,
          stepId: 2,
          generationModel: 'glm-5-2',
          metrics: { promptTokens: 100, completionTokens: 40, cachedTokens: 25 },
        },
        // Step 2: no metrics — skipped.
        {
          timestamp: null,
          role: null,
          text: null,
          stepId: 3,
          generationModel: null,
          metrics: null,
        },
        // Step 3: has metrics — orderedMessages has only 2 entries, so
        // orderedMessages[3] is undefined → parentId undefined (graceful).
        {
          timestamp: null,
          role: null,
          text: null,
          stepId: 4,
          generationModel: 'swe-1-7',
          metrics: { promptTokens: 100, completionTokens: 40, cachedTokens: 25 },
        },
      ],
    } as unknown as Parameters<typeof buildTokenUsageRecords>[2];
    // Only 2 messages — shorter than the 4-step array.
    const orderedMessages = [{ nodeId: 10 }, { nodeId: 20 }] as unknown as Parameters<
      typeof buildTokenUsageRecords
    >[5];
    const result = buildTokenUsageRecords('s1', session, atif, [], 'artifact-1', orderedMessages);

    expect(result.records.length).toBe(2);
    // Step 1 (index 1) links to orderedMessages[1] (nodeId 20).
    expect(result.records[0]?.parentId).toBeDefined();
    expect(result.records[0]?.payload).toMatchObject({ requestOrder: 2 });
    // Step 3 (index 3) is beyond orderedMessages length → no parentId.
    expect(result.records[1]?.parentId).toBeUndefined();
    expect(result.records[1]?.payload).toMatchObject({ requestOrder: 4 });
  });
});

describe('Per-message model_usage tier (transcript-only context growth)', () => {
  function message(nodeId: number, chatUsage: unknown): DevinMessageLine {
    return {
      type: 'message',
      nodeId,
      chatUsage,
      chatMessage: { message_id: `msg-${nodeId}`, role: 'assistant' },
      role: 'assistant',
      parsedMetadata: null,
    } as unknown as DevinMessageLine;
  }

  const models = [{ modelUid: 'swe-2-high', label: 'SWE-2 High' }] as unknown as Parameters<
    typeof buildTokenUsageRecords
  >[3];

  it('emits one record per metered message, parented to its own turn, with cache-exclusive input', () => {
    const session = { id: 's1', metadata: null, model: null } as unknown as Parameters<
      typeof buildTokenUsageRecords
    >[1];
    const orderedMessages = [
      message(10, null),
      message(11, {
        requestId: 'req-11',
        generationModel: 'swe-2-high',
        inputTokens: 14558,
        outputTokens: 112,
        cacheReadTokens: null,
        cacheCreationTokens: null,
      }),
      message(12, {
        requestId: 'req-12',
        generationModel: 'swe-2-high',
        inputTokens: 2454,
        outputTokens: 315,
        cacheReadTokens: 44288,
        cacheCreationTokens: null,
      }),
    ] as unknown as Parameters<typeof buildTokenUsageRecords>[5];

    const result = buildTokenUsageRecords(
      's1',
      session,
      undefined,
      models,
      'artifact-1',
      orderedMessages,
    );

    const requestRecords = result.records.filter((r) => r.recordType === 'model_request');
    // Per-message records are `model_request`; a session aggregate
    // `model_usage` record accompanies them for the token identity.
    expect(requestRecords).toHaveLength(2);
    expect(result.records.filter((r) => r.recordType === 'model_usage')).toHaveLength(1);
    expect(requestRecords[0]?.sourceField).toBe('chat_message.metrics');
    expect(requestRecords[0]?.payload).toMatchObject({
      requestOrder: 2,
      requestId: 'req-11',
      model: 'swe-2-high',
      inputTokens: 14558,
      outputTokens: 112,
      cacheReadTokens: null,
      // cacheReadTokens is null, so the record is not certified exact.
      tokenValuesExact: false,
      effort: 'High',
      normalizedEffort: 'high',
    });
    expect(requestRecords[0]?.parentId).toBeDefined();
    expect(requestRecords[1]?.payload).toMatchObject({
      requestOrder: 3,
      requestId: 'req-12',
      inputTokens: 2454,
      outputTokens: 315,
      cacheReadTokens: 44288,
    });
    // Each record links to a DIFFERENT turn — never one shared aggregate.
    expect(requestRecords[0]?.parentId).not.toBe(requestRecords[1]?.parentId);
    // requestOrder tracks the message's 1-based position, so a metered
    // message after an unmetered one keeps its absolute (gapped) order
    // rather than being renumbered.
    expect(
      requestRecords.map((r) => (r.payload as { requestOrder?: number }).requestOrder),
    ).toEqual([2, 3]);
  });

  it('skips messages with no usage and messages whose metrics are entirely null', () => {
    const session = { id: 's1', metadata: null, model: null } as unknown as Parameters<
      typeof buildTokenUsageRecords
    >[1];
    const orderedMessages = [
      message(1, null),
      message(2, {
        requestId: null,
        generationModel: null,
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheCreationTokens: null,
      }),
      message(3, {
        requestId: 'req-3',
        generationModel: null,
        inputTokens: 5,
        outputTokens: 1,
        cacheReadTokens: null,
        cacheCreationTokens: null,
      }),
    ] as unknown as Parameters<typeof buildTokenUsageRecords>[5];

    const result = buildTokenUsageRecords(
      's1',
      session,
      undefined,
      models,
      'artifact-1',
      orderedMessages,
    );
    const requestRecords = result.records.filter((r) => r.recordType === 'model_request');
    expect(requestRecords).toHaveLength(1);
    expect(requestRecords[0]?.payload).toMatchObject({ requestOrder: 3, inputTokens: 5 });
  });

  it('gives ATIF step metrics precedence over per-message metrics', () => {
    const session = { id: 's1', metadata: null, model: 'glm-5-2' } as unknown as Parameters<
      typeof buildTokenUsageRecords
    >[1];
    const atif = {
      finalMetrics: {
        totalPromptTokens: 100,
        totalCompletionTokens: 50,
        totalCachedTokens: 10,
        totalSteps: 1,
      },
      steps: [
        {
          timestamp: null,
          role: null,
          text: null,
          stepId: 7,
          generationModel: 'glm-5-2',
          metrics: { promptTokens: 100, completionTokens: 50, cachedTokens: 10 },
        },
      ],
    } as unknown as Parameters<typeof buildTokenUsageRecords>[2];
    const orderedMessages = [
      message(1, {
        requestId: 'req-1',
        generationModel: 'swe-2-high',
        inputTokens: 999,
        outputTokens: 999,
        cacheReadTokens: null,
        cacheCreationTokens: null,
      }),
    ] as unknown as Parameters<typeof buildTokenUsageRecords>[5];

    const result = buildTokenUsageRecords(
      's1',
      session,
      atif,
      models,
      'artifact-1',
      orderedMessages,
    );
    expect(result.records).toHaveLength(1);
    expect(result.records[0]?.sourceField).toBe('atif_step');
    expect(result.records[0]?.payload).toMatchObject({ inputTokens: 90, requestOrder: 7 });
  });

  it('leaves the session aggregate turn-unscoped when no per-message metrics exist', () => {
    const session = {
      id: 'brassy-humor',
      metadata: null,
      model: 'swe-2-high',
    } as unknown as Parameters<typeof buildTokenUsageRecords>[1];
    const orderedMessages = [message(3, null), message(4, null)] as unknown as Parameters<
      typeof buildTokenUsageRecords
    >[5];
    const result = buildTokenUsageRecords(
      's1',
      session,
      undefined,
      models,
      'artifact-1',
      orderedMessages,
    );

    expect(result.records).toHaveLength(1);
    expect(result.records[0]?.sourceField).toBe('final_metrics');
    // Regression: the whole-session aggregate must never be attributed to a
    // single turn (the old first-turn linkage put ~50.2M tokens on message #1).
    expect(result.records[0]?.parentId).toBeUndefined();
    const aggregatePayload = (result.records[0]?.payload ?? {}) as { requestId?: string };
    expect(aggregatePayload.requestId).toBe('brassy-humor');
  });
});

describe('Internal tool invocations', () => {
  it('normalises tool name from update, title, kind, and id', () => {
    const toolCall = {
      toolCallId: 'tc-1',
      call: {
        title: 'EditFile',
        kind: 'edit',
        rawInput: { file_path: 'src/index.ts' },
      },
      update: { inferenceToolName: 'OverrideName', status: 'completed' },
    } as unknown as DevinToolCallLine;
    const result = buildToolInvocationRecords('s1', [toolCall], 'artifact-1');
    expect(result.records[0]?.payload).toMatchObject({
      name: 'OverrideName',
      target: 'src/index.ts',
    });
  });

  it('maps error and incomplete statuses', () => {
    const toolCalls = [
      { toolCallId: 'e', call: { kind: 'execute', rawInput: 'x' }, update: { status: 'failed' } },
      { toolCallId: 'i', call: { kind: 'search', rawInput: 'y' }, update: { status: 'pending' } },
      { toolCallId: 'u', call: { kind: 'edit', rawInput: 'z' }, update: { status: 'unknown' } },
    ] as unknown as DevinToolCallLine[];
    const result = buildToolInvocationRecords('s1', toolCalls, 'artifact-1');
    const statuses = result.records
      .filter((r) => r.recordType === 'invocation')
      .map((r) => (r.payload as { status: string }).status);
    expect(statuses).toContain('error');
    expect(statuses).toContain('incomplete');
    expect(statuses).toContain('unknown');
  });

  it('falls back through tool name and target sources', () => {
    const toolCalls = [
      { toolCallId: 'tc-1', call: { kind: 'edit' }, update: null },
      { toolCallId: 'tc-2', call: { title: 'Named' }, update: { inferenceToolName: 'Override' } },
      {
        toolCallId: 'tc-3',
        call: { kind: 'execute', rawInput: { path: 'src' } },
        update: { status: 123 },
      },
      {
        toolCallId: 'tc-4',
        call: { kind: 'search', content: { file_path: 'x' } },
        update: { status: 'completed' },
      },
    ] as unknown as DevinToolCallLine[];
    const result = buildToolInvocationRecords('s1', toolCalls, 'artifact-1');
    const names = result.records
      .filter((r) => r.recordType === 'invocation')
      .map((r) => (r.payload as { name: string }).name);
    expect(names).toEqual(['edit', 'Override', 'execute', 'search']);
    const targets = result.records
      .filter((r) => r.recordType === 'invocation')
      .map((r) => (r.payload as { target?: string }).target);
    expect(targets).toEqual([undefined, undefined, 'src', 'x']);
  });

  it('emits only an input payload when no update is present', () => {
    const toolCall = {
      toolCallId: 'tc-1',
      call: { kind: 'edit', rawInput: 'content' },
      update: null,
    } as unknown as DevinToolCallLine;
    const result = buildToolInvocationRecords('s1', [toolCall], 'artifact-1');
    const payloads = result.records.filter((r) => r.recordType === 'payload');
    expect(payloads.length).toBe(1);
    expect(payloads[0]?.payload).toMatchObject({ payloadType: 'input' });
  });
});

describe('Internal classification', () => {
  it('classifies B3 artifacts by path and validates content', () => {
    const result = classifyDevinArtifacts({
      artifacts: [
        {
          relativePath: 'transcript.jsonl',
          content: '{"type":"session","id":"s1","ts":1,"order":1}\n',
          mediaType: 'application/jsonl',
        },
        {
          relativePath: 'native/atif-transcript.json',
          content: '{"schema_version":"ATIF-v1.7","steps":[],"final_metrics":{}}',
          mediaType: 'application/json',
        },
        {
          relativePath: 'native/schema-descriptor.json',
          content: '{"refineryVersion":16,"supported":true}',
          mediaType: 'application/json',
        },
        {
          relativePath: 'native/models.json',
          content: '[{"modelUid":"x","label":"X","familyUid":"f","costTier":"Standard"}]',
          mediaType: 'application/json',
        },
        { relativePath: 'plans/plan-abc.md', content: '# Plan', mediaType: 'text/markdown' },
        { relativePath: '.devin/config.json', content: '{}', mediaType: 'application/json' },
        { relativePath: 'unknown.bin', content: 'x', mediaType: 'application/octet-stream' },
      ],
    });
    const byPath = new Map(result.artifacts.map((a) => [a.relativePath, a]));
    expect(byPath.get('transcript.jsonl')?.confidence).toBe('exact');
    expect(byPath.get('native/atif-transcript.json')?.confidence).toBe('exact');
    expect(byPath.get('native/schema-descriptor.json')?.kind).toBe('settings');
    expect(byPath.get('native/models.json')?.kind).toBe('settings');
    expect(byPath.get('plans/plan-abc.md')?.kind).toBe('transcript');
    expect(byPath.get('.devin/config.json')?.scope).toBe('workspace');
    expect(byPath.get('unknown.bin')?.kind).toBe('unclassified');
    expect(result.warnings?.length ?? 0).toBe(1);
  });

  it('downgrades confidence when content validation fails', () => {
    const result = classifyDevinArtifacts({
      artifacts: [
        { relativePath: 'transcript.jsonl', content: 'not-json', mediaType: 'application/jsonl' },
        {
          relativePath: 'native/atif-transcript.json',
          content: 'not-json',
          mediaType: 'application/json',
        },
        { relativePath: 'native/models.json', content: '{}', mediaType: 'application/json' },
      ],
    });
    expect(result.artifacts[0]?.confidence).toBe('inferred');
    expect(result.artifacts[1]?.confidence).toBe('inferred');
    expect(result.artifacts[2]?.confidence).toBe('inferred');
  });
});

describe('Internal parse bundle', () => {
  it('parses a branchy message tree and respects main_chain_id', () => {
    const jsonl = [
      '{"type":"session","id":"s1","ts":1,"order":1,"main_chain_id":"3"}',
      '{"type":"message","session_id":"s1","node_id":1,"parent_node_id":null,"chat_message":"{}","order":2}',
      '{"type":"message","session_id":"s1","node_id":2,"parent_node_id":1,"chat_message":"{}","order":3}',
      '{"type":"message","session_id":"s1","node_id":3,"parent_node_id":2,"chat_message":"{}","order":4}',
      '{"type":"message","session_id":"s1","node_id":4,"parent_node_id":2,"chat_message":"{}","order":5}',
    ].join('\n');
    const bundle = {
      artifacts: [
        { relativePath: 'transcript.jsonl', content: jsonl, mediaType: 'application/jsonl' },
      ],
      sourceFingerprint: 'fp-parse',
    };
    const parsed = parseDevinBundle(bundle);
    expect(parsed.orderedMessages.map((m) => m.nodeId)).toEqual([1, 2, 3, 4]);
  });

  it('warns but does not fail when ATIF schema version is unsupported', () => {
    const bundle = {
      artifacts: [
        {
          relativePath: 'transcript.jsonl',
          content: '{"type":"session","id":"s1"}',
          mediaType: 'application/jsonl',
        },
        {
          relativePath: 'native/atif-transcript.json',
          content: '{"schema_version":"ATIF-v2.0"}',
          mediaType: 'application/json',
        },
      ],
      sourceFingerprint: 'fp-atif',
    };
    const parsed = parseDevinBundle(bundle);
    expect(parsed.atif).toBeUndefined();
    expect(parsed.warnings.length).toBeGreaterThan(0);
  });

  it('parses schema descriptor, plan, models, and raw models', () => {
    const bundle = {
      artifacts: [
        {
          relativePath: 'transcript.jsonl',
          content: '{"type":"session","id":"s1"}',
          mediaType: 'application/jsonl',
        },
        {
          relativePath: 'native/schema-descriptor.json',
          content: '{"refineryVersion":16,"supported":true}',
          mediaType: 'application/json',
        },
        {
          relativePath: 'native/models.json',
          content: '[{"modelUid":"x","label":"X","familyUid":"f","costTier":"Standard"}]',
          mediaType: 'application/json',
        },
        {
          relativePath: 'native/models-list.raw.json',
          content: 'raw',
          mediaType: 'application/json',
        },
        { relativePath: 'plans/plan-123.md', content: '# Plan', mediaType: 'text/markdown' },
      ],
      sourceFingerprint: 'fp-extras',
    };
    const parsed = parseDevinBundle(bundle);
    expect(parsed.schemaDescriptor).toBeDefined();
    expect(parsed.models.length).toBe(1);
    expect(parsed.modelsRaw).toBe('raw');
    expect(parsed.planContent).toBe('# Plan');
  });

  it('returns no root transcript without a recognized root artifact', () => {
    const bundle = {
      artifacts: [
        {
          relativePath: 'native/schema-descriptor.json',
          content: '{}',
          mediaType: 'application/json',
        },
      ],
      sourceFingerprint: 'fp-empty',
    };
    const parsed = parseDevinBundle(bundle);
    expect(parsed.rootTranscriptText).toBeUndefined();
  });
});

describe('Internal capabilities', () => {
  it('reports partial steps when messages are present but ATIF is missing', () => {
    const bundle = {
      artifacts: [
        {
          relativePath: 'transcript.jsonl',
          content:
            '{"type":"session","id":"s1","ts":1,"order":1}\n{"type":"message","session_id":"s1","node_id":1,"parent_node_id":null,"chat_message":"{}","order":2}',
          mediaType: 'application/jsonl',
        },
      ],
      sourceFingerprint: 'fp-cap',
    };
    const caps = getDevinMetricCapabilities(bundle);
    const byId = new Map(caps.map((c) => [c.metricId, c]));
    expect(byId.get('devin:steps:count:root_only')?.state).toBe('partial');
    expect(byId.get('devin:turns:count:root_only')?.state).toBe('available');
  });

  it('detects token availability from response_dimensions', () => {
    const bundle = {
      artifacts: [
        {
          relativePath: 'transcript.jsonl',
          content: `{"type":"session","id":"s1","ts":1,"order":1,"metadata":"${JSON.stringify({ response_dimensions: [{ prompt_tokens: 1 }] }).replace(/"/g, '\\"')}"}\n`,
          mediaType: 'application/jsonl',
        },
      ],
      sourceFingerprint: 'fp-dim',
    };
    const caps = getDevinMetricCapabilities(bundle);
    const byId = new Map(caps.map((c) => [c.metricId, c]));
    expect(byId.get('devin:tokens:prompt:root_only')?.state).toBe('available');
  });
});

describe('Internal session spine', () => {
  it('builds a spine with no messages and ATIF step timestamps', () => {
    const session = {
      id: 's1',
      createdAt: null,
      lastActivityAt: null,
      metadata: null,
    } as unknown as Parameters<typeof buildSessionSpine>[1];
    const atifSteps = [
      { timestamp: '2026-08-01T12:00:00.000Z' },
      { timestamp: '2026-08-01T12:00:10.000Z' },
    ];
    const result = buildSessionSpine('s1', session, [], atifSteps, 'artifact-1');
    expect(result.records.length).toBe(1);
    expect(result.summary.startTime).toBeDefined();
    expect(result.summary.endTime).toBeDefined();
  });

  it('surfaces the persisted session title as aiTitle for ingestion', () => {
    const session = {
      id: 's1',
      title: 'Fix the login redirect',
      createdAt: null,
      lastActivityAt: null,
      metadata: null,
    } as unknown as Parameters<typeof buildSessionSpine>[1];
    const result = buildSessionSpine('s1', session, [], [], 'artifact-1');
    expect(result.records[0]?.payload).toMatchObject({
      title: 'Fix the login redirect',
      aiTitle: 'Fix the login redirect',
    });
    // A persisted harness title suppresses the first-message fallback.
    expect(
      (result.records[0]?.payload as Record<string, unknown> | undefined)?.fallbackTitle,
    ).toBeUndefined();
  });

  it('derives fallbackTitle from the first user message when sessions.db has no title', () => {
    const session = {
      id: 's1',
      title: null,
      createdAt: null,
      lastActivityAt: null,
      metadata: null,
    } as unknown as Parameters<typeof buildSessionSpine>[1];
    const messages = [
      { nodeId: 1, role: 'system', chatMessage: { role: 'system', content: 'sys' } },
      {
        nodeId: 2,
        role: 'user',
        chatMessage: {
          role: 'user',
          content: 'Triage the flaky pipeline test that fails on CI for no reason at all',
        },
      },
      {
        nodeId: 3,
        role: 'assistant',
        chatMessage: { role: 'assistant', content: 'On it.' },
      },
    ] as unknown as Parameters<typeof buildSessionSpine>[2];
    const result = buildSessionSpine('s1', session, messages, [], 'artifact-1');
    expect(result.records[0]?.payload).toMatchObject({
      aiTitle: null,
      fallbackTitle: 'Triage the flaky pipeline test that fails on CI fo…',
    });
  });
});

describe('Internal definitions', () => {
  it('throws for an unknown metric id', () => {
    expect(() => definitionFor('devin:unknown:metric')).toThrow();
  });

  it('returns all phase 1 metric definitions', () => {
    expect(getDevinMetricDefinitions().length).toBe(24);
  });
});
