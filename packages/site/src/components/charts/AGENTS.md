# components/charts/

Reusable chart web components built on tree-shaken ECharts.

## Files

- **analytics-chart.ts** — Chart wrapper element. Picks the right ECharts option builder by `chartType`, renders a textual summary, a tabular fallback, and loading/empty/error/partial states.
- **chart-types.ts** — Shared chart DTO types (`ChartSeries`, `ChartBucket`, `ChartState`), state union, compact number formatting (`formatChartValue`), and heatmap cell classification (`classifyHeatmapCell`).
- **chart-helpers.ts** — Domain-agnostic ECharts option builders for `time_series`, `stacked_bar`, `horizontal_bar`, `heatmap`, etc., stable per-entity series color assignment (`colorForEntity`), and textual summary generation. Every color literal here is imported from `styles/tokens.ts` — ECharts cannot resolve `var(--rd-*)` CSS custom properties.
- **echarts-base.ts** — Tree-shaken ECharts core registration (SVG renderer, grid, tooltip, legend, data zoom, toolbox), resize handling, keyboard-accessible table fallback, and the loading/empty/error state machine (skeleton shimmer, neutral empty affordance, error banner + retry).
- **rd-heatmap-grid.ts** — DOM-rendered heatmap grid (`rd-heatmap-grid`), used by `echarts-base` in place of ECharts' `heatmap` series when `chartType === 'heatmap'`. Missing cells (`y === null`) render as a dashed "—" cell with a DOM-assertable `data-missing="true"` attribute, distinct from a measured-zero cell — see `.agents/rules/missing-is-never-zero.md`.
- **sparkline.ts** — Shared inline-SVG sparkline (`rd-sparkline`) from sub-issue 3 (card components). Do not fork a second sparkline renderer; theme/consume this one.

## Invariants

- No SQL types or canonical metric calculations live in these components.
- Components consume only `ChartSeries` DTOs from `chart-types.ts`.
- Every aggregate is paired with sample size (n=X) in the textual summary.
- Charts are color-independent: status and series are encoded through labels, patterns, and textual summaries, not color alone.
- Categorical series colors are assigned per stable entity id (`colorForEntity`), never by array/index position — removing a series from the input must not repaint the remaining series' colors.
- Legend is rendered only for 2+ distinct series; a single series is titled instead, with no legend box.
- Status colors (`statusGood`/`statusWarning`/`statusCritical` in `tokens.ts`) are reserved for outcome/status encodings and must never be assigned as a categorical series color.
- Empty and error states must render structurally distinct DOM (`.state-empty`/`.state-unavailable` vs `.state-error`/`.state-integrity-error`/`.state-unsupported`, `[role="alert"]`) — see `.agents/rules/no-silent-empty-states.md` and `tests/e2e/helpers/chart-content.ts`.
