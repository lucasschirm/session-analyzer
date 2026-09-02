import {
  ComponentIdentityStore,
  EnvironmentStore,
  FRESH_SCHEMA_SQL,
  IngestionSourceStore,
  InvocationPayloadStore,
  InvocationStore,
  MessageStore,
  PayloadStore,
  PortfolioStore,
  ProjectStore,
  SessionStore,
  SourceProjectStore,
  TenantStore,
  TurnStore,
} from '@lucasschirm/sal-db-core';
import { beforeEach, describe, expect, it } from 'vitest';
import { WasmSqliteExecutor } from '../../../db-core/tests/helpers/sqlite-wasm-adapter.js';
import { getKpiBand, resolvePreviousWindow } from '../../src/analytics-portfolio.js';
import { createMetadataView, createSessionEvidenceView } from '../../src/analytics-session.js';
import { createProjectBehaviorView } from '../../src/project-behavior.js';

const TENANT_ID = 'tenant-169';
const PORTFOLIO_ID = 'portfolio-169';
const SOURCE_ID = 'source-169';
const ENV_ID = 'env-169';
const PROJECT_ID = 'project-169';
const SESSION_ID = 'session-169';

async function createExecutor(): Promise<WasmSqliteExecutor> {
  const executor = await WasmSqliteExecutor.create();
  await executor.exec(FRESH_SCHEMA_SQL);
  return executor;
}

async function seedPortfolio(executor: WasmSqliteExecutor): Promise<void> {
  await TenantStore.insert(executor, { id: TENANT_ID, name: 'Test' });
  await PortfolioStore.insert(executor, { id: PORTFOLIO_ID, tenantId: TENANT_ID, name: 'P' });
  await IngestionSourceStore.insert(executor, {
    id: SOURCE_ID,
    portfolioId: PORTFOLIO_ID,
    nativeSourceId: 'src',
    displayName: 'Source',
    type: 'claude_code',
    authority: 'local',
  });
  await EnvironmentStore.insert(executor, PORTFOLIO_ID, {
    id: ENV_ID,
    ingestionSourceId: SOURCE_ID,
    nativeEnvironmentId: 'env-native',
  });
  await ProjectStore.insert(executor, { id: PROJECT_ID, portfolioId: PORTFOLIO_ID, name: 'alpha' });
  await SourceProjectStore.insert(executor, PORTFOLIO_ID, {
    projectId: PROJECT_ID,
    ingestionSourceId: SOURCE_ID,
    nativeProjectId: 'native-alpha',
  });
}

async function insertSession(
  executor: WasmSqliteExecutor,
  id: string,
  startTime: number | null,
): Promise<void> {
  await SessionStore.insert(executor, {
    id,
    projectId: PROJECT_ID,
    ingestionSourceId: SOURCE_ID,
    nativeSessionId: id,
    harness: 'claude-code',
    finality: 'final',
    startTime,
  });
}

describe('resolvePreviousWindow (issue #169)', () => {
  it('returns undefined for the All preset (no start bound) — no fabricated delta', () => {
    expect(resolvePreviousWindow(undefined)).toBeUndefined();
  });

  it('returns an equal-length prior window for a bounded range', () => {
    const previous = resolvePreviousWindow({
      start: '2026-08-08T00:00:00.000Z',
      end: '2026-08-15T00:00:00.000Z',
    });
    expect(previous).toEqual({
      start: '2026-08-01T00:00:00.000Z',
      end: '2026-08-08T00:00:00.000Z',
    });
  });

  it('stays equal-length across a DST transition (US spring-forward)', () => {
    // 2026-03-08 is the US DST transition; a naive calendar-day shift would
    // produce an unequal-length window. Epoch-ms arithmetic does not.
    const previous = resolvePreviousWindow({
      start: '2026-03-08T00:00:00.000Z',
      end: '2026-03-15T00:00:00.000Z',
    });
    const durationMs =
      new Date('2026-03-15T00:00:00.000Z').getTime() -
      new Date('2026-03-08T00:00:00.000Z').getTime();
    const prevDurationMs =
      new Date(previous?.end as string).getTime() - new Date(previous?.start as string).getTime();
    expect(prevDurationMs).toBe(durationMs);
  });

  it('spans a short month (Feb) without shrinking the previous window', () => {
    const previous = resolvePreviousWindow({
      start: '2026-03-01T00:00:00.000Z',
      end: '2026-03-29T00:00:00.000Z',
    });
    const durationMs = 28 * 24 * 60 * 60 * 1000;
    expect(
      new Date(previous?.end as string).getTime() - new Date(previous?.start as string).getTime(),
    ).toBe(durationMs);
  });
});

