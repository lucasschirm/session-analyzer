import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';
import { buildFailingQueryWorker, installFailingWorker } from './helpers/worker-failure';

/**
 * E2E coverage for the redesigned Session Evidence page (issue #172):
 * breadcrumb + header card, turn timeline, and the fresh full-detail events
 * table (built per `.agents/skills/filterable-table-pattern`, backed by the
 * non-paginated `getSessionEvents`/`getTurnTimeline` DTOs from issue #169 —
 * never the old cursor-paginated `getEvidencePages`).
 *
 * Catalog IDs: UX-031 (full journey + header/timeline/table render, against
 * a really-ingested session), UX-032 (toolbar filters, AND-combined, live
 * counter), UX-033 (timeline click applies/clears a turn filter chip),
 * UX-034 (error-row expand shows payload JSON), UX-035 (empty vs error
 * affordances on the events table). See
 * `docs/superpowers/plans/2026-08-27-e2e-coverage-enhancement.md` §6.1 and
 * §9 for why UX-032/033/034/035's "empty" case run against a canned worker
 * rather than a really-ingested session.
 */

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

function fixture(name: string): string {
  return path.join(FIXTURES_DIR, name);
}

/**
 * Import a session via the Manual Import flow and click through to its
 * Session Evidence page. Returns the analytics-internal session id parsed
 * from the resulting URL. Mirrors `importAndOpenSession` in `app.spec.ts`.
 */
