import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';
import { expectManualImportState, queryManualImportState } from './helpers/manual-import-state';

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

function fixture(name: string): string {
  return path.join(FIXTURES_DIR, name);
}

/**
 * Navigate to Manual Import and upload a fixture file.
 */
async function openManualImportAndUpload(page: Page, fileName: string): Promise<void> {
  await page.goto('/#/manual-import');
  await expect(page.getByRole('heading', { name: 'Manual Import' })).toBeVisible();

  await page.locator('input[type="file"]').setInputFiles([fixture(fileName)]);

  // The harness selector section renders once detection has finished,
  // regardless of whether detection matched, was ambiguous, or was unmatched.
  await expect(page.getByRole('heading', { name: 'Harness' })).toBeVisible({ timeout: 15000 });
}

/**
 * Wait for `manual-import-state` to settle into a specific error class.
 *
 * Wraps `expectManualImportState` in `expect(...).toPass()` so the assertion is
 * retried until the state panel stops loading and reaches the expected phase.
 */
async function waitForManualImportState(
  page: Page,
  expected: Parameters<typeof expectManualImportState>[1],
): Promise<void> {
  const state = page.locator('manual-import-state');
  await expect(state).toBeVisible();
  await expect(async () => expectManualImportState(state, expected)).toPass({ timeout: 15000 });
}

test.describe('UX-007: manual import failure specificity', () => {
  test('detection-failure fixture surfaces a detection-specific Unsupported affordance', async ({
    page,
  }) => {
    await openManualImportAndUpload(page, 'unknown-harness.jsonl');

    // A fixture whose JSON shape matches no supported harness should not be
    // conflated with a generic "Import failed" message. The state panel must
    // show the Unsupported failure class and a detection-specific reason.
    await waitForManualImportState(page, {
      phase: 'unsupported',
      badgeText: 'Unsupported',
      hintIncludes: 'no transformer detected this bundle',
      hintExcludes: ['Import failed', 'Integrity Error', 'Unavailable'],
    });
  });

  test('ingestion-failure fixture surfaces a distinct ingestion-specific Unavailable affordance', async ({
    page,
  }) => {
    await openManualImportAndUpload(page, 'claude-partial-no-transcript.json');

    // The fixture is schema-detected as a Claude Code artifact, but it does not
    // contain a session transcript. After selecting a project and importing, the
    // ingestion stage must surface a specific error class, not a generic one.
    await page.locator('#project-select').selectOption('__new__');
    await page.locator('input[placeholder="New project name"]').fill('UX-007 Ingestion Failure');

    const sessionInput = page.locator('#session-input');
    await expect(sessionInput).not.toHaveValue('');

    await page.getByRole('button', { name: 'Import partial session' }).click();

    await waitForManualImportState(page, {
      phase: 'unavailable',
      badgeText: 'Unavailable',
      hintIncludes: 'missing_root_transcript',
      hintExcludes: [
        'no transformer detected this bundle',
        'Integrity check failed',
        'unknown error',
      ],
    });
  });

  test('failure classes are structurally distinct from the generic empty/idle state', async ({
    page,
  }) => {
    await page.goto('/#/manual-import');
    await expect(page.getByRole('heading', { name: 'Manual Import' })).toBeVisible();

    const state = page.locator('manual-import-state');
    await expect(state).toBeVisible();

    // The idle affordance is a neutral "Idle" badge with an upload hint. It
    // must not satisfy either the error or the empty-affordance selectors used
    // by the other failure assertions.
    const idle = await queryManualImportState(state);
    expect(idle.phase).toBe('idle');
    expect(idle.badgeText).toBe('Idle');
    expect(idle.badgeClass).not.toMatch(/unsupported|unavailable|integrity-error/);
    expect(idle.message).not.toContain('Import failed');
    expect(idle.message).not.toContain('Unsupported');
    expect(idle.message).not.toContain('Integrity Error');
    expect(idle.message).not.toContain('Unavailable');
  });
});
