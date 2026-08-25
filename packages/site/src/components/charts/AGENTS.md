# components/charts/

Reusable chart web components built on tree-shaken ECharts.

## Files

- **analytics-chart.ts** — Chart wrapper element. Picks the right ECharts option builder by `chartType`, renders a textual summary, a tabular fallback, and loading/empty/error/partial states.
- **chart-types.ts** — Shared chart DTO types (`ChartSeries`, `ChartBucket`, `ChartState`), state union, and compact number formatting (`formatChartValue`).
- **chart-helpers.ts** — Domain-agnostic ECharts option builders for `time_series`, `stacked_bar`, `doughnut`, etc., plus textual summary generation.
- **echarts-base.ts** — Tree-shaken ECharts core registration (SVG renderer, grid, tooltip, legend, data zoom, toolbox), resize handling, and keyboard-accessible table fallback.

## Invariants

- No SQL types or canonical metric calculations live in these components.
- Components consume only `ChartSeries` DTOs from `chart-types.ts`.
- Every aggregate is paired with sample size (n=X) in the textual summary.
- Charts are color-independent: status and series are encoded through labels, patterns, and textual summaries, not color alone.
