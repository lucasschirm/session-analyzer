import { expect, test } from '@playwright/test';
import {
  assertEmptyAffordance,
  assertErrorBoundary,
  assertNoErrorBoundary,
  expectRenderedGeometry,
} from './helpers/chart-content';

/**
 * Smoke tests for the chart-content assertion helpers (TSK0001).
 *
 * These tests create `analytics-chart` elements directly in the document so they
 * exercise the real shadow-DOM structure without depending on live analytics
 * data. They prove the helpers can distinguish:
 *
 * - a chart with rendered geometry (data)
 * - a genuine zero-row / empty result (empty state badge, no error)
 * - a forced query failure (error state badge, no empty)
 */

test.describe('Chart content helpers', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('app-root')).toBeVisible({ timeout: 30000 });
  });

  test('UX-001 (helper smoke): chart with data renders non-zero geometry', async ({ page }) => {
    await page.evaluate(async () => {
      await customElements.whenDefined('analytics-chart');

      const body = document.body;
      const chart = document.createElement('analytics-chart');
      chart.id = 'helper-chart-data';
      chart.style.display = 'block';
      chart.style.width = '800px';
      chart.style.height = '500px';
      chart.style.padding = '20px';
      chart.title = 'Data smoke';
      chart.series = {
        seriesId: 'helper-smoke',
        label: 'Helper smoke data',
        chartType: 'histogram',
        xLabel: 'Category',
        yLabel: 'Count',
        unit: 'count',
        buckets: [
          { x: 'A', y: 5, label: 'A' },
          { x: 'B', y: 12, label: 'B' },
          { x: 'C', y: 8, label: 'C' },
        ],
      };
      body.appendChild(chart);

      // Give Lit + ECharts one frame to settle; `expectRenderedGeometry` polls
      // from this point, so this does not need to be exact.
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    const chart = page.locator('analytics-chart#helper-chart-data');
    await expect(chart).toBeVisible();

    await expectRenderedGeometry(chart);
    await assertNoErrorBoundary(chart);
  });

  test('UX-002 (helper smoke): empty and error affordances are structurally distinct', async ({
    page,
  }) => {
    await page.evaluate(async () => {
      await customElements.whenDefined('analytics-chart');

      const body = document.body;

      function addStateChart(id: string, state: 'empty' | 'error') {
        const chart = document.createElement('analytics-chart');
        chart.id = id;
        chart.style.display = 'block';
        chart.style.width = '800px';
        chart.style.height = '500px';
        chart.style.padding = '20px';
        chart.setAttribute('state', state);
        chart.title = `${state} smoke`;
        body.appendChild(chart);
      }

      addStateChart('helper-chart-empty', 'empty');
      addStateChart('helper-chart-error', 'error');
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    const emptyChart = page.locator('analytics-chart#helper-chart-empty');
    const errorChart = page.locator('analytics-chart#helper-chart-error');
    await expect(emptyChart).toBeVisible();
    await expect(errorChart).toBeVisible();

    // Genuine zero-row result: empty badge, no error boundary, no rendered geometry.
    await assertNoErrorBoundary(emptyChart);
    await assertEmptyAffordance(emptyChart);
    await expect(expectRenderedGeometry(emptyChart, { timeout: 1000 })).rejects.toThrow(
      /Expected chart to render non-zero SVG\/canvas geometry/,
    );

    // Forced query failure: error boundary, no empty badge, no rendered geometry.
    await assertErrorBoundary(errorChart);
    await expect(assertEmptyAffordance(errorChart)).rejects.toThrow(
      /Expected an empty or unavailable affordance/,
    );
    await expect(expectRenderedGeometry(errorChart, { timeout: 1000 })).rejects.toThrow(
      /Expected chart to render non-zero SVG\/canvas geometry/,
    );
  });
});
