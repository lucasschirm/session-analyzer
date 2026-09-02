import {
  ComponentIdentityStore,
  EnvironmentStore,
  FRESH_SCHEMA_SQL,
  IngestionSourceStore,
  InvocationStore,
  MessageStore,
  PortfolioStore,
  ProjectStore,
  SessionStore,
  SourceProjectStore,
  TenantStore,
  TurnStore,
} from '@lucasschirm/sal-db-core';
import { describe, expect, it } from 'vitest';
import { WasmSqliteExecutor } from '../../../db-core/tests/helpers/sqlite-wasm-adapter.js';
import { createSessionEvidenceView } from '../../src/analytics-session.js';

const TENANT_ID = 'tenant-tt-169';
const PORTFOLIO_ID = 'portfolio-tt-169';
const SOURCE_ID = 'source-tt-169';
const ENV_ID = 'env-tt-169';
const PROJECT_ID = 'project-tt-169';
const SESSION_ID = 'session-tt-169';

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
  endTime: number | null,
): Promise<void> {
  await SessionStore.insert(executor, {
    id,
    projectId: PROJECT_ID,
    ingestionSourceId: SOURCE_ID,
    nativeSessionId: id,
    harness: 'claude-code',
    finality: 'final',
    startTime,
    endTime,
  } as never);
}

