import { expect, type Locator } from '@playwright/test';

/** Selectors shared by the chart-specific and generic empty-vs-error affordance
 * assertions below, per `.agents/rules/no-silent-empty-states.md`: a query
 * failure and a zero-row result must render structurally distinct markers. */
const ERROR_SELECTORS =
  '.chart-error, .state-error, .state-integrity-error, .state-unsupported, [role="alert"]';
const EMPTY_SELECTORS = '.state-empty, .state-unavailable';

export interface ChartGeometry {
  /** Rendering back-end used by ECharts. */
  renderer: 'svg' | 'canvas';
  /** Rendered width in CSS pixels. */
  width: number;
  /** Rendered height in CSS pixels. */
  height: number;
  /** Number of meaningful shapes inside the rendering surface. */
  shapeCount: number;
}

export interface ChartContent {
  /** True when the chart has a non-zero rendered SVG/canvas surface with geometry. */
  hasGeometry: boolean;
  /** Geometry details, or null if nothing was rendered. */
  geometry: ChartGeometry | null;
  /** Number of error affordance markers in the chart. */
  errorCount: number;
  /** Text content of each error affordance marker. */
  errorTexts: string[];
  /** Number of empty/zero-data affordance markers in the chart. */
  emptyCount: number;
  /** Text content of the first empty affordance marker, if any. */
  emptyText: string | null;
}

/**
 * Query the chart's shadow DOM from inside the browser. This function is sent
 * to the page via `locator.evaluate`, so it must be self-contained: all helper
 * logic lives inside the returned callback.
 */
async function queryChartContent(locator: Locator): Promise<ChartContent> {
  return locator.first().evaluate<ChartContent, undefined>((el) => {
    const ERROR_SELECTORS =
      '.chart-error, .state-error, .state-integrity-error, .state-unsupported, [role="alert"]';
    const EMPTY_SELECTORS = '.state-empty, .state-unavailable';

    function findEchartsBase(node: Element) {
      if ((node as HTMLElement).tagName === 'ANALYTICS-CHART') {
        const chart = node as HTMLElement;
        const base = chart.shadowRoot?.querySelector('echarts-base') as HTMLElement | null;
        return { chart, base };
      }

      if ((node as HTMLElement).tagName === 'ECHARTS-BASE') {
        const root = node.getRootNode() as ShadowRoot | null;
        const chart = root?.host ?? null;
        return { chart: (chart as HTMLElement) ?? null, base: node as HTMLElement };
      }

      const chart = (node as HTMLElement).closest('analytics-chart');
      const base = (node as HTMLElement).closest('echarts-base');
      return { chart, base };
    }

    function extractGeometry(container: Element): ChartGeometry | null {
      const svg = container.querySelector('svg');
      if (svg) {
        const rect = svg.getBoundingClientRect();
        const shapes = svg.querySelectorAll('g > *');
        return {
          renderer: 'svg',
          width: rect.width,
          height: rect.height,
          shapeCount: shapes.length,
        };
      }

      const canvas = container.querySelector('canvas');
      if (canvas) {
        const rect = canvas.getBoundingClientRect();
        return {
          renderer: 'canvas',
          width: rect.width,
          height: rect.height,
          shapeCount: 0,
        };
      }

      return null;
    }

    function readChartContent(node: Element): ChartContent {
      const { base } = findEchartsBase(node);

      if (!base?.shadowRoot) {
        return {
          hasGeometry: false,
          geometry: null,
          errorCount: 0,
          errorTexts: [],
          emptyCount: 0,
          emptyText: null,
        };
      }

      const root = base.shadowRoot;
      const container = root.querySelector('.chart-container');
      const errorEls = Array.from(root.querySelectorAll(ERROR_SELECTORS));
      const emptyEls = Array.from(root.querySelectorAll(EMPTY_SELECTORS));
      const geometry = container ? extractGeometry(container) : null;

      return {
        hasGeometry:
          geometry !== null &&
          geometry.width > 0 &&
          geometry.height > 0 &&
          (geometry.renderer === 'canvas' || geometry.shapeCount > 0),
        geometry,
        errorCount: errorEls.length,
        errorTexts: errorEls.map((e) => (e.textContent ?? '').trim()).filter(Boolean),
        emptyCount: emptyEls.length,
        emptyText: (emptyEls[0]?.textContent ?? '').trim() || null,
      };
    }

    return readChartContent(el);
  });
}

/**
 * Polls the `analytics-chart` (or `echarts-base`) referenced by `locator` and
 * asserts that ECharts rendered non-zero SVG/canvas geometry inside the
 * component's shadow DOM. This proves the chart produced real marks — not just
 * a title, legend, or state badge.
 */
export async function expectRenderedGeometry(
  locator: Locator,
  options?: { timeout?: number },
): Promise<void> {
  const timeout = options?.timeout ?? 5000;
  const target = locator.first();

  await expect
    .poll(
      async () => {
        const content = await queryChartContent(target);
        return content.hasGeometry;
      },
      {
        message: 'Expected chart to render non-zero SVG/canvas geometry',
        timeout,
      },
    )
    .toBe(true);
}

