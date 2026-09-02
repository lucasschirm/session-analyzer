import { beforeAll, describe, expect, it } from 'vitest';
import { ComponentIdentityStore } from '../../src/component-ecosystem.js';
import {
  EnvironmentStore,
  IngestionSourceStore,
  PortfolioStore,
  ProjectStore,
  SourceProjectStore,
  TenantStore,
} from '../../src/identity.js';
import { ProjectBehaviorStore } from '../../src/project-behavior-store.js';
import { FRESH_SCHEMA_SQL } from '../../src/schema.js';
import {
  InvocationStore,
  ModelRequestStore,
  ModelUsageStore,
  SessionStore,
  TurnStore,
} from '../../src/session-evidence.js';
import { getSqlite3, WasmSqliteExecutor } from '../helpers/sqlite-wasm-adapter.js';

beforeAll(async () => {
  await getSqlite3();
});

const PROJECT_ID = 'pb-project';
const PORTFOLIO_ID = 'pb-portfolio';

async function seed(): Promise<WasmSqliteExecutor> {
  const executor = await WasmSqliteExecutor.create();
  await executor.exec(FRESH_SCHEMA_SQL);
  await TenantStore.insert(executor, { id: 'pb-tenant', name: 'T', createdAt: 1, updatedAt: 1 });
  await PortfolioStore.insert(executor, {
    id: PORTFOLIO_ID,
    tenantId: 'pb-tenant',
    name: 'P',
    createdAt: 1,
    updatedAt: 1,
  });
  await IngestionSourceStore.insert(executor, {
    id: 'pb-ingestion',
    portfolioId: PORTFOLIO_ID,
    nativeSourceId: 'claude-local',
    displayName: 'Claude',
    type: 'claude_code',
    authority: 'local',
    createdAt: 1,
    updatedAt: 1,
  });
  await EnvironmentStore.insert(executor, PORTFOLIO_ID, {
    id: 'pb-env',
    ingestionSourceId: 'pb-ingestion',
    nativeEnvironmentId: 'env',
    createdAt: 1,
    updatedAt: 1,
  });
  await ProjectStore.insert(executor, {
    id: PROJECT_ID,
    portfolioId: PORTFOLIO_ID,
    name: PROJECT_ID,
    createdAt: 1,
    updatedAt: 1,
  });
  await SourceProjectStore.insert(executor, PORTFOLIO_ID, {
    projectId: PROJECT_ID,
    ingestionSourceId: 'pb-ingestion',
    nativeProjectId: 'native-pb',
    createdAt: 1,
    updatedAt: 1,
  });
  return executor;
}

async function insertSession(
  executor: WasmSqliteExecutor,
  id: string,
  startTime: number | null,
  endTime: number | null = null,
  outcome: string | null = null,
): Promise<void> {
  await SessionStore.insert(executor, {
    id,
    projectId: PROJECT_ID,
    ingestionSourceId: 'pb-ingestion',
    environmentId: 'pb-env',
    harness: 'claude-code',
    nativeSessionId: id,
    currentGenerationId: null,
    occurrenceTime: null,
    finality: 'final',
    mode: null,
    taskCohort: null,
    startTime,
    endTime,
    aiTitle: null,
    slug: null,
    agentName: null,
    cwd: null,
    gitBranch: null,
    cliVersions: null,
    isSidechain: false,
    agentId: null,
    outcome,
  } as never);
}

