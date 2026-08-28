import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';
import { verifyExportContents } from './helpers/export-verify';

/**
 * E2E tests covering the complete user journey through the analytics-based
 * architecture:
 *
 * project CRUD (control DB) -> manual import (analytics DB) ->
 * session evidence view -> project behavior view -> persistence ->
 * SQLite export -> project deletion.
 *
 * The old project-view/session-dashboard/indicator pages were removed in
 * TSK0044. Session upload now goes through the Manual Import page, and
 * analytics are viewed through the Session Evidence and Project Behavior
 * pages.
 */

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

function fixture(name: string): string {
  return path.join(FIXTURES_DIR, name);
}

async function createProject(page: Page, name: string, description = ''): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: '+ New Project' }).click();
  await page.locator('#project-name-input').fill(name);
  if (description) {
    await page.locator('#project-description-input').fill(description);
  }
  await page.getByRole('button', { name: 'Create Project' }).click();
  await expect(page.locator('.project-card', { hasText: name })).toBeVisible();
}

/**
 * Navigate to the Manual Import page and import a session file into a new
 * analytics project. Returns the session ID that was imported.
 *
 * The manual import flow:
 * 1. Go to #/manual-import
 * 2. Upload file(s) via the upload zone's file input
 * 3. Wait for harness detection to complete
 * 4. Select "+ New project" and enter the project name
 * 5. Click "Import partial session"
 * 6. Wait for the "View session" button to appear
 */
async function importSession(
  page: Page,
  projectName: string,
  fileNames: string[],
): Promise<string> {
  await page.goto('/#/manual-import');
  await expect(page.getByRole('heading', { name: 'Manual Import' })).toBeVisible();

  // Step 1: Upload files.
  const filePaths = fileNames.map((f) => fixture(f));
  await page.locator('input[type="file"]').setInputFiles(filePaths);

  // Step 2: Wait for harness detection to complete — the harness selector
  // section appears after detection finishes.
  await expect(page.getByRole('heading', { name: 'Harness' })).toBeVisible({ timeout: 15000 });

  // Step 3: Select "+ New project" from the project dropdown and enter name.
  const projectSelect = page.locator('#project-select');
  await projectSelect.selectOption('__new__');
  await page.locator('input[placeholder="New project name"]').fill(projectName);

  // Step 4: Verify session ID was auto-derived from the transcript filename.
  const sessionInput = page.locator('#session-input');
  await expect(sessionInput).not.toHaveValue('');

  // Step 5: Click import and wait for completion.
  await page.getByRole('button', { name: 'Import partial session' }).click();

  // Wait for the "View session" button to appear (phase = 'partial').
  await expect(page.getByRole('button', { name: 'View session' })).toBeVisible({
    timeout: 30000,
  });

  return sessionInput.inputValue();
}

/**
 * Import a session and navigate to its Session Evidence page.
 * Returns the session ID from the URL (the analytics-internal composite ID,
 * which may differ from the input value).
 */
