import { expect, test } from '@playwright/test';
import { assertNoErrorBoundary, expectRenderedGeometry } from './helpers/chart-content';
import { devinModelSwitchFiles, devinUsageAttributionFiles } from './helpers/devin-fixtures.js';
import { importDevinSession, openDevinSessionEvidence } from './helpers/devin-manual-import.js';

const PROJECT_NAME = 'Devin Journey';
const SESSION_ID = 'test-sess';

const MODEL_SWITCH_PROJECT = 'Devin Model Switch';
const MODEL_SWITCH_SESSION_ID = 'devin-ms-sess';

// The usage-attribution fixture: an assistant node dispatching `exec` (a
// builtin no promoted availability list offers), a tool-result node answering
// it, and a node invoking the cog-declared `add-e2e-test` skill.
const USAGE_PROJECT = 'Devin Usage Attribution';
const USAGE_SESSION_ID = 'devin-usage-sess';

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

    // The Evidence rows section is gone from the overview; the transcript is a
    // drill-down behind the header action, and the session's own drill-down
    // entry is the Tool / Skill / Agent activity section.
    await expect(page.getByRole('heading', { name: 'Evidence', exact: true })).toHaveCount(0);
    await expect(
      page.getByRole('heading', { name: 'Tool / Skill / Agent activity' }),
    ).toBeVisible();
    await expect(page.locator('component-utilization-panel .panel-title')).toContainText(
      'Session Component Availability & Invocations',
    );
  });

  test('UX-023: transcript drill-down shows messages and pagination', async ({ page }) => {
    const sessionId = await importDevinSession(page, PROJECT_NAME, SESSION_ID);
    await openDevinSessionEvidence(page, sessionId);

    // The overview renders no transcript list; the header action routes to
    // `?view=transcript`, which is where the messages live.
    await expect(page.locator('session-evidence-transcript')).toHaveCount(0);
    await page.getByRole('link', { name: 'View Full Transcript' }).click();
    await expect(page.getByRole('heading', { name: 'Transcript' })).toBeVisible({
      timeout: 10000,
    });

    // The four messages from the fixture transcript are surfaced.
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

    // Missing drill-down data is reported by an explicit empty notice...
    await expect(page.getByText('No validation records found.')).toBeVisible();

    // ...not by a generic or global error banner.
    await expect(page.getByText('Session evidence failed to load.')).not.toBeVisible();
    await expect(page.locator('session-evidence-view').locator('.error')).not.toBeVisible();

    // The removed sections leave no placeholder or empty state behind.
    await expect(page.locator('session-evidence-evidence')).toHaveCount(0);
    await expect(page.locator('session-evidence-tree')).toHaveCount(0);

    // The transcript has real data and therefore does not show its empty notice.
    await page.getByRole('link', { name: 'View Full Transcript' }).click();
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
    // fixture has two ATIF agent-generation steps with per-step metrics.
    // ATIF's `prompt_tokens` is cache-INCLUSIVE, and the `inputTokens`
    // payload field is now cache-EXCLUSIVE (shared contract), so
    // `context = (prompt - cached) + cached = prompt`:
    //   step 1 (glm-5-2): prompt 18071 / cached 11874 / completion 59
    //     -> context = 18071
    //   step 2 (swe-1-7): prompt 17033 / cached 11136 / completion 37
    //     -> context = 17033
    // The flat-chart bug produced a single context value for all four
    // points; the fix links each per-step usage record to its turn via
    // parentId so the context level changes between the two steps. (The
    // earlier `prompt + cached` values asserted here double-counted the
    // cached subset.)
    await chart.locator('summary', { hasText: 'View as table' }).click();
    const rows = chart.locator('tbody tr');
    await expect(rows.first()).toBeVisible({ timeout: 10000 });

    // Two distinct context levels must appear (non-flat chart).
    // Row counts are derived from the modelSwitchBundle fixture: 4 messages
    // (2 user + 2 assistant) → 2 rows per context level. Editing the
    // fixture's message count or per-step token values requires updating
    // these assertions.
    await expect(chart.locator('tbody tr', { hasText: 'context 18,071 tokens' })).toHaveCount(2);
    await expect(chart.locator('tbody tr', { hasText: 'context 17,033 tokens' })).toHaveCount(2);

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

test.describe('Devin usage attribution: component availability, message domains, drawer raw view', () => {
  test('UX-039: an invoked tool, skill, and agent each report as Used', async ({ page }) => {
    const sessionId = await importDevinSession(
      page,
      USAGE_PROJECT,
      USAGE_SESSION_ID,
      devinUsageAttributionFiles(),
    );
    await openDevinSessionEvidence(page, sessionId);

    const panel = page.locator('component-utilization-panel');
    await expect(panel).toBeVisible();

    // Tools: `exec` is invoked but offered by no promoted availability list, so
    // it must land in the Used column. The bug this covers reported
    // "Tools 5 0 5" — every component available, none used — for Devin
    // sessions that had hundreds of tool calls.
    const toolsRow = panel.locator('tbody tr', { hasText: 'Tools' });
    await expect(toolsRow.locator('td').nth(1)).toHaveText('5');
    await expect(toolsRow.locator('td').nth(2)).toHaveText('1');
    await expect(toolsRow.locator('td').nth(3)).toHaveText('4');

    // Skills: declared by a `skill/add-e2e-test` cog AND invoked — one
    // component reported as both available and used, never duplicated.
    const skillsRow = panel.locator('tbody tr', { hasText: 'Skills' });
    await expect(skillsRow.locator('td').nth(1)).toHaveText('1');
    await expect(skillsRow.locator('td').nth(2)).toHaveText('1');
    await expect(skillsRow.locator('td').nth(3)).toHaveText('0');

    await panel.getByRole('button', { name: /Tools/ }).click();
    await expect(panel.locator('.pill.used')).toHaveText(['tool/exec']);
    // Order follows the exposure rows, so compare the set.
    const unusedPills = await panel.locator('.pill.unused').allTextContents();
    expect(unusedPills.sort()).toEqual(
      [
        'tool/mcp_call_tool',
        'tool/mcp_list_servers',
        'tool/mcp_list_tools',
        'tool/mcp_read_resource',
      ].sort(),
    );

    // The same attribution drives the Tool / Skill / Agent activity table: one
    // row per used component, labeled by `kind/nativeId` (never the raw
    // canonical id, per never-display-raw-ids.md) and carrying its real
    // invocation count.
    const activity = page.locator('#component-activity');
    const activityRows = activity.locator('.component-table tbody tr');
    await expect(activityRows).toHaveCount(2);
    const activityTexts = (await activityRows.allTextContents()).map((text) =>
      text.replaceAll(/\s+/g, ' ').trim(),
    );
    expect(activityTexts.some((t) => /tool\/exec.*Invocations: 1/.test(t))).toBe(true);
    expect(activityTexts.some((t) => /skill\/add-e2e-test.*Invocations: 1/.test(t))).toBe(true);
  });

  test('UX-041: context-growth bars separate Tool, Skill, and Agent messages', async ({ page }) => {
    const sessionId = await importDevinSession(
      page,
      USAGE_PROJECT,
      USAGE_SESSION_ID,
      devinUsageAttributionFiles(),
    );
    await openDevinSessionEvidence(page, sessionId);

    const contextGrowth = page.locator('session-evidence-view #context-growth');
    await expect(contextGrowth).toBeVisible({ timeout: 15000 });
    const chart = contextGrowth.locator('analytics-chart');
    await expectRenderedGeometry(chart, { timeout: 15000 });

    // The legend names every color the chart can use, so the encoding is
    // documented rather than decorative.
    await expect(contextGrowth.locator('.kind-legend-item')).toHaveText([
      'Message',
      'Tool call',
      'Skill call',
      'Agent call',
    ]);

    // Color-independent: the accessible table fallback repeats the domain in
    // the row label. Node 1 (the user prompt) keeps the plain label.
    await chart.locator('summary', { hasText: 'View as table' }).click();
    await expect(chart.locator('tbody tr', { hasText: 'Message #1 (user): context' })).toHaveCount(
      1,
    );
    await expect(
      chart.locator('tbody tr', { hasText: 'Message #2 (assistant, tool invocation)' }),
    ).toHaveCount(1);
    await expect(
      chart.locator('tbody tr', { hasText: 'Message #3 (tool, tool invocation)' }),
    ).toHaveCount(1);
    await expect(
      chart.locator('tbody tr', { hasText: 'Message #4 (assistant, skill invocation)' }),
    ).toHaveCount(1);
  });

  test('UX-042: the message drawer toggles between parsed and raw JSON', async ({ page }) => {
    const sessionId = await importDevinSession(
      page,
      USAGE_PROJECT,
      USAGE_SESSION_ID,
      devinUsageAttributionFiles(),
    );
    await openDevinSessionEvidence(page, sessionId);

    const chart = page.locator('session-evidence-view #context-growth analytics-chart');
    await expect(chart).toBeVisible({ timeout: 15000 });
    await chart.locator('summary', { hasText: 'View as table' }).click();
    await chart.locator('tbody tr').nth(1).click();

    const drawer = page.locator('session-evidence-view session-context-drawer');
    await expect(drawer.locator('.drawer-panel')).toBeVisible({ timeout: 5000 });
    // Row 2 of the table is the assistant node that dispatched `exec`, so the
    // drawer names the domain the bar's color encoded.
    await expect(drawer.locator('.kind-badge')).toHaveText('tool message');

    const content = drawer.locator('.content-section');
    await expect(content.getByRole('heading', { name: 'Message Content' })).toBeVisible();

    // Parsed is the default view.
    await expect(content.locator('.view-toggle button[aria-pressed="true"]')).toHaveText([
      'Parsed',
    ]);
    await expect(content.locator('pre.raw-json')).toHaveCount(0);

    await content.getByRole('button', { name: 'Raw' }).click();
    const json = content.locator('pre.raw-json');
    await expect(json).toBeVisible();
    // The raw view is the whole message record, formatted — not just its body.
    const parsed = await json.textContent();
    expect(parsed).toContain('"messageId"');
    expect(parsed).toContain('"contextTokens"');
    expect(parsed).toContain('"invocationKind"');
    expect(JSON.parse(parsed ?? '{}')).toMatchObject({ role: 'assistant' });

    // And it switches back.
    await content.getByRole('button', { name: 'Parsed' }).click();
    await expect(content.locator('pre.raw-json')).toHaveCount(0);
    await expect(content).toContainText('Running exec');
  });

  test('UX-043: the session duration card is presented in whole minutes', async ({ page }) => {
    const sessionId = await importDevinSession(
      page,
      USAGE_PROJECT,
      USAGE_SESSION_ID,
      devinUsageAttributionFiles(),
    );
    await openDevinSessionEvidence(page, sessionId);

    const duration = page
      .locator('metrics-card')
      .filter({ hasText: 'Session duration (min)' })
      .first();
    await expect(duration).toBeVisible();
    // e.g. "1.667 minutes" is noise on a wall-clock duration card.
    await expect(duration.locator('.value')).toHaveText(/\d+ minutes/);
    await expect(duration.locator('.value')).not.toContainText('.');
  });
});
