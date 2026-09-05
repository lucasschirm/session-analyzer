import type {
  AtifFinalMetrics,
  AtifStep,
  AtifTranscript,
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

/** The pre-#322 flat-key probe, kept only as a fallback for unobserved shapes. */
function sumFlatKeyDimensions(dimensions: unknown[]): {
  prompt: number | null;
  completion: number | null;
  cached: number | null;
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
  return any ? { prompt, completion, cached } : { prompt: null, completion: null, cached: null };
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
} {
  const uid = sumUidDimensions(dimensions);
  if (uid.input === null && uid.output === null && uid.cachedInput === null) {
    return sumFlatKeyDimensions(dimensions);
  }
  const prompt =
    uid.input !== null ? uid.input + (uid.cachedInput ?? 0) : (uid.cachedInput ?? null);
  return { prompt, completion: uid.output, cached: uid.cachedInput };
}

function tokensFromAtif(finalMetrics: AtifFinalMetrics): {
  prompt: number | null;
  completion: number | null;
  cached: number | null;
  steps: number | null;
} {
  return {
    prompt: finalMetrics.totalPromptTokens,
    completion: finalMetrics.totalCompletionTokens,
    cached: finalMetrics.totalCachedTokens,
    steps: finalMetrics.totalSteps,
  };
}

function tokensFromMetadata(metadata: Record<string, unknown>): {
  prompt: number | null;
  completion: number | null;
  cached: number | null;
} {
  const responseDimensions = metadata.response_dimensions;
  if (Array.isArray(responseDimensions) && responseDimensions.length > 0) {
    return sumResponseDimensions(responseDimensions);
  }
  return { prompt: null, completion: null, cached: null };
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
  prompt: number | null;
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

/** Assembles a `model_usage` evidence record, sharing the provenance shape. */
function usageRecord(
  recordId: string,
  sessionId: string,
  sourceEventId: string,
  sourceField: string,
  rootArtifactId: string,
  payload: NormalizedEvidenceRecord['payload'],
): NormalizedEvidenceRecord {
  return {
    recordId,
    recordType: 'model_usage',
    sessionId,
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
    inputTokens: metrics.promptTokens,
    outputTokens: metrics.completionTokens,
    cacheCreationTokens: null,
    cacheReadTokens: metrics.cachedTokens,
    tokenValuesExact: stepMetricsAreExact(metrics),
    cost: null,
    costExact: false,
    ...effortPayloadFields(step.generationModel, models),
  };
  const recordId = stableId('model_usage', { session: sessionId, step: requestOrder });
  return usageRecord(recordId, sessionId, sourceEventId, 'atif_step', rootArtifactId, payload);
}

function buildStepRecords(
  sessionId: string,
  steps: readonly AtifStep[],
  models: readonly DevinModelRecord[],
  rootArtifactId: string,
): NormalizedEvidenceRecord[] {
  const records: NormalizedEvidenceRecord[] = [];
  steps.forEach((step, index) => {
    if (!step.metrics) return;
    records.push(stepUsageRecord(sessionId, step, step.metrics, index, models, rootArtifactId));
  });
  return records;
}

/** Tiers 2/3: a single session-level aggregate record (unchanged behavior). */
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
    requestOrder: 1,
    requestId: sourceEventId,
    model: resolvedModel,
    provider: 'unknown',
    inputTokens: aggregate.prompt,
    outputTokens: aggregate.completion,
    cacheCreationTokens: null,
    cacheReadTokens: aggregate.cached,
    tokenValuesExact: aggregate.exact,
    cost: null,
    costExact: false,
    ...effortPayloadFields(resolvedModel, models),
  };
  const recordId = stableId('model_usage', { session: sessionId });
  return usageRecord(recordId, sessionId, sourceEventId, 'final_metrics', rootArtifactId, payload);
}

/**
 * Three-tier fallback (richest available source wins), per DS-B25's
 * per-turn-model-attribution fix:
 * 1. Per-ATIF-step `model_usage` records when at least one step carries
 *    real `metrics` (a genuine agent-generation step) — attributes usage to
 *    the model that actually generated each turn instead of collapsing the
 *    whole session onto whichever model happened to be active last.
 * 2. `atif.finalMetrics`-only aggregate when `atif` is present but no step
 *    has usable `metrics` (degenerate/older-schema ATIF).
 * 3. `session.metadata.response_dimensions`-based aggregate when `atif` is
 *    absent entirely.
 *
 * The top-level aggregate fields (`prompt`/`completion`/`cached`/`total`/
 * `steps`/`exact`) are unchanged across all three tiers — they still source
 * from `atif.finalMetrics` whenever `atif` is present, regardless of which
 * tier populates `records[]`.
 */
export function buildTokenUsageRecords(
  sessionId: string,
  session: DevinSessionLine | undefined,
  atif: AtifTranscript | undefined,
  models: readonly DevinModelRecord[],
  rootArtifactId: string,
): TokenUsageResult {
  const metadata = parseMetadata(session?.metadata ?? null);
  const aggregate = aggregateTokens(atif, metadata);
  const total = totalFromParts(aggregate.prompt, aggregate.completion);

  const stepRecords = atif ? buildStepRecords(sessionId, atif.steps, models, rootArtifactId) : [];
  const records =
    stepRecords.length > 0
      ? stepRecords
      : [sessionLevelRecord(sessionId, session, models, rootArtifactId, aggregate)];

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
