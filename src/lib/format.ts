/**
 * Number formatting helpers.
 *
 * Large token counts (real Claude Code sessions routinely process billions
 * of cumulative tokens once repeated cache reads are counted) are rendered
 * compactly; the exact figure is always available via a tooltip.
 */

/** "1,357,717,861" -> "1.4B", "1,357,717" -> "1.4M", "999,999" -> "999,999". */
export function formatCompactNumber(value: number): string {
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);

  if (abs >= 1_000_000_000) return `${sign}${trimTrailingZero((abs / 1_000_000_000).toFixed(1))}B`;
  if (abs >= 1_000_000) return `${sign}${trimTrailingZero((abs / 1_000_000).toFixed(1))}M`;
  return value.toLocaleString();
}

function trimTrailingZero(value: string): string {
  return value.endsWith('.0') ? value.slice(0, -2) : value;
}

/** Full comma-grouped number, meant for a hover tooltip alongside the compact display. */
export function formatFullNumber(value: number): string {
  return value.toLocaleString();
}

/** Milliseconds -> "2h 15m" / "3m 20s" / "45s", for durations like avg. time per task. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s';

  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/**
 * Rough token-count estimate for arbitrary text, when no exact `usage`-object
 * figure is available (e.g. tool_result content, which Claude Code never
 * reports token counts for individually). Uses the commonly-cited ~4
 * characters-per-token heuristic for English/code text - not a real
 * tokenizer, and deliberately not meant to be pixel-accurate against the
 * `usage` object's exact input/output/cache figures. Callers must label
 * anything built from this as an estimate (e.g. "~12.3K tokens (est.)") so
 * it's never confused with the exact figures elsewhere on the page.
 */
export function estimateTokenCount(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/** "1357717" -> "~1.4M tokens (est.)", the standard label for estimated token counts. */
export function formatEstimatedTokens(count: number): string {
  return `~${formatCompactNumber(count)} tokens (est.)`;
}
