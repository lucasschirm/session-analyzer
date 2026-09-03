import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';
import { verifyExportContents } from './helpers/export-verify';
import { captureAnalyticsWorker, seedSession } from './helpers/seeded-store';

/**
 * UX-047: The header Export button on the Portfolio route (added by the app
 * shell sub-issue #165, wired to `analyticsClient.exportAnalyticsDatabase()`)
 * downloads a valid SQLite analytics database that contains the seeded session
 * rows.
 */

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

function fixture(name: string): string {
  return path.join(FIXTURES_DIR, name);
}

function fixtureText(name: string): string {
  return fs.readFileSync(fixture(name), 'utf8');
}

async function seedPortfolioForExport(
  page: Page,
  projectId: string,
  sessionId: string,
): Promise<void> {
  const content = fixtureText('claude-session-with-subagent.jsonl');
  await seedSession({
    page,
    projectId,
    sessionId,
    content,
    importBatchIdPrefix: 'ux047',
  });
}

async function waitForAppReady(page: Page): Promise<void> {
  await expect(page.locator('icon-rail')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.app-loading')).toBeHidden({ timeout: 15000 });
}

test('UX-047: portfolio Export button downloads an analytics database with the seeded project and session', async ({
  page,
}) => {
  const projectId = `ux047-project-${Date.now()}`;
  const sessionId = `ux047-session-${Date.now()}`;

  await captureAnalyticsWorker(page);
  await page.goto('/');
  await waitForAppReady(page);

  // Seed a real session into the analytics DB so the export has rows to assert.
  await seedPortfolioForExport(page, projectId, sessionId);

  // Open the Portfolio route where the redesigned title row carries the
  // Export button (issue #170 / #165 shell wiring).
  await page.goto('/#/');
  await waitForAppReady(page);
  await expect(page.locator('portfolio-view')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('filter-bar')).toBeVisible({ timeout: 15000 });

  // The export button must be present and clickable, and the download must
  // arrive as a `.sqlite` file.
  const exportButton = page.locator('portfolio-view .export-button');
  await expect(exportButton).toBeVisible({ timeout: 10000 });
  await expect(exportButton).toHaveText('Export');

  const [download] = await Promise.all([page.waitForEvent('download'), exportButton.click()]);

  expect(download.suggestedFilename()).toMatch(/sal-analytics-.*\.sqlite$/);

  const downloadPath = await download.path();
  expect(downloadPath).toBeTruthy();

  // The exported analytics DB must be a valid SQLite file and must include the
  // seeded project and session rows. The other control-DB tables (e.g.
  // connections, passkey_state) live in the separate control database and are
  // legitimately absent here.
  const counts = await verifyExportContents(downloadPath as string);
  expect(counts.projects).toBeGreaterThanOrEqual(1);
  expect(counts.sessions).toBeGreaterThanOrEqual(1);
});
