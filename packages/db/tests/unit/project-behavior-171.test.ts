import {
  EnvironmentStore,
  FRESH_SCHEMA_SQL,
  IngestionSourceStore,
  ModelRequestStore,
  ModelUsageStore,
  PortfolioStore,
  ProjectStore,
  SessionStore,
  SourceProjectStore,
  TenantStore,
} from '@lucasschirm/sal-db-core';
import { describe, expect, it } from 'vitest';
import { WasmSqliteExecutor } from '../../../db-core/tests/helpers/sqlite-wasm-adapter.js';
import {
  createProjectBehaviorView,
  getProjectHeader,
  getStatStrip,
} from '../../src/project-behavior.js';

const TENANT_ID = 'tenant-pb171';
const PORTFOLIO_ID = 'portfolio-pb171';
const SOURCE_ID = 'source-pb171';
const ENV_ID = 'env-pb171';
const PROJECT_ID = 'project-pb171';

async function createExecutor(displayName?: string | null): Promise<WasmSqliteExecutor> {
  const executor = await WasmSqliteExecutor.create();
  await executor.exec(FRESH_SCHEMA_SQL);
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
  await ProjectStore.insert(executor, {
    id: PROJECT_ID,
    portfolioId: PORTFOLIO_ID,
    name: 'alpha',
    displayName: displayName ?? undefined,
  });
  await SourceProjectStore.insert(executor, PORTFOLIO_ID, {
    projectId: PROJECT_ID,
    ingestionSourceId: SOURCE_ID,
    nativeProjectId: 'native-alpha',
  });
  return executor;
}

async function insertSession(
  executor: WasmSqliteExecutor,
  id: string,
  harness: string,
  startTime: number | null,
  endTime: number | null = null,
): Promise<void> {
  await SessionStore.insert(executor, {
    id,
    projectId: PROJECT_ID,
    ingestionSourceId: SOURCE_ID,
    nativeSessionId: id,
    harness,
    finality: 'final',
    startTime,
    endTime,
  });
}

