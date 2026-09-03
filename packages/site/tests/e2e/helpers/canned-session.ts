import type { Page } from '@playwright/test';
import { installFailingWorker } from './worker-failure';

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
export const CANNED_EVENTS = [
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

/** `(view, method)` -> canned successful result. Anything else falls back to `null`. */
export const CANNED_RESULTS: Record<string, unknown> = {
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
export function buildCannedSessionWorker(overrides: Record<string, unknown> = {}): string {
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

/**
 * Replace the analytics worker with a canned session worker before the app
 * creates it. Use this before `page.goto()`/`page.reload()` so the browser
 * instantiates the fake worker instead of the real `analytics-worker`.
 */
export async function installCannedSessionWorker(
  page: Page,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  await installFailingWorker(page, {
    match: 'analytics-worker',
    workerScript: buildCannedSessionWorker(overrides),
  });
}
