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

/** "0.42" -> "42%", "1" -> "100%". Rounds to the nearest whole percent. */
export function formatPercent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

/** Module-level `Intl` formatter singletons — constructing one per call
 * (the `toLocaleString`/`toLocaleDateString` default) is measurably wasteful
 * on a list rendered per row (e.g. the portfolio project leaderboard). */
const wholeNumberFormatter = new Intl.NumberFormat(undefined);
const shortDateFormatter = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });

/** "1234.5" -> "$1,235" (whole-dollar, comma-grouped). `formatChartValue`
 * (chart-types.ts) handles the compact "$1.2K" form for chart axes/tooltips;
 * this is the plain form for stat tiles and tables. */
export function formatCurrency(value: number): string {
  return `$${wholeNumberFormatter.format(Math.round(value))}`;
}

/** ISO timestamp -> "Sep 2" (no year) for compact "last active" columns. */
export function formatShortDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return shortDateFormatter.format(date);
}

/** Epoch ms -> "just now" / "3m ago" / "2h ago" / "5d ago", for the Portfolio
 * title row's sync-status chip. */
export function formatRelativeTime(epochMs: number): string {
  const deltaMs = Date.now() - epochMs;
  const minutes = Math.round(deltaMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}
