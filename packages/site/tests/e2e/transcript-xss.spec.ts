import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

function fixture(name: string): string {
  return path.join(FIXTURES_DIR, name);
}

async function importSession(
  page: Page,
  projectName: string,
  fileNames: string[],
): Promise<string> {
  await page.goto('/#/manual-import');
  await expect(page.getByRole('heading', { name: 'Manual Import' })).toBeVisible();

  const filePaths = fileNames.map((f) => fixture(f));
  await page.locator('input[type="file"]').setInputFiles(filePaths);

  // Wait for harness detection to finish.
  await expect(page.getByRole('heading', { name: 'Harness' })).toBeVisible({ timeout: 15000 });

  await page.locator('#project-select').selectOption('__new__');
  await page.locator('input[placeholder="New project name"]').fill(projectName);

  const sessionInput = page.locator('#session-input');
  await expect(sessionInput).not.toHaveValue('');

  await page.getByRole('button', { name: 'Import partial session' }).click();
  await expect(page.getByRole('button', { name: 'View session' })).toBeVisible({
    timeout: 30000,
  });
  return sessionInput.inputValue();
}

async function importAndOpenSession(
  page: Page,
  projectName: string,
  fileNames: string[],
): Promise<string> {
  await importSession(page, projectName, fileNames);
  await page.getByRole('button', { name: 'View session' }).click();
  await expect(page).toHaveURL(/#\/sessions\//);

  // Wait for the initial evidence load to finish so the subsequent
  // hash change to the transcript tab is not dropped while loading.
  await page.waitForFunction(
    () => {
      const app = document.querySelector('app-root');
      const view = app?.shadowRoot?.querySelector('session-evidence-view');
      return !view || (view as unknown as { loading?: boolean }).loading === false;
    },
    { timeout: 15000 },
  );

  const url = page.url();
  const match = url.match(/#\/sessions\/(.+)$/);
  return match ? decodeURIComponent(match[1]) : '';
}

test.describe('UX-011: Transcript XSS sanitization', () => {
  test('strips executable markup while keeping safe text visible', async ({ page }) => {
    // Safety net: if any XSS payload executes and opens a dialog, fail immediately.
    let dialogFired = false;
    let dialogMessage = '';
    page.on('dialog', async (dialog) => {
      dialogFired = true;
      dialogMessage = `${dialog.type()}: ${dialog.message()}`;
      await dialog.dismiss();
    });

    const sessionId = await importAndOpenSession(page, 'XSS Test Project', [
      'claude-xss-payload.jsonl',
    ]);
    expect(sessionId).not.toBe('');

    // Reload the same session with the transcript tab active so the first
    // evidence load renders the transcript panel.
    await page.goto(`/#/sessions/${encodeURIComponent(sessionId)}?view=transcript`);

    // The session evidence view should render with the session ID in the breadcrumb.
    await expect(page.locator('session-evidence-header')).toBeVisible({ timeout: 15000 });

    // Wait for the transcript panel to load.
    await page.waitForFunction(
      () => {
        const app = document.querySelector('app-root');
        const view = app?.shadowRoot?.querySelector('session-evidence-view');
        const transcriptEl = view?.shadowRoot?.querySelector('session-evidence-transcript');
        const bodies = transcriptEl?.shadowRoot?.querySelectorAll('.message-body') ?? [];
        return bodies.length > 0;
      },
      { timeout: 15000 },
    );

    // Pull the rendered message body HTML and text from the nested shadow DOM.
    const transcript = await page.evaluate(() => {
      const app = document.querySelector('app-root');
      const view = app?.shadowRoot?.querySelector('session-evidence-view');
      const transcriptEl = view?.shadowRoot?.querySelector('session-evidence-transcript');
      const bodies = transcriptEl?.shadowRoot?.querySelectorAll('.message-body') ?? [];
      const html = Array.from(bodies)
        .map((el) => el.innerHTML)
        .join('\n');
      const text = Array.from(bodies)
        .map((el) => el.textContent)
        .join(' ');
      return { html, text };
    });

    const lower = transcript.html.toLowerCase();

    // No executable markup survives sanitization.
    expect(lower, 'transcript contains a <script> tag').not.toContain('<script');
    expect(transcript.html, 'transcript contains an onerror attribute').not.toMatch(
      /\sonerror\s*=/i,
    );
    expect(transcript.html, 'transcript contains an inline event handler').not.toMatch(
      /\s(on[a-z]+)\s*=/i,
    );

    // The safe visible text remains as inert text.
    expect(transcript.text).toContain('Before the attack');
    expect(transcript.text).toContain('and after the attack');
    expect(transcript.text).toContain('still safe.');

    expect(dialogFired, `Unexpected dialog fired: ${dialogMessage}`).toBe(false);
  });
});
