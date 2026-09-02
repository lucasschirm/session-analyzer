/**
 * Redesign design tokens — the same name -> hex values defined as `--rd-*`
 * custom properties in `packages/site/index.html`'s `:root` block.
 *
 * This module is the source consumers that cannot read CSS custom
 * properties reach for directly: echarts option builders need literal
 * color strings (not `var(--rd-*)`), and unit tests compare this module
 * against `index.html` to keep the two in sync (see
 * `packages/site/tests/unit/tokens.test.ts`).
 *
 * The pre-existing `--md-sys-color-*` tokens are intentionally NOT
 * represented here — they stay untouched in `index.html` until each
 * consumer migrates on its own sub-issue, and are out of scope for this
 * module. Key names below mirror the `--rd-*` CSS custom property names
 * (kebab-case -> camelCase) on purpose, so the unit test can cross-check
 * the two sources mechanically.
 */

/** Surface (background) tokens, darkest-to-lightest layering. */
export const surfaceTokens = {
  surfacePage: '#0c0e13',
  surfaceRail: '#10131a',
  surfaceCard: '#171b24',
  surfaceInset: '#12151c',
  surfaceRowHover: '#1f2531',
} as const;

/** Hairline / border tokens, lightest emphasis last. */
export const borderTokens = {
  border1: '#20242e',
  border2: '#232936',
  border3: '#2a303c',
  borderEmphasis: '#313947',
  borderEmphasis2: '#3a4150',
} as const;

/** Text ("ink") tokens, most-to-least prominent. */
export const inkTokens = {
  inkPrimary: '#e6e9ef',
  inkSecondary: '#c9d4e3',
  inkMuted: '#9aa4b2',
  inkFaint: '#7d8794',
} as const;

/** Accent (brand/interactive) tokens. */
export const accentTokens = {
  accent: '#4f8cff',
  accentContainer: '#1c2b4a',
  accentOnContainer: '#cfe0ff',
  accentSuccess: '#3ecf8e',
  accentError: '#ff6b6b',
} as const;

/**
 * Status tokens for chart/outcome semantics (e.g. a pass/warn/fail badge).
 * Never reuse these as categorical series colors — see `seriesTokens`.
 */
export const statusTokens = {
  statusGood: '#3ecf8e',
  statusWarning: '#fab219',
  statusCritical: '#d03b3b',
} as const;

/**
 * Categorical series colors, in validated presentation order. Do not
 * reorder — charts assign these positionally to series 1-5. A 6th series
 * (and beyond) folds into an "Other" bucket rather than adding a 6th color.
 */
export const seriesTokens = ['#4f8cff', '#d95926', '#199e70', '#c98500', '#d55181'] as const;

/** Sequential heatmap ramp, low -> high. See `rampStep` to index into it by fraction. */
export const rampTokens = [
  '#161d2c',
  '#1a2c4d',
  '#1c4382',
  '#1c5cab',
  '#2a78d6',
  '#4f8cff',
  '#86b6ef',
] as const;

/** Typography tokens. Numeric columns additionally use `font-variant-numeric: tabular-nums`. */
export const fontTokens = {
  fontDisplay: "'Space Grotesk', 'Segoe UI', Arial, sans-serif",
  fontBody: "'Space Grotesk', 'Segoe UI', Arial, sans-serif",
} as const;

const seriesTokenEntries = Object.fromEntries(
  seriesTokens.map((hex, i) => [`series${i + 1}`, hex]),
);
const rampTokenEntries = Object.fromEntries(rampTokens.map((hex, i) => [`ramp${i}`, hex]));

/** Every color token (name -> hex), flattened for completeness checks against index.html. */
export const tokens: Readonly<Record<string, string>> = Object.freeze({
  ...surfaceTokens,
  ...borderTokens,
  ...inkTokens,
  ...accentTokens,
  ...statusTokens,
  ...seriesTokenEntries,
  ...rampTokenEntries,
});

/**
 * Maps a fraction in [0, 1] to a step of the sequential heatmap ramp
 * (`rampTokens`), for coloring heatmap cells by intensity. Out-of-range
 * input is clamped rather than throwing, since callers may pass a raw
 * ratio (e.g. `value / max`) that can exceed [0, 1] due to floating-point
 * or stale-max edge cases; `NaN` (e.g. a 0/0 ratio) falls back to the
 * lowest ramp step.
 */
export function rampStep(fraction: number): string {
  if (Number.isNaN(fraction)) return rampTokens[0];

  const clamped = Math.min(1, Math.max(0, fraction));
  const index = Math.round(clamped * (rampTokens.length - 1));
  return rampTokens[index];
}