describe('PortfolioView.getKpiBand (issue #169)', () => {
  beforeEach(async () => {});

  it('omits the delta for the All preset (no timeRange) — never a fabricated 0%', async () => {
    const executor = await createExecutor();
    await seedPortfolio(executor);
    await insertSession(executor, SESSION_ID, 1000);

    const band = await getKpiBand(executor, { portfolioId: PORTFOLIO_ID });
    expect(band.sessions.current).toBe(1);
    expect(band.sessions.previous).toBeUndefined();
    expect(band.sessions.previousN).toBeUndefined();
  });

  it('reports current vs previous window counts for a bounded TimeRange', async () => {
    const executor = await createExecutor();
    await seedPortfolio(executor);
    await insertSession(executor, 's-current', 8 * 24 * 60 * 60 * 1000);
    await insertSession(executor, 's-previous', 2 * 24 * 60 * 60 * 1000);

    const band = await getKpiBand(executor, {
      portfolioId: PORTFOLIO_ID,
      timeRange: {
        start: new Date(7 * 24 * 60 * 60 * 1000).toISOString(),
        end: new Date(14 * 24 * 60 * 60 * 1000).toISOString(),
      },
    });
    expect(band.sessions.current).toBe(1);
    expect(band.sessions.previous).toBe(1);
  });
});

describe('MetadataView.getDimensionDomains (issue #169)', () => {
  it('returns observed project/harness values and an empty model domain', async () => {
    const executor = await createExecutor();
    await seedPortfolio(executor);
    await insertSession(executor, SESSION_ID, 1000);

    const view = createMetadataView(executor);
    const domains = await view.getDimensionDomains({ portfolioId: PORTFOLIO_ID });
    expect(domains.projects).toEqual(['alpha']);
    expect(domains.harnesses).toEqual(['claude-code']);
    expect(domains.models).toEqual([]);
    expect(domains.token.eligibleN).toBe(domains.token.knownN);
  });
});

describe('ProjectBehaviorView.getOutcomeMix (issue #169)', () => {
  it('wires the existing session:outcome rollup into the read contract', async () => {
    const executor = await createExecutor();
    await seedPortfolio(executor);
    await SessionStore.insert(executor, {
      id: 'outcome-session',
      projectId: PROJECT_ID,
      ingestionSourceId: SOURCE_ID,
      nativeSessionId: 'outcome-session',
      harness: 'claude-code',
      finality: 'final',
      outcome: 'clean',
    });

    const view = createProjectBehaviorView(executor);
    const mix = await view.getOutcomeMix(PROJECT_ID);
    expect(mix.buckets).toEqual(
      expect.arrayContaining([expect.objectContaining({ outcome: 'clean', count: 1 })]),
    );
    expect(mix.token.knownN).toBe(1);
  });
});