/**
 * Reads the rendered geometry for the chart referenced by `locator`.
 *
 * Returns `null` when the chart has no rendered SVG/canvas surface (e.g. it is
 * still loading, empty, or in an error state). This is the non-throwing
 * counterpart to {@link expectRenderedGeometry}, used when a test needs to
 * compare pre/post geometry across a live data refresh.
 */
export async function getRenderedGeometry(locator: Locator): Promise<ChartGeometry | null> {
  const content = await queryChartContent(locator.first());
  return content.hasGeometry ? (content.geometry ?? null) : null;
}

/**
 * Asserts that the `analytics-chart` referenced by `locator` does **not** carry
 * an error boundary. This is the negative guard for the `no-silent-empty-states`
 * rule: a legitimate empty/zero-data badge does **not** satisfy this assertion,
 * only the absence of the error marker does.
 */
export async function assertNoErrorBoundary(locator: Locator): Promise<void> {
  const content = await queryChartContent(locator.first());
  expect(
    content.errorCount,
    `Expected no chart error boundary, but found: ${content.errorTexts.join(', ') || 'unknown'}`,
  ).toBe(0);
}

/**
 * Asserts that the `analytics-chart` referenced by `locator` displays an error
 * affordance that is structurally distinct from the empty state. The same DOM
 * shape must never satisfy both `assertErrorBoundary` and `assertEmptyAffordance`.
 */
export async function assertErrorBoundary(locator: Locator): Promise<void> {
  const content = await queryChartContent(locator.first());
  expect(content.errorCount, 'Expected a chart error boundary to be present').toBeGreaterThan(0);
  expect(
    content.emptyCount,
    'Error boundary must not also be satisfied by an empty-state selector',
  ).toBe(0);
}

/**
 * Asserts the presence of an empty (or unavailable) affordance and the absence
 * of an error affordance. Used together with `assertErrorBoundary` to prove that
 * zero-row results and query failures never render the same DOM shape.
 */
export async function assertEmptyAffordance(locator: Locator): Promise<void> {
  const content = await queryChartContent(locator.first());
  expect(
    content.emptyCount,
    'Expected an empty or unavailable affordance to be present',
  ).toBeGreaterThan(0);
  expect(
    content.errorCount,
    'Empty affordance must not also be satisfied by an error-boundary selector',
  ).toBe(0);
}

export interface ComponentAffordance {
  errorCount: number;
  errorTexts: string[];
  emptyCount: number;
  emptyText: string | null;
}

/**
 * Reads empty/error affordance markers directly from `locator`'s own shadow
 * root (not an `analytics-chart`/`echarts-base` ancestor search). This is the
 * generic counterpart to `queryChartContent` for non-chart data components
 * (metric cards, tables, lists) that follow the same `.state-empty` /
 * `.state-error` convention required by `.agents/rules/no-silent-empty-states.md`.
 */
async function queryComponentAffordance(locator: Locator): Promise<ComponentAffordance> {
  return locator.first().evaluate<ComponentAffordance, { error: string; empty: string }>(
    (el, selectors) => {
      const root = (el as HTMLElement).shadowRoot;
      if (!root) {
        return { errorCount: 0, errorTexts: [], emptyCount: 0, emptyText: null };
      }
      const errorEls = Array.from(root.querySelectorAll(selectors.error));
      const emptyEls = Array.from(root.querySelectorAll(selectors.empty));
      return {
        errorCount: errorEls.length,
        errorTexts: errorEls.map((e) => (e.textContent ?? '').trim()).filter(Boolean),
        emptyCount: emptyEls.length,
        emptyText: (emptyEls[0]?.textContent ?? '').trim() || null,
      };
    },
    { error: ERROR_SELECTORS, empty: EMPTY_SELECTORS },
  );
}

/**
 * Generic empty-vs-error affordance pair, for any data-rendering component
 * (metric card, table, list — not just `analytics-chart`) that renders
 * `.state-error`/`.state-empty` markers in its own shadow root.
 *
 * Asserts a distinguishable error affordance is present and no empty-state
 * marker is also present, so a failure can never be read as "no data" per
 * `.agents/rules/no-silent-empty-states.md`.
 */
export async function assertComponentErrorAffordance(locator: Locator): Promise<void> {
  const content = await queryComponentAffordance(locator);
  expect(content.errorCount, 'Expected a component error affordance to be present').toBeGreaterThan(
    0,
  );
  expect(
    content.emptyCount,
    'Error affordance must not also be satisfied by an empty-state selector',
  ).toBe(0);
}

/**
 * The empty-state counterpart to `assertComponentErrorAffordance`: asserts a
 * distinguishable empty/unavailable affordance is present with no error
 * marker, proving a genuine zero-row result never renders identically to a
 * query failure.
 */
export async function assertComponentEmptyAffordance(locator: Locator): Promise<void> {
  const content = await queryComponentAffordance(locator);
  expect(
    content.emptyCount,
    'Expected a component empty or unavailable affordance to be present',
  ).toBeGreaterThan(0);
  expect(
    content.errorCount,
    'Empty affordance must not also be satisfied by an error-boundary selector',
  ).toBe(0);
}
