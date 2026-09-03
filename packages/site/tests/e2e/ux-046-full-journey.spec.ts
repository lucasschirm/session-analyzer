import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';
import { installCannedSessionWorker } from './helpers/canned-session';
import { captureAnalyticsWorker, seedSession } from './helpers/seeded-store';

/**
 * UX-046: Full end-to-end journey from a seeded session through the redesigned
 * analytics shell: upload/sync a fixture → portfolio renders with a visible n=
 * sample size → drill into a project → drill into a session → filter the
 * session events table → expand an error row.
 *
 * The session-events and turn-timeline data are served by a canned worker
 * because the app's real ingestion path does not yet populate the
 * `invocations`/`turns`/`messages`/`payloads` tables those DTOs read from. That
 * gap is documented and covered separately by PIPE-014; using a canned worker
 * here lets us exercise the full Portfolio → Project → Session → filter →
 * expand navigation and interaction path end-to-end.
 */

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

function fixture(name: string): string {
  return path.join(FIXTURES_DIR, name);
}

function fixtureText(name: string): string {
  return fs.readFileSync(fixture(name), 'utf8');
}

async function seedJourneySession(page: Page, projectId: string, sessionId: string): Promise<void> {
  const content = fixtureText('claude-session-with-subagent.jsonl');
  await seedSession({
    page,
    projectId,
    sessionId,
    content,
    importBatchIdPrefix: 'ux046',
  });
}

function sessionsHeroTile(page: Page) {
  return page.locator('stat-tile-hero').first();
}

async function waitForAppReady(page: Page): Promise<void> {
  await expect(page.locator('icon-rail')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.app-loading')).toBeHidden({ timeout: 15000 });
}

test('UX-046: full journey from fixture to error-row expand', async ({ page }) => {
  const projectId = `ux046-project-${Date.now()}`;
  const sessionId = `ux046-session-${Date.now()}`;

  // 1. Seed the fixture through the real analytics worker (upload/sync seam).
  await captureAnalyticsWorker(page);
  await page.goto('/');
  await waitForAppReady(page);
  await seedJourneySession(page, projectId, sessionId);

  // 2. Portfolio renders with a visible n= sample-size caption.
  await page.goto('/#/');
  await waitForAppReady(page);
  await expect(page.locator('filter-bar')).toBeVisible({ timeout: 15000 });

  const hero = sessionsHeroTile(page);
  await expect(hero).toBeVisible({ timeout: 15000 });
  await expect
    .poll(async () => hero.getAttribute('samplelabel'), { timeout: 15000 })
    .toMatch(/n=\d+/);

  // 3. Drill into the project from the leaderboard.
  const leaderboard = page.locator('table.leaderboard');
  await expect(leaderboard).toBeVisible({ timeout: 15000 });
  // Wait for at least one row, then click the link whose project-name contains
  // our seeded project. The exact display name is the `projectId` we passed.
  await expect
    .poll(async () => leaderboard.locator('tbody tr').count(), { timeout: 15000 })
    .toBeGreaterThan(0);
  const projectLink = leaderboard.locator('a').filter({ hasText: projectId }).first();
  await expect(projectLink).toBeVisible({ timeout: 10000 });
  await projectLink.click();

  await expect(page).toHaveURL(/#\/projects\//, { timeout: 15000 });
  await expect(page.locator('project-behavior-view')).toBeVisible({ timeout: 15000 });
  const projectHeader = page.locator('h1');
  await expect(projectHeader).toBeVisible({ timeout: 15000 });
  await expect(projectHeader).toContainText(projectId);
  await expect(page.locator('filter-bar')).toBeVisible({ timeout: 15000 });

  // 4. Install a canned session worker and perform a full reload directly to
  //    the session route so it can display realistic events despite the
  //    ingestion gap. A query param (`?_`) forces the browser to load a new
  //    document rather than treating this as a same-page hash change.
  const siteOrigin = new URL(page.url()).origin;
  await installCannedSessionWorker(page);
  await page.goto(`${siteOrigin}/?_=1#/sessions/${encodeURIComponent(sessionId)}`);

  // 5. Session Evidence header, timeline, and events table render.
  await waitForAppReady(page);
  await expect(page.locator('session-evidence-header')).toBeVisible({ timeout: 15000 });
  const table = page.locator('session-evidence-events-table');
  await expect(table).toBeVisible({ timeout: 15000 });
  await expect(table.locator('tbody tr.event-row')).toHaveCount(3);

  // 6. Filter to the single error row.
  await table.locator('input[type="checkbox"]').check();
  await expect(table.locator('tbody tr.event-row')).toHaveCount(1);
  await expect(table.locator('tbody tr.event-row.error-row')).toHaveCount(1);
  await expect(table).toContainText('1 of 3 events');

  // AND-combine with free-text search that still matches the Bash error row.
  await table.locator('input[type="text"]').fill('bash');
  await expect(table.locator('tbody tr.event-row')).toHaveCount(1);
  await expect(table.locator('tbody tr.event-row')).toContainText('Bash');

  // 7. Expand the error row and verify the pretty-printed payload JSON.
  const errorRow = table.locator('tbody tr.event-row.error-row').first();
  await errorRow.click();

  const expanded = table.locator('.expanded-row').first();
  await expect(expanded).toBeVisible();
  await expect(expanded.locator('.detail-block pre').first()).toBeVisible();
  await expect(expanded).toContainText('"command"');
  await expect(expanded).toContainText('"error"');
});