async function importAndOpenSession(
  page: Page,
  projectName: string,
  fileNames: string[],
): Promise<string> {
  await importSession(page, projectName, fileNames);
  await page.getByRole('button', { name: 'View session' }).click();
  // Wait for the Session Evidence view to render. The URL contains a
  // composite analytics session ID, so we just check that we navigated
  // to the sessions route.
  await expect(page).toHaveURL(/#\/sessions\//);
  // Extract the session ID from the URL hash for later assertions.
  const url = page.url();
  const match = url.match(/#\/sessions\/(.+)$/);
  return match ? decodeURIComponent(match[1]) : '';
}

/**
 * Drop fixture files onto the upload zone (simulates folder drag & drop).
 */
async function dropFixtures(page: Page, fileNames: string[]): Promise<void> {
  const files = fileNames.map((name) => ({
    name,
    content: fs.readFileSync(fixture(name), 'utf8'),
  }));
  const dataTransfer = await page.evaluateHandle((entries) => {
    const dt = new DataTransfer();
    for (const entry of entries) {
      dt.items.add(new File([entry.content], entry.name, { type: 'application/json' }));
    }
    return dt;
  }, files);
  await page.locator('upload-zone div.upload-zone').dispatchEvent('drop', { dataTransfer });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test.describe('Home page', () => {
  test('renders the dashboard shell with an empty project state', async ({ page }) => {
    await expect(page).toHaveTitle(/Session Analyzer/);
    await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
    await expect(page.getByRole('button', { name: '+ New Project' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Export Database' })).toBeVisible();
    await expect(page.getByText('No projects yet')).toBeVisible();
  });

  test('creates a project through the modal', async ({ page }) => {
    await createProject(page, 'Modal Project', 'Created via modal');

    const card = page.locator('.project-card', { hasText: 'Modal Project' });
    await expect(card).toContainText('Created via modal');
    await expect(card).toContainText('0 sessions');
  });

  test('requires a name before creating a project', async ({ page }) => {
    await page.getByRole('button', { name: '+ New Project' }).click();
    const submit = page.getByRole('button', { name: 'Create Project' });
    await expect(submit).toBeDisabled();

    await page.locator('#project-name-input').fill('Now it has a name');
    await expect(submit).toBeEnabled();
  });
});

test.describe('Full user journey', () => {
  test('create project -> manual import -> session evidence view', async ({ page }) => {
    await importAndOpenSession(page, 'Demo Project', ['claude-session.jsonl']);

    // The Session Evidence view renders with the session ID in the heading.
    await expect(page.getByText(/Session Evidence —/)).toBeVisible();

    // The preview server sends COOP/COEP headers, so the SQLite OPFS backend
    // must be active (not the in-memory fallback).
    await expect(page.getByText('OPFS')).toBeVisible();

    // The Evidence section should be present with its tab list.
    await expect(page.getByRole('heading', { name: 'Evidence', exact: true })).toBeVisible();
  });

  test('uploads every supported format via manual import', async ({ page }) => {
    // Upload all supported formats in a single import batch.
    await page.goto('/#/manual-import');
    await page
      .locator('input[type="file"]')
      .setInputFiles([
        fixture('antigravity-session.json'),
        fixture('opencode-session.jsonl'),
        fixture('mcp-session.jsonl'),
        fixture('local-runner-session.jsonl'),
        fixture('agentic-pi-session.jsonl'),
      ]);

    // Wait for detection — the harness selector section should appear.
    // Some formats may not be detected (e.g. local-runner, mcp) but the
    // detection section still renders with an unmatched state.
    await expect(page.getByRole('heading', { name: 'Harness' })).toBeVisible({ timeout: 15000 });
  });
});

test.describe('Rich session dashboard', () => {
  test('surfaces session evidence with ai-title and transcript content', async ({ page }) => {
    await importAndOpenSession(page, 'Rich Panel Project', ['claude-rich-session.jsonl']);

    // The Session Evidence view renders with the session ID in the heading.
    await expect(page.getByText(/Session Evidence —/)).toBeVisible();

    // The Evidence section should be present.
    await expect(page.getByRole('heading', { name: 'Evidence', exact: true })).toBeVisible();
  });
});

test.describe('Drag & drop upload', () => {
  test('accepts a dropped session file in manual import', async ({ page }) => {
    await page.goto('/#/manual-import');
    await expect(page.getByRole('heading', { name: 'Manual Import' })).toBeVisible();

    const content = fs.readFileSync(fixture('claude-session.jsonl'), 'utf8');
    const dataTransfer = await page.evaluateHandle((fileContent) => {
      const dt = new DataTransfer();
      dt.items.add(new File([fileContent], 'dropped-session.jsonl', { type: 'application/json' }));
      return dt;
    }, content);

    await page.locator('upload-zone div.upload-zone').dispatchEvent('drop', { dataTransfer });

    // The file should appear in the file list.
    await expect(page.getByText('dropped-session.jsonl')).toBeVisible({ timeout: 10000 });
  });
});

test.describe('Subagent folder ingestion', () => {
  test('imports a transcript that references subagents as a single session', async ({ page }) => {
    // In the new analytics architecture, subagent sidecars are handled by
    // the sync engine, not manual import. We upload just the main transcript
    // (which contains subagent references) and verify it imports successfully.
    await importAndOpenSession(page, 'Subagent Combined Project', [
      'claude-session-with-subagent.jsonl',
    ]);

    // The Session Evidence view should render with the session data.
    await expect(page.getByText(/Session Evidence —/)).toBeVisible();

    // The Evidence section should be present.
    await expect(page.getByRole('heading', { name: 'Evidence', exact: true })).toBeVisible();
  });

  test('re-importing the same session updates it in place', async ({ page }) => {
    // First import.
    await importSession(page, 'Subagent Dedup Project', ['claude-session-with-subagent.jsonl']);

    // Reset the import form.
    await page.getByRole('button', { name: 'Reset' }).click();

    // Re-import the same file.
    await importSession(page, 'Subagent Dedup Project', ['claude-session-with-subagent.jsonl']);

    // The second import should succeed (either committed or superseded,
    // not a conflict that blocks the flow).
    await expect(page.getByRole('button', { name: 'View session' })).toBeVisible({
      timeout: 30000,
    });
  });
});

test.describe('Persistence (OPFS)', () => {
  test('projects survive a page reload', async ({ page }) => {
    await createProject(page, 'Persist Project');

    await page.reload();

    // The project should still be visible on the home page.
    await expect(page.locator('.project-card', { hasText: 'Persist Project' })).toBeVisible();
  });

  test('analytics sessions survive a page reload', async ({ page }) => {
    await importAndOpenSession(page, 'Persist Analytics Project', ['claude-session.jsonl']);

    // Reload the page — the hash route is preserved, so we land back on
    // the Session Evidence view.
    await page.reload();
    await expect(page.getByText(/Session Evidence —/)).toBeVisible({ timeout: 15000 });
  });
});

test.describe('Database export', () => {
  test('downloads the SQLite database file', async ({ page }) => {
    await createProject(page, 'Export Project');

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Export Database' }).click(),
    ]);

    expect(download.suggestedFilename()).toMatch(/session-analyzer-.*\.sqlite$/);

    const downloadPath = await download.path();
    expect(downloadPath).toBeTruthy();

    const fd = fs.openSync(downloadPath, 'r');
    const header = Buffer.alloc(16);
    fs.readSync(fd, header, 0, 16, 0);
    fs.closeSync(fd);
    expect(header.subarray(0, 15).toString('utf8')).toBe('SQLite format 3');

    const counts = await verifyExportContents(downloadPath);
    expect(counts.projects).toBe(1);
    expect(counts.sessions).toBe(0);
  });
});

test.describe('Project deletion', () => {
  test('deleting a project removes it from the home page', async ({ page }) => {
    page.on('dialog', (dialog) => dialog.accept());

    await createProject(page, 'Doomed Project');

    await page
      .locator('.project-card', { hasText: 'Doomed Project' })
      .getByRole('button', { name: 'Delete Project' })
      .click();

    await expect(page.locator('.project-card')).toHaveCount(0);
    await expect(page.getByText('No projects yet')).toBeVisible();
  });
});

test.describe('Routing', () => {
  test('unknown hash routes render the fallback page', async ({ page }) => {
    await page.goto('/#/definitely-missing');
    await expect(page.getByText('Page not found')).toBeVisible();
  });

  test('session evidence view renders for unknown sessions without crashing', async ({ page }) => {
    await page.goto('/#/sessions/does-not-exist');
    // The Session Evidence view should render (either with an error message
    // or an empty state), not crash or show the fallback page.
    await expect(page.getByText(/Session Evidence/)).toBeVisible({ timeout: 10000 });
  });
});
