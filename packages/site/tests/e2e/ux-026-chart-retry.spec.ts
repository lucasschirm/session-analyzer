import { expect, test } from '@playwright/test';
import { assertErrorBoundary } from './helpers/chart-content';

/**
 * UX-026: Chart error affordance carries a working retry control.
 *
 * Part of issue #168 (chart layer upgrade). `echarts-base`'s error-state
 * panel (`.chart-affordance.state-error`) now includes a "Retry" button that
 * dispatches a `chart-retry` `CustomEvent` (bubbling + composed) so a hosting
 * page can re-issue the failed query. This proves the button exists inside
 * the real shadow DOM and that clicking it actually fires the signal a page
 * would listen for — not just that the button is present in markup.
 */

test.describe('UX-026: chart error retry affordance', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('app-root')).toBeVisible({ timeout: 30000 });
  });

  test('clicking Retry on a chart error state dispatches chart-retry', async ({ page }) => {
    await page.evaluate(async () => {
      await customElements.whenDefined('analytics-chart');

      const chart = document.createElement('analytics-chart');
      chart.id = 'ux026-error-chart';
      chart.style.display = 'block';
      chart.style.width = '800px';
      chart.style.height = '500px';
      chart.title = 'UX-026 retry smoke';
      chart.setAttribute('state', 'error');
      document.body.appendChild(chart);

      (window as unknown as { __ux026RetryCount: number }).__ux026RetryCount = 0;
      chart.addEventListener('chart-retry', () => {
        (window as unknown as { __ux026RetryCount: number }).__ux026RetryCount += 1;
      });

      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    const chart = page.locator('analytics-chart#ux026-error-chart');
    await expect(chart).toBeVisible();

    // Confirm the error affordance itself is present and structurally
    // distinct from the empty state before exercising its retry control.
    await assertErrorBoundary(chart);

    const retryButton = chart.locator('button.affordance-retry');
    await expect(retryButton).toBeVisible();
    await retryButton.click();

    await expect
      .poll(async () =>
        page.evaluate(() => (window as unknown as { __ux026RetryCount: number }).__ux026RetryCount),
      )
      .toBe(1);
  });
});
