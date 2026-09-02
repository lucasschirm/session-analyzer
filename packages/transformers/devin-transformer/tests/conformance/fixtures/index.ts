import type { TransformContext, UnknownArtifactBundle } from '@lucasschirm/sal-transformer-shared';
import type {
  ConformanceFixture,
  TransformerFixtures,
} from '@lucasschirm/sal-transformer-shared/conformance';

export const defaultContext: TransformContext = {
  analysisReleaseId: 'r1',
  parserId: '@lucasschirm/sal-devin-session-parser',
  parserVersion: '0.1.0',
  sourceFingerprint: 'fp-test',
  sourceEnvironmentId: 'test-env',
  sourceProjectId: 'test-proj',
  sourceSessionId: 'test-sess',
};

function artifact(
  relativePath: string,
  content: string,
  mediaType: string,
  sha256?: string,
): { relativePath: string; content: string; mediaType: string; sha256?: string } {
  return { relativePath, content, mediaType, sha256 };
}

function devinJsonlLine(type: string, rest: Record<string, unknown>): string {
  return JSON.stringify({ type, ...rest });
}

function sessionLine(
  id: string,
  mainChainId: number | undefined,
  metadata?: Record<string, unknown>,
): string {
  return devinJsonlLine('session', {
    ts: 1722520800,
    order: 1,
    id,
    working_directory: '/workspace/test',
    backend_type: 'devin',
    model: 'devin-default',
    agent_mode: 'auto',
    created_at: 1722520800,
    last_activity_at: 1722520900,
    title: 'Devin fixture session',
    main_chain_id: mainChainId === undefined ? undefined : String(mainChainId),
    metadata: metadata ? JSON.stringify(metadata) : undefined,
  });
}

function messageLine(
  sessionId: string,
  nodeId: number,
  parentNodeId: number | null,
  role: string,
  content: string,
): string {
  return devinJsonlLine('message', {
    ts: null,
    order: nodeId + 1,
    session_id: sessionId,
    node_id: nodeId,
    parent_node_id: parentNodeId,
    chat_message: JSON.stringify({
      message_id: `msg-${nodeId}`,
      role,
      content,
    }),
    created_at: null,
    metadata: null,
  });
}

function toolCallLine(
  sessionId: string,
  toolCallId: string,
  kind: string,
  title: string,
  status: string,
): string {
  return devinJsonlLine('tool_call', {
    ts: null,
    order: 100,
    row_id: 1,
    session_id: sessionId,
    tool_call_id: toolCallId,
    tool_call_json: JSON.stringify({
      toolCallId,
      title,
      kind,
      rawInput: { file_path: 'src/index.ts' },
    }),
    tool_call_update_json: JSON.stringify({
      toolCallId,
      status,
      inferenceToolName: title,
    }),
  });
}

function atifTranscript(
  steps: { timestamp: string; role: string; text: string }[],
  finalMetrics: {
    totalPromptTokens: number;
    totalCompletionTokens: number;
    totalCachedTokens: number;
    totalSteps: number;
  },
): string {
  return JSON.stringify(
    {
      schema_version: 'ATIF-v1.7',
      agent: { model_name: 'devin-default' },
      steps,
      final_metrics: {
        total_prompt_tokens: finalMetrics.totalPromptTokens,
        total_completion_tokens: finalMetrics.totalCompletionTokens,
        total_cached_tokens: finalMetrics.totalCachedTokens,
        total_steps: finalMetrics.totalSteps,
      },
    },
    null,
    2,
  );
}

function modelsJson(): string {
  return JSON.stringify([
    {
      modelUid: 'devin-default',
      label: 'Devin Default',
      familyUid: 'devin',
      costTier: 'standard',
      maxContextTokens: 1_000_000,
      maxOutputTokens: 8_000,
      pricing: {
        inputPerMTok: 3.0,
        cachedInputPerMTok: 0.5,
        outputPerMTok: 10.0,
      },
    },
  ]);
}