async function insertGeneration(
  executor: WasmSqliteExecutor,
  sessionId: string,
  generationId: string,
): Promise<void> {
  const { rows } = await executor.exec('SELECT id FROM analysis_releases WHERE id = ?', ['pb-ar']);
  if (rows.length === 0) {
    await executor.exec(
      `INSERT INTO analysis_releases
       (id, ontology_version, metric_registry_version, statistical_policy_version,
        rollup_policy_version, mapping_version, created_at, is_default)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['pb-ar', '0.1.0', '0.1.0', '0.1.0', '0.1.0', '0.1.0', 1, 0],
    );
  }
  await executor.exec(
    `INSERT INTO transformation_generations
     (id, session_id, analysis_release_id, parser_version, transformer_version,
      ontology_version, metric_version, schema_version, status, source_availability, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      generationId,
      sessionId,
      'pb-ar',
      '0.1.0',
      '0.1.0',
      '0.1.0',
      '0.1.0',
      '0.1.0',
      'committed',
      'local',
      1,
    ],
  );
}

async function insertModelRequest(
  executor: WasmSqliteExecutor,
  sessionId: string,
  generationId: string,
  requestOrder: number,
  model: string,
  inputTokens: number | null,
  outputTokens: number | null,
): Promise<string> {
  return ModelRequestStore.insert(executor, {
    sessionId,
    generationId,
    requestOrder,
    model,
    provider: 'anthropic',
    inputTokens,
    outputTokens,
    status: 'success',
  } as never);
}

async function insertCost(
  executor: WasmSqliteExecutor,
  sessionId: string,
  generationId: string,
  requestId: string,
  cost: number | null,
): Promise<void> {
  await ModelUsageStore.insert(executor, {
    sessionId,
    generationId,
    requestId,
    tokenClass: 'input',
    tokenCount: 10,
    isEstimated: false,
    cost,
  } as never);
}

async function insertTurn(
  executor: WasmSqliteExecutor,
  sessionId: string,
  generationId: string,
  ordering: number,
): Promise<void> {
  await TurnStore.insert(executor, {
    sessionId,
    generationId,
    ordering,
    role: 'human',
  } as never);
}

async function insertToolInvocation(
  executor: WasmSqliteExecutor,
  sessionId: string,
  generationId: string,
  componentId: string | null,
  status: 'completed' | 'failed',
  createdAt: number,
): Promise<void> {
  const startId = `start-${sessionId}-${createdAt}-${Math.random()}`;
  await InvocationStore.insert(executor, {
    sessionId,
    generationId,
    kind: 'tool',
    componentId,
    startId,
    rootSessionId: sessionId,
    status,
  } as never);
  await executor.exec(
    'UPDATE invocations SET created_at = ? WHERE session_id = ? AND kind = ? AND start_id = ?',
    [createdAt, sessionId, 'tool', startId],
  );
}

async function insertToolComponent(
  executor: WasmSqliteExecutor,
  nativeId: string,
): Promise<string> {
  return ComponentIdentityStore.insert(executor, {
    portfolioId: PORTFOLIO_ID,
    kind: 'tool',
    nativeId,
    canonicalSourceIdentity: `tool:${nativeId}`,
    displayName: nativeId,
  });
}

describe('ProjectBehaviorStore.countSessionsInWindow / getSessionDurationsInWindow', () => {
  it('counts sessions with start_time inside the window, excluding null start_time', async () => {
    const executor = await seed();
    await insertSession(executor, 's1', 1000, 2000);
    await insertSession(executor, 's-no-start', null);
    expect(await ProjectBehaviorStore.countSessionsInWindow(executor, PROJECT_ID, 0, 5000)).toBe(1);
  });

  it('excludes sessions missing end_time from durations, never coercing to 0ms', async () => {
    const executor = await seed();
    await insertSession(executor, 's1', 1000, 4000);
    await insertSession(executor, 's-open', 1000, null);
    const rows = await ProjectBehaviorStore.getSessionDurationsInWindow(
      executor,
      PROJECT_ID,
      0,
      5000,
    );
    expect(rows).toEqual([{ sessionId: 's1', durationMs: 3000 }]);
  });

  it('resolves via indexed SEARCH, never a full table SCAN', async () => {
    const executor = await seed();
    await insertSession(executor, 's1', 1000, 2000);
    const { rows } = await executor.exec(
      `EXPLAIN QUERY PLAN
       SELECT (s.end_time - s.start_time) FROM sessions s
       WHERE s.project_id = ? AND s.start_time IS NOT NULL AND s.end_time IS NOT NULL
         AND s.start_time >= ? AND s.start_time < ?`,
      [PROJECT_ID, 0, 5000],
    );
    const details = rows.map((r) => String(r.detail));
    expect(details.some((d) => /^SCAN/.test(d))).toBe(false);
  });
});

describe('ProjectBehaviorStore.getSessionTurnCountsInWindow', () => {
  it('excludes sessions with zero turn rows (missing, not a measured 0)', async () => {
    const executor = await seed();
    await insertSession(executor, 's1', 1000);
    await insertGeneration(executor, 's1', 'gen-1');
    await insertTurn(executor, 's1', 'gen-1', 0);
    await insertTurn(executor, 's1', 'gen-1', 1);
    await insertSession(executor, 's-no-turns', 2000);

    const rows = await ProjectBehaviorStore.getSessionTurnCountsInWindow(
      executor,
      PROJECT_ID,
      0,
      5000,
    );
    expect(rows).toEqual([{ sessionId: 's1', turnCount: 2 }]);
  });
});

describe('ProjectBehaviorStore.getSessionTokensInWindow', () => {
  it('reports tokensSum null for a session with no known token requests', async () => {
    const executor = await seed();
    await insertSession(executor, 's1', 1000);
    await insertGeneration(executor, 's1', 'gen-1');
    await insertModelRequest(executor, 's1', 'gen-1', 0, 'claude-sonnet', 100, 50);
    await insertSession(executor, 's-null', 2000);
    await insertGeneration(executor, 's-null', 'gen-2');
    await insertModelRequest(executor, 's-null', 'gen-2', 0, 'claude-sonnet', null, null);

    const rows = await ProjectBehaviorStore.getSessionTokensInWindow(executor, PROJECT_ID, 0, 5000);
    expect(rows).toEqual(
      expect.arrayContaining([
        { sessionId: 's1', tokensSum: 150 },
        { sessionId: 's-null', tokensSum: null },
      ]),
    );
  });

  it('never treats a request with only one side known as a fully-known 0-contribution', async () => {
    // A request row with input_tokens known but output_tokens missing (or
    // vice versa) must not silently coerce the missing side to 0 and count
    // the row as "known" — that would undercount the session's true total
    // (`.agents/rules/missing-is-never-zero.md`). The row is excluded from
    // both the sum and the known count until both sides are recorded.
    const executor = await seed();
    await insertSession(executor, 's-partial', 1000);
    await insertGeneration(executor, 's-partial', 'gen-1');
    await insertModelRequest(executor, 's-partial', 'gen-1', 0, 'claude-sonnet', 100, null);
    await insertModelRequest(executor, 's-partial', 'gen-1', 1, 'claude-sonnet', null, 40);
    await insertModelRequest(executor, 's-partial', 'gen-1', 2, 'claude-sonnet', 10, 20);

    const rows = await ProjectBehaviorStore.getSessionTokensInWindow(executor, PROJECT_ID, 0, 5000);
    const row = rows.find((r) => r.sessionId === 's-partial');
    // Only the fully-known row (10 + 20) contributes; the two partial rows
    // are excluded entirely rather than fabricating a 0 for their missing side.
    expect(row).toEqual({ sessionId: 's-partial', tokensSum: 30 });
  });
});

describe('ProjectBehaviorStore.getSessionCostInWindow', () => {
  it('reports costSum null (coverage gap) rather than 0 when no cost row is known', async () => {
    const executor = await seed();
    await insertSession(executor, 's1', 1000);
    await insertGeneration(executor, 's1', 'gen-1');
    const reqId = await insertModelRequest(executor, 's1', 'gen-1', 0, 'claude-sonnet', 10, 10);
    await insertCost(executor, 's1', 'gen-1', reqId, 0.02);

    await insertSession(executor, 's-null', 2000);
    await insertGeneration(executor, 's-null', 'gen-2');
    const reqId2 = await insertModelRequest(
      executor,
      's-null',
      'gen-2',
      0,
      'claude-sonnet',
      10,
      10,
    );
    await insertCost(executor, 's-null', 'gen-2', reqId2, null);

    const rows = await ProjectBehaviorStore.getSessionCostInWindow(executor, PROJECT_ID, 0, 5000);
    const s1 = rows.find((r) => r.sessionId === 's1');
    expect(s1?.costSum).toBeCloseTo(0.02);
    expect(rows.some((r) => r.sessionId === 's-null')).toBe(false);
  });
});

describe('ProjectBehaviorStore.getWeeklyToolInvocations', () => {
  it('counts total and failed tool invocations per week bucket', async () => {
    const executor = await seed();
    await insertSession(executor, 's1', 1000);
    await insertGeneration(executor, 's1', 'gen-1');
    const componentId = await insertToolComponent(executor, 'bash');
    await insertToolInvocation(
      executor,
      's1',
      'gen-1',
      componentId,
      'completed',
      1_700_000_000_000,
    );
    await insertToolInvocation(executor, 's1', 'gen-1', componentId, 'failed', 1_700_000_001_000);

    const rows = await ProjectBehaviorStore.getWeeklyToolInvocations(executor, PROJECT_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0].totalToolCalls).toBe(2);
    expect(rows[0].failedToolCalls).toBe(1);
  });

  it('produces no row for a project with zero tool invocations (fully missing)', async () => {
    const executor = await seed();
    await insertSession(executor, 's1', 1000);
    const rows = await ProjectBehaviorStore.getWeeklyToolInvocations(executor, PROJECT_ID);
    expect(rows).toEqual([]);
  });
});

