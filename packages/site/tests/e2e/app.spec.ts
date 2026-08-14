import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';

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
  test('create project -> upload -> dashboard -> indicator drill-down -> transcript', async ({
    page,
  }) => {
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

    // Back to the dashboard, open the dedicated transcript page.
    await page.getByRole('link', { name: '← Back to Session' }).click();
    await page.getByRole('link', { name: 'View Session Transcript' }).click();
    await expect(page).toHaveURL(/#\/sessions\/.+\/transcript$/);
    await expect(page.getByRole('heading', { name: /^Transcript/ })).toBeVisible();

    const transcript = page.locator('session-transcript');
    await expect(transcript).toContainText('I fixed the bug');
    // Markdown was rendered ...
    await expect(transcript.locator('strong')).toHaveText('app.ts');
    // ... and DOMPurify stripped the injected event handler.
    expect(await page.content()).not.toContain('onerror');

    // No subagents on this session - no card row, single main column.
    await expect(page.locator('.subagent-row')).toHaveCount(0);
    await expect(page.locator('.transcript-column')).toHaveCount(1);

    await page.getByRole('link', { name: '← Back to Session' }).click();
    await expect(page.getByRole('heading', { name: 'claude-session.jsonl' })).toBeVisible();
  });

  test('uploads every supported format', async ({ page }) => {
    await createProject(page, 'Formats Project');
    await openProject(page, 'Formats Project');

    await page
      .locator('input[type="file"]')
      .setInputFiles([
        fixture('antigravity-session.json'),
        fixture('opencode-session.jsonl'),
        fixture('mcp-session.jsonl'),
        fixture('local-runner-session.jsonl'),
        fixture('agentic-pi-session.jsonl'),
      ]);

    await expect(page.locator('.session-item')).toHaveCount(5);
    // session-list renders into a shadow root, so a raw textContent() read
    // (which doesn't cross shadow boundaries) comes back empty; use
    // Playwright's own text matching, which pierces shadow DOM.
    const sessionList = page.locator('session-list');
    for (const source of ['antigravity', 'opencode codex', 'mcp', 'local runner', 'agentic pi']) {
      await expect(sessionList).toContainText(source, { ignoreCase: true });
    }
  });
});

