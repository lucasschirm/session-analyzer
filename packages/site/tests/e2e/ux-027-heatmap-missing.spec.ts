import { expect, test } from '@playwright/test';

/**
 * UX-027: Heatmap missing cells are DOM-distinct from measured-zero cells.
 *
 * Part of issue #168 (chart layer upgrade). Per
 * `.agents/rules/missing-is-never-zero.md`, a `heatmap`-type `analytics-chart`
 * must never render a missing native value (`ChartBucket.y === null`)
 * identically to a measured `0`. `rd-heatmap-grid` (rendered in place of an
 * ECharts heatmap series) marks a missing cell with `data-missing="true"`
 * and a dashed "—" cell; a measured-zero cell carries `data-missing="false"`
 * and shows "0". This test asserts both are present, distinguishable by a
 * DOM-assertable attribute, in the real rendered shadow tree.
 */

test.describe('UX-027: heatmap missing-vs-zero cell distinction', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('app-root')).toBeVisible({ timeout: 30000 });
  });

  test('a missing cell carries data-missing="true" and a measured-zero cell does not', async ({
    page,
  }) => {
    await page.evaluate(async () => {
      await customElements.whenDefined('analytics-chart');

      const chart = document.createElement('analytics-chart');
      chart.id = 'ux027-heatmap';
      chart.style.display = 'block';
      chart.style.width = '800px';
      chart.style.height = '500px';
      chart.title = 'UX-027 heatmap smoke';
      (chart as unknown as { series: unknown }).series = {
        seriesId: 'ux027-heatmap',
        label: 'Component activity',
        chartType: 'heatmap',
        xLabel: 'Day',
        yLabel: 'Component',
        unit: 'count',
        buckets: [
          { x: 'Mon', y: 12, label: 'Mon', series: 'alpha' },
          { x: 'Tue', y: 0, label: 'Tue', series: 'alpha' },
          { x: 'Wed', y: null, label: 'Wed', series: 'alpha' },
        ],
      };
      document.body.appendChild(chart);

      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    const chart = page.locator('analytics-chart#ux027-heatmap');
    await expect(chart).toBeVisible();

    const missingCell = chart.locator('[data-missing="true"]');
    const zeroCell = chart.locator('[data-missing="false"]', { hasText: '0' });

    await expect(missingCell).toHaveCount(1);
    await expect(missingCell).toHaveText('—');

    await expect(zeroCell).toHaveCount(1);
    await expect(zeroCell.first()).toHaveAttribute('data-missing', 'false');

    // The ramp legend surfaces min/max labels for the sequential ramp.
    await expect(chart.locator('.legend')).toContainText('12');
  });
});