describe('ProjectBehaviorStore.getTopToolsByInvocations', () => {
  it('ranks tool-kind invocations by count, descending', async () => {
    const executor = await seed();
    await insertSession(executor, 's1', 1000);
    await insertGeneration(executor, 's1', 'gen-1');
    const bash = await insertToolComponent(executor, 'bash');
    const read = await insertToolComponent(executor, 'read');
    await insertToolInvocation(executor, 's1', 'gen-1', bash, 'completed', 2000);
    await insertToolInvocation(executor, 's1', 'gen-1', bash, 'completed', 2100);
    await insertToolInvocation(executor, 's1', 'gen-1', read, 'completed', 2200);

    const rows = await ProjectBehaviorStore.getTopToolsByInvocations(
      executor,
      PROJECT_ID,
      0,
      5000,
      10,
    );
    expect(rows[0]).toEqual({ componentId: bash, displayName: 'bash', invocationCount: 2 });
    expect(rows[1]).toEqual({ componentId: read, displayName: 'read', invocationCount: 1 });
  });
});

describe('ProjectBehaviorStore.getModelHarnessCohortRows', () => {
  it('returns one row per (model, harness, session) with per-session tokens/cost/outcome', async () => {
    const executor = await seed();
    await insertSession(executor, 's1', 1000, null, 'clean');
    await insertGeneration(executor, 's1', 'gen-1');
    const reqId = await insertModelRequest(executor, 's1', 'gen-1', 0, 'claude-sonnet', 100, 50);
    await insertCost(executor, 's1', 'gen-1', reqId, 0.1);

    const rows = await ProjectBehaviorStore.getModelHarnessCohortRows(
      executor,
      PROJECT_ID,
      0,
      5000,
    );
    expect(rows).toEqual([
      {
        model: 'claude-sonnet',
        harness: 'claude-code',
        sessionId: 's1',
        tokensSum: 150,
        costSum: 0.1,
        outcome: 'clean',
      },
    ]);
  });
});
