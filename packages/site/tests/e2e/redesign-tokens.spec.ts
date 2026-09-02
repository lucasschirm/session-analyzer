import { expect, test } from '@playwright/test';

/**
 * E2E regression test for the redesign's self-hosted typography
 * (issue #164 / packages/site/index.html's `@font-face` block).
 *
 * Covered change:
 * - UX-022: Space Grotesk loads from the self-hosted `packages/site/public/fonts/`
 *   woff2 files, not a runtime Google Fonts dependency, so the app stays
 *   fully offline-capable per GitHub Pages + service-worker constraints.
 */

const FONT_URL_PATTERN = /\/fonts\/space-grotesk-\d+\.woff2/;
const EXTERNAL_FONT_HOST_PATTERN = /fonts\.(googleapis|gstatic)\.com/;

test.describe('Self-hosted typography (UX-022)', () => {
  test('UX-022: Space Grotesk woff2 loads from the same origin and is usable via the Font Loading API', async ({
    page,
  }) => {
    const fontResponseStatuses: number[] = [];
    const externalFontRequests: string[] = [];

    page.on('response', (response) => {
      if (FONT_URL_PATTERN.test(response.url())) {
        fontResponseStatuses.push(response.status());
      }
    });
    page.on('request', (request) => {
      if (EXTERNAL_FONT_HOST_PATTERN.test(request.url())) {
        externalFontRequests.push(request.url());
      }
    });

    await page.goto('/#/');
    // `/` has no global header as of issue #170 (a page-owned title row
    // replaces it) — `icon-rail` is the route-independent app-ready signal.
    await expect(page.locator('icon-rail')).toBeVisible({ timeout: 15000 });

    // Nothing in this PR's scope renders text with the new font yet (that
    // lands with each consumer's own sub-issue), so force the browser to
    // fetch and register it via the Font Loading API rather than relying on
    // an element that happens to use it.
    const loadedWeights = await page.evaluate(async () => {
      await Promise.all([
        document.fonts.load("400 16px 'Space Grotesk'"),
        document.fonts.load("700 16px 'Space Grotesk'"),
      ]);
      return {
        regular: document.fonts.check("400 16px 'Space Grotesk'"),
        bold: document.fonts.check("700 16px 'Space Grotesk'"),
      };
    });

    expect(loadedWeights.regular).toBe(true);
    expect(loadedWeights.bold).toBe(true);

    expect(fontResponseStatuses.length).toBeGreaterThan(0);
    expect(fontResponseStatuses.every((status) => status === 200)).toBe(true);
    expect(externalFontRequests).toEqual([]);
  });
});
