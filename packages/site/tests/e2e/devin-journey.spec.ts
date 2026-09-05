import { expect, test } from '@playwright/test';
import {
  importDevinSession,
  openDevinSessionEvidence,
  switchSessionEvidenceTab,
} from './helpers/devin-manual-import.js';

const PROJECT_NAME = 'Devin Journey';
const SESSION_ID = 'test-sess';

test.describe('Devin session upload → drill-down journey', () => {
  test('UX-022: manual upload of a golden Devin bundle reaches the session dashboard', async ({
    page,
  }) => {
    const sessionId = await importDevinSession(page, PROJECT_NAME, SESSION_ID);
    expect(sessionId).not.toBe('');

    // Session Evidence heading for the imported session.
    await expect(page.getByRole('heading', { name: /Session Evidence/ })).toBeVisible();

    // The session is detected and ingested as the devin harness.
    await expect(page.getByText('Harness: devin')).toBeVisible();

    // The total token headline metric is rendered with a value and sample size.
    // The devin fixture produces 150 tokens from the ATIF final_metrics
    // (prompt 100 + completion 50 — cached is a subset of prompt, #323).
    const totalTokensCard = page.getByRole('button', { name: /150 token/ });
    await expect(totalTokensCard).toBeVisible();
    await expect(totalTokensCard).toContainText('n=1');

    // The Evidence and Transcript tabs are available for drill-down.
    await expect(page.getByText('Evidence', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Transcript', { exact: true }).first()).toBeVisible();

    // The component-facts section for tool/skill/agent activity is present.
    await expect(page.getByText('Tool / Skill / Agent activity')).toBeVisible();
  });

  test('UX-023: transcript drill-down shows messages and pagination, missing evidence is reported', async ({
    page,
  }) => {
    const sessionId = await importDevinSession(page, PROJECT_NAME, SESSION_ID);
    await openDevinSessionEvidence(page, sessionId);

    // The Evidence tab is the default; it reports that no evidence rows exist
    // because the pipeline currently does not back-fill turns/invocations tables.
    await expect(page.getByText('No evidence rows found.')).toBeVisible();

    // Switch to the Transcript tab.
    // Direct click is avoided because the hash-router currently strips the
    // `?view=transcript` query before the view can observe it (session-evidence
    // query parameters are not preserved across hashchange).
    await switchSessionEvidenceTab(page, 'transcript');
    await expect(page.getByText('Transcript', { exact: true }).first()).toHaveClass(/active/);

    // The four messages from the fixture transcript are surfaced from
    // normalized_events fallback.
    await expect(page.getByText('Hello')).toBeVisible();
    await expect(page.getByText('Hi there')).toBeVisible();
    await expect(page.getByText('Edit a file')).toBeVisible();
    await expect(page.getByText('Done')).toBeVisible();

    // Single-page transcript: both pagination controls are disabled.
    const previous = page.getByRole('button', { name: 'Previous' });
    const next = page.getByRole('button', { name: 'Next' });
    await expect(previous).toBeVisible();
    await expect(next).toBeVisible();
    await expect(previous).toBeDisabled();
    await expect(next).toBeDisabled();
  });

  test('UX-024: empty drill-down states are structurally distinct from error states', async ({
    page,
  }) => {
    const sessionId = await importDevinSession(page, PROJECT_NAME, SESSION_ID);
    await openDevinSessionEvidence(page, sessionId);

    // Missing drill-down data is reported by explicit empty notices...
    await expect(page.getByText('No evidence rows found.')).toBeVisible();
    await expect(page.getByText('No component activity found.')).toBeVisible();

    // ...not by a generic or global error banner.
    await expect(page.getByText('Session evidence failed to load.')).not.toBeVisible();
    await expect(page.locator('session-evidence-view').locator('.error')).not.toBeVisible();

    // The transcript tab has real data and therefore does not show its empty notice.
    await switchSessionEvidenceTab(page, 'transcript');
    await expect(page.getByText('No transcript messages found.')).not.toBeVisible();
  });
});