async function seedGeneration(executor: WasmSqliteExecutor): Promise<string> {
  const analysisReleaseId = 'ar-tt-169';
  await executor.exec(
    `INSERT INTO analysis_releases (
      id, ontology_version, metric_registry_version, statistical_policy_version,
      rollup_policy_version, mapping_version, created_at, is_default
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [analysisReleaseId, '1', '1', '1', '1', '1', 1, 0],
  );
  const generationId = 'gen-tt-169';
  await executor.exec(
    `INSERT INTO transformation_generations (
      id, session_id, analysis_release_id, parser_version, transformer_version,
      ontology_version, metric_version, schema_version, status, source_availability, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [generationId, SESSION_ID, analysisReleaseId, '1', '1', '1', '1', '1', 'committed', 'local', 1],
  );
  return generationId;
}

async function insertInvocation(
  executor: WasmSqliteExecutor,
  generationId: string,
  kind: string,
  componentId: string,
  createdAt: number,
): Promise<void> {
  await InvocationStore.insert(executor, {
    sessionId: SESSION_ID,
    generationId,
    kind,
    componentId,
    status: 'completed',
    latencyMs: 10,
    rootSessionId: SESSION_ID,
    origin: 'root',
    createdAt,
  } as never);
}

async function insertMessage(
  executor: WasmSqliteExecutor,
  generationId: string,
  role: 'user' | 'assistant',
  ordering: number,
  timestamp: number,
): Promise<void> {
  const turnId = await TurnStore.insert(executor, {
    sessionId: SESSION_ID,
    generationId,
    ordering,
    role: role === 'user' ? 'human' : 'assistant',
  } as never);
  await MessageStore.insert(executor, {
    sessionId: SESSION_ID,
    generationId,
    turnId,
    ordering,
    role,
    timestamp,
    retainedContent: role,
    retainContent: true,
  } as never);
}

async function seedFullTimeline(executor: WasmSqliteExecutor): Promise<void> {
  await seedPortfolio(executor);
  await insertSession(executor, SESSION_ID, 0, 1000);
  const generationId = await seedGeneration(executor);
  const toolComponentId = await ComponentIdentityStore.insert(executor, {
    portfolioId: PORTFOLIO_ID,
    kind: 'tool',
    canonicalSourceIdentity: 'Read',
    nativeId: 'Read',
    displayName: 'Read file',
  } as never);
  const skillComponentId = await ComponentIdentityStore.insert(executor, {
    portfolioId: PORTFOLIO_ID,
    kind: 'skill',
    canonicalSourceIdentity: 'multi-issue-agent',
    nativeId: 'multi-issue-agent',
    displayName: 'Multi issue agent',
  } as never);
  // A sub_agent *invocation* is backed by an `agent`-kind component identity
  // — `component_identities.kind` has no `sub_agent` value of its own (see
  // schema CHECK); `sub_agent` is an invocation-kind/origin concept, not a
  // component domain.
  const subAgentComponentId = await ComponentIdentityStore.insert(executor, {
    portfolioId: PORTFOLIO_ID,
    kind: 'agent',
    canonicalSourceIdentity: 'reviewer',
    nativeId: 'reviewer',
    displayName: 'Reviewer',
  } as never);

  await insertMessage(executor, generationId, 'user', 1, 100);
  await insertInvocation(executor, generationId, 'tool', toolComponentId, 200);
  await insertInvocation(executor, generationId, 'skill', skillComponentId, 400);
  await insertInvocation(executor, generationId, 'sub_agent', subAgentComponentId, 600);
  await insertMessage(executor, generationId, 'assistant', 2, 800);
}

describe('SessionEvidenceView.getTurnTimeline (issue #169)', () => {
  it('builds segments whose durations sum exactly to the session duration', async () => {
    const executor = await createExecutor();
    await seedFullTimeline(executor);
    const view = createSessionEvidenceView(executor);
    const timeline = await view.getTurnTimeline(SESSION_ID);

    expect(timeline.totalDurationMs).toBe(1000);
    const sum = timeline.segments.reduce((acc, s) => acc + s.durationMs, 0);
    expect(sum).toBe(1000);
    // Segments are contiguous: each segment's start equals the previous
    // segment's end, and the first/last segments touch the outer bounds.
    expect(timeline.segments[0]?.startMs).toBe(0);
    let cursor = 0;
    for (const segment of timeline.segments) {
      expect(segment.startMs).toBe(cursor);
      cursor += segment.durationMs;
    }
    expect(cursor).toBe(1000);
  });

  it('never labels the invocation band "tool" — tool/skill/agent are combined into "invocation"', async () => {
    const executor = await createExecutor();
    await seedFullTimeline(executor);
    const view = createSessionEvidenceView(executor);
    const timeline = await view.getTurnTimeline(SESSION_ID);

    const invocationSegments = timeline.segments.filter((s) => s.kind === 'invocation');
    expect(invocationSegments).toHaveLength(2);
    for (const segment of invocationSegments) {
      // The DTO's `kind` vocabulary never contains a bare "tool"/"skill"/
      // "agent" value at the band level — only `invocationKind` may.
      expect(segment.kind).not.toBe('tool');
      expect(segment.kind).not.toBe('skill');
      expect(segment.kind).not.toBe('agent');
    }
    expect(invocationSegments.map((s) => s.invocationKind).sort()).toEqual(['skill', 'tool']);
  });

  it('keeps sub_agent time as its own band, never folded into invocation', async () => {
    const executor = await createExecutor();
    await seedFullTimeline(executor);
    const view = createSessionEvidenceView(executor);
    const timeline = await view.getTurnTimeline(SESSION_ID);

    const subAgentSegments = timeline.segments.filter((s) => s.kind === 'sub_agent');
    expect(subAgentSegments).toHaveLength(1);
    expect(subAgentSegments[0]?.invocationKind).toBeUndefined();
    const invocationSegments = timeline.segments.filter((s) => s.kind === 'invocation');
    expect(invocationSegments.every((s) => s.invocationKind !== undefined)).toBe(true);
  });

  it('reports user/assistant message segments too, in start-time order', async () => {
    const executor = await createExecutor();
    await seedFullTimeline(executor);
    const view = createSessionEvidenceView(executor);
    const timeline = await view.getTurnTimeline(SESSION_ID);

    expect(timeline.segments.map((s) => s.kind)).toEqual([
      'user',
      'invocation',
      'invocation',
      'sub_agent',
      'assistant',
    ]);
  });

  it('returns an empty segment list for a session with no timestamped evidence (not an error)', async () => {
    const executor = await createExecutor();
    await seedPortfolio(executor);
    await insertSession(executor, SESSION_ID, 0, 1000);
    const view = createSessionEvidenceView(executor);
    const timeline = await view.getTurnTimeline(SESSION_ID);

    expect(timeline.segments).toEqual([]);
    expect(timeline.totalDurationMs).toBe(1000);
    expect(timeline.token.eligibleN).toBe(0);
  });

  it('falls back to the min/max instant timestamp when session bounds are missing', async () => {
    const executor = await createExecutor();
    await seedPortfolio(executor);
    await insertSession(executor, SESSION_ID, null, null);
    const generationId = await seedGeneration(executor);
    await insertMessage(executor, generationId, 'user', 1, 100);
    await insertMessage(executor, generationId, 'assistant', 2, 300);
    const view = createSessionEvidenceView(executor);
    const timeline = await view.getTurnTimeline(SESSION_ID);

    expect(timeline.totalDurationMs).toBe(200);
    expect(timeline.segments).toHaveLength(2);
    expect(timeline.segments[0]?.startMs).toBe(100);
  });

  it('reports totalDurationMs: null when there is neither a session bound nor any evidence', async () => {
    const executor = await createExecutor();
    await seedPortfolio(executor);
    await insertSession(executor, SESSION_ID, null, null);
    const view = createSessionEvidenceView(executor);
    const timeline = await view.getTurnTimeline(SESSION_ID);

    expect(timeline.segments).toEqual([]);
    expect(timeline.totalDurationMs).toBeNull();
  });

  it('reports sample size via the token (eligibleN vs knownN)', async () => {
    const executor = await createExecutor();
    await seedFullTimeline(executor);
    const view = createSessionEvidenceView(executor);
    const timeline = await view.getTurnTimeline(SESSION_ID);

    expect(timeline.token.eligibleN).toBe(5);
    expect(timeline.token.knownN).toBe(5);
  });
});
