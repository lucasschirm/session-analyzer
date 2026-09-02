import { beforeAll, describe, expect, it } from 'vitest';
import {
  EnvironmentStore,
  IngestionSourceStore,
  PortfolioStore,
  ProjectStore,
  SourceProjectStore,
  TenantStore,
} from '../../src/identity.js';
import { PortfolioKpiStore } from '../../src/portfolio-kpi.js';
import { FRESH_SCHEMA_SQL } from '../../src/schema.js';
import {
  InvocationStore,
  ModelRequestStore,
  ModelUsageStore,
  SessionStore,
} from '../../src/session-evidence.js';
import { getSqlite3, WasmSqliteExecutor } from '../helpers/sqlite-wasm-adapter.js';

beforeAll(async () => {
  await getSqlite3();
});

async function seed(): Promise<{ executor: WasmSqliteExecutor; portfolioId: string }> {
  const executor = await WasmSqliteExecutor.create();
  await executor.exec(FRESH_SCHEMA_SQL);
  const portfolioId = 'pk-portfolio';
  await TenantStore.insert(executor, { id: 'pk-tenant', name: 'T', createdAt: 1, updatedAt: 1 });
  await PortfolioStore.insert(executor, {
    id: portfolioId,
    tenantId: 'pk-tenant',
    name: 'P',
    createdAt: 1,
    updatedAt: 1,
  });
  await IngestionSourceStore.insert(executor, {
    id: 'pk-ingestion',
    portfolioId,
    nativeSourceId: 'claude-local',
    displayName: 'Claude',
    type: 'claude_code',
    authority: 'local',
    createdAt: 1,
    updatedAt: 1,
  });
  await EnvironmentStore.insert(executor, portfolioId, {
    id: 'pk-env',
    ingestionSourceId: 'pk-ingestion',
    nativeEnvironmentId: 'env',
    createdAt: 1,
    updatedAt: 1,
  });
  await ProjectStore.insert(executor, {
    id: 'pk-project',
    portfolioId,
    name: 'pk-project',
    createdAt: 1,
    updatedAt: 1,
  });
  await SourceProjectStore.insert(executor, portfolioId, {
    projectId: 'pk-project',
    ingestionSourceId: 'pk-ingestion',
    nativeProjectId: 'native-pk',
    createdAt: 1,
    updatedAt: 1,
  });
  return { executor, portfolioId };
}

async function insertSession(
  executor: WasmSqliteExecutor,
  id: string,
  startTime: number | null,
): Promise<void> {
  await SessionStore.insert(executor, {
    id,
    projectId: 'pk-project',
    ingestionSourceId: 'pk-ingestion',
    environmentId: 'pk-env',
    harness: 'claude-code',
    nativeSessionId: id,
    currentGenerationId: null,
    occurrenceTime: null,
    finality: 'final',
    mode: null,
    taskCohort: null,
    startTime,
    endTime: null,
    aiTitle: null,
    slug: null,
    agentName: null,
    cwd: null,
    gitBranch: null,
    cliVersions: null,
    isSidechain: false,
    agentId: null,
    outcome: null,
  } as never);
}

