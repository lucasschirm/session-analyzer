import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * E2E tests covering the complete user journey:
 * project CRUD -> session upload (picker + drag & drop) -> parsing ->
 * session dashboard metrics -> indicator drill-down -> transcript ->
 * search -> SQLite export -> OPFS persistence across reloads.
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

async function openProject(page: Page, name: string): Promise<void> {
  await page.goto('/');
  await page.locator('.project-card', { hasText: name }).click();
  await expect(page.getByRole('heading', { name })).toBeVisible();
}

async function uploadFile(page: Page, fileName: string): Promise<void> {
  await page.locator('input[type="file"]').setInputFiles(fixture(fileName));
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
  });
});

test.describe('Full user journey', () => {
  test('create project -> upload -> dashboard -> indicator drill-down -> transcript', async ({ page }) => {
    await createProject(page, 'Demo Project', 'E2E demo project');
    await openProject(page, 'Demo Project');

    // The preview server sends COOP/COEP headers, so the SQLite OPFS backend
    // must be active (not the in-memory fallback).
    await expect(page.getByText('OPFS')).toBeVisible();

    // Upload zone is at the top of the project view.
    await expect(page.locator('upload-zone')).toBeVisible();
    await expect(page.getByText('Drag & drop session files here')).toBeVisible();

    await uploadFile(page, 'claude-session.jsonl');
    const sessionRow = page.locator('.session-item', { hasText: 'claude-session.jsonl' });
    await expect(sessionRow).toBeVisible();

    // Open the session dashboard.
    await sessionRow.click();
    await expect(page.getByRole('heading', { name: 'claude-session.jsonl' })).toBeVisible();

    // Metric cards: 120+80 input, 15+45+5 output -> 265 total tokens.
    const metricsGrid = page.locator('.metrics-grid');
    await expect(metricsGrid).toContainText('265');
    await expect(metricsGrid).toContainText('↑ 200 in • ↓ 65 out');
    await expect(metricsGrid).toContainText('most used');

    // Clicking a metric card routes to the Indicator Details page.
    await page.locator('metrics-card', { hasText: 'Files Written' }).click();
    await expect(page.getByRole('heading', { name: 'Files Written' })).toBeVisible();
    await expect(page.locator('events-table')).toContainText('src/app.fixed.ts');
    await expect(page.locator('events-table')).not.toContainText('src/app.ts');

    // Back to the dashboard, open the transcript.
    await page.getByRole('link', { name: '← Back to Session' }).click();
    await page.getByRole('button', { name: 'View Session Transcript' }).click();

    const transcript = page.locator('session-transcript');
    await expect(transcript).toContainText('I fixed the bug');
    // Markdown was rendered ...
    await expect(transcript.locator('strong')).toHaveText('app.ts');
    // ... and DOMPurify stripped the injected event handler.
    expect(await page.content()).not.toContain('onerror');
  });

  test('uploads every supported format', async ({ page }) => {
    await createProject(page, 'Formats Project');
    await openProject(page, 'Formats Project');

    await page.locator('input[type="file"]').setInputFiles([
      fixture('antigravity-session.json'),
      fixture('opencode-session.jsonl'),
      fixture('mcp-session.jsonl'),
      fixture('local-runner-session.jsonl'),
      fixture('agentic-pi-session.jsonl'),
    ]);

    await expect(page.locator('.session-item')).toHaveCount(5);
    const listText = await page.locator('session-list').textContent();
    for (const source of ['antigravity', 'opencode codex', 'mcp', 'local runner', 'agentic pi']) {
      expect(listText?.toLowerCase()).toContain(source);
    }
  });
});

test.describe('Search', () => {
  test('filters sessions by title and by message content', async ({ page }) => {
    await createProject(page, 'Search Project');
    await openProject(page, 'Search Project');

    await uploadFile(page, 'claude-session.jsonl');
    await expect(page.locator('.session-item')).toHaveCount(1);
    await uploadFile(page, 'agentic-pi-session.jsonl');
    await expect(page.locator('.session-item')).toHaveCount(2);

    // Filter by title.
    await page.getByLabel('Search sessions').fill('agentic');
    await expect(page.locator('.session-item')).toHaveCount(1);
    await expect(page.locator('.session-item')).toContainText('agentic-pi-session.jsonl');

    // Filter by transcript message content ("Add a restful API route").
    await page.getByLabel('Search sessions').fill('restful');
    await expect(page.locator('.session-item')).toHaveCount(1);
    await expect(page.locator('.session-item')).toContainText('agentic-pi-session.jsonl');

    // Clearing restores the full list.
    await page.getByLabel('Search sessions').fill('');
    await expect(page.locator('.session-item')).toHaveCount(2);
  });
});

test.describe('Drag & drop upload', () => {
  test('accepts a dropped session file', async ({ page }) => {
    await createProject(page, 'Drop Project');
    await openProject(page, 'Drop Project');

    const content = fs.readFileSync(fixture('claude-session.jsonl'), 'utf8');
    const dataTransfer = await page.evaluateHandle((fileContent) => {
      const dt = new DataTransfer();
      dt.items.add(new File([fileContent], 'dropped-session.jsonl', { type: 'application/json' }));
      return dt;
    }, content);

    await page.locator('upload-zone div.upload-zone').dispatchEvent('drop', { dataTransfer });

    await expect(
      page.locator('.session-item', { hasText: 'dropped-session.jsonl' })
    ).toBeVisible();
  });
});

test.describe('Persistence (OPFS)', () => {
  test('projects and sessions survive a page reload', async ({ page }) => {
    await createProject(page, 'Persist Project');
    await openProject(page, 'Persist Project');
    await uploadFile(page, 'claude-session.jsonl');
    await expect(
      page.locator('.session-item', { hasText: 'claude-session.jsonl' })
    ).toBeVisible();

    await page.reload();

    await expect(page.locator('.project-card', { hasText: 'Persist Project' })).toBeVisible();
    await openProject(page, 'Persist Project');
    await expect(
      page.locator('.session-item', { hasText: 'claude-session.jsonl' })
    ).toBeVisible();
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

    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk));
      if (Buffer.concat(chunks).length > 16) break;
    }
    const header = Buffer.concat(chunks).subarray(0, 15).toString('utf8');
    expect(header).toBe('SQLite format 3');
  });
});

test.describe('Project deletion', () => {
  test('deleting a project cascades to its sessions', async ({ page }) => {
    page.on('dialog', (dialog) => dialog.accept());

    await createProject(page, 'Doomed Project');
    await openProject(page, 'Doomed Project');
    await uploadFile(page, 'claude-session.jsonl');
    await expect(page.locator('.session-item')).toHaveCount(1);

    await page.goto('/');
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

  test('session dashboard shows a notice for unknown sessions', async ({ page }) => {
    await page.goto('/#/sessions/does-not-exist');
    await expect(page.getByText(/Session not found/)).toBeVisible();
  });
});