async function importAndOpenSession(
  page: Page,
  projectName: string,
  fileNames: string[],
): Promise<string> {
  await page.goto('/#/manual-import');
  await expect(page.getByRole('heading', { name: 'Manual Import' })).toBeVisible();

  const filePaths = fileNames.map((f) => fixture(f));
  await page.locator('input[type="file"]').setInputFiles(filePaths);
  await expect(page.getByRole('heading', { name: 'Harness' })).toBeVisible({ timeout: 15000 });

  const projectSelect = page.locator('#project-select');
  await projectSelect.selectOption('__new__');
  await page.locator('input[placeholder="New project name"]').fill(projectName);

  const sessionInput = page.locator('#session-input');
  await expect(sessionInput).not.toHaveValue('');

  await page.getByRole('button', { name: 'Import partial session' }).click();
  await expect(page.getByRole('button', { name: 'View session' })).toBeVisible({
    timeout: 30000,
  });
  await page.getByRole('button', { name: 'View session' }).click();

  await expect(page).toHaveURL(/#\/sessions\//);
  const url = page.url();
  const match = url.match(/#\/sessions\/([^?]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}

const TOKEN = {
  analysisReleaseId: 'rel-1',
  generationId: 'gen-1',
  comparabilityGroupId: 'cgrp-session',
  eligibleN: 1,
  knownN: 1,
  unknownCount: 0,
  coverage: 'complete',
  measurementClass: 'observed',
  confidence: 'high',
  metricVersion: '0.1.0',
  evidenceLinks: [],
};

/** Canned `session.getSessionEvents` payload: one Tool row, one failed Bash row, one Skill row. */
const CANNED_EVENTS = [
  {
    id: 'inv-read',
    timestamp: '2026-08-11T10:00:00.000Z',
    turnNumber: 1,
    kind: 'tool',
    name: 'Read',
    target: 'src/index.ts',
    tokens: 42,
    durationMs: 120,
    status: 'completed',
    inputPayload: { payloadId: 'p1', content: '{"path":"src/index.ts"}', truncated: false },
    resultPayload: { payloadId: 'p2', content: '{"ok":true}', truncated: false },
  },
  {
    id: 'inv-bash',
    timestamp: '2026-08-11T10:00:05.000Z',
    turnNumber: 2,
    kind: 'tool',
    name: 'Bash',
    target: undefined,
    status: 'failed',
    inputPayload: { payloadId: 'p3', content: '{"command":"false"}', truncated: false },
    resultPayload: {
      payloadId: 'p4',
      content: '{"error":"command failed with exit code 1"}',
      truncated: false,
    },
  },
  {
    id: 'inv-skill',
    timestamp: '2026-08-11T10:00:10.000Z',
    turnNumber: 3,
    kind: 'skill',
    name: 'code-review',
    status: 'completed',
    inputPayload: { payloadId: 'p5', content: '{"effort":"high"}', truncated: false },
  },
];

const CANNED_TIMELINE = {
  token: TOKEN,
  sessionId: 'canned-session',
  totalDurationMs: 12000,
  segments: [
    { kind: 'user', startMs: 0, durationMs: 3000, sourceId: 'inv-read' },
    {
      kind: 'invocation',
      startMs: 3000,
      durationMs: 6000,
      invocationKind: 'tool',
      sourceId: 'inv-bash',
    },
    {
      kind: 'invocation',
      startMs: 9000,
      durationMs: 3000,
      invocationKind: 'skill',
      sourceId: 'inv-skill',
    },
  ],
};

/** `(view, method)` -> canned successful result. Anything else falls back per `defaultFor`. */
const CANNED_RESULTS: Record<string, unknown> = {
  'session.getSummary': {
    token: TOKEN,
    sessionId: 'canned-session',
    rootSessionId: 'canned-session',
    harness: 'claude-code',
    mode: 'default',
    outcome: 'ended_on_error',
    headlineMetrics: [],
  },
  'session.getSessionEvents': { token: TOKEN, sessionId: 'canned-session', events: CANNED_EVENTS },
  'session.getTurnTimeline': CANNED_TIMELINE,
  'session.getContextTimingSeries': { token: TOKEN, points: [] },
  'session.getRootChildBreakdown': {
    token: TOKEN,
    root: { sessionId: 'canned-session', isRoot: true, childCount: 0, contributionMetrics: [] },
    children: [],
  },
  'session.getComponentFacts': {
    items: [],
    generationToken: 'gen-1',
    analysisReleaseToken: 'rel-1',
  },
  'session.getValidationSummary': { token: TOKEN, validations: [] },
  'session.getTranscriptPages': {
    items: [
      {
        evidenceId: 'm1',
        entityType: 'message',
        turnNumber: 1,
        timestamp: '2026-08-11T10:00:00.000Z',
        summary: 'Message 1 (user)\n\nInvestigate the flaky test',
        evidenceLinks: [],
      },
    ],
    generationToken: 'gen-1',
    analysisReleaseToken: 'rel-1',
  },
  'search.getRootSessionTree': { rootSessionId: 'canned-session', nodes: [] },
};

/**
 * Build a worker script that answers the boot handshake and every
 * `session.*`/`search.getRootSessionTree` query with a canned, successful
 * DTO from `CANNED_RESULTS` (overridable per test). This exercises the real
 * bundled `session-evidence-view`/`-timeline`/`-events-table` components
 * end-to-end against realistic data — the app's real ingestion path does
 * not yet populate the `invocations`/`turns`/`messages`/`payloads` tables
 * `getSessionEvents`/`getTurnTimeline` read from (a documented, pre-existing
 * gap — see `packages/db/tests/pipeline/pipe-014-session-events-and-dimension-domains.test.ts`),
 * so canning the worker response is the only way to exercise filter/expand/
 * timeline-click interactions end-to-end today.
 */
function buildCannedSessionWorker(overrides: Record<string, unknown> = {}): string {
  const results = { ...CANNED_RESULTS, ...overrides };
  return `
  self.onmessage = (event) => {
    const request = event.data;
    const id = request.id ?? 0;
    switch (request.type) {
      case 'init':
      case 'getBackend':
        self.postMessage({
          id, ok: true,
          backend: { backendName: 'wasm-memory', durability: 'ephemeral', journalMode: 'delete', storage: 'memory' },
          storage: 'memory',
        });
        break;
      case 'resolveProjectId':
        self.postMessage({ id, ok: true, result: request.projectId });
        break;
      case 'query': {
        const key = request.view + '.' + request.method;
        const results = ${JSON.stringify(results)};
        if (Object.prototype.hasOwnProperty.call(results, key)) {
          self.postMessage({ id, ok: true, result: results[key] });
        } else {
          self.postMessage({ id, ok: true, result: null });
        }
        break;
      }
      default:
        self.postMessage({ id, ok: true });
    }
  };
  `;
}

async function installCannedSessionWorker(
  page: Page,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  await installFailingWorker(page, {
    match: 'analytics-worker',
    workerScript: buildCannedSessionWorker(overrides),
  });
}

test.describe('UX-031: Session Evidence full journey', () => {
  test('UX-031: portfolio -> project -> session lands on the redesigned Session Evidence page', async ({
    page,
  }) => {
    const projectName = 'Session Evidence Journey';
    const sessionId = await importAndOpenSession(page, projectName, ['claude-rich-session.jsonl']);
    expect(sessionId).not.toBe('');

    // Stop 1: session evidence header + breadcrumb render (we arrived here
    // via the manual-import "View session" journey, which is the same
    // navigation the Outliers/leaderboard session links use elsewhere).
    const header = page.locator('session-evidence-header');
    await expect(header).toBeVisible({ timeout: 15000 });
    await expect(header).toContainText('Portfolio');
    await expect(header).toContainText(sessionId);

    // Stop 2: the Projects page (control-DB project CRUD) loads independently
    // — "portfolio -> project" leg of the journey. Manual import's on-the-fly
    // project only exists in the analytics DB, not the control-DB project
    // list `/projects` renders, so this stop verifies the page itself loads
    // rather than a specific card (out of scope for this site-only issue).
    await page.goto('/#/projects');
    await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible({ timeout: 15000 });

    // Stop 3: back to the session — the global header is swapped for the
    // page-owned title row on this route only.
    await page.goto(`/#/sessions/${encodeURIComponent(sessionId)}`);
    await expect(page.locator('session-evidence-header')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('app-root header')).toHaveCount(0);

    // The turn timeline and events table both render (honestly empty today —
    // see the module doc comment on the ingestion gap).
    await expect(page.locator('session-evidence-timeline')).toBeVisible();
    await expect(page.locator('session-evidence-events-table')).toBeVisible();
    await expect(page.locator('session-evidence-events-table')).toContainText(
      'No events recorded for this session.',
    );
  });
});

test.describe('UX-032: Session Evidence events table filters', () => {
  test('UX-032: tool dropdown, errors-only checkbox, and free-text search filter live and AND-combine', async ({
    page,
  }) => {
    await installCannedSessionWorker(page);
    await page.goto('/#/sessions/canned-session');
    const table = page.locator('session-evidence-events-table');
    await expect(table).toBeVisible({ timeout: 15000 });

    const totalRows = await table.locator('tbody tr.event-row').count();
    expect(totalRows).toBe(3);
    await expect(table).toContainText('no filters active');

    // Errors-only narrows to the fixture's single failed Bash invocation.
    await table.locator('input[type="checkbox"]').check();
    await expect(table.locator('tbody tr.event-row')).toHaveCount(1);
    await expect(table.locator('tbody tr.event-row.error-row')).toHaveCount(1);

    // AND-combine with a text search that also matches the error row.
    await table.locator('input[type="text"]').fill('bash');
    await expect(table.locator('tbody tr.event-row')).toHaveCount(1);
    await expect(table).toContainText('1 of 3 events');

    // A dropdown value that does not match the error row AND-combines to zero.
    await table.locator('select').selectOption('Read');
    await expect(table.locator('tbody tr.event-row')).toHaveCount(0);
    await expect(table).toContainText('No events match the current filters.');

    // Clearing every filter restores every row and the "no filters" copy.
    await table.locator('select').selectOption('');
    await table.locator('input[type="checkbox"]').uncheck();
    await table.locator('input[type="text"]').fill('');
    await expect(table.locator('tbody tr.event-row')).toHaveCount(totalRows);
    await expect(table).toContainText('no filters active');
  });

  test('UX-032: the tool dropdown options stay stable while other filters narrow the row set', async ({
    page,
  }) => {
    await installCannedSessionWorker(page);
    await page.goto('/#/sessions/canned-session');
    const table = page.locator('session-evidence-events-table');
    await expect(table).toBeVisible({ timeout: 15000 });

    const optionsBefore = await table.locator('select option').allTextContents();
    expect(optionsBefore).toEqual(['All names', 'Bash', 'Read', 'code-review']);

    await table.locator('input[type="checkbox"]').check();
    const optionsAfter = await table.locator('select option').allTextContents();
    expect(optionsAfter).toEqual(optionsBefore);
  });
});

test.describe('UX-033: Session Evidence timeline drives the events table', () => {
  test('UX-033: clicking a timeline segment applies a dismissible turn filter chip', async ({
    page,
  }) => {
    await installCannedSessionWorker(page);
    await page.goto('/#/sessions/canned-session');
    const timeline = page.locator('session-evidence-timeline');
    const table = page.locator('session-evidence-events-table');
    await expect(timeline).toBeVisible({ timeout: 15000 });
    await expect(table).toBeVisible();

    const segments = timeline.locator('.segment');
    await expect(segments).toHaveCount(3);

    // The second segment resolves to the Bash invocation's turn (2).
    await segments.nth(1).click();
    await expect(table.locator('.turn-chip')).toBeVisible();
    await expect(table.locator('.turn-chip')).toContainText('Turn 2');
    await expect(table.locator('tbody tr.event-row')).toHaveCount(1);
    await expect(table.locator('tbody tr.event-row')).toContainText('Bash');

    // Dismissing the chip clears the filter and restores every row.
    await table.locator('.turn-chip button').click();
    await expect(table.locator('.turn-chip')).toHaveCount(0);
    await expect(table.locator('tbody tr.event-row')).toHaveCount(3);
  });
});

test.describe('UX-034: Session Evidence error row expand', () => {
  test('UX-034: expanding an error row shows the tinted/badged collapsed state and pretty-printed payload JSON', async ({
    page,
  }) => {
    await installCannedSessionWorker(page);
    await page.goto('/#/sessions/canned-session');
    const table = page.locator('session-evidence-events-table');
    await expect(table).toBeVisible({ timeout: 15000 });

    // The error badge and tinted row are visible without expanding.
    const errorRow = table.locator('tbody tr.event-row.error-row').first();
    await expect(errorRow).toBeVisible();
    await expect(errorRow.locator('.error-badge')).toBeVisible();
    await expect(table.locator('.expanded-row')).toHaveCount(0);

    // Expanding shows pretty-printed Input/Result JSON with an internal
    // scroll container (never blowing out page layout).
    await errorRow.click();
    const expanded = table.locator('.expanded-row').first();
    await expect(expanded).toBeVisible();
    await expect(expanded.locator('.detail-block pre').first()).toBeVisible();
    await expect(expanded).toContainText('"command"');
    await expect(expanded).toContainText('"error"');
  });
});

test.describe('UX-035: Session Evidence events table empty vs error', () => {
  test('UX-035: an over-narrow filter shows the distinct "no events match" empty affordance', async ({
    page,
  }) => {
    await installCannedSessionWorker(page);
    await page.goto('/#/sessions/canned-session');
    const table = page.locator('session-evidence-events-table');
    await expect(table).toBeVisible({ timeout: 15000 });

    await table.locator('input[type="text"]').fill('this-name-matches-nothing-at-all');
    await expect(table.locator('.state-empty')).toBeVisible();
    await expect(table.locator('tbody tr.event-row')).toHaveCount(0);
  });

  test('UX-035: a forced worker query failure shows a distinct error affordance, never the empty one', async ({
    page,
  }) => {
    // Replace the analytics worker before the app boots so the session
    // events/turn-timeline queries fail outright — no import needed, the
    // query fails regardless of whether the session exists.
    await installFailingWorker(page, {
      match: 'analytics-worker',
      workerScript: buildFailingQueryWorker('Simulated events query failure'),
    });

    await page.goto('/#/sessions/does-not-matter');
    await expect(page.locator('session-evidence-header')).toBeVisible({ timeout: 15000 });

    // The events table is replaced by an error affordance, not rendered at
    // all with an empty state — proving a query failure is never read as
    // "no data" (`.agents/rules/no-silent-empty-states.md`).
    await expect(page.locator('session-evidence-events-table')).toHaveCount(0);
    await expect(page.getByText('Simulated events query failure').first()).toBeVisible();
  });
});