function schemaDescriptor(supported = true): string {
  return JSON.stringify({
    schema_version: 'devin-session-jsonl/v1',
    supported,
    features: ['session', 'message', 'tool_call', 'prompt'],
  });
}

function bundle(
  artifacts: { relativePath: string; content: string; mediaType: string }[],
): UnknownArtifactBundle {
  return {
    artifacts,
    sourceIdentity: {
      sourceId: 'test-source',
      environmentId: 'test-env',
      projectId: 'test-proj',
      sessionId: 'test-sess',
    },
    sourceFingerprint: 'fp-test',
  };
}

function fixture(
  name: string,
  description: string,
  bundle: UnknownArtifactBundle,
  tags: string[],
): ConformanceFixture<UnknownArtifactBundle> {
  return {
    name,
    description,
    bundle,
    context: defaultContext,
    tags,
  };
}

const sessionId = 'test-sess';

const linearTranscript = [
  sessionLine(sessionId, 4),
  messageLine(sessionId, 1, null, 'user', 'Hello'),
  messageLine(sessionId, 2, 1, 'assistant', 'Hi there'),
  messageLine(sessionId, 3, 2, 'user', 'Edit a file'),
  messageLine(sessionId, 4, 3, 'assistant', 'Done'),
  toolCallLine(sessionId, 'tc-1', 'edit', 'EditFile', 'success'),
].join('\n');

const linearAtif = atifTranscript(
  [
    { timestamp: '2026-08-01T12:00:00.000Z', role: 'user', text: 'Hello' },
    { timestamp: '2026-08-01T12:00:05.000Z', role: 'assistant', text: 'Hi there' },
    { timestamp: '2026-08-01T12:00:10.000Z', role: 'user', text: 'Edit a file' },
    { timestamp: '2026-08-01T12:00:15.000Z', role: 'assistant', text: 'Done' },
  ],
  { totalPromptTokens: 100, totalCompletionTokens: 50, totalCachedTokens: 10, totalSteps: 4 },
);

export const linearBundle: UnknownArtifactBundle = bundle([
  artifact('transcript.jsonl', linearTranscript, 'application/jsonl'),
  artifact('native/atif-transcript.json', linearAtif, 'application/json'),
  artifact('native/models.json', modelsJson(), 'application/json'),
  artifact('native/schema-descriptor.json', schemaDescriptor(true), 'application/json'),
]);

const branchyTranscript = [
  sessionLine(sessionId, 4),
  messageLine(sessionId, 1, null, 'user', 'Hello'),
  messageLine(sessionId, 2, 1, 'assistant', 'Hi'),
  messageLine(sessionId, 3, 2, 'user', 'Try approach A'),
  messageLine(sessionId, 4, 3, 'assistant', 'A done'),
  messageLine(sessionId, 5, 2, 'user', 'Try approach B'),
  messageLine(sessionId, 6, 5, 'assistant', 'B done'),
  toolCallLine(sessionId, 'tc-a', 'execute', 'RunTests', 'success'),
].join('\n');

const branchyAtif = atifTranscript(
  [
    { timestamp: '2026-08-01T12:00:00.000Z', role: 'user', text: 'Hello' },
    { timestamp: '2026-08-01T12:00:05.000Z', role: 'assistant', text: 'Hi' },
    { timestamp: '2026-08-01T12:00:10.000Z', role: 'user', text: 'Try approach A' },
    { timestamp: '2026-08-01T12:00:20.000Z', role: 'assistant', text: 'A done' },
  ],
  { totalPromptTokens: 200, totalCompletionTokens: 80, totalCachedTokens: 20, totalSteps: 4 },
);

export const branchyBundle: UnknownArtifactBundle = bundle([
  artifact('transcript.jsonl', branchyTranscript, 'application/jsonl'),
  artifact('native/atif-transcript.json', branchyAtif, 'application/json'),
  artifact('native/models.json', modelsJson(), 'application/json'),
]);

const planContent = `# Plan

1. Greet the user.
2. Edit src/index.ts.
3. Run tests.
`;

