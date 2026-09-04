import type {
  AtifFinalMetrics,
  AtifStep,
  AtifTranscript,
  DevinModelRecord,
  DevinSessionLine,
} from '@lucasschirm/sal-devin-session-parser';
import type { NormalizedEvidenceRecord } from '@lucasschirm/sal-transformer-shared';
import { stableId } from './session-spine.js';

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

function sumResponseDimensions(dimensions: unknown[]): {
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

function totalFromParts(
  prompt: number | null,
  completion: number | null,
  cached: number | null,
): number | null {
  return prompt !== null && completion !== null && cached !== null
    ? prompt + completion + cached
    : null;
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
 * Tier 1: one `model_usage` record per ATIF step carrying real `metrics`
 * (`source: "agent"` generation steps only — see `AtifStep` doc comment).
 * `requestOrder` prefers the step's own `stepId`, falling back to its
 * 1-based position in `atif.steps` when `stepId` is absent (older/degenerate
 * ATIF). Steps without `metrics` are skipped, not padded with zeros.
 */
function stepUsageRecord(
  sessionId: string,
  session: DevinSessionLine | undefined,
  step: AtifStep,
  metrics: NonNullable<AtifStep['metrics']>,
  index: number,
  models: readonly DevinModelRecord[],
  rootArtifactId: string,
): NormalizedEvidenceRecord {
  const requestOrder = step.stepId ?? index + 1;
  return {
    recordId: stableId('model_usage', { session: sessionId, step: requestOrder }),
    recordType: 'model_usage',
    sessionId,
    sourceEventId: session?.id ?? 'unknown',
    sourceField: 'atif_step',
    provenance: {
      artifactId: rootArtifactId,
      sourceEventId: session?.id ?? 'unknown',
      sourceField: 'atif_step',
      path: rootArtifactId,
    },
    payload: {
      requestOrder,
      requestId: `${sessionId}:step:${requestOrder}`,
      model: resolveModelId(step.generationModel, models),
      provider: 'unknown',
      inputTokens: metrics.promptTokens,
      outputTokens: metrics.completionTokens,
      cacheCreationTokens: null,
      cacheReadTokens: metrics.cachedTokens,
      tokenValuesExact: true,
      cost: null,
      costExact: false,
    },
  };
}

function buildStepRecords(
  sessionId: string,
  session: DevinSessionLine | undefined,
  steps: readonly AtifStep[],
  models: readonly DevinModelRecord[],
  rootArtifactId: string,
): NormalizedEvidenceRecord[] {
  const records: NormalizedEvidenceRecord[] = [];
  steps.forEach((step, index) => {
    if (!step.metrics) return;
    records.push(
      stepUsageRecord(sessionId, session, step, step.metrics, index, models, rootArtifactId),
    );
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
  return {
    recordId: stableId('model_usage', { session: sessionId }),
    recordType: 'model_usage',
    sessionId,
    sourceEventId: session?.id ?? 'unknown',
    sourceField: 'final_metrics',
    provenance: {
      artifactId: rootArtifactId,
      sourceEventId: session?.id ?? 'unknown',
      sourceField: 'final_metrics',
      path: rootArtifactId,
    },
    payload: {
      requestOrder: 1,
      requestId: session?.id ?? 'unknown',
      model: resolveModel(session, models),
      provider: 'unknown',
      inputTokens: aggregate.prompt,
      outputTokens: aggregate.completion,
      cacheCreationTokens: null,
      cacheReadTokens: aggregate.cached,
      tokenValuesExact: aggregate.exact,
      cost: null,
      costExact: false,
    },
  };
}

/**
 * Three-tier fallback (richest available source wins), per DS-B27's
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
  const total = totalFromParts(aggregate.prompt, aggregate.completion, aggregate.cached);

  const stepRecords = atif
    ? buildStepRecords(sessionId, session, atif.steps, models, rootArtifactId)
    : [];
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
