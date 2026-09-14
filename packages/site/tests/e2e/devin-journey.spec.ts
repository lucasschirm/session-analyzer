import { expect, test } from '@playwright/test';
import { assertNoErrorBoundary, expectRenderedGeometry } from './helpers/chart-content';
import { devinModelSwitchFiles } from './helpers/devin-fixtures.js';
import {
  importDevinSession,
  openDevinSessionEvidence,
  switchSessionEvidenceTab,
} from './helpers/devin-manual-import.js';

const PROJECT_NAME = 'Devin Journey';
const SESSION_ID = 'test-sess';

const MODEL_SWITCH_PROJECT = 'Devin Model Switch';
const MODEL_SWITCH_SESSION_ID = 'devin-ms-sess';

test.describe('Devin session upload → drill-down journey', () => {
  test('UX-022: manual upload of a golden Devin bundle reaches the session dashboard', async ({
    page,
  }) => {
    const sessionId = await importDevinSession(page, PROJECT_NAME, SESSION_ID);
    expect(sessionId).not.toBe('');

    // Session Evidence heading for the imported session shows its title.
    await expect(
      page.locator('session-evidence-view').getByRole('heading', { level: 1 }),
    ).toBeVisible();

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

test.describe('Devin model-switch session: context growth, tools, and drawer', () => {
  test('UX-037: context-growth chart is non-flat across two model-switch steps', async ({
    page,
  }) => {
    const sessionId = await importDevinSession(
      page,
      MODEL_SWITCH_PROJECT,
      MODEL_SWITCH_SESSION_ID,
      devinModelSwitchFiles(),
    );
    await openDevinSessionEvidence(page, sessionId);

    const contextGrowth = page.locator('session-evidence-view #context-growth');
    await expect(contextGrowth).toBeVisible({ timeout: 15000 });

    const chart = contextGrowth
      .locator('analytics-chart')
      .filter({ has: page.getByRole('heading', { name: 'Context growth across session' }) });
    await expect(chart).toBeVisible({ timeout: 15000 });

    // Real SVG marks — not a legend-only or empty-state render.
    await expectRenderedGeometry(chart, { timeout: 15000 });
    await assertNoErrorBoundary(chart);

    // Data correctness via the accessible table fallback. The modelSwitch
    // fixture has two ATIF agent-generation steps with per-step metrics:
    //   step 1 (glm-5-2): prompt 18071 / cached 11874 / completion 59
    //     -> context = 18071 + 11874 = 29945
    //   step 2 (swe-1-7): prompt 17033 / cached 11136 / completion 37
    //     -> context = 17033 + 11136 = 28169
    // The flat-chart bug produced a single context value for all four
    // points; the fix links each per-step usage record to its turn via
    // parentId so the context level changes between the two steps.
    await chart.locator('summary', { hasText: 'View as table' }).click();
    const rows = chart.locator('tbody tr');
    await expect(rows.first()).toBeVisible({ timeout: 10000 });

    // Two distinct context levels must appear (non-flat chart).
    // Row counts are derived from the modelSwitchBundle fixture: 4 messages
    // (2 user + 2 assistant) → 2 rows per context level. Editing the
    // fixture's message count or per-step token values requires updating
    // these assertions.
    await expect(chart.locator('tbody tr', { hasText: 'context 29,945 tokens' })).toHaveCount(2);
    await expect(chart.locator('tbody tr', { hasText: 'context 28,169 tokens' })).toHaveCount(2);

    // Generation tokens are attributed per-step, not session-aggregate.
    await expect(chart.locator('tbody tr', { hasText: 'generation 59 tokens' })).toHaveCount(1);
    await expect(chart.locator('tbody tr', { hasText: 'generation 37 tokens' })).toHaveCount(1);
  });

  test('UX-038: context drawer shows the assistant message body, not "No content recorded"', async ({
    page,
  }) => {
    const sessionId = await importDevinSession(
      page,
      MODEL_SWITCH_PROJECT,
      MODEL_SWITCH_SESSION_ID,
      devinModelSwitchFiles(),
    );
    await openDevinSessionEvidence(page, sessionId);

    const contextGrowth = page.locator('session-evidence-view #context-growth');
    await expect(contextGrowth).toBeVisible({ timeout: 15000 });
    const chart = contextGrowth.locator('analytics-chart');
    await expect(chart).toBeVisible({ timeout: 15000 });

    // Wait for the chart data to load, then open the accessible table.
    await expect(contextGrowth.locator('.summary-toggle')).toBeVisible({ timeout: 15000 });
    await chart.locator('summary', { hasText: 'View as table' }).click();

    // The second row is the first assistant message ("Got it, running as GLM-5.2.").
    const assistantRow = chart.locator('tbody tr').nth(1);
    await expect(assistantRow).toBeVisible({ timeout: 10000 });
    await assistantRow.click();

    // The drawer opens.
    const drawer = page.locator('session-evidence-view session-context-drawer');
    const drawerPanel = drawer.locator('.drawer-panel');
    await expect(drawerPanel).toBeVisible({ timeout: 5000 });

    // The Message Content section shows the assistant answer (markdown-rendered),
    // not the empty-state "No content recorded for this message." notice.
    const contentSection = drawer.locator('.content-section');
    await expect(contentSection.getByText('Message Content')).toBeVisible();
    await expect(contentSection.locator('.empty-text')).not.toBeVisible();
    await expect(contentSection).toContainText('Got it, running as GLM-5.2.');
  });
});