test.describe('Rich session dashboard', () => {
  test('surfaces ai-title, token/model/skill breakdowns, cache diagnostics and message nesting', async ({
    page,
  }) => {
    await createProject(page, 'Rich Panel Project');
    await openProject(page, 'Rich Panel Project');

    await uploadFile(page, 'claude-rich-session.jsonl');

    // The ai-title CLI event overrides the filename as the session title.
    const sessionRow = page.locator('.session-item', { hasText: 'Rich Session Demo' });
    await expect(sessionRow).toBeVisible();
    await sessionRow.click();
    await expect(page.getByRole('heading', { name: 'Rich Session Demo' })).toBeVisible();

    // Token Usage breakdown: input/output/cache-write/cache-read panel.
    await expect(page.getByText('Cache Write')).toBeVisible();
    await expect(page.getByText('Cache Read')).toBeVisible();

    // Tool Result Tokens panel: estimated from the two tool_result payloads
    // ("review complete" -> ceil(15/4)=4, the failed bash result -> ceil(37/4)=10,
    // 14 total) as a percentage of total input volume (70 input + 1000 cache
    // write + 700 cache read = 1770) -> 0.8%. Always labeled an estimate.
    const toolTokensPanel = page.locator('.panel', { hasText: 'Tool Result Tokens' });
    await expect(toolTokensPanel).toBeVisible();
    await expect(toolTokensPanel).toContainText('(est.)');
    await expect(toolTokensPanel).toContainText('14');
    await expect(toolTokensPanel).toContainText('0.8%');

    // Models Used table lists both models this session used.
    const modelsPanel = page.locator('.panel', { hasText: 'Models Used' });
    await expect(modelsPanel).toBeVisible();
    await expect(modelsPanel).toContainText('claude-opus-5');
    await expect(modelsPanel).toContainText('claude-haiku-4-5');

    // Skills Used panel groups by skill name, with a total usage count.
    await expect(page.getByRole('heading', { name: 'Skills Used' })).toBeVisible();
    await expect(page.locator('.skill-name')).toHaveText('Skill');
    await expect(page.locator('.skill-usage')).toHaveText('Total usage: 1');
    await expect(page.locator('.skill-params')).toContainText('code-review');

    // Cache Diagnostics panel tallies the cache_miss_reason.
    const diagnosticsPanel = page.locator('.panel', { hasText: 'Cache Diagnostics' });
    await expect(diagnosticsPanel).toBeVisible();
    await expect(diagnosticsPanel.locator('.rank-item')).toContainText('tools changed');

    await page.getByText('View all diagnostics →').click();
    await expect(page.getByRole('heading', { name: 'Cache Diagnostics' })).toBeVisible();
    await expect(page.locator('events-table')).toContainText('Cache miss: tools_changed');

    // The metadata cell shows a preview, exposes the full JSON as a hover
    // tooltip, and expands inline on click.
    const metadataCell = page.locator('.metadata-cell').first();
    await expect(metadataCell).toHaveAttribute('title', /cache_miss_reason/);
    await expect(metadataCell.locator('.metadata-full')).toHaveCount(0);
    await metadataCell.click();
    await expect(metadataCell.locator('.metadata-full')).toContainText('cache_miss_reason');

    // Task reminders: two task_reminder snapshots, both tasks completed by
    // the second one (1s apart) -> Total Tasks 2, both completed, avg 1s.
    await page.getByRole('link', { name: '← Back to Session' }).click();
    const tasksCard = page.locator('metrics-card', { hasText: 'Total Tasks' });
    await expect(tasksCard).toContainText('2');
    await expect(page.locator('metrics-card', { hasText: 'Tasks Completed' })).toContainText(
      'of 2 total',
    );
    await expect(page.locator('metrics-card', { hasText: 'Avg Time / Task' })).toContainText('1s');

    await tasksCard.click();
    await expect(page.getByRole('heading', { name: 'Tasks' })).toBeVisible();
    await expect(page.locator('events-table')).toContainText('Investigate cache');
    await expect(page.locator('events-table')).toContainText('Write report');
    await expect(page.locator('events-table')).toContainText('completed');

    // Turns indicator: the assistant reply nests under the user message it
    // replied to (matching uuid); the second assistant turn's immediate
    // parent was a tool-result-only entry (never a transcript message), so
    // it has no resolvable parent here and stays at the top level.
    await page.getByRole('link', { name: '← Back to Session' }).click();
    await page.locator('metrics-card', { hasText: 'Total Interactions' }).click();
    await expect(page.getByRole('heading', { name: 'Interactions (Turns)' })).toBeVisible();

    const rootNodes = page.locator('.message-tree > .message-node');
    await expect(rootNodes).toHaveCount(2);
    const parentNode = page.locator('.message-node.root', {
      hasText: 'Investigate cache behavior',
    });
    await expect(parentNode.locator('.message-children')).toContainText('Investigating now.');
    const orphanNode = page.locator('.message-node.root', { hasText: 'Done investigating.' });
    await expect(orphanNode.locator('.message-children')).toHaveCount(0);
  });
});

test.describe('Tools indicator', () => {
  test('filters tool calls and expands a row to show inputs and result', async ({ page }) => {
    await createProject(page, 'Tools Panel Project');
    await openProject(page, 'Tools Panel Project');

    await uploadFile(page, 'claude-rich-session.jsonl');
    const sessionRow = page.locator('.session-item', { hasText: 'Rich Session Demo' });
    await sessionRow.click();

    await page.locator('metrics-card', { hasText: 'Tools Used' }).click();
    await expect(page.getByRole('heading', { name: 'Tool Executions' })).toBeVisible();

    // The fixture has a Skill call and a failed Bash call, but Skill (and
    // Agent) invocations have their own dedicated indicator and are excluded
    // from the generic tools list - only the Bash call shows here.
    await expect(page.locator('.tool-row')).toHaveCount(1);
    const failedRow = page.locator('.tool-row', { hasText: 'Bash' });
    await expect(failedRow).toHaveClass(/tool-row-error/);
    await expect(failedRow).toContainText('Error');

    // Expanding the failed row reveals its inputs and result.
    await failedRow.click();
    const detailRow = page.locator('.tool-detail-row');
    await expect(detailRow).toContainText('"command": "false"');
    await expect(detailRow).toContainText('bash: command failed with exit code 1');

    // Errors-only filter narrows to just the failed call (already the only row here).
    await page.getByLabel('Errors only').check();
    await expect(page.locator('.tool-row')).toHaveCount(1);
    await expect(page.locator('.tool-row')).toContainText('Bash');
    await page.getByLabel('Errors only').uncheck();

    // The by-tool dropdown only offers generic tools - Skill is not one of them.
    const toolOptions = await page.locator('.tool-filters select option').allTextContents();
    expect(toolOptions).toContain('Bash');
    expect(toolOptions).not.toContain('Skill');

    // Free-text filter matches against the result content too.
    await page.locator('.tool-filters input[type="text"]').fill('command failed');
    await expect(page.locator('.tool-row')).toHaveCount(1);
    await expect(page.locator('.tool-row')).toContainText('Bash');
  });
});