export const planBundle: UnknownArtifactBundle = bundle([
  artifact('transcript.jsonl', linearTranscript, 'application/jsonl'),
  artifact('native/atif-transcript.json', linearAtif, 'application/json'),
  artifact('plans/plan-a1b2c3d4.md', planContent, 'text/markdown'),
  artifact('native/models.json', modelsJson(), 'application/json'),
]);

const partialTranscript = [
  sessionLine(sessionId, 2),
  messageLine(sessionId, 1, null, 'user', 'Hello'),
  messageLine(sessionId, 2, 1, 'assistant', 'Hi'),
  toolCallLine(sessionId, 'tc-1', 'search', 'SearchFiles', 'success'),
].join('\n');

export const partialTokensBundle: UnknownArtifactBundle = bundle([
  artifact('transcript.jsonl', partialTranscript, 'application/jsonl'),
  artifact('native/models.json', modelsJson(), 'application/json'),
]);

const unknownAtif = JSON.stringify(
  {
    schema_version: 'ATIF-v2.0',
    agent: { model_name: 'devin-default' },
    steps: [{ timestamp: '2026-08-01T12:00:00.000Z', role: 'user', text: 'Hello' }],
    final_metrics: { total_prompt_tokens: 50, total_completion_tokens: 20 },
  },
  null,
  2,
);

export const unknownSchemaBundle: UnknownArtifactBundle = bundle([
  artifact('transcript.jsonl', partialTranscript, 'application/jsonl'),
  artifact('native/atif-transcript.json', unknownAtif, 'application/json'),
  artifact('native/models.json', modelsJson(), 'application/json'),
]);

const replayedTranscript = [
  sessionLine(sessionId, 2),
  messageLine(sessionId, 1, null, 'user', 'Hello'),
  messageLine(sessionId, 1, null, 'user', 'Hello'),
  messageLine(sessionId, 2, 1, 'assistant', 'Hi'),
  toolCallLine(sessionId, 'tc-1', 'edit', 'EditFile', 'success'),
].join('\n');

export const replayedBundle: UnknownArtifactBundle = bundle([
  artifact('transcript.jsonl', replayedTranscript, 'application/jsonl'),
  artifact('native/atif-transcript.json', linearAtif, 'application/json'),
  artifact('native/models.json', modelsJson(), 'application/json'),
]);

export const noRootBundle: UnknownArtifactBundle = bundle([
  artifact('native/schema-descriptor.json', schemaDescriptor(true), 'application/json'),
  artifact('native/models.json', modelsJson(), 'application/json'),
  artifact('.devin/config.json', JSON.stringify({ project: 'test' }), 'application/json'),
]);

export const devinConformanceFixtures: TransformerFixtures<UnknownArtifactBundle> = {
  fixtures: [
    fixture(
      'linear-root',
      'A simple linear session with ATIF final metrics and a tool call.',
      linearBundle,
      ['root', 'linear', 'deterministic', 'exact-estimated', 'provenance', 'formulas'],
    ),
    fixture(
      'branchy-messages',
      'A session with a branched message tree and main chain selection.',
      branchyBundle,
      ['root', 'branchy', 'deterministic'],
    ),
    fixture('with-plan', 'A session that includes a plan markdown artifact.', planBundle, [
      'root',
      'plan',
      'deterministic',
    ]),
    fixture(
      'partial-tokens',
      'A session without ATIF or response_dimensions; token metrics should be unavailable.',
      partialTokensBundle,
      ['root', 'partial', 'unavailable', 'exact-estimated', 'deterministic'],
    ),
    fixture(
      'unknown-schema',
      'A session with an unsupported ATIF schema version.',
      unknownSchemaBundle,
      ['root', 'unknown-schema', 'unavailable', 'deterministic'],
    ),
    fixture(
      'replayed-events',
      'A session containing a replayed source event to test deterministic deduplication.',
      replayedBundle,
      ['root', 'replayed', 'deterministic'],
    ),
    fixture('no-root', 'Configuration artifacts without a root transcript.', noRootBundle, [
      'no-root',
      'unavailable',
    ]),
  ],
};