async function insertGeneration(
  executor: WasmSqliteExecutor,
  sessionId: string,
  generationId: string,
): Promise<void> {
  const { rows } = await executor.exec('SELECT id FROM analysis_releases WHERE id = ?', [
    'pb171-ar',
  ]);
  if (rows.length === 0) {
    await executor.exec(
      `INSERT INTO analysis_releases
       (id, ontology_version, metric_registry_version, statistical_policy_version,
        rollup_policy_version, mapping_version, created_at, is_default)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['pb171-ar', '0.1.0', '0.1.0', '0.1.0', '0.1.0', '0.1.0', 1, 0],
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
      'pb171-ar',
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
): Promise<string> {
  return ModelRequestStore.insert(executor, {
    sessionId,
    generationId,
    requestOrder,
    model,
    provider: 'anthropic',
    inputTokens: 100,
    outputTokens: 50,
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

describe('getProjectHeader (issue #171)', () => {
  it('falls back to the project name when no display name is set', async () => {
    const executor = await createExecutor(null);
    await insertSession(executor, 's1', 'claude-code', 1000, 2000);
    const header = await getProjectHeader(executor, PROJECT_ID);
    expect(header.displayName).toBe('alpha');
  });

  it('prefers the stored display name over the raw project name', async () => {
    const executor = await createExecutor('Alpha Project');
    await insertSession(executor, 's1', 'claude-code', 1000, 2000);
    const header = await getProjectHeader(executor, PROJECT_ID);
    expect(header.displayName).toBe('Alpha Project');
  });

  it('reports harnesses observed and all-time session count across harnesses', async () => {
    const executor = await createExecutor('Alpha');
    await insertSession(executor, 's1', 'claude-code', 1000, 2000);
    await insertSession(executor, 's2', 'codex', 500, 1500);
    await insertSession(executor, 's3', 'claude-code', 2000, 3000);

    const header = await getProjectHeader(executor, PROJECT_ID);
    expect(header.harnesses).toEqual(['claude-code', 'codex']);
    expect(header.sessionCount).toBe(3);
  });

  it('derives the active window from the earliest and latest known start times', async () => {
    const executor = await createExecutor('Alpha');
    await insertSession(executor, 's1', 'claude-code', 2_000, null);
    await insertSession(executor, 's2', 'claude-code', 10_000, null);

    const header = await getProjectHeader(executor, PROJECT_ID);
    expect(header.activeWindowStart).toBe(new Date(2_000).toISOString());
    expect(header.activeWindowEnd).toBe(new Date(10_000).toISOString());
  });

  it('omits the active window when no session has a known start time', async () => {
    const executor = await createExecutor('Alpha');
    await insertSession(executor, 's1', 'claude-code', null, null);

    const header = await getProjectHeader(executor, PROJECT_ID);
    expect(header.activeWindowStart).toBeUndefined();
    expect(header.activeWindowEnd).toBeUndefined();
  });

  it('is exposed through the view factory', async () => {
    const executor = await createExecutor('Alpha');
    await insertSession(executor, 's1', 'claude-code', 1000, 2000);
    const view = createProjectBehaviorView(executor);
    expect(await view.getHeader(PROJECT_ID)).toBeDefined();
  });
});

describe('getStatStrip tokensPerSession previous-window delta (issue #171)', () => {
  it('omits previousValue when no time range is given (All preset)', async () => {
    const executor = await createExecutor('Alpha');
    await insertSession(executor, 's1', 'claude-code', 1000);
    const result = await getStatStrip(executor, PROJECT_ID, {});
    expect(result.tokensPerSession.previousValue).toBeUndefined();
  });

  it('computes previousValue from the equal-length preceding window', async () => {
    const executor = await createExecutor('Alpha');
    // Previous window: [0, 1000). Current window: [1000, 2000).
    await insertSession(executor, 's-prev', 'claude-code', 500);
    await insertGeneration(executor, 's-prev', 'gen-prev');
    const reqPrev = await insertModelRequest(executor, 's-prev', 'gen-prev', 0, 'claude-sonnet');
    void reqPrev;

    await insertSession(executor, 's-cur', 'claude-code', 1500);
    await insertGeneration(executor, 's-cur', 'gen-cur');
    await insertModelRequest(executor, 's-cur', 'gen-cur', 0, 'claude-sonnet');

    const result = await getStatStrip(executor, PROJECT_ID, {
      timeRange: { start: new Date(1000).toISOString(), end: new Date(2000).toISOString() },
    });
    expect(result.tokensPerSession.value).toBe(150);
    expect(result.tokensPerSession.previousValue).toBe(150);
    expect(result.tokensPerSession.previousKnownN).toBe(1);
    // Equal current/previous — a real, computed 0% delta, not an omission.
    expect(result.tokensPerSession.deltaPercent).toBe(0);
    expect(result.tokensPerSession.deltaDirection).toBe('flat');
  });
});

describe('getStatStrip sessions deltaPercent/deltaDirection (issue #171)', () => {
  it('omits deltaPercent/deltaDirection when no previous window exists (All preset)', async () => {
    const executor = await createExecutor('Alpha');
    await insertSession(executor, 's1', 'claude-code', 1000);
    const result = await getStatStrip(executor, PROJECT_ID, {});
    expect(result.sessions.deltaPercent).toBeUndefined();
    expect(result.sessions.deltaDirection).toBeUndefined();
  });

  it('computes an increase as a positive deltaPercent with an "up" direction', async () => {
    const executor = await createExecutor('Alpha');
    await insertSession(executor, 's-prev', 'claude-code', 500);
    await insertSession(executor, 's-cur-1', 'claude-code', 1500);
    await insertSession(executor, 's-cur-2', 'claude-code', 1600);
    const result = await getStatStrip(executor, PROJECT_ID, {
      timeRange: { start: new Date(1000).toISOString(), end: new Date(2000).toISOString() },
    });
    expect(result.sessions.current).toBe(2);
    expect(result.sessions.previous).toBe(1);
    expect(result.sessions.deltaPercent).toBe(100);
    expect(result.sessions.deltaDirection).toBe('up');
  });

  it('leaves deltaPercent null when the previous window had 0 sessions (undefined ratio)', async () => {
    const executor = await createExecutor('Alpha');
    await insertSession(executor, 's-cur', 'claude-code', 1500);
    const result = await getStatStrip(executor, PROJECT_ID, {
      timeRange: { start: new Date(1000).toISOString(), end: new Date(2000).toISOString() },
    });
    expect(result.sessions.current).toBe(1);
    expect(result.sessions.previous).toBe(0);
    expect(result.sessions.deltaPercent).toBeNull();
    expect(result.sessions.deltaDirection).toBe('up');
  });
});

describe('getStatStrip costHarnessCoverage (issue #171)', () => {
  it('reports 0 of 0 when no harness has a session with model requests in the window', async () => {
    const executor = await createExecutor('Alpha');
    await insertSession(executor, 's1', 'claude-code', 1000);
    const result = await getStatStrip(executor, PROJECT_ID, {});
    expect(result.costHarnessCoverage).toEqual({ reportingHarnessCount: 0, totalHarnessCount: 0 });
  });

  it('flags a harness with no known cost separately from one that reports it', async () => {
    const executor = await createExecutor('Alpha');

    await insertSession(executor, 's1', 'claude-code', 1000);
    await insertGeneration(executor, 's1', 'gen-1');
    const req1 = await insertModelRequest(executor, 's1', 'gen-1', 0, 'claude-sonnet');
    await insertCost(executor, 's1', 'gen-1', req1, 0.5);

    await insertSession(executor, 's2', 'codex', 1000);
    await insertGeneration(executor, 's2', 'gen-2');
    await insertModelRequest(executor, 's2', 'gen-2', 0, 'gpt-5');
    // codex session records no cost row at all.

    const result = await getStatStrip(executor, PROJECT_ID, {});
    expect(result.costHarnessCoverage).toEqual({ reportingHarnessCount: 1, totalHarnessCount: 2 });
  });
});