describe('SessionEvidenceView.getSessionEvents / getEventPayload (issue #169)', () => {
  async function seedSessionWithEvents(
    executor: WasmSqliteExecutor,
  ): Promise<{ payloadId: string }> {
    await seedPortfolio(executor);
    await insertSession(executor, SESSION_ID, 1000);
    const componentId = await ComponentIdentityStore.insert(executor, {
      portfolioId: PORTFOLIO_ID,
      kind: 'tool',
      canonicalSourceIdentity: 'Read',
      nativeId: 'Read',
      displayName: 'Read file',
    } as never);
    const analysisReleaseId = 'ar-169';
    await executor.exec(
      `INSERT INTO analysis_releases (
        id, ontology_version, metric_registry_version, statistical_policy_version,
        rollup_policy_version, mapping_version, created_at, is_default
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [analysisReleaseId, '1', '1', '1', '1', '1', 1, 0],
    );
    const generationId = 'gen-169';
    await executor.exec(
      `INSERT INTO transformation_generations (
        id, session_id, analysis_release_id, parser_version, transformer_version,
        ontology_version, metric_version, schema_version, status, source_availability, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        generationId,
        SESSION_ID,
        analysisReleaseId,
        '1',
        '1',
        '1',
        '1',
        '1',
        'committed',
        'local',
        1,
      ],
    );
    const payloadId = await PayloadStore.insert(executor, {
      sessionId: SESSION_ID,
      generationId,
      payloadType: 'input',
      exactTokens: 4,
      rawContent: new TextEncoder().encode('a'.repeat(20000)),
      retainRaw: true,
    } as never);
    const invocationId = await InvocationStore.insert(executor, {
      sessionId: SESSION_ID,
      generationId,
      kind: 'tool',
      componentId,
      status: 'completed',
      latencyMs: 42,
      rootSessionId: SESSION_ID,
      origin: 'root',
    } as never);
    await InvocationPayloadStore.insert(executor, {
      invocationId,
      payloadId,
      sessionId: SESSION_ID,
      generationId,
      attributionType: 'exact',
      isInput: true,
      isResult: false,
      isContext: false,
    } as never);
    const smallResultPayloadId = await PayloadStore.insert(executor, {
      sessionId: SESSION_ID,
      generationId,
      payloadType: 'result',
      exactTokens: 2,
      rawContent: new TextEncoder().encode('ok'),
      retainRaw: true,
    } as never);
    await InvocationPayloadStore.insert(executor, {
      invocationId,
      payloadId: smallResultPayloadId,
      sessionId: SESSION_ID,
      generationId,
      attributionType: 'exact',
      isInput: false,
      isResult: true,
      isContext: false,
    } as never);
    const turnId = await TurnStore.insert(executor, {
      sessionId: SESSION_ID,
      generationId,
      ordering: 1,
      role: 'human',
    } as never);
    await MessageStore.insert(executor, {
      sessionId: SESSION_ID,
      generationId,
      turnId,
      ordering: 1,
      role: 'user',
      timestamp: 500,
      retainedContent: 'hi',
      retainContent: true,
    } as never);
    return { payloadId };
  }

  it('returns both the invocation and the message as shaped rows, with sample size', async () => {
    const executor = await createExecutor();
    await seedSessionWithEvents(executor);

    const view = createSessionEvidenceView(executor);
    const detail = await view.getSessionEvents(SESSION_ID);
    expect(detail.events).toHaveLength(2);
    expect(detail.token.eligibleN).toBe(2);
    const invocationRow = detail.events.find((e) => e.kind === 'tool');
    expect(invocationRow).toMatchObject({ name: 'Read file', status: 'completed', durationMs: 42 });
    const messageRow = detail.events.find((e) => e.kind === 'user_message');
    expect(messageRow).toMatchObject({ turnNumber: 1, name: 'user' });
  });

  it('truncates a payload over the transfer cap and marks truncated: true', async () => {
    const executor = await createExecutor();
    await seedSessionWithEvents(executor);
    const view = createSessionEvidenceView(executor);
    const detail = await view.getSessionEvents(SESSION_ID);
    const invocationRow = detail.events.find((e) => e.kind === 'tool');
    expect(invocationRow?.inputPayload?.truncated).toBe(true);
    expect(invocationRow?.inputPayload?.content?.length).toBeLessThan(20000);
  });

  it('does not mark a small payload truncated: true (regression: truncated must not be always-true)', async () => {
    const executor = await createExecutor();
    await seedSessionWithEvents(executor);
    const view = createSessionEvidenceView(executor);
    const detail = await view.getSessionEvents(SESSION_ID);
    const messageRow = detail.events.find((e) => e.kind === 'user_message');
    const invocationRow = detail.events.find((e) => e.kind === 'tool');
    // The message row carries no payload at all; the invocation row's small
    // result payload (set up by seedSessionWithEvents, distinct from the
    // large input payload asserted truncated above) must not be flagged
    // truncated just because *some* payload on the session was.
    expect(messageRow?.inputPayload).toBeUndefined();
    expect(invocationRow?.resultPayload?.truncated).toBe(false);
    expect(invocationRow?.resultPayload?.content).toBe('ok');
  });

  it('fetches the full untruncated payload via getEventPayload', async () => {
    const executor = await createExecutor();
    const { payloadId } = await seedSessionWithEvents(executor);
    const view = createSessionEvidenceView(executor);
    const full = await view.getEventPayload(SESSION_ID, payloadId);
    expect(full?.content).toHaveLength(20000);
  });

  it('returns an empty events list for a session with no evidence (empty range)', async () => {
    const executor = await createExecutor();
    await seedPortfolio(executor);
    await insertSession(executor, 'empty-session', 1000);
    const view = createSessionEvidenceView(executor);
    const detail = await view.getSessionEvents('empty-session');
    expect(detail.events).toEqual([]);
    expect(detail.token.eligibleN).toBe(0);
  });
});