test.describe('Skills indicator', () => {
  test('shows skill invocations with inputs, result, and linked follow-up content', async ({
    page,
  }) => {
    await createProject(page, 'Skills Panel Project');
    await openProject(page, 'Skills Panel Project');

    await uploadFile(page, 'claude-rich-session.jsonl');
    const sessionRow = page.locator('.session-item', { hasText: 'Rich Session Demo' });
    await sessionRow.click();

    await page.locator('metrics-card', { hasText: 'Skills' }).click();
    await expect(page.getByRole('heading', { name: 'Skill Invocations' })).toBeVisible();

    await expect(page.locator('.tool-row')).toHaveCount(1);
    const row = page.locator('.tool-row');
    await expect(row).toContainText('code-review');

    await row.click();
    const detailRow = page.locator('.tool-detail-row');
    await expect(detailRow).toContainText('review complete');
    // The follow-up text the model produced right after the Skill's
    // tool_result ("Done investigating.", uuid u2 -> a2's parent_uuid u2).
    await expect(detailRow).toContainText('Done investigating.');
  });
});

test.describe('Agents indicator', () => {
  test('shows agent invocations, excluded from the tools list, with inputs and result', async ({
    page,
  }) => {
    await createProject(page, 'Agents Panel Project');
    await openProject(page, 'Agents Panel Project');

    await uploadFile(page, 'claude-session.jsonl');
    const sessionRow = page.locator('.session-item', { hasText: 'claude-session.jsonl' });
    await sessionRow.click();

    // The Agent call (toolu_125, "verify build") doesn't count as a tool call.
    await page.locator('metrics-card', { hasText: 'Tools Used' }).click();
    await expect(page.getByRole('heading', { name: 'Tool Executions' })).toBeVisible();
    await expect(page.locator('.tool-row')).toHaveCount(2);
    await expect(page.locator('.tool-row', { hasText: 'Agent' })).toHaveCount(0);

    await page.getByRole('link', { name: '← Back to Session' }).click();
    await page.locator('metrics-card', { hasText: 'Agents' }).click();
    await expect(page.getByRole('heading', { name: 'Agent Invocations' })).toBeVisible();

    await expect(page.locator('.tool-row')).toHaveCount(1);
    const row = page.locator('.tool-row');
    await expect(row).toContainText('verify build');

    await row.click();
    const detailRow = page.locator('.tool-detail-row');
    await expect(detailRow).toContainText('build verified');
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

    await expect(page.locator('.session-item', { hasText: 'dropped-session.jsonl' })).toBeVisible();
  });
});

