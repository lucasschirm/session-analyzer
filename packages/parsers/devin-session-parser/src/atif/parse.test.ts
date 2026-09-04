import { describe, expect, it } from 'vitest';
import { parseAtifTranscript } from './parse.js';

function baseTranscript(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 'ATIF-v1.7',
    agent: { model_name: 'devin-model-1' },
    steps: [{ timestamp: '2026-01-01T00:00:00Z', role: 'assistant', text: 'hi' }],
    final_metrics: {
      total_prompt_tokens: 100,
      total_completion_tokens: 50,
      total_cached_tokens: 10,
      total_steps: 3,
    },
    ...overrides,
  };
}

describe('parseAtifTranscript — schema_version', () => {
  it('accepts ATIF-v1.7', () => {
    const result = parseAtifTranscript(baseTranscript());
    expect(result.ok).toBe(true);
  });

  it('rejects a missing schema_version without throwing', () => {
    const { schema_version: _schemaVersion, ...rest } = baseTranscript();
    expect(() => parseAtifTranscript(rest)).not.toThrow();
    expect(parseAtifTranscript(rest).ok).toBe(false);
  });

  it('rejects a mismatched schema_version', () => {
    const result = parseAtifTranscript(baseTranscript({ schema_version: 'ATIF-v2.0' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('ATIF-v2.0');
  });

  it('rejects non-object input without throwing', () => {
    expect(() => parseAtifTranscript(null)).not.toThrow();
    expect(parseAtifTranscript(null).ok).toBe(false);
    expect(parseAtifTranscript('a string').ok).toBe(false);
  });
});

describe('parseAtifTranscript — steps', () => {
  it('parses per-step RFC3339 timestamps', () => {
    const result = parseAtifTranscript(baseTranscript());
    if (!result.ok) throw new Error('expected ok');
    expect(result.transcript.steps[0].timestamp).toBe('2026-01-01T00:00:00Z');
  });

  it('nulls a non-RFC3339 timestamp rather than throwing', () => {
    const result = parseAtifTranscript(
      baseTranscript({ steps: [{ timestamp: 'not-a-date', role: 'assistant', text: 'hi' }] }),
    );
    if (!result.ok) throw new Error('expected ok');
    expect(result.transcript.steps[0].timestamp).toBeNull();
  });

  it('defaults to an empty steps array when steps is absent', () => {
    const { steps: _steps, ...rest } = baseTranscript();
    const result = parseAtifTranscript(rest);
    if (!result.ok) throw new Error('expected ok');
    expect(result.transcript.steps).toEqual([]);
  });
});

describe('parseAtifTranscript — steps — stepId/generationModel/metrics', () => {
  it('extracts stepId, generationModel, and metrics from a real agent-shaped step', () => {
    const result = parseAtifTranscript(
      baseTranscript({
        steps: [
          {
            step_id: 9,
            source: 'agent',
            model_name: 'SWE-1.7 Max',
            metrics: { prompt_tokens: 18071, completion_tokens: 59, cached_tokens: 11874 },
            extra: {
              generation_model: 'glm-5-2',
              telemetry: { source: 'assistant', operation: 'inference' },
            },
          },
        ],
      }),
    );
    if (!result.ok) throw new Error('expected ok');
    expect(result.transcript.steps[0]).toMatchObject({
      stepId: 9,
      generationModel: 'glm-5-2',
      metrics: { promptTokens: 18071, completionTokens: 59, cachedTokens: 11874 },
    });
  });

  it('nulls stepId, generationModel, and metrics on a system/user-shaped step', () => {
    const result = parseAtifTranscript(
      baseTranscript({
        steps: [{ step_id: 1, source: 'user', timestamp: '2026-01-01T00:00:00Z' }],
      }),
    );
    if (!result.ok) throw new Error('expected ok');
    expect(result.transcript.steps[0].generationModel).toBeNull();
    expect(result.transcript.steps[0].metrics).toBeNull();
    expect(result.transcript.steps[0].stepId).toBe(1);
  });

  it('nulls generationModel when extra is absent or not an object', () => {
    const missingExtra = parseAtifTranscript(baseTranscript({ steps: [{ step_id: 1 }] }));
    const nonObjectExtra = parseAtifTranscript(
      baseTranscript({ steps: [{ step_id: 1, extra: 'not-an-object' }] }),
    );
    if (!missingExtra.ok || !nonObjectExtra.ok) throw new Error('expected ok');
    expect(missingExtra.transcript.steps[0].generationModel).toBeNull();
    expect(nonObjectExtra.transcript.steps[0].generationModel).toBeNull();
  });

  it('nulls individually-missing metrics fields rather than zeroing them', () => {
    const result = parseAtifTranscript(
      baseTranscript({ steps: [{ step_id: 1, metrics: { prompt_tokens: 5 } }] }),
    );
    if (!result.ok) throw new Error('expected ok');
    expect(result.transcript.steps[0].metrics).toEqual({
      promptTokens: 5,
      completionTokens: null,
      cachedTokens: null,
    });
  });

  it('nulls stepId when step_id is absent or non-numeric', () => {
    const result = parseAtifTranscript(baseTranscript({ steps: [{ step_id: 'nine' }] }));
    if (!result.ok) throw new Error('expected ok');
    expect(result.transcript.steps[0].stepId).toBeNull();
  });
});

describe('parseAtifTranscript — agent.model_name', () => {
  it('extracts agent.model_name', () => {
    const result = parseAtifTranscript(baseTranscript());
    if (!result.ok) throw new Error('expected ok');
    expect(result.transcript.agentModelName).toBe('devin-model-1');
  });

  it('nulls agentModelName when agent is absent', () => {
    const { agent: _agent, ...rest } = baseTranscript();
    const result = parseAtifTranscript(rest);
    if (!result.ok) throw new Error('expected ok');
    expect(result.transcript.agentModelName).toBeNull();
  });
});

describe('parseAtifTranscript — final_metrics', () => {
  it('parses all four fields when present', () => {
    const result = parseAtifTranscript(baseTranscript());
    if (!result.ok) throw new Error('expected ok');
    expect(result.transcript.finalMetrics).toEqual({
      totalPromptTokens: 100,
      totalCompletionTokens: 50,
      totalCachedTokens: 10,
      totalSteps: 3,
    });
  });

  it('surfaces absent fields as null, never 0, when one or more are missing', () => {
    const result = parseAtifTranscript(
      baseTranscript({ final_metrics: { total_prompt_tokens: 100 } }),
    );
    if (!result.ok) throw new Error('expected ok');
    expect(result.transcript.finalMetrics).toEqual({
      totalPromptTokens: 100,
      totalCompletionTokens: null,
      totalCachedTokens: null,
      totalSteps: null,
    });
  });

  it('surfaces all fields as null when final_metrics is entirely absent', () => {
    const { final_metrics: _finalMetrics, ...rest } = baseTranscript();
    const result = parseAtifTranscript(rest);
    if (!result.ok) throw new Error('expected ok');
    expect(result.transcript.finalMetrics).toEqual({
      totalPromptTokens: null,
      totalCompletionTokens: null,
      totalCachedTokens: null,
      totalSteps: null,
    });
  });
});
