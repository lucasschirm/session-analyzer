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
  cogsJson?: unknown[],
  overrides?: { title?: string; model?: string; lastActivityAt?: number; order?: number },
): string {
  return devinJsonlLine('session', {
    ts: 1722520800,
    order: overrides?.order ?? 1,
    id,
    working_directory: '/workspace/test',
    backend_type: 'devin',
    model: overrides?.model ?? 'devin-default',
    agent_mode: 'auto',
    created_at: 1722520800,
    last_activity_at: overrides?.lastActivityAt ?? 1722520900,
    title: overrides?.title ?? 'Devin fixture session',
    // The real schema stores main_chain_id as INTEGER (#324) — emit the
    // number, matching what the extractor spreads from node:sqlite rows.
    main_chain_id: mainChainId,
    metadata: metadata ? JSON.stringify(metadata) : undefined,
    cogs_json: cogsJson ? JSON.stringify(cogsJson) : undefined,
  });
}

function messageLine(
  sessionId: string,
  nodeId: number,
  parentNodeId: number | null,
  role: string,
  content: string,
  options?: {
    rowId?: number;
    createdAt?: number | null;
    metadata?: {
      summarized_from?: number | null;
      num_tokens_preceding?: number | null;
      is_system_prefix?: boolean | null;
    };
  },
): string {
  return devinJsonlLine('message', {
    ts: null,
    order: nodeId + 1,
    row_id: options?.rowId ?? nodeId,
    session_id: sessionId,
    node_id: nodeId,
    parent_node_id: parentNodeId,
    chat_message: JSON.stringify({
      message_id: `msg-${nodeId}`,
      role,
      content,
    }),
    created_at: options?.createdAt ?? null,
    metadata: options?.metadata ? JSON.stringify(options.metadata) : null,
  });
}

function promptLine(sessionId: string, id: number, content: string, ts: number): string {
  return devinJsonlLine('prompt', {
    ts,
    order: 1000 + id,
    id,
    session_id: sessionId,
    content,
    is_shell: 0,
  });
}

/**
 * `_meta["cognition.ai/inferenceToolName"]` must be nested under `_meta` on
 * BOTH `tool_call_json` and `tool_call_update_json` — `parseAcpToolCallUpdate`'s
 * `extractInferenceToolName` only reads `record._meta`, never a top-level
 * `inferenceToolName` field (DS-F11 (#288); this was a pre-existing
 * fixture/production shape mismatch, harmless only because no prior fixture
 * depended on `inferenceToolName` resolving to anything).
 */
function toolCallLine(
  sessionId: string,
  toolCallId: string,
  kind: string,
  title: string,
  status: string,
  options?: { inferenceToolName?: string; rawInput?: Record<string, unknown> },
): string {
  const inferenceToolName = options?.inferenceToolName ?? title;
  const rawInput = options?.rawInput ?? { file_path: 'src/index.ts' };
  const meta = { 'cognition.ai/inferenceToolName': inferenceToolName };
  return devinJsonlLine('tool_call', {
    ts: null,
    order: 100,
    row_id: 1,
    session_id: sessionId,
    tool_call_id: toolCallId,
    tool_call_json: JSON.stringify({ toolCallId, title, kind, rawInput, _meta: meta }),
    tool_call_update_json: JSON.stringify({ toolCallId, status, _meta: meta }),
  });
}

/**
 * A `tool_call` line with `tool_call_json`'s own `_meta` set but NO
 * `tool_call_update_json` at all — simulates a session interrupted before
 * the ACP update for this call arrived. Devin stamps
 * `_meta["cognition.ai/inferenceToolName"]` on `tool_call_json` itself
 * (not only on the update), so the domain-correct kind/name must still be
 * resolvable from `call` alone (DS-F11 (#288) review finding).
 */
function interruptedToolCallLine(
  sessionId: string,
  toolCallId: string,
  kind: string,
  title: string,
  inferenceToolName: string,
  rawInput: Record<string, unknown>,
): string {
  const meta = { 'cognition.ai/inferenceToolName': inferenceToolName };
  return devinJsonlLine('tool_call', {
    ts: null,
    order: 100,
    row_id: 1,
    session_id: sessionId,
    tool_call_id: toolCallId,
    tool_call_json: JSON.stringify({ toolCallId, title, kind, rawInput, _meta: meta }),
  });
}

interface AtifTranscriptStep {
  timestamp: string;
  role: string;
  text: string;
  /** ATIF-real `source: "agent"` step extras (findings 3a/3b of DS-B25
   * (#285)): `generation_model` is the trustworthy per-step model signal. */
  extra?: { generation_model: string };
  metrics?: { prompt_tokens: number; completion_tokens: number; cached_tokens: number };
}

