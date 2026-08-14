/**
 * Sums `message.usage` across every assistant entry into
 * `ClaudeCodeSession['aggregateUsage']` — spec §1.1.
 *
 * See spec: docs/superpowers/specs/2026-08-12-claude-session-parser-design.md
 */

import type { ClaudeCodeEntry, ClaudeCodeSession } from '../types/session.js';

function numOr0(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

export function accumulateUsage(entries: ClaudeCodeEntry[]): ClaudeCodeSession['aggregateUsage'] {
  const totals: ClaudeCodeSession['aggregateUsage'] = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    models: {},
  };

  for (const entry of entries) {
    // The `'message' in entry` check (beyond `entry.type === 'assistant'`)
    // is required for TypeScript to actually narrow `entry` to
    // `AssistantEntry`: `UnknownEntry.type` is typed as plain `string`, so
    // it structurally overlaps every literal type in the union, including
    // `'assistant'` — the equality check alone can't rule it out.
    if (entry.type !== 'assistant' || !('message' in entry)) continue;
    const usage = entry.message?.usage;
    if (!usage) continue;

    // CRITICAL: usage.iterations[] (per-iteration usage on interleaved-
    // thinking retries) OVERLAPS these top-level fields — it must NEVER be
    // additionally summed here, that would double-count. The top-level
    // fields already represent the assistant entry's full usage view
    // (confirmed real, 21k+ occurrences corpus-wide; see the doc comment on
    // AssistantEntry.message.usage.iterations in types/session.ts and spec
    // §1.2/§5). Do not "fix" this by adding an iterations loop below.
    const inputTokens = numOr0(usage.input_tokens);
    const outputTokens = numOr0(usage.output_tokens);
    const cacheCreationTokens = numOr0(usage.cache_creation_input_tokens);
    const cacheReadTokens = numOr0(usage.cache_read_input_tokens);

    totals.inputTokens += inputTokens;
    totals.outputTokens += outputTokens;
    totals.cacheCreationTokens += cacheCreationTokens;
    totals.cacheReadTokens += cacheReadTokens;

    const model = entry.message?.model;
    if (typeof model === 'string' && model.length > 0) {
      // Assistant entries with no `model` still contribute to the top-level
      // totals above, but are intentionally NOT bucketed under `models`
      // (there is no key to bucket them under) — this is the documented
      // decision for how such entries are keyed (they simply aren't).
      const bucket = totals.models[model] ?? {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      };
      bucket.inputTokens += inputTokens;
      bucket.outputTokens += outputTokens;
      bucket.cacheCreationTokens += cacheCreationTokens;
      bucket.cacheReadTokens += cacheReadTokens;
      totals.models[model] = bucket;
    }
  }

  return totals;
}