test.describe('Subagent folder ingestion', () => {
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

  test('folds subagent tokens/models into the session when dropped alongside the transcript', async ({
    page,
  }) => {
    await createProject(page, 'Subagent Combined Project');
    await openProject(page, 'Subagent Combined Project');

    await dropFixtures(page, [
      'claude-session-with-subagent.jsonl',
      'agent-e2esub1.jsonl',
      'agent-e2esub1.meta.json',
    ]);

    const sessionRow = page.locator('.session-item', {
      hasText: 'claude-session-with-subagent.jsonl',
    });
    await expect(sessionRow).toBeVisible();
    await sessionRow.click();

    // total_tokens is input+output only (cache tokens excluded - see
    // SessionBuilder.finalize): main (100+50) + subagent (20+10) = 180.
    const totalTokensCard = page.locator('metrics-card', { hasText: 'Total Tokens' });
    await expect(totalTokensCard).toContainText('180');

    const subagentsPanel = page.locator('.panel', { hasText: 'Subagents' });
    await expect(subagentsPanel).toBeVisible();
    await expect(subagentsPanel).toContainText('Handle the subtask');
    await expect(subagentsPanel).toContainText('general-purpose');
    await expect(subagentsPanel).toContainText('claude-haiku-4-5');

    const modelsPanel = page.locator('.panel', { hasText: 'Models Used' });
    await expect(modelsPanel).toContainText('claude-sonnet-5');
    await expect(modelsPanel).toContainText('claude-haiku-4-5');
  });

  test('attaches subagent data to an already-uploaded session from the session page', async ({
    page,
  }) => {
    await createProject(page, 'Subagent Post-hoc Project');
    await openProject(page, 'Subagent Post-hoc Project');

    await uploadFile(page, 'claude-session-with-subagent.jsonl');
    const sessionRow = page.locator('.session-item', {
      hasText: 'claude-session-with-subagent.jsonl',
    });
    await expect(sessionRow).toBeVisible();
    await sessionRow.click();

    // Before attaching: just the main transcript's 150 tokens, no Subagents panel.
    await expect(page.locator('metrics-card', { hasText: 'Total Tokens' })).toContainText('150');
    await expect(page.locator('.panel', { hasText: 'Subagents' })).toHaveCount(0);

    await dropFixtures(page, ['agent-e2esub1.jsonl', 'agent-e2esub1.meta.json']);

    // 150 (main) + 30 (subagent input+output, cache excluded) = 180.
    await expect(page.locator('metrics-card', { hasText: 'Total Tokens' })).toContainText('180');
    const subagentsPanel = page.locator('.panel', { hasText: 'Subagents' });
    await expect(subagentsPanel).toBeVisible();
    await expect(subagentsPanel).toContainText('Handle the subtask');
  });

  test('opens a subagent transcript column alongside the main transcript, closable independently', async ({
    page,
  }) => {
    await createProject(page, 'Subagent Transcript Project');
    await openProject(page, 'Subagent Transcript Project');

    await dropFixtures(page, [
      'claude-session-with-subagent.jsonl',
      'agent-e2esub1.jsonl',
      'agent-e2esub1.meta.json',
    ]);

    const sessionRow = page.locator('.session-item', {
      hasText: 'claude-session-with-subagent.jsonl',
    });
    await sessionRow.click();
    await page.getByRole('link', { name: 'View Session Transcript' }).click();
    await expect(page).toHaveURL(/#\/sessions\/.+\/transcript$/);

    // Main transcript column, full width - no subagent column open yet, no
    // top row: the card is rendered inline in the conversation instead.
    await expect(page.locator('.transcript-column')).toHaveCount(1);
    const mainColumn = page.locator('.transcript-column').nth(0);
    const card = page.locator('.subagent-card', { hasText: 'Handle the subtask' });
    await expect(card).toBeVisible();

    // Positioned after "Working on it." (the message closest to the
    // subagent's own started_at), not before "Do the main task" at the top -
    // both live inside session-transcript's own shadow root, so walk it
    // directly rather than relying on innerText to flatten nested shadow DOM.
    const order = await mainColumn
      .locator('session-transcript')
      .evaluate((el) =>
        Array.from(
          (el as unknown as { shadowRoot: ShadowRoot }).shadowRoot.querySelectorAll(
            '.message, .subagent-row',
          ),
        ).map((node) => node.textContent ?? ''),
      );
    const mainIndex = order.findIndex((text) => text.includes('Working on it.'));
    const cardIndex = order.findIndex((text) => text.includes('Handle the subtask'));
    expect(mainIndex).toBeGreaterThanOrEqual(0);
    expect(cardIndex).toBeGreaterThan(mainIndex);

    // Clicking the card navigates to the agent-scoped route and opens a
    // second column showing that subagent's own transcript, side by side.
    // (agentId is parsed from the filename "agent-e2esub1.jsonl", stripping
    // the "agent-" prefix - see SUBAGENT_FILE_PATTERN in lib/subagents.ts.)
    await card.click();
    await expect(page).toHaveURL(/#\/sessions\/.+\/transcript\/e2esub1$/);
    await expect(page.locator('.transcript-column')).toHaveCount(2);
    const subagentColumn = page.locator('.transcript-column').nth(1);
    await expect(subagentColumn).toContainText('Subtask prompt');
    await expect(subagentColumn).toContainText('Subtask done.');
    // The main column's content is unaffected.
    await expect(page.locator('.transcript-column').nth(0)).toContainText('Do the main task');

    // Closing via the column's own close button removes just that column and
    // navigates back to the bare transcript route.
    await subagentColumn.locator('.column-close').click();
    await expect(page).toHaveURL(/#\/sessions\/.+\/transcript$/);
    await expect(page.locator('.transcript-column')).toHaveCount(1);
  });

  test('deep-links directly into the split view via the /transcript/:agentId route', async ({
    page,
  }) => {
    await createProject(page, 'Subagent Deep Link Project');
    await openProject(page, 'Subagent Deep Link Project');

    await dropFixtures(page, [
      'claude-session-with-subagent.jsonl',
      'agent-e2esub1.jsonl',
      'agent-e2esub1.meta.json',
    ]);

    const sessionRow = page.locator('.session-item', {
      hasText: 'claude-session-with-subagent.jsonl',
    });
    await sessionRow.click();
    const sessionUrl = page.url();
    const sessionId = sessionUrl.match(/#\/sessions\/([^/]+)/)?.[1];

    // agentId is parsed from the filename "agent-e2esub1.jsonl", stripping
    // the "agent-" prefix - see SUBAGENT_FILE_PATTERN in lib/subagents.ts.
    await page.goto(`${sessionUrl.split('#')[0]}#/sessions/${sessionId}/transcript/e2esub1`);

    await expect(page.locator('.transcript-column')).toHaveCount(2);
    const subagentColumn = page.locator('.transcript-column').nth(1);
    await expect(subagentColumn).toContainText('Subtask done.');

    const mainColumn = page.locator('.transcript-column').nth(0);
    const activeCard = mainColumn.locator('.subagent-card.active', {
      hasText: 'Handle the subtask',
    });
    await expect(activeCard).toBeVisible();
  });

  test('re-uploading the same session updates it in place instead of creating a duplicate', async ({
    page,
  }) => {
    await createProject(page, 'Subagent Dedup Project');
    await openProject(page, 'Subagent Dedup Project');

    await uploadFile(page, 'claude-session-with-subagent.jsonl');
    await expect(page.locator('.session-item')).toHaveCount(1);

    // Re-upload the exact same transcript.
    await uploadFile(page, 'claude-session-with-subagent.jsonl');

    // Still exactly one session - the re-upload updated it, not duplicated it.
    await expect(page.locator('.session-item')).toHaveCount(1);
    await expect(page.locator('.project-card')).toHaveCount(0); // sanity: still on project view, not home
  });
});

test.describe('Persistence (OPFS)', () => {
  test('projects and sessions survive a page reload', async ({ page }) => {
    await createProject(page, 'Persist Project');
    await openProject(page, 'Persist Project');
    await uploadFile(page, 'claude-session.jsonl');
    await expect(page.locator('.session-item', { hasText: 'claude-session.jsonl' })).toBeVisible();

    await page.reload();

    // The hash route is preserved across a reload, so we land back on the
    // project view (not the home page) - verify the session survived there.
    await expect(page.getByRole('heading', { name: 'Persist Project' })).toBeVisible();
    await expect(page.locator('.session-item', { hasText: 'claude-session.jsonl' })).toBeVisible();

    // The project also still shows up from the home page.
    await openProject(page, 'Persist Project');
    await expect(page.locator('.session-item', { hasText: 'claude-session.jsonl' })).toBeVisible();
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

  test('session transcript page shows a notice for unknown sessions', async ({ page }) => {
    await page.goto('/#/sessions/does-not-exist/transcript');
    await expect(page.getByText(/Session not found/)).toBeVisible();
  });
});