async function insertGeneration(
  executor: WasmSqliteExecutor,
  sessionId: string,
  generationId: string,
): Promise<void> {
  const { rows } = await executor.exec('SELECT id FROM analysis_releases WHERE id = ?', ['pk-ar']);
  if (rows.length === 0) {
    await executor.exec(
      `INSERT INTO analysis_releases
       (id, ontology_version, metric_registry_version, statistical_policy_version,
        rollup_policy_version, mapping_version, created_at, is_default)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['pk-ar', '0.1.0', '0.1.0', '0.1.0', '0.1.0', '0.1.0', 1, 0],
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
      'pk-ar',
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

async function insertModelUsageCost(
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

async function insertInvocation(
  executor: WasmSqliteExecutor,
  sessionId: string,
  generationId: string,
  kind: 'tool' | 'skill' | 'agent' | 'sub_agent',
  createdAt: number,
): Promise<void> {
  await InvocationStore.insert(executor, {
    sessionId,
    generationId,
    kind,
    startId: `start-${kind}-${createdAt}`,
    rootSessionId: sessionId,
    status: 'completed',
  } as never);
  // InvocationStore.insert stamps created_at with Date.now(); override it so
  // window-based tests can control which bucket the row falls into.
  await executor.exec(
    'UPDATE invocations SET created_at = ? WHERE session_id = ? AND kind = ? AND start_id = ?',
    [createdAt, sessionId, kind, `start-${kind}-${createdAt}`],
  );
}

describe('PortfolioKpiStore.countSessionsInWindow', () => {
  it('counts sessions with start_time inside [start, end)', async () => {
    const { executor, portfolioId } = await seed();
    await insertSession(executor, 's1', 1000);
    await insertSession(executor, 's2', 2000);
    await insertSession(executor, 's3', 5000);
    expect(await PortfolioKpiStore.countSessionsInWindow(executor, portfolioId, 0, 3000)).toBe(2);
  });

  it('returns 0 (a real measured zero) for an empty window, not a missing marker', async () => {
    const { executor, portfolioId } = await seed();
    await insertSession(executor, 's1', 1000);
    expect(await PortfolioKpiStore.countSessionsInWindow(executor, portfolioId, 9000, 9999)).toBe(
      0,
    );
  });

  it('excludes sessions with no start_time from the window count', async () => {
    const { executor, portfolioId } = await seed();
    await insertSession(executor, 's1', null);
    expect(await PortfolioKpiStore.countSessionsInWindow(executor, portfolioId, 0, 999999)).toBe(0);
  });

  it('resolves via indexed SEARCH, never a full table SCAN, for the window query', async () => {
    const { executor, portfolioId } = await seed();
    await insertSession(executor, 's1', 1000);
    const { rows } = await executor.exec(
      `EXPLAIN QUERY PLAN
       SELECT COUNT(*) AS c FROM sessions s JOIN projects p ON p.id = s.project_id
       WHERE p.portfolio_id = ? AND s.start_time IS NOT NULL AND s.start_time >= ? AND s.start_time < ?`,
      [portfolioId, 0, 999999],
    );
    const details = rows.map((r) => String(r.detail));
    expect(details.some((d) => /^SCAN/.test(d))).toBe(false);
    expect(details.every((d) => /^SEARCH/.test(d))).toBe(true);
  });
});

describe('PortfolioKpiStore.sumTokensInWindow', () => {
  it('sums input/output tokens and tracks known counts independently per side', async () => {
    const { executor, portfolioId } = await seed();
    await insertSession(executor, 's1', 1000);
    await insertGeneration(executor, 's1', 'gen-1');
    await insertModelRequest(executor, 's1', 'gen-1', 0, 'claude-sonnet', 100, 50);
    // A request with a missing output_tokens: it must not contribute a 0 to
    // the output sum, and must not be counted in outputKnownN.
    await insertModelRequest(executor, 's1', 'gen-1', 1, 'claude-sonnet', 200, null);

    const totals = await PortfolioKpiStore.sumTokensInWindow(executor, portfolioId, 0, 5000);
    expect(totals.inputTokensSum).toBe(300);
    expect(totals.inputKnownN).toBe(2);
    expect(totals.outputTokensSum).toBe(50);
    expect(totals.outputKnownN).toBe(1);
    expect(totals.eligibleN).toBe(2);
  });

  it('reports all-zero totals (a real measured zero) for a window with no requests', async () => {
    const { executor, portfolioId } = await seed();
    const totals = await PortfolioKpiStore.sumTokensInWindow(executor, portfolioId, 0, 5000);
    expect(totals).toEqual({
      inputTokensSum: 0,
      inputKnownN: 0,
      outputTokensSum: 0,
      outputKnownN: 0,
      eligibleN: 0,
    });
  });
});

describe('PortfolioKpiStore.sumCostInWindow', () => {
  it('reports coverage gap (reportedHarnesses 0) distinct from a $0 cost', async () => {
    const { executor, portfolioId } = await seed();
    await insertSession(executor, 's1', 1000);
    await insertGeneration(executor, 's1', 'gen-1');
    const requestId = await insertModelRequest(executor, 's1', 'gen-1', 0, 'claude-sonnet', 10, 10);
    // A model_usage row with cost = NULL: this harness never reports cost.
    await insertModelUsageCost(executor, 's1', 'gen-1', requestId, null);

    const totals = await PortfolioKpiStore.sumCostInWindow(executor, portfolioId, 0, 5000);
    expect(totals.costSum).toBe(0);
    expect(totals.reportedHarnesses).toBe(0);
    expect(totals.totalHarnesses).toBe(1);
  });

  it('counts a harness as reported once it has at least one non-null cost row', async () => {
    const { executor, portfolioId } = await seed();
    await insertSession(executor, 's1', 1000);
    await insertGeneration(executor, 's1', 'gen-1');
    const requestId = await insertModelRequest(executor, 's1', 'gen-1', 0, 'claude-sonnet', 10, 10);
    await insertModelUsageCost(executor, 's1', 'gen-1', requestId, 0.05);

    const totals = await PortfolioKpiStore.sumCostInWindow(executor, portfolioId, 0, 5000);
    expect(totals.costSum).toBeCloseTo(0.05);
    expect(totals.reportedHarnesses).toBe(1);
    expect(totals.totalHarnesses).toBe(1);
  });
});

describe('PortfolioKpiStore.getCleanCompletionInWindow', () => {
  it('excludes the null-outcome (unreadable tail) bucket from knownN', async () => {
    const { executor, portfolioId } = await seed();
    await insertSession(executor, 's-clean', 1000);
    await SessionStore.update(executor, 'pk-project', 's-clean', { outcome: 'clean' } as never);
    await insertSession(executor, 's-error', 2000);
    await SessionStore.update(executor, 'pk-project', 's-error', {
      outcome: 'ended_on_error',
    } as never);
    await insertSession(executor, 's-unclassified', 3000);

    const totals = await PortfolioKpiStore.getCleanCompletionInWindow(
      executor,
      portfolioId,
      0,
      5000,
    );
    expect(totals.eligibleN).toBe(3);
    expect(totals.knownN).toBe(2);
    expect(totals.cleanN).toBe(1);
  });
});

describe('PortfolioKpiStore.getSessionsByModelInWindow', () => {
  it('groups sessions with no model_requests row under model = "unknown"', async () => {
    const { executor, portfolioId } = await seed();
    await insertSession(executor, 's-known', 1000);
    await insertGeneration(executor, 's-known', 'gen-1');
    await insertModelRequest(executor, 's-known', 'gen-1', 0, 'claude-sonnet', 1, 1);
    await insertSession(executor, 's-unknown', 2000);

    const rows = await PortfolioKpiStore.getSessionsByModelInWindow(executor, portfolioId, 0, 5000);
    expect(rows).toEqual(
      expect.arrayContaining([
        { model: 'claude-sonnet', sessionCount: 1 },
        { model: 'unknown', sessionCount: 1 },
      ]),
    );
  });
});

describe('PortfolioKpiStore model x harness matrix (missing vs. zero)', () => {
  it('distinguishes a pair that has never run (missing) from one with 0 sessions this window', async () => {
    const { executor, portfolioId } = await seed();
    // s-old ran (sonnet, claude-code) outside the query window: this pair is
    // "ever observed" but had 0 sessions inside [10000, 20000).
    await insertSession(executor, 's-old', 1000);
    await insertGeneration(executor, 's-old', 'gen-old');
    await insertModelRequest(executor, 's-old', 'gen-old', 0, 'claude-sonnet', 1, 1);
    // s-new ran (opus, claude-code) inside the window.
    await insertSession(executor, 's-new', 15000);
    await insertGeneration(executor, 's-new', 'gen-new');
    await insertModelRequest(executor, 's-new', 'gen-new', 0, 'claude-opus', 1, 1);

    const everObserved = await PortfolioKpiStore.getModelHarnessPairsEverObserved(
      executor,
      portfolioId,
    );
    const windowCounts = await PortfolioKpiStore.getModelHarnessCountsInWindow(
      executor,
      portfolioId,
      10000,
      20000,
    );

    expect(everObserved).toEqual(
      expect.arrayContaining([
        { model: 'claude-sonnet', harness: 'claude-code' },
        { model: 'claude-opus', harness: 'claude-code' },
      ]),
    );
    // sonnet/claude-code is ever-observed but has 0 sessions in this window —
    // a real measured zero, not present in windowCounts.
    expect(windowCounts.find((r) => r.model === 'claude-sonnet')).toBeUndefined();
    expect(windowCounts).toEqual(
      expect.arrayContaining([{ model: 'claude-opus', harness: 'claude-code', sessionCount: 1 }]),
    );
    // A pair never observed at all (e.g. haiku/claude-code) would not appear
    // in everObserved either — the db-package layer maps that absence to a
    // `sessionCount: null` matrix cell, distinct from sonnet's measured 0.
    expect(everObserved.some((p) => p.model === 'claude-haiku')).toBe(false);
  });
});

describe('PortfolioKpiStore invocations by domain (MCP not double-counted)', () => {
  it('sums to the same total as a raw invocation count, with an MCP-classified tool row', async () => {
    const { executor, portfolioId } = await seed();
    await insertSession(executor, 's1', 1000);
    await insertGeneration(executor, 's1', 'gen-1');
    // This "tool" invocation represents an MCP-server call (per the
    // analytics-domain-distinctions rule, MCP calls are stored with
    // kind = 'tool' and sub-classified via component_identities.kind =
    // 'mcp_server' — they are never a fifth invocation kind).
    await insertInvocation(executor, 's1', 'gen-1', 'tool', 2000);
    await insertInvocation(executor, 's1', 'gen-1', 'tool', 2100);
    await insertInvocation(executor, 's1', 'gen-1', 'skill', 2200);
    await insertInvocation(executor, 's1', 'gen-1', 'agent', 2300);
    await insertInvocation(executor, 's1', 'gen-1', 'sub_agent', 2400);

    const byDomain = await PortfolioKpiStore.getInvocationsByDomainInWindow(
      executor,
      portfolioId,
      0,
      5000,
    );
    const total = await PortfolioKpiStore.countTotalInvocationsInWindow(
      executor,
      portfolioId,
      0,
      5000,
    );

    expect(total).toBe(5);
    expect(byDomain.reduce((sum, r) => sum + r.count, 0)).toBe(total);
    expect(byDomain).toEqual(
      expect.arrayContaining([
        { kind: 'tool', count: 2 },
        { kind: 'skill', count: 1 },
        { kind: 'agent', count: 1 },
        { kind: 'sub_agent', count: 1 },
      ]),
    );
    // Exactly the four canonical kinds — no fifth "mcp" bucket.
    expect(byDomain.map((r) => r.kind).sort()).toEqual(['agent', 'skill', 'sub_agent', 'tool']);
  });
});
