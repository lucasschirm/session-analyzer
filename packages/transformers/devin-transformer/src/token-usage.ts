import type {
  AtifFinalMetrics,
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

function resolveModel(
  session: DevinSessionLine | undefined,
  models: readonly DevinModelRecord[],
): string {
  const model = session?.model;
  if (!model) return 'unknown';
  const match = models.find(
    (m) => m.modelUid === model || m.label.toLowerCase() === model.toLowerCase(),
  );
  return match ? match.modelUid : model;
}

export function buildTokenUsageRecords(
  sessionId: string,
  session: DevinSessionLine | undefined,
  atif: AtifTranscript | undefined,
  models: readonly DevinModelRecord[],
  rootArtifactId: string,
): TokenUsageResult {
  const metadata = parseMetadata(session?.metadata ?? null);

  let prompt: number | null = null;
  let completion: number | null = null;
  let cached: number | null = null;
  let steps: number | null = null;
  let exact = false;

  if (atif?.finalMetrics) {
    const fromAtif = tokensFromAtif(atif.finalMetrics);
    prompt = fromAtif.prompt;
    completion = fromAtif.completion;
    cached = fromAtif.cached;
    steps = fromAtif.steps;
    exact = prompt !== null || completion !== null || cached !== null;
  } else {
    const fromMeta = tokensFromMetadata(metadata);
    prompt = fromMeta.prompt;
    completion = fromMeta.completion;
    cached = fromMeta.cached;
    exact = prompt !== null || completion !== null || cached !== null;
  }

  const total: number | null =
    prompt !== null && completion !== null && cached !== null ? prompt + completion + cached : null;

  const model = resolveModel(session, models);
  const provider = 'unknown';

  const records: NormalizedEvidenceRecord[] = [
    {
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
        model,
        provider,
        inputTokens: prompt,
        outputTokens: completion,
        cacheCreationTokens: null,
        cacheReadTokens: cached,
        tokenValuesExact: exact,
        cost: null,
        costExact: false,
      },
    },
  ];

  return { records, prompt, completion, cached, total, steps, exact };
}
