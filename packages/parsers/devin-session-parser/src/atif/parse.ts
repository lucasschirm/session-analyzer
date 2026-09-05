/**
 * Parses ATIF (Agent Transcript Interchange Format) v1.7 native transcript
 * JSON (`native/atif-transcript.json`) into a typed structure: per-step
 * RFC3339 timestamps, `agent.model_name`, and `final_metrics` — pruned to
 * text turns only.
 *
 * `final_metrics` fields are individually optional upstream: any absent
 * field surfaces as `null` here, never `0` (`missing-is-never-zero`).
 */

export const ATIF_SCHEMA_VERSION = 'ATIF-v1.7';

export interface AtifStepMetrics {
  promptTokens: number | null;
  completionTokens: number | null;
  cachedTokens: number | null;
}

export interface AtifStep {
  /** RFC3339 timestamp; `null` when absent or not RFC3339-shaped. */
  timestamp: string | null;
  role: string | null;
  text: string | null;
  /** `raw.step_id`; `null` when absent, for stable per-step ordering. */
  stepId: number | null;
  /** `raw.extra.generation_model` — the trustworthy per-step model signal
   * (unlike `AtifTranscript.agentModelName`, which is agent-level/current-state
   * and unreliable per step); `null` when `extra` is absent/non-object or the
   * field isn't a string. */
  generationModel: string | null;
  /** `raw.metrics`; `null` (not per-field-zeroed) when the whole object is
   * absent — present only on `source: "agent"` steps upstream. */
  metrics: AtifStepMetrics | null;
}

export interface AtifFinalMetrics {
  totalPromptTokens: number | null;
  totalCompletionTokens: number | null;
  totalCachedTokens: number | null;
  totalSteps: number | null;
}

export interface AtifTranscript {
  schemaVersion: typeof ATIF_SCHEMA_VERSION;
  agentModelName: string | null;
  steps: AtifStep[];
  finalMetrics: AtifFinalMetrics;
}

export type ParseAtifResult =
  | { ok: true; transcript: AtifTranscript }
  | { ok: false; reason: string };

// RFC3339: YYYY-MM-DDTHH:MM:SS[.frac](Z|+HH:MM|-HH:MM) — a pragmatic, not
// fully exhaustive, validity check (never throws on a non-match).
const RFC3339_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function isRfc3339(value: unknown): value is string {
  return typeof value === 'string' && RFC3339_PATTERN.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalNumber(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function parseStepMetrics(raw: unknown): AtifStepMetrics | null {
  if (!isRecord(raw)) return null;
  return {
    promptTokens: optionalNumber(raw, 'prompt_tokens'),
    completionTokens: optionalNumber(raw, 'completion_tokens'),
    cachedTokens: optionalNumber(raw, 'cached_tokens'),
  };
}

function parseStepGenerationModel(raw: unknown): string | null {
  if (!isRecord(raw) || !isRecord(raw.extra)) return null;
  return typeof raw.extra.generation_model === 'string' ? raw.extra.generation_model : null;
}

function parseStepId(raw: Record<string, unknown>): number | null {
  return typeof raw.step_id === 'number' && Number.isFinite(raw.step_id) ? raw.step_id : null;
}

function parseStep(raw: unknown): AtifStep {
  if (!isRecord(raw)) {
    return {
      timestamp: null,
      role: null,
      text: null,
      stepId: null,
      generationModel: null,
      metrics: null,
    };
  }
  return {
    timestamp: isRfc3339(raw.timestamp) ? raw.timestamp : null,
    role: typeof raw.role === 'string' ? raw.role : null,
    text: typeof raw.text === 'string' ? raw.text : null,
    stepId: parseStepId(raw),
    generationModel: parseStepGenerationModel(raw),
    metrics: parseStepMetrics(raw.metrics),
  };
}

function parseFinalMetrics(raw: unknown): AtifFinalMetrics {
  const record = isRecord(raw) ? raw : {};
  return {
    totalPromptTokens: optionalNumber(record, 'total_prompt_tokens'),
    totalCompletionTokens: optionalNumber(record, 'total_completion_tokens'),
    totalCachedTokens: optionalNumber(record, 'total_cached_tokens'),
    totalSteps: optionalNumber(record, 'total_steps'),
  };
}

function parseAgentModelName(raw: unknown): string | null {
  if (!isRecord(raw)) return null;
  return typeof raw.model_name === 'string' ? raw.model_name : null;
}

/**
 * Validates and parses an ATIF v1.7 transcript. Returns `{ ok: false }`
 * (never throws) when `schema_version` is missing or not `"ATIF-v1.7"`, or
 * when the input isn't a JSON object at all.
 */
export function parseAtifTranscript(input: unknown): ParseAtifResult {
  if (!isRecord(input)) {
    return { ok: false, reason: 'input is not a JSON object' };
  }
  if (input.schema_version !== ATIF_SCHEMA_VERSION) {
    return { ok: false, reason: `unsupported schema_version ${String(input.schema_version)}` };
  }
  const steps = Array.isArray(input.steps) ? input.steps.map(parseStep) : [];
  return {
    ok: true,
    transcript: {
      schemaVersion: ATIF_SCHEMA_VERSION,
      agentModelName: parseAgentModelName(input.agent),
      steps,
      finalMetrics: parseFinalMetrics(input.final_metrics),
    },
  };
}
