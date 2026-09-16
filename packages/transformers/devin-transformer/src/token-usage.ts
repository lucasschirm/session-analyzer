import type {
  AtifFinalMetrics,
  AtifStep,
  AtifTranscript,
  DevinMessageLine,
  DevinModelRecord,
  DevinSessionLine,
} from '@lucasschirm/sal-devin-session-parser';
import type { NormalizedEvidenceRecord } from '@lucasschirm/sal-transformer-shared';
import { resolveDevinEffortForModel } from './effort.js';
import { provenanceForArtifact, stableId } from './session-spine.js';

export interface TokenUsageResult {
  readonly records: readonly NormalizedEvidenceRecord[];
  readonly prompt: number | null;
  readonly completion: number | null;
  readonly cached: number | null;
  readonly total: number | null;
  readonly steps: number | null;
  readonly exact: boolean;
}

function parseMetadata(metadata: string | null): Record<string, unknown> {
  if (!metadata) return {};
  try {
    const parsed: unknown = JSON.parse(metadata);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Extracts the numeric value of one real `response_dimensions[]` entry:
 * `{ group_title, uid, kind: { CumulativeMetric: { value } } }` (the shape
 * observed on every session in a live Devin CLI 3000.6.x store — #322).
 * Non-cumulative dimensions (e.g. `uid: "model"` carrying a label string)
 * return null and are skipped by the caller.
 */
function cumulativeMetricValue(d: Record<string, unknown>): number | null {
  const kind = d.kind;
  if (!kind || typeof kind !== 'object') return null;
  const metric = (kind as Record<string, unknown>).CumulativeMetric;
  if (!metric || typeof metric !== 'object') return null;
  const value = (metric as Record<string, unknown>).value;
  return typeof value === 'number' ? value : null;
}

function sumUidDimensions(dimensions: unknown[]): {
  input: number | null;
  output: number | null;
  cachedInput: number | null;
} {
  let input: number | null = null;
  let output: number | null = null;
  let cachedInput: number | null = null;
  for (const dim of dimensions) {
    if (!dim || typeof dim !== 'object') continue;
    const d = dim as Record<string, unknown>;
    const value = cumulativeMetricValue(d);
    if (value === null) continue;
    if (d.uid === 'input_tokens') input = (input ?? 0) + value;
    else if (d.uid === 'output_tokens') output = (output ?? 0) + value;
    else if (d.uid === 'cached_input_tokens') cachedInput = (cachedInput ?? 0) + value;
  }
  return { input, output, cachedInput };
}

/**
 * Cache-exclusive input tokens from a cache-inclusive prompt count and its
 * cache-read subset. ATIF reports `promptTokens`/`totalPromptTokens` as
 * INCLUDING cache reads, whereas the shared `model_usage`/`model_request`
 * payload contract (and Devin's own `response_dimensions.input_tokens` /
 * `chat_message.metadata.metrics.input_tokens`, both verified cache-exclusive)
 * is that `inputTokens` EXCLUDES cache reads. Keeping one contract across
 * harnesses is what lets `context-timing.ts` sum in + cacheRead + cacheCreate
 * without double-counting the cached subset.
 *
 * When either side is unknown, the prompt is returned as-is — no fabricated
 * subtraction (`missing-is-never-zero`); the accompanying `tokenValuesExact:
 * false` flags the value as not certified.
 */
function cacheExclusiveInput(prompt: number | null, cached: number | null): number | null {
  if (prompt === null) return null;
  if (cached === null) return prompt;
  return Math.max(prompt - cached, 0);
}

/** The pre-#322 flat-key probe, kept only as a fallback for unobserved shapes. */
function sumFlatKeyDimensions(dimensions: unknown[]): {
  prompt: number | null;
  completion: number | null;
  cached: number | null;
  input: number | null;
} {
  let prompt = 0;
  let completion = 0;
  let cached = 0;
  let any = false;
  for (const dim of dimensions) {
    if (!dim || typeof dim !== 'object') continue;
    const d = dim as Record<string, unknown>;
    const p = d.prompt_tokens ?? d.promptTokens ?? d.input_tokens;
    const c = d.completion_tokens ?? d.completionTokens ?? d.output_tokens;
    const ch = d.cached_tokens ?? d.cachedTokens ?? d.cache_read_tokens;
    if (typeof p === 'number') {
      prompt += p;
      any = true;
    }
    if (typeof c === 'number') {
      completion += c;
      any = true;
    }
    if (typeof ch === 'number') {
      cached += ch;
      any = true;
    }
  }
  return any
    ? { prompt, completion, cached, input: prompt }
    : { prompt: null, completion: null, cached: null, input: null };
}

/**
 * Real `response_dimensions[]` uids are `input_tokens` / `output_tokens` /
 * `cached_input_tokens`, where `input_tokens` EXCLUDES cache reads (observed
 * cached ≫ input on real sessions, e.g. 37.5M cached vs 3.2M input). ATIF
 * `final_metrics.totalPromptTokens` INCLUDES its cached subset ("Subset of
 * prompt_tokens that were cache hits"), so to keep ONE meaning for
 * `devin:tokens:prompt` across sourcing tiers, prompt here is
 * input + cached when both are present. When only `input_tokens` was
 * reported, prompt carries it as-is and `cached: null` flags the missing
 * cache dimension (never coerced to 0 — missing-is-never-zero).
 */
function sumResponseDimensions(dimensions: unknown[]): {
  prompt: number | null;
  completion: number | null;
  cached: number | null;
  input: number | null;
} {
  const uid = sumUidDimensions(dimensions);
  if (uid.input === null && uid.output === null && uid.cachedInput === null) {
    return sumFlatKeyDimensions(dimensions);
  }
  const prompt =
    uid.input !== null ? uid.input + (uid.cachedInput ?? 0) : (uid.cachedInput ?? null);
  return { prompt, completion: uid.output, cached: uid.cachedInput, input: uid.input };
}

function tokensFromAtif(finalMetrics: AtifFinalMetrics): {
  prompt: number | null;
  completion: number | null;
  cached: number | null;
  input: number | null;
  steps: number | null;
} {
  return {
    prompt: finalMetrics.totalPromptTokens,
    completion: finalMetrics.totalCompletionTokens,
    cached: finalMetrics.totalCachedTokens,
    input: cacheExclusiveInput(finalMetrics.totalPromptTokens, finalMetrics.totalCachedTokens),
    steps: finalMetrics.totalSteps,
  };
}

function tokensFromMetadata(metadata: Record<string, unknown>): {
  prompt: number | null;
  completion: number | null;
  cached: number | null;
  input: number | null;
} {
  const responseDimensions = metadata.response_dimensions;
  if (Array.isArray(responseDimensions) && responseDimensions.length > 0) {
    return sumResponseDimensions(responseDimensions);
  }
  return { prompt: null, completion: null, cached: null, input: null };
}

/**
 * Matches a raw model string (session-level `sessions.model`, or a per-step
 * `extra.generation_model`) against the models catalog by `modelUid` or
 * case-insensitive `label`, falling back to the raw string verbatim when no
 * match is found (e.g. `compactor` — a real recorded value, never dropped,
 * per `analytics-domain-distinctions`/`missing-is-never-zero`). `null`/empty
 * input resolves to `'unknown'`, distinct from "recorded but unmatched".
 */
function resolveModelId(raw: string | null, models: readonly DevinModelRecord[]): string {
  if (!raw) return 'unknown';
  const match = models.find(
    (m) => m.modelUid === raw || m.label.toLowerCase() === raw.toLowerCase(),
  );
  return match ? match.modelUid : raw;
}

function resolveModel(
  session: DevinSessionLine | undefined,
  models: readonly DevinModelRecord[],
): string {
  return resolveModelId(session?.model ?? null, models);
}

/**
 * `devin:tokens:total` = prompt + completion (#323). `cached` is a SUBSET of
 * prompt in every sourcing tier — ATIF's spec defines `cached_tokens` as
 * "Subset of prompt_tokens that were cache hits" (real store: 8.89M cached
 * of 9.41M prompt), and tier 3 constructs prompt as input + cached (#322) —
 * so adding it again double-counted cache-heavy sessions by up to ~2x.
 */
function totalFromParts(prompt: number | null, completion: number | null): number | null {
  return prompt !== null && completion !== null ? prompt + completion : null;
}

interface TokenAggregate {
  /** Cache-inclusive prompt — the `devin:tokens:prompt` meaning. */
  prompt: number | null;
  /** Cache-exclusive input — the `model_usage.inputTokens` payload meaning. */
  input: number | null;
  completion: number | null;
  cached: number | null;
  steps: number | null;
  exact: boolean;
}

function aggregateTokens(
  atif: AtifTranscript | undefined,
  metadata: Record<string, unknown>,
): TokenAggregate {
  if (atif?.finalMetrics) {
    const fromAtif = tokensFromAtif(atif.finalMetrics);
    const exact =
      fromAtif.prompt !== null || fromAtif.completion !== null || fromAtif.cached !== null;
    return { ...fromAtif, exact };
  }
  const fromMeta = tokensFromMetadata(metadata);
  const exact =
    fromMeta.prompt !== null || fromMeta.completion !== null || fromMeta.cached !== null;
  return { ...fromMeta, steps: null, exact };
}

/**
 * A step's metrics are only certified "exact" when every field the payload
 * reports is actually present — a step with `metrics: {}` or any
 * individually-missing field (`AtifStepMetrics` fields are each
 * independently nullable, see the parser) must not be marked exact, per
 * `.agents/rules/missing-is-never-zero.md`'s "exact vs. estimated stays
 * separable" invariant.
 */
function stepMetricsAreExact(metrics: NonNullable<AtifStep['metrics']>): boolean {
  return (
    metrics.promptTokens !== null &&
    metrics.completionTokens !== null &&
    metrics.cachedTokens !== null
  );
}

/**
 * The `effort`/`normalizedEffort` payload fields shared by both the per-step
 * (tier 1) and session-level (tiers 2/3) `model_usage` records — sourced
 * from Devin's model catalog `label` (DS-B31/#290), never from `model_uid`
 * alone (finding 3b). `resolveDevinEffortForModel` already returns
 * `{ raw: null, normalized: null }` for an unresolved model, so this never
 * guesses a tier.
 */
function effortPayloadFields(
  modelUid: string | null,
  models: readonly DevinModelRecord[],
): { effort: string | null; normalizedEffort: string | null } {
  const result = resolveDevinEffortForModel(modelUid, models);
  return { effort: result.raw, normalizedEffort: result.normalized };
}

/** Assembles a usage evidence record, sharing the provenance shape. */
function usageRecord(
  recordType: 'model_usage' | 'model_request',
  recordId: string,
  sessionId: string,
  sourceEventId: string,
  sourceField: string,
  rootArtifactId: string,
  payload: NormalizedEvidenceRecord['payload'],
  parentId?: string,
): NormalizedEvidenceRecord {
  return {
    recordId,
    recordType,
    sessionId,
    parentId,
    sourceEventId,
    sourceField,
    provenance: provenanceForArtifact(rootArtifactId, sourceEventId, sourceField),
    payload,
  };
}

/**
 * Tier 1: one `model_usage` record per ATIF step carrying real `metrics`
 * (`source: "agent"` generation steps only — see `AtifStep` doc comment).
 * `requestOrder` prefers the step's own `stepId`, falling back to its
 * 1-based position in `atif.steps` when `stepId` is absent (older/degenerate
 * ATIF). Steps without `metrics` are skipped, not padded with zeros.
 * Per-step, not per-session: `sourceEventId` independently identifies the
 * step that produced each record (mirrors claude-code-usage.ts's per-turn
 * `entry.uuid` provenance), rather than collapsing to one shared pointer.
 */
function stepUsageRecord(
  sessionId: string,
  step: AtifStep,
  metrics: NonNullable<AtifStep['metrics']>,
  index: number,
  models: readonly DevinModelRecord[],
  rootArtifactId: string,
  parentId?: string,
): NormalizedEvidenceRecord {
  const requestOrder = step.stepId ?? index + 1;
  // `sourceEventId` and `payload.requestId` both key off the canonical
  // `sessionId` parameter (not `session?.id`, which may legitimately differ
  // or be absent) so the two stay consistent with each other.
  const sourceEventId = `${sessionId}:step:${requestOrder}`;
  const payload = {
    requestOrder,
    requestId: `${sessionId}:step:${requestOrder}`,
    model: resolveModelId(step.generationModel, models),
    provider: 'unknown',
    // ATIF `promptTokens` INCLUDES its cached subset; the shared payload
    // contract is cache-EXCLUSIVE `inputTokens`, so subtract the reported
    // cache reads (see `cacheExclusiveInput`).
    inputTokens: cacheExclusiveInput(metrics.promptTokens, metrics.cachedTokens),
    outputTokens: metrics.completionTokens,
    cacheCreationTokens: null,
    cacheReadTokens: metrics.cachedTokens,
    tokenValuesExact: stepMetricsAreExact(metrics),
    cost: null,
    costExact: false,
    ...effortPayloadFields(step.generationModel, models),
  };
  const recordId = stableId('model_usage', { session: sessionId, step: requestOrder });
  return usageRecord(
    'model_usage',
    recordId,
    sessionId,
    sourceEventId,
    'atif_step',
    rootArtifactId,
    payload,
    parentId,
  );
}

function buildStepRecords(
  sessionId: string,
  steps: readonly AtifStep[],
  models: readonly DevinModelRecord[],
  rootArtifactId: string,
  orderedMessages: readonly DevinMessageLine[],
): NormalizedEvidenceRecord[] {
  const records: NormalizedEvidenceRecord[] = [];
  steps.forEach((step, index) => {
    if (!step.metrics) return;
    // Link the model_usage record to the corresponding turn via parentId so
    // the context-timing computation (resolveMessageRequest → byTurn) can
    // attribute the step's token usage to the right message. ATIF steps are
    // in the same conversation order as orderedMessages (both represent the
    // main-chain sequence), so step `index` maps to orderedMessages[index].
    const message = orderedMessages[index];
    const parentId = message
      ? stableId('turn', { session: sessionId, nodeId: message.nodeId })
      : undefined;
    records.push(
      stepUsageRecord(sessionId, step, step.metrics, index, models, rootArtifactId, parentId),
    );
  });
  return records;
}

/**
 * Tiers 3/4: the single session-level aggregate record. Used only when
 * neither per-ATIF-step metrics nor per-message metrics are available.
 *
 * This record is deliberately NOT parented to a turn AND carries no
 * `requestOrder`. It holds whole-session cumulative totals, so binding it to
 * any single message — via a turn `parentId` (as an earlier fix did,
 * linking it to the first turn) or via the context-timing computation's
 * `byOrder` fallback (which binds `requestOrder: 1` to message #1) —
 * attributes the entire session's context volume, often tens of millions of
 * tokens, to message #1 and fabricates a matching compaction on message #2.
 * Session totals are surfaced through `TokenUsageResult`/metric values,
 * which cite this record by id; the context chart falls back to
 * `numTokensPreceding` checkpoints instead.
 */
function sessionLevelRecord(
  sessionId: string,
  session: DevinSessionLine | undefined,
  models: readonly DevinModelRecord[],
  rootArtifactId: string,
  aggregate: TokenAggregate,
): NormalizedEvidenceRecord {
  const sourceEventId = session?.id ?? 'unknown';
  const resolvedModel = resolveModel(session, models);
  const payload = {
    // No `requestOrder`: this is a session-scoped aggregate, not a message
    // request. A numeric order would make the context-timing computation's
    // `byOrder` fallback bind the whole-session total to whichever message
    // holds that ordinal (message #1 for `1`) even without a `parentId`.
    requestId: sourceEventId,
    model: resolvedModel,
    provider: 'unknown',
    // Cache-exclusive input, matching the shared `inputTokens` contract
    // (Devin's `input_tokens` uid already excludes cache reads; `prompt`
    // above is the cache-inclusive metric meaning).
    inputTokens: aggregate.input,
    outputTokens: aggregate.completion,
    cacheCreationTokens: null,
    cacheReadTokens: aggregate.cached,
    tokenValuesExact: aggregate.exact,
    cost: null,
    costExact: false,
    ...effortPayloadFields(resolvedModel, models),
  };
  const recordId = stableId('model_usage', { session: sessionId });
  return usageRecord(
    'model_usage',
    recordId,
    sessionId,
    sourceEventId,
    'final_metrics',
    rootArtifactId,
    payload,
  );
}

/**
 * Tier 2: one `model_request` record per `message_nodes` row that carries its
 * own per-request usage (`chat_message.metadata.metrics` + `request_id` +
 * `generation_model`, parsed onto `DevinMessageLine.chatUsage`). This is the
 * richest source on transcript-only bundles (no ATIF), and unlike the
 * session aggregate it is genuinely per-message: each record is parented to
 * its own turn and its values are that request's, never cumulative.
 *
 * Typed `model_request` (not `model_usage`) deliberately: the per-message
 * `chat_message.metadata.metrics` sums do not exactly equal the harness's own
 * cumulative `response_dimensions` session total, so they must not enter the
 * `model_usage` set that `devin:tokens:total` is reconciled against. The
 * session aggregate stays a single `model_usage` record (below) for the token
 * identity; these `model_request` records feed the context-growth computation
 * only (it accepts both types).
 *
 * `requestOrder` is the message's 1-based ordinal in `orderedMessages` —
 * the exact ordinal `buildSessionSpine` assigns that message's turn — so
 * `resolveMessageRequest` resolves it via both `byTurn` and `byOrder`.
 * Messages whose metrics bag is present but entirely null are skipped (no
 * fabricated zero-usage request, per `missing-is-never-zero`).
 */
function buildMessageUsageRecords(
  sessionId: string,
  orderedMessages: readonly DevinMessageLine[],
  models: readonly DevinModelRecord[],
  rootArtifactId: string,
): NormalizedEvidenceRecord[] {
  const records: NormalizedEvidenceRecord[] = [];
  orderedMessages.forEach((message, index) => {
    const usage = message.chatUsage;
    if (!usage) return;
    const hasAnyToken =
      usage.inputTokens !== null ||
      usage.outputTokens !== null ||
      usage.cacheReadTokens !== null ||
      usage.cacheCreationTokens !== null;
    if (!hasAnyToken) return;
    const requestOrder = index + 1;
    // Prefer the harness's own request id for provenance; fall back to a
    // node-scoped id (never the bare session id, which would collide with
    // the session-level aggregate record).
    const sourceEventId = usage.requestId ?? `${sessionId}:msg:${message.nodeId}`;
    const resolvedModel = resolveModelId(usage.generationModel, models);
    const payload = {
      requestOrder,
      requestId: sourceEventId,
      model: resolvedModel,
      provider: 'unknown',
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheCreationTokens: usage.cacheCreationTokens,
      cacheReadTokens: usage.cacheReadTokens,
      // Exact only when both the prompt and completion sides were reported
      // (`cache_*` fields are independently nullable), mirroring
      // `stepMetricsAreExact`.
      tokenValuesExact: usage.inputTokens !== null && usage.outputTokens !== null,
      cost: null,
      costExact: false,
      ...effortPayloadFields(usage.generationModel, models),
    };
    const recordId = stableId('model_request', {
      session: sessionId,
      msgId: message.nodeId,
    });
    records.push(
      usageRecord(
        'model_request',
        recordId,
        sessionId,
        sourceEventId,
        'chat_message.metrics',
        rootArtifactId,
        payload,
        stableId('turn', { session: sessionId, nodeId: message.nodeId }),
      ),
    );
  });
  return records;
}

/**
 * Four-tier fallback (richest available source wins), per DS-B25's
 * per-turn-model-attribution fix:
 * 1. Per-ATIF-step `model_usage` records when at least one step carries
 *    real `metrics` (a genuine agent-generation step) — attributes usage to
 *    the model that actually generated each turn instead of collapsing the
 *    whole session onto whichever model happened to be active last.
 * 2. Per-message `model_request` records from `chat_message.metadata.metrics`
 *    when no ATIF step carries metrics — transcript-only bundles still get
 *    genuine per-request attribution (each record parented to its own
 *    turn), instead of one cumulative session total.
 * 3. `atif.finalMetrics`-only aggregate when `atif` is present but no step
 *    has usable `metrics` (degenerate/older-schema ATIF).
 * 4. `session.metadata.response_dimensions`-based aggregate when `atif` is
 *    absent and no message carries metrics.
 *
 * When tier 2 applies, its per-message `model_request` records are emitted
 * ALONGSIDE the single `model_usage` session aggregate (not instead of it):
 * the aggregate keeps `devin:tokens:*`'s provenance and token identity
 * pointing at the harness-reported cumulative totals, while the per-request
 * records feed the context-growth chart.
 *
 * The top-level aggregate fields (`prompt`/`completion`/`cached`/`total`/
 * `steps`/`exact`) are unchanged across all tiers — they still source from
 * `atif.finalMetrics` whenever `atif` is present, regardless of which tier
 * populates `records[]`. The single aggregate record is intentionally never
 * parented to a turn and carries no `requestOrder` (see
 * `sessionLevelRecord`).
 */
export function buildTokenUsageRecords(
  sessionId: string,
  session: DevinSessionLine | undefined,
  atif: AtifTranscript | undefined,
  models: readonly DevinModelRecord[],
  rootArtifactId: string,
  orderedMessages: readonly DevinMessageLine[],
): TokenUsageResult {
  const metadata = parseMetadata(session?.metadata ?? null);
  const aggregate = aggregateTokens(atif, metadata);
  const total = totalFromParts(aggregate.prompt, aggregate.completion);

  const stepRecords = atif
    ? buildStepRecords(sessionId, atif.steps, models, rootArtifactId, orderedMessages)
    : [];
  // Tier 2 runs only when tier 1 produced nothing; it is the richest
  // per-message source on transcript-only bundles.
  const messageRecords =
    stepRecords.length > 0
      ? []
      : buildMessageUsageRecords(sessionId, orderedMessages, models, rootArtifactId);
  const aggregateRecord = sessionLevelRecord(sessionId, session, models, rootArtifactId, aggregate);
  const records =
    stepRecords.length > 0
      ? stepRecords
      : messageRecords.length > 0
        ? [...messageRecords, aggregateRecord]
        : [aggregateRecord];

  return {
    records,
    prompt: aggregate.prompt,
    completion: aggregate.completion,
    cached: aggregate.cached,
    total,
    steps: aggregate.steps,
    exact: aggregate.exact,
  };
}