function atifTranscript(
  steps: AtifTranscriptStep[],
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
      steps: steps.map((step, index) => ({ ...step, step_id: index + 1 })),
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

/**
 * DS-B31 (#290): the same two models the `modelSwitchBundle` ATIF steps
 * reference (`glm-5-2`, `swe-1-7`), with their real catalog `label`s —
 * finding 3b's unsuffixed-`model_uid`, label-only tier case (`"glm-5-2"` ->
 * `"GLM-5.2 High"`, `"swe-1-7"` -> `"SWE-1.7 Max"`) — so the model-switch
 * conformance fixture exercises real effort resolution, not just an
 * unmatched-model passthrough.
 */
function modelsJsonWithTiers(): string {
  return JSON.stringify([
    JSON.parse(modelsJson())[0],
    { modelUid: 'glm-5-2', label: 'GLM-5.2 High', familyUid: 'glm-5', costTier: 'standard' },
    { modelUid: 'swe-1-7', label: 'SWE-1.7 Max', familyUid: 'swe-1', costTier: 'standard' },
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

// The real materialized-transcript shape after two sync passes: the sync
// plugin re-appends the `session` line on EVERY pass ("last-write-wins
// replay semantics", devin-session-sync `filterNewRows`), so a session
// synced twice carries two session lines — the stale first-pass row first,
// the current row last. The reader must resolve session-level state from
// the LAST line (#320).
const sessionReplayTranscript = [
  sessionLine(sessionId, 4),
  messageLine(sessionId, 1, null, 'user', 'Hello'),
  messageLine(sessionId, 2, 1, 'assistant', 'Hi there'),
  messageLine(sessionId, 3, 2, 'user', 'Edit a file'),
  messageLine(sessionId, 4, 3, 'assistant', 'Done'),
  sessionLine(sessionId, 4, undefined, undefined, {
    title: 'Fresh replayed title',
    model: 'devin-updated',
    lastActivityAt: 1722524500,
    order: 6,
  }),
].join('\n');

export const sessionReplayBundle: UnknownArtifactBundle = bundle([
  artifact('transcript.jsonl', sessionReplayTranscript, 'application/jsonl'),
  artifact('native/models.json', modelsJson(), 'application/json'),
  artifact('native/schema-descriptor.json', schemaDescriptor(true), 'application/json'),
]);

// #341 (PIPE-019): the exact artifact shape devin-session-sync's fixed
// message_nodes content-hash watermark guarantees for an IDLE session
// synced twice -- message_nodes rewritten at fresh row_ids by Devin's own
// whole-forest persist churn, but content genuinely unchanged, so the
// extractor appends nothing for them (`filterChangedMessageNodes`); only
// the session's own last-write-wins line legitimately re-appears one line
// later (`jsonl-writer.ts`'s `appendSessionLines` doc comment), exactly
// mirroring devin-session-sync's own `session-sync.test.ts` proof at the
// extractor-unit level. `idleResyncPass1Bundle`/`idleResyncPass2Bundle`
// are two DIFFERENT transcripts for the SAME session (pass 2 = pass 1 +
// one appended session line, no repeated message lines) so a pipeline
// test can ingest both as two sequential manifest versions and prove the
// db/analytics layer doesn't inflate turn/message evidence from the
// churn, even though the raw transcript.jsonl artifact legitimately grew.
const idleResyncPass1Transcript = [
  sessionLine(sessionId, 2, undefined, undefined, { lastActivityAt: 1722520900 }),
  messageLine(sessionId, 1, null, 'user', 'Check on the deployment'),
  messageLine(sessionId, 2, 1, 'assistant', 'Deployment looks healthy'),
  toolCallLine(sessionId, 'tc-idle-1', 'execute', 'CheckStatus', 'success'),
].join('\n');

const idleResyncPass2Transcript = [
  idleResyncPass1Transcript,
  sessionLine(sessionId, 2, undefined, undefined, { lastActivityAt: 1722524500, order: 5 }),
].join('\n');

export const idleResyncPass1Bundle: UnknownArtifactBundle = bundle([
  artifact('transcript.jsonl', idleResyncPass1Transcript, 'application/jsonl'),
  artifact('native/models.json', modelsJson(), 'application/json'),
]);

export const idleResyncPass2Bundle: UnknownArtifactBundle = bundle([
  artifact('transcript.jsonl', idleResyncPass2Transcript, 'application/jsonl'),
  artifact('native/models.json', modelsJson(), 'application/json'),
]);

// A tool call whose state changed across sync passes: the extractor's
// content-hash watermark re-emits the row per state change, so the
// materialized transcript legitimately carries the SAME toolCallId more
// than once (#321) — here pending (no update), then completed, then a
// torn-snapshot regression that re-appended the pending shape after the
// completed one (PR #304 review, extractor finding F8). The reader must
// resolve one invocation, in the completed state.
const toolCallReplayTranscript = [
  sessionLine(sessionId, 2),
  messageLine(sessionId, 1, null, 'user', 'Run the build'),
  messageLine(sessionId, 2, 1, 'assistant', 'Running it now'),
  interruptedToolCallLine(sessionId, 'tc-replay-1', 'execute', 'RunCommand', 'RunCommand', {
    command: 'pnpm build',
  }),
  toolCallLine(sessionId, 'tc-replay-1', 'execute', 'RunCommand', 'completed'),
  interruptedToolCallLine(sessionId, 'tc-replay-1', 'execute', 'RunCommand', 'RunCommand', {
    command: 'pnpm build',
  }),
].join('\n');

export const toolCallReplayBundle: UnknownArtifactBundle = bundle([
  artifact('transcript.jsonl', toolCallReplayTranscript, 'application/jsonl'),
  artifact('native/models.json', modelsJson(), 'application/json'),
  artifact('native/schema-descriptor.json', schemaDescriptor(true), 'application/json'),
]);

// The REAL `sessions.metadata.response_dimensions` shape (verified on every
// session of a live Devin CLI 3000.6.x store, #322): entries carry
// `{ group_title, uid, kind: { CumulativeMetric: { value } } }`, with
// `input_tokens` EXCLUDING cache reads (note cached >> input, real ratios),
// plus a non-cumulative `model` dimension that must be skipped. No ATIF
// artifact — this is the tier-3 path 20 of 28 real sessions take.
const metadataTokensTranscript = [
  sessionLine(sessionId, 2, {
    response_dimensions: [
      {
        group_title: 'Tokens',
        uid: 'input_tokens',
        kind: { CumulativeMetric: { value: 3265287 } },
      },
      {
        group_title: 'Tokens',
        uid: 'output_tokens',
        kind: { CumulativeMetric: { value: 136906 } },
      },
      {
        group_title: 'Tokens',
        uid: 'cached_input_tokens',
        kind: { CumulativeMetric: { value: 37556736 } },
      },
      { group_title: 'Model', uid: 'model', kind: { Metric: { value: 'GLM-5.2 High' } } },
    ],
  }),
  messageLine(sessionId, 1, null, 'user', 'Hello'),
  messageLine(sessionId, 2, 1, 'assistant', 'Hi there'),
].join('\n');

export const metadataTokensBundle: UnknownArtifactBundle = bundle([
  artifact('transcript.jsonl', metadataTokensTranscript, 'application/jsonl'),
  artifact('native/models.json', modelsJson(), 'application/json'),
  artifact('native/schema-descriptor.json', schemaDescriptor(true), 'application/json'),
]);

// The #309/#324 scenario the heuristic gets wrong: an orphaned sub-agent
// tree (root's parent missing) LARGER than the true conversation. With the
// INTEGER main_chain_id signal live (#324), the authoritative chain must
// win; the biggest-subtree heuristic remains only a fallback for sessions
// genuinely lacking main_chain_id.
const authoritativeChainTranscript = [
  sessionLine(sessionId, 2),
  messageLine(sessionId, 1, null, 'user', 'Real question'),
  messageLine(sessionId, 2, 1, 'assistant', 'Real answer'),
  messageLine(sessionId, 10, 999, 'user', 'Orphan subagent prompt'),
  messageLine(sessionId, 11, 10, 'assistant', 'Orphan reply 1'),
  messageLine(sessionId, 12, 11, 'user', 'Orphan follow-up'),
  messageLine(sessionId, 13, 12, 'assistant', 'Orphan reply 2'),
  messageLine(sessionId, 14, 13, 'assistant', 'Orphan reply 3'),
].join('\n');

export const authoritativeChainBundle: UnknownArtifactBundle = bundle([
  artifact('transcript.jsonl', authoritativeChainTranscript, 'application/jsonl'),
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

// DS-B25 (#285): a mid-session model switch (glm-5-2 -> swe-1-7) across two
// ATIF agent-generation steps, using the exact token counts from the real
// `shadow-collar` repro (findings 3a/3b) — exercises per-step `model_usage`
// attribution instead of a single last-write-wins record. `final_metrics`
// equals the exact sum of both steps' `metrics`, mirroring the real data.
const modelSwitchTranscript = [
  sessionLine(sessionId, 4),
  messageLine(sessionId, 1, null, 'user', 'this is a message for glm-5.2'),
  messageLine(sessionId, 2, 1, 'assistant', 'Got it, running as GLM-5.2.'),
  messageLine(sessionId, 3, 2, 'user', 'this is a message to swe'),
  messageLine(sessionId, 4, 3, 'assistant', 'Got it, SWE mode acknowledged.'),
  toolCallLine(sessionId, 'tc-1', 'edit', 'EditFile', 'success'),
].join('\n');

const modelSwitchAtif = atifTranscript(
  [
    { timestamp: '2026-08-01T12:00:00.000Z', role: 'user', text: 'this is a message for glm-5.2' },
    {
      timestamp: '2026-08-01T12:00:05.000Z',
      role: 'assistant',
      text: 'Got it, running as GLM-5.2.',
      extra: { generation_model: 'glm-5-2' },
      metrics: { prompt_tokens: 18071, completion_tokens: 59, cached_tokens: 11874 },
    },
    { timestamp: '2026-08-01T12:00:10.000Z', role: 'user', text: 'this is a message to swe' },
    {
      timestamp: '2026-08-01T12:00:15.000Z',
      role: 'assistant',
      text: 'Got it, SWE mode acknowledged.',
      extra: { generation_model: 'swe-1-7' },
      metrics: { prompt_tokens: 17033, completion_tokens: 37, cached_tokens: 11136 },
    },
  ],
  { totalPromptTokens: 35104, totalCompletionTokens: 96, totalCachedTokens: 23010, totalSteps: 4 },
);

export const modelSwitchBundle: UnknownArtifactBundle = bundle([
  artifact('transcript.jsonl', modelSwitchTranscript, 'application/jsonl'),
  artifact('native/atif-transcript.json', modelSwitchAtif, 'application/json'),
  artifact('native/models.json', modelsJsonWithTiers(), 'application/json'),
]);

// DS-B31 (#290): a single ATIF agent-generation step whose model resolves to
// a real, recognized effort tier, with no second step to transition
// from/to — exercises `devin:effort:changes:*`'s n=1 "measured zero, never
// unavailable" case (`.agents/rules/missing-is-never-zero.md`).
const singleTierAtif = atifTranscript(
  [
    { timestamp: '2026-08-01T12:00:00.000Z', role: 'user', text: 'Hello' },
    {
      timestamp: '2026-08-01T12:00:05.000Z',
      role: 'assistant',
      text: 'Hi there',
      extra: { generation_model: 'glm-5-3-low' },
      metrics: { prompt_tokens: 100, completion_tokens: 50, cached_tokens: 10 },
    },
  ],
  { totalPromptTokens: 100, totalCompletionTokens: 50, totalCachedTokens: 10, totalSteps: 2 },
);

function modelsJsonSingleTier(): string {
  return JSON.stringify([
    JSON.parse(modelsJson())[0],
    { modelUid: 'glm-5-3-low', label: 'GLM-5.3 Low', familyUid: 'glm-5', costTier: 'standard' },
  ]);
}

export const singleTierBundle: UnknownArtifactBundle = bundle([
  artifact('transcript.jsonl', linearTranscript, 'application/jsonl'),
  artifact('native/atif-transcript.json', singleTierAtif, 'application/json'),
  artifact('native/models.json', modelsJsonSingleTier(), 'application/json'),
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

// #341: devin-session-sync's fixed message_nodes content-hash watermark
// means a genuine in-place edit to an existing node is captured as a
// SECOND `message` line under the SAME node_id, at a fresh (later) row_id
// -- the extractor only ever appends, never rewrites history in place.
// Unlike `replayedBundle` above (a byte-identical duplicate, same row_id),
// this reproduces a real in-place-update replay: same node_id, DIFFERENT
// row_id, DIFFERENT content. Regression-lock for devin-transformer: proves
// the pre-existing Map/Set-based dedup in `parse-bundle.ts` already
// resolves this to exactly ONE message/turn record carrying the LATEST
// content -- no production transformer change needed to support #341's
// extractor fix. Both replayed lines share the SAME node_id, so they also
// collapse to the same synthetic `messageId()` (`msg-1`, derived from the
// shared node_id) and both pass through `dedupeByMessageId`'s grouping
// step -- but since its own `keepNodeIds` check is nodeId-keyed, and both
// entries share that one nodeId, it lets both through unchanged here (it
// only actually drops an entry when two DIFFERENT node_ids collide on one
// messageId, e.g. the `subagentBundle` fixture's 249/250 pair below). The
// actual collapse to one record is `byId`'s last-write-wins `Map`
// construction plus `visited`'s single-visitation guard in `visitSubtree`,
// both operating on `dedupeByMessageId`'s (here, unchanged) output.
const messageNodeReplayTranscript = [
  sessionLine(sessionId, 2),
  messageLine(sessionId, 1, null, 'user', 'Run the build', { rowId: 10 }),
  messageLine(sessionId, 1, null, 'user', 'Run the build (edited)', { rowId: 255 }),
  messageLine(sessionId, 2, 1, 'assistant', 'Done'),
].join('\n');

export const messageNodeReplayBundle: UnknownArtifactBundle = bundle([
  artifact('transcript.jsonl', messageNodeReplayTranscript, 'application/jsonl'),
  artifact('native/models.json', modelsJson(), 'application/json'),
]);

// Reproduces (anonymized) the real `shadow-collar` session's node 45-63
// shape from DS-B27 (#287) Research Finding 2: a linear pre-compaction chain
// 45->...->49->...->55->57, a dead sibling branch (56, sharing parent 55
// with 57, from an earlier retried turn) that a naive `node_id BETWEEN 50
// AND 57` range would wrongly include, and the compaction's own output-node
// subtree (58-63) reattaching the main chain at node 49. A correlated
// `/compact` prompt row (Finding 1) makes `trigger: 'manual'` derivable.
const compactionSessionId = 'shadow-collar-anon';

const compactionTranscript = [
  sessionLine(compactionSessionId, 63),
  messageLine(compactionSessionId, 45, null, 'user', 'Start task', { createdAt: 1788465000 }),
  messageLine(compactionSessionId, 46, 45, 'assistant', 'Working on it', { createdAt: 1788465010 }),
  messageLine(compactionSessionId, 47, 46, 'user', 'Continue', { createdAt: 1788465020 }),
  messageLine(compactionSessionId, 48, 47, 'assistant', 'More progress', { createdAt: 1788465030 }),
  messageLine(compactionSessionId, 49, 48, 'user', 'Keep going', { createdAt: 1788465040 }),
  messageLine(compactionSessionId, 50, 49, 'assistant', 'Step 50', { createdAt: 1788465050 }),
  messageLine(compactionSessionId, 51, 50, 'user', 'Step 51', { createdAt: 1788465060 }),
  messageLine(compactionSessionId, 52, 51, 'assistant', 'Step 52', { createdAt: 1788465070 }),
  messageLine(compactionSessionId, 53, 52, 'user', 'Step 53', { createdAt: 1788465080 }),
  messageLine(compactionSessionId, 54, 53, 'assistant', 'Step 54', { createdAt: 1788465090 }),
  messageLine(compactionSessionId, 55, 54, 'user', 'Step 55', { createdAt: 1788465100 }),
  messageLine(compactionSessionId, 56, 55, 'assistant', 'Retried approach (dead branch)', {
    createdAt: 1788465105,
  }),
  messageLine(compactionSessionId, 57, 55, 'assistant', 'Last pre-compaction turn', {
    createdAt: 1788465110,
    metadata: { summarized_from: null, num_tokens_preceding: 17033, is_system_prefix: null },
  }),
  messageLine(compactionSessionId, 58, null, 'system', 'You are a Summarizer...', {
    createdAt: 1788465458,
    metadata: { summarized_from: null, num_tokens_preceding: null, is_system_prefix: true },
  }),
  messageLine(compactionSessionId, 59, 58, 'user', 'Full prior conversation dump', {
    createdAt: 1788465458,
  }),
  messageLine(compactionSessionId, 60, 59, 'user', 'Now summarize the conversation above...', {
    createdAt: 1788465458,
  }),
  messageLine(compactionSessionId, 61, 60, 'assistant', '<summary>...</summary>', {
    createdAt: 1788465458,
    metadata: { summarized_from: 57, num_tokens_preceding: null, is_system_prefix: null },
  }),
  messageLine(compactionSessionId, 62, 49, 'system', '<available_skills>...', {
    createdAt: 1788465458,
  }),
  messageLine(
    compactionSessionId,
    63,
    62,
    'system',
    'You are continuing work from a previous conversation thread...',
    {
      createdAt: 1788465458,
      metadata: { summarized_from: 57, num_tokens_preceding: null, is_system_prefix: null },
    },
  ),
  promptLine(compactionSessionId, 1, '/compact', 1788465456),
  toolCallLine(compactionSessionId, 'tc-1', 'edit', 'EditFile', 'success'),
].join('\n');

const compactionAtif = atifTranscript(
  [{ timestamp: '2026-09-03T19:57:36.000Z', role: 'user', text: 'compact' }],
  { totalPromptTokens: 17033, totalCompletionTokens: 154, totalCachedTokens: 0, totalSteps: 19 },
);

export const compactionBoundaryBundle: UnknownArtifactBundle = bundle([
  artifact('transcript.jsonl', compactionTranscript, 'application/jsonl'),
  artifact('native/atif-transcript.json', compactionAtif, 'application/json'),
  artifact('native/models.json', modelsJson(), 'application/json'),
]);

const mcpAllowListCog = {
  source: { Session: 'System' },
  lifetime: { Unique: 'core/model' },
  set_system_prefix: null,
  append_system_messages: [],
  context: [],
  footer_messages: [],
  user_display: [],
  permissions: [],
  tool_availability: {
    AllowList: [
      { Name: { exact: 'exec' } },
      { Name: { exact: 'read' } },
      { Name: { exact: 'mcp_call_tool' } },
      { Name: { exact: 'mcp_list_servers' } },
      { Name: { exact: 'mcp_list_tools' } },
      { Name: { exact: 'mcp_read_resource' } },
    ],
  },
  model: 'devin-default',
};

const skillCog = {
  source: { Session: 'Hook' },
  lifetime: { Unique: 'skill/add-e2e-test' },
  set_system_prefix: null,
  append_system_messages: [],
  context: [],
  footer_messages: [],
  user_display: [],
  permissions: [],
  tool_availability: null,
  model: null,
};

const componentsTranscript = [
  sessionLine(sessionId, 3, undefined, [mcpAllowListCog, skillCog]),
  messageLine(sessionId, 1, null, 'user', 'Invoke a skill and a subagent'),
  messageLine(sessionId, 2, 1, 'assistant', 'On it'),
  messageLine(sessionId, 3, 2, 'assistant', 'Done'),
  toolCallLine(sessionId, 'tc-skill-1', 'execute', 'Invoked skill add-e2e-test', 'success', {
    inferenceToolName: 'skill',
    rawInput: { command: 'invoke', skill: 'add-e2e-test' },
  }),
  toolCallLine(sessionId, 'tc-agent-1', 'execute', 'Ran pr-review subagent', 'success', {
    inferenceToolName: 'run_subagent',
    rawInput: { profile: 'pr-review', title: 'Review PR #264', task: 'Review the pull request' },
  }),
].join('\n');

export const componentsBundle: UnknownArtifactBundle = bundle([
  artifact('transcript.jsonl', componentsTranscript, 'application/jsonl'),
  artifact('native/atif-transcript.json', linearAtif, 'application/json'),
  artifact('native/models.json', modelsJson(), 'application/json'),
]);

// A skill/<name> cog present with NO matching tool_call_state invocation —
// the component must still be derived from the cog alone (DS-F11 (#288)
// research findings §2: the cog and the invocation are two different
// evidence sources and must not be conflated).
const skillCogOnlyTranscript = [
  sessionLine(sessionId, 1, undefined, [skillCog]),
  messageLine(sessionId, 1, null, 'user', 'Hello'),
].join('\n');

export const skillCogOnlyBundle: UnknownArtifactBundle = bundle([
  artifact('transcript.jsonl', skillCogOnlyTranscript, 'application/jsonl'),
  artifact('native/models.json', modelsJson(), 'application/json'),
]);

// A functions.skill invocation present with NO matching skill/<name> cog —
// the invocation-count metric is driven only by tool_call_state, never by
// cog presence, so the metric must still count it even without a cog.
const skillInvocationOnlyTranscript = [
  sessionLine(sessionId, 1, undefined),
  messageLine(sessionId, 1, null, 'user', 'Hello'),
  toolCallLine(sessionId, 'tc-skill-only', 'execute', 'Invoked skill add-e2e-test', 'success', {
    inferenceToolName: 'skill',
    rawInput: { command: 'invoke', skill: 'add-e2e-test' },
  }),
].join('\n');

export const skillInvocationOnlyBundle: UnknownArtifactBundle = bundle([
  artifact('transcript.jsonl', skillInvocationOnlyTranscript, 'application/jsonl'),
  artifact('native/models.json', modelsJson(), 'application/json'),
]);

// A core/model AllowList cog (declaring the 4 MCP wrapper tool names) with
// NO matching tool_call_state invocation of any of them, and no skill/agent
// activity either — every session component here is declared availability
// only, never confirmed by an actual invocation. Exercises the
// temporalRole fix: a merged snapshot with zero confirmed-runtime
// components must not be labeled 'runtime' (DS-F11 (#288) review finding).
const mcpDeclaredOnlyTranscript = [
  sessionLine(sessionId, 1, undefined, [mcpAllowListCog]),
  messageLine(sessionId, 1, null, 'user', 'Hello'),
].join('\n');

export const mcpDeclaredOnlyBundle: UnknownArtifactBundle = bundle([
  artifact('transcript.jsonl', mcpDeclaredOnlyTranscript, 'application/jsonl'),
  artifact('native/models.json', modelsJson(), 'application/json'),
]);

// A functions.skill call interrupted before its tool_call_update_json
// arrived — no `update` record exists at all, only `call`. The call's own
// `_meta["cognition.ai/inferenceToolName"]` must still resolve this as
// `kind: 'skill'`, not silently fall back to `kind: 'tool'` (DS-F11 (#288)
// review finding: the fallback chain must not reproduce the Skill/Agent
// conflation bug this PR fixes for a narrower "no update record" trigger).
const interruptedSkillTranscript = [
  sessionLine(sessionId, 1, undefined, [skillCog]),
  messageLine(sessionId, 1, null, 'user', 'Invoke a skill, then get interrupted'),
  interruptedToolCallLine(
    sessionId,
    'tc-skill-interrupted',
    'execute',
    'Invoked skill add-e2e-test',
    'skill',
    { command: 'invoke', skill: 'add-e2e-test' },
  ),
].join('\n');

export const interruptedSkillCallBundle: UnknownArtifactBundle = bundle([
  artifact('transcript.jsonl', interruptedSkillTranscript, 'application/jsonl'),
  artifact('native/models.json', modelsJson(), 'application/json'),
]);

/**
 * DS-B28 (#294): a session with BOTH a foreground and a background
 * `run_subagent` invocation, each already carrying the synthetic
 * prompt/result `message` lines exactly as `jsonl-writer.ts`'s
 * `appendSubagentLines` would emit them (reusing the real `message` line
 * shape/fields, per the issue's acceptance criterion) -- proving
 * `DevinTransformer.transform()` builds `subagent_turn` evidence end-to-end
 * from real `transcript.jsonl` text, through the UNMODIFIED `parse-line.ts`
 * parsing path, with no bespoke line format.
 *
 * Also includes one duplicate `message_nodes` pair (mirroring the issue's
 * cited `shadow-collar` nodes 249/250) and one orphaned sub-agent tree
 * (mirroring `foremost-hide` nodes 316-322), so the conformance suite
 * exercises findings #4/#5's fixes on the SAME session as the sub-agent
 * capture, not just in isolation.
 */
function subagentTaggedMessageLine(
  sessionIdArg: string,
  nodeId: number,
  parentNodeId: number | null,
  role: string,
  content: string,
  chatMessageExtensions?: Record<string, unknown>,
): string {
  return devinJsonlLine('message', {
    ts: null,
    order: nodeId + 2000,
    row_id: nodeId,
    session_id: sessionIdArg,
    node_id: nodeId,
    parent_node_id: parentNodeId,
    chat_message: JSON.stringify({
      message_id: `msg-${nodeId}`,
      role,
      content,
      ...(chatMessageExtensions ? { metadata: { extensions: chatMessageExtensions } } : {}),
    }),
    created_at: null,
    metadata: null,
  });
}

function subagentSyntheticLine(
  sessionIdArg: string,
  nodeId: number,
  parentNodeId: number | null,
  role: 'user' | 'assistant',
  content: string,
  subagentExtensions: Record<string, unknown>,
  syntheticBookkeeping: Record<string, unknown>,
): string {
  return devinJsonlLine('message', {
    ts: null,
    order: nodeId % 100_000,
    row_id: -1,
    session_id: sessionIdArg,
    node_id: nodeId,
    parent_node_id: parentNodeId,
    chat_message: JSON.stringify({ role, content, metadata: { extensions: subagentExtensions } }),
    created_at: null,
    metadata: JSON.stringify(syntheticBookkeeping),
  });
}

function syntheticPair(
  sessionIdArg: string,
  taggedNodeId: number,
  agentId: string,
  promptContent: string,
  resultContent: string,
  resultExtensions: Record<string, unknown>,
  isBackground: boolean,
  sourceNodeId: number,
): string[] {
  const promptNodeId = Number.MAX_SAFE_INTEGER - taggedNodeId * 2;
  const resultNodeId = Number.MAX_SAFE_INTEGER - taggedNodeId * 2 - 1;
  return [
    subagentSyntheticLine(
      sessionIdArg,
      promptNodeId,
      null,
      'user',
      promptContent,
      { 'subagent/agent_id': agentId },
      {
        'sal/synthetic_subagent_kind': 'prompt',
        'sal/synthetic_subagent_rawinput_profile': 'subagent_explore',
        'sal/synthetic_subagent_tool_call_id': `functions.run_subagent:${taggedNodeId}`,
      },
    ),
    subagentSyntheticLine(
      sessionIdArg,
      resultNodeId,
      promptNodeId,
      'assistant',
      resultContent,
      resultExtensions,
      {
        'sal/synthetic_subagent_kind': 'result',
        'sal/synthetic_subagent_is_background': isBackground,
        'sal/synthetic_subagent_source_node_id': sourceNodeId,
      },
    ),
  ];
}

const subagentSessionId = 'test-sess-subagent';

const foregroundResultExtensions = {
  'subagent/agent_id': '44472e00',
  'subagent/profile_name': 'Explore',
  'subagent/model': 'Subagent Default',
  'subagent/chain_node_id': 176,
};

const backgroundResultExtensions = {
  'subagent/agent_id': '55c47591',
  'subagent/profile_name': 'Explore',
  'subagent/model': 'Subagent Default',
};

const subagentTranscript = [
  sessionLine(subagentSessionId, 250),
  // --- Foreground invocation: shadow-collar nodes 177/178 shape. ---
  subagentTaggedMessageLine(subagentSessionId, 90, null, 'user', 'start'),
  subagentTaggedMessageLine(subagentSessionId, 177, 90, 'assistant', 'calling run_subagent'),
  subagentTaggedMessageLine(
    subagentSessionId,
    178,
    177,
    'tool',
    'Subagent agent_id=44472e00 completed successfully:\n\nfull foreground report',
    foregroundResultExtensions,
  ),
  ...syntheticPair(
    subagentSessionId,
    178,
    '44472e00',
    'Explore the auth module',
    'full foreground report',
    foregroundResultExtensions,
    false,
    178,
  ),
  // --- Background invocation: shadow-collar nodes 226-250 shape. ---
  subagentTaggedMessageLine(subagentSessionId, 226, 178, 'assistant', 'run it bg'),
  subagentTaggedMessageLine(
    subagentSessionId,
    227,
    226,
    'tool',
    'Background subagent started with agent_id=55c47591 running in the background.',
    backgroundResultExtensions,
  ),
  subagentTaggedMessageLine(subagentSessionId, 228, 227, 'assistant', 'ok, later'),
  subagentTaggedMessageLine(subagentSessionId, 246, 228, 'assistant', 'checking on it'),
  subagentTaggedMessageLine(
    subagentSessionId,
    247,
    246,
    'tool',
    'Subagent 55c47591 completed. Its full report is delivered in the <subagent_completion_notification> message; you do not need to read it again.',
  ),
  subagentTaggedMessageLine(
    subagentSessionId,
    248,
    247,
    'system',
    '<subagent_completion_notification>\n[Background subagent with agent_id=55c47591 completed]\n\nfull background report',
  ),
  ...syntheticPair(
    subagentSessionId,
    227,
    '55c47591',
    'Explore the billing module',
    '<subagent_completion_notification>\n[Background subagent with agent_id=55c47591 completed]\n\nfull background report',
    backgroundResultExtensions,
    true,
    248,
  ),
  // --- Finding #4: duplicate message_nodes pair (shadow-collar 249/250 shape). ---
  subagentTaggedMessageLine(subagentSessionId, 249, 248, 'assistant', 'duplicated content'),
  devinJsonlLine('message', {
    ts: null,
    order: 4250,
    row_id: 250,
    session_id: subagentSessionId,
    node_id: 250,
    parent_node_id: 248,
    chat_message: JSON.stringify({
      message_id: 'msg-249',
      role: 'assistant',
      content: 'duplicated content',
    }),
    created_at: null,
    metadata: JSON.stringify({
      summarized_from: null,
      num_tokens_preceding: 500,
      is_system_prefix: null,
    }),
  }),
  // --- Finding #5: orphaned sub-agent tree (foremost-hide 316-322 shape). ---
  subagentTaggedMessageLine(
    subagentSessionId,
    317,
    null,
    'system',
    'You are a senior engineer performing thorough pull request reviews...',
  ),
  subagentTaggedMessageLine(subagentSessionId, 318, 317, 'user', 'Review PR #264'),
  subagentTaggedMessageLine(subagentSessionId, 320, 318, 'assistant', 'Looking at the diff'),
  subagentTaggedMessageLine(subagentSessionId, 322, 320, 'assistant', 'Posted the review'),
].join('\n');

export const subagentBundle: UnknownArtifactBundle = bundle([
  artifact('transcript.jsonl', subagentTranscript, 'application/jsonl'),
  artifact('native/models.json', modelsJson(), 'application/json'),
]);

export const noRootBundle: UnknownArtifactBundle = bundle([
  artifact('native/schema-descriptor.json', schemaDescriptor(true), 'application/json'),
  artifact('native/models.json', modelsJson(), 'application/json'),
  artifact('.devin/config.json', JSON.stringify({ project: 'test' }), 'application/json'),
]);

// The devin 'complete' fixture (#308): every invocation domain (tool, skill,
// agent), transform-time components from cogs (skill + MCP wrapper tools)
// and tool_call_state (agent), inline Sub Agent evidence (a detached
// conversation subtree), and ATIF final metrics whose token identity
// reconciles exactly (prompt 100 incl. 10 cached + completion 50 = total
// 150 = the session-level model_usage inputTokens + outputTokens). Enables
// toolSkillAgentSubAgentDistinct and rootOnlyAndInclusiveNoDoubleCount to
// actually run for devin instead of reporting `unverified`.
const completeSessionTranscript = [
  sessionLine(sessionId, 3, undefined, [mcpAllowListCog, skillCog]),
  messageLine(sessionId, 1, null, 'user', 'Invoke a skill and a subagent'),
  messageLine(sessionId, 2, 1, 'assistant', 'On it'),
  messageLine(sessionId, 3, 2, 'assistant', 'Done'),
  messageLine(sessionId, 40, 999, 'user', 'Detached subagent task prompt'),
  messageLine(sessionId, 41, 40, 'assistant', 'Detached subagent result'),
  toolCallLine(sessionId, 'tc-skill-1', 'execute', 'Invoked skill add-e2e-test', 'success', {
    inferenceToolName: 'skill',
    rawInput: { command: 'invoke', skill: 'add-e2e-test' },
  }),
  toolCallLine(sessionId, 'tc-agent-1', 'execute', 'Ran pr-review subagent', 'success', {
    inferenceToolName: 'run_subagent',
    rawInput: { profile: 'pr-review', title: 'Review PR #264', task: 'Review the pull request' },
  }),
  toolCallLine(sessionId, 'tc-tool-1', 'edit', 'EditFile', 'success'),
].join('\n');

export const completeSessionBundle: UnknownArtifactBundle = bundle([
  artifact('transcript.jsonl', completeSessionTranscript, 'application/jsonl'),
  artifact('native/atif-transcript.json', linearAtif, 'application/json'),
  artifact('native/models.json', modelsJson(), 'application/json'),
  artifact('native/schema-descriptor.json', schemaDescriptor(true), 'application/json'),
]);

// The devin 'classification' fixture (#308): an artifact no path rule
// covers — partialSnapshotsDoNotImplyRemovals asserts the unclassified
// artifact degrades completeness (never a `complete` claim) instead of
// implying removal.
const partialClassificationTranscript = [
  sessionLine(sessionId, 2),
  messageLine(sessionId, 1, null, 'user', 'Hello'),
  messageLine(sessionId, 2, 1, 'assistant', 'Hi'),
].join('\n');

export const partialClassificationBundle: UnknownArtifactBundle = bundle([
  artifact('transcript.jsonl', partialClassificationTranscript, 'application/jsonl'),
  artifact('native/models.json', modelsJson(), 'application/json'),
  artifact('mystery/unknown-artifact.bin', 'opaque-bytes', 'application/octet-stream'),
]);

export const devinConformanceFixtures: TransformerFixtures<UnknownArtifactBundle> = {
  fixtures: [
    // Listed first: `runTransformerConformanceSuite`'s provenance/formula
    // check selects the *first* successful fixture with metrics and
    // evidence as its single sampled target - this fixture must be that one
    // so the `compaction`/`context` formula checks (DS-B27 (#287)) flip from
    // "TODO: no records..." to "...formula records present." It carries a
    // superset of `linear-root`'s coverage (tokens, a tool call) so no other
    // formula check regresses.
    fixture(
      'compaction-boundary',
      "A session with a compaction boundary (DS-B27 (#287)'s shadow-collar node 45-63 shape): a dead sibling branch, a summarizer output subtree, and a correlated /compact prompt row.",
      compactionBoundaryBundle,
      ['root', 'compaction', 'deterministic', 'provenance', 'formulas'],
    ),
    fixture(
      'linear-root',
      'A simple linear session with ATIF final metrics and a tool call.',
      linearBundle,
      ['root', 'linear', 'deterministic', 'exact-estimated', 'provenance', 'formulas'],
    ),
    fixture(
      'model-switch',
      'A session with a mid-session model switch (glm-5-2 -> swe-1-7) across two ATIF ' +
        "agent-generation steps, using the real shadow-collar repro's token counts " +
        '(DS-B25 (#285)) — exercises per-step model_usage attribution instead of a single ' +
        'last-write-wins record.',
      modelSwitchBundle,
      ['root', 'model-switch', 'tokens', 'deterministic'],
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
    fixture(
      'message-node-replay',
      'A message_nodes row replayed under the SAME node_id at a fresh row_id with genuinely ' +
        'different content (#341: the extractor now captures in-place node edits as an appended ' +
        'line rather than rewriting history) -- regression-lock proving the pre-existing ' +
        'Map/Set-based dedup in parse-bundle.ts resolves to one record with the latest content, ' +
        'with no production transformer change required.',
      messageNodeReplayBundle,
      ['root', 'replayed', 'deterministic'],
    ),
    fixture(
      'session-replay',
      'A transcript with two session lines (stale first-pass row, then the current row) — ' +
        'the real shape after two sync passes; session-level state must resolve from the ' +
        'LAST line (#320).',
      sessionReplayBundle,
      ['root', 'deterministic'],
    ),
    fixture(
      'idle-resync-pass-1',
      'PIPE-019 (#341) pass 1 of two: a minimal idle-session transcript (2 messages, 1 tool ' +
        'call) that pass 2 below extends with exactly one re-appended session line and no ' +
        'repeated message lines, matching the fixed message_nodes content-hash watermark.',
      idleResyncPass1Bundle,
      ['root', 'deterministic'],
    ),
    fixture(
      'idle-resync-pass-2',
      'PIPE-019 (#341) pass 2 of two: idle-resync-pass-1 plus one re-appended session line ' +
        '(message_nodes churned at fresh row_ids but content unchanged, so nothing else is ' +
        're-emitted) — the real artifact shape after a second sync of an idle session.',
      idleResyncPass2Bundle,
      ['root', 'deterministic'],
    ),
    fixture(
      'tool-call-replay',
      'A tool call captured three times across sync passes (pending, completed, then a ' +
        'torn-snapshot pending regression) under one toolCallId — must dedupe to a single ' +
        'completed invocation with unique recordIds (#321).',
      toolCallReplayBundle,
      ['root', 'deterministic'],
    ),
    fixture(
      'metadata-tokens',
      'An ATIF-less session whose metadata carries the REAL response_dimensions shape ' +
        '({ uid, kind: { CumulativeMetric: { value } } }) — the tier-3 token path (#322); ' +
        'includes a non-cumulative model dimension that must be skipped.',
      metadataTokensBundle,
      ['root', 'deterministic', 'exact-estimated'],
    ),
    fixture(
      'authoritative-main-chain',
      'A session whose INTEGER main_chain_id points at a 2-node conversation while a ' +
        'LARGER 5-node orphan tree is present — the authoritative signal must beat the ' +
        'biggest-subtree heuristic (#324, the #309 failure case).',
      authoritativeChainBundle,
      ['root', 'deterministic'],
    ),
    fixture('no-root', 'Configuration artifacts without a root transcript.', noRootBundle, [
      'no-root',
      'unavailable',
    ]),
    fixture(
      'session-components',
      'A session with a skill/add-e2e-test cog, a core/model AllowList including the 4 MCP ' +
        'wrapper tools, a functions.skill call, and a functions.run_subagent call — exercises ' +
        'cogs_json-derived skill/tool components, tool_call_state-derived agent components, and ' +
        'the Skill/Agent/Tool invocation domain fix.',
      componentsBundle,
      ['root', 'components', 'skill', 'agent', 'mcp', 'deterministic'],
    ),
    fixture(
      'subagent-evidence',
      'A session with a foreground and a background run_subagent invocation (real subagent/* ' +
        'extension tags and synthetic prompt/result message lines), a duplicate message_nodes ' +
        "pair, and an orphaned sub-agent tree — exercises DS-B28 (#294)'s Sub Agent domain " +
        'evidence capture and the ordering-corruption fixes together.',
      subagentBundle,
      ['root', 'subagent', 'deterministic'],
    ),
    fixture(
      'complete-session',
      'The devin complete fixture (#308): tool/skill/agent invocations, cogs- and ' +
        'tool_call_state-derived components, inline Sub Agent evidence (detached ' +
        'conversation), and exactly-reconciling ATIF token totals — makes ' +
        'toolSkillAgentSubAgentDistinct and rootOnlyAndInclusiveNoDoubleCount run for devin.',
      completeSessionBundle,
      ['root', 'subagent', 'complete', 'deterministic'],
    ),
    fixture(
      'partial-classification',
      'A bundle containing an artifact no path rule covers (#308): ' +
        'partialSnapshotsDoNotImplyRemovals asserts unclassified artifacts degrade ' +
        'completeness without implying removal or claiming complete.',
      partialClassificationBundle,
      ['root', 'classification', 'unavailable', 'deterministic'],
    ),
  ],
};
