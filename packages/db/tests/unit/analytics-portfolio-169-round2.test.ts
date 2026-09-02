import {
  ComponentIdentityStore,
  EnvironmentStore,
  FRESH_SCHEMA_SQL,
  IngestionSourceStore,
  InvocationStore,
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
import { createPortfolioView, getKpiBand } from '../../src/analytics-portfolio.js';

const TENANT_ID = 'tenant-169b';
const PORTFOLIO_ID = 'portfolio-169b';
const SOURCE_ID = 'source-169b';
const ENV_ID = 'env-169b';
const PROJECT_ID = 'project-169b';

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
  outcome: 'clean' | 'interrupted_by_user' | 'ended_on_error' | null = null,
  harness = 'claude-code',
): Promise<void> {
  await SessionStore.insert(executor, {
    id,
    projectId: PROJECT_ID,
    ingestionSourceId: SOURCE_ID,
    nativeSessionId: id,
    harness,
    finality: 'final',
    startTime,
    outcome,
  } as never);
}

async function insertGeneration(
  executor: WasmSqliteExecutor,
  sessionId: string,
  generationId: string,
): Promise<void> {
  const { rows } = await executor.exec('SELECT id FROM analysis_releases WHERE id = ?', [
    'ar-169b',
  ]);
  if (rows.length === 0) {
    await executor.exec(
      `INSERT INTO analysis_releases
       (id, ontology_version, metric_registry_version, statistical_policy_version,
        rollup_policy_version, mapping_version, created_at, is_default)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['ar-169b', '0.1.0', '0.1.0', '0.1.0', '0.1.0', '0.1.0', 1, 0],
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
      'ar-169b',
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

describe('PortfolioView.getKpiBand token/cost/clean-completion (issue #169 round 2)', () => {
  it('reports token totals, cost coverage, and clean-completion rate for the All preset', async () => {
    const executor = await createExecutor();
    await seedPortfolio(executor);
    await insertSession(executor, 's-clean', 1000, 'clean');
    await insertSession(executor, 's-error', 2000, 'ended_on_error');
    await insertGeneration(executor, 's-clean', 'gen-1');
    const requestId = await insertModelRequest(
      executor,
      's-clean',
      'gen-1',
      0,
      'claude-sonnet',
      100,
      50,
    );
    await ModelUsageStore.insert(executor, {
      sessionId: 's-clean',
      generationId: 'gen-1',
      requestId,
      tokenClass: 'input',
      tokenCount: 100,
      isEstimated: false,
      cost: null,
    } as never);

    const band = await getKpiBand(executor, { portfolioId: PORTFOLIO_ID });

    expect(band.tokens.in.current).toBe(100);
    expect(band.tokens.in.currentN).toBe(1);
    expect(band.tokens.out.current).toBe(50);
    expect(band.tokens.out.currentN).toBe(1);

    // No harness reported a non-null cost row: this is a coverage gap, never
    // a fabricated $0.
    expect(band.cost.currentTotal).toBeNull();
    expect(band.cost.currentReportedHarnesses).toBe(0);
    expect(band.cost.currentTotalHarnesses).toBe(1);

    // 1 of 2 finalized sessions has a known (non-null) outcome ('clean' is
    // classified, 'ended_on_error' is also classified — so knownN=2,
    // cleanN=1).
    expect(band.cleanCompletionRate.knownN).toBe(2);
    expect(band.cleanCompletionRate.eligibleN).toBe(2);
    expect(band.cleanCompletionRate.value).toBeCloseTo(0.5);
  });

  it('returns a null clean-completion rate (never 0%) when no session has a classified outcome', async () => {
    const executor = await createExecutor();
    await seedPortfolio(executor);
    await insertSession(executor, 's-unclassified', 1000, null);

    const band = await getKpiBand(executor, { portfolioId: PORTFOLIO_ID });
    expect(band.cleanCompletionRate.knownN).toBe(0);
    expect(band.cleanCompletionRate.value).toBeNull();
  });

  it('reports currentTotal as a real $0 (not null) once at least one harness reports cost', async () => {
    const executor = await createExecutor();
    await seedPortfolio(executor);
    await insertSession(executor, 's1', 1000);
    await insertGeneration(executor, 's1', 'gen-1');
    const requestId = await insertModelRequest(executor, 's1', 'gen-1', 0, 'claude-sonnet', 10, 10);
    await ModelUsageStore.insert(executor, {
      sessionId: 's1',
      generationId: 'gen-1',
      requestId,
      tokenClass: 'input',
      tokenCount: 10,
      isEstimated: false,
      cost: 0,
    } as never);

    const band = await getKpiBand(executor, { portfolioId: PORTFOLIO_ID });
    expect(band.cost.currentTotal).toBe(0);
    expect(band.cost.currentReportedHarnesses).toBe(1);
  });
});

describe('PortfolioView.getSessionsByModel (issue #169 round 2)', () => {
  it('lists sessions-by-model counts with the unknown bucket for sessions with no model_requests', async () => {
    const executor = await createExecutor();
    await seedPortfolio(executor);
    await insertSession(executor, 's-known', 1000);
    await insertGeneration(executor, 's-known', 'gen-1');
    await insertModelRequest(executor, 's-known', 'gen-1', 0, 'claude-sonnet', 1, 1);
    await insertSession(executor, 's-unknown', 2000);

    const view = createPortfolioView(executor);
    const bar = await view.getSessionsByModel({ portfolioId: PORTFOLIO_ID });
    expect(bar.rows).toEqual(
      expect.arrayContaining([
        { model: 'claude-sonnet', sessionCount: 1 },
        { model: 'unknown', sessionCount: 1 },
      ]),
    );
    expect(bar.token.knownN).toBe(2);
  });
});

describe('PortfolioView.getModelHarnessMatrix (issue #169 round 2, missing vs. zero)', () => {
  it('reports sessionCount: null for a model x harness pair never observed', async () => {
    const executor = await createExecutor();
    await seedPortfolio(executor);
    await insertSession(executor, 's-sonnet', 1000);
    await insertGeneration(executor, 's-sonnet', 'gen-1');
    await insertModelRequest(executor, 's-sonnet', 'gen-1', 0, 'claude-sonnet', 1, 1);
    await insertSession(executor, 's-opus', 15000);
    await insertGeneration(executor, 's-opus', 'gen-2');
    await insertModelRequest(executor, 's-opus', 'gen-2', 0, 'claude-opus', 1, 1);

    const view = createPortfolioView(executor);
    const matrix = await view.getModelHarnessMatrix({
      portfolioId: PORTFOLIO_ID,
      timeRange: {
        start: new Date(10000).toISOString(),
        end: new Date(20000).toISOString(),
      },
    });

    expect(matrix.models.sort()).toEqual(['claude-opus', 'claude-sonnet']);
    const sonnetCell = matrix.cells.find((c) => c.model === 'claude-sonnet');
    const opusCell = matrix.cells.find((c) => c.model === 'claude-opus');
    // sonnet ran outside the window: ever-observed, 0 sessions this window —
    // a real measured zero.
    expect(sonnetCell?.sessionCount).toBe(0);
    // opus ran inside the window.
    expect(opusCell?.sessionCount).toBe(1);
  });

  it('reports sessionCount: null for a (model, harness) pair the harness has never jointly run, distinct from a 0-session pair', async () => {
    // Regression coverage gap: every other test in this suite only ever
    // seeds `harness: 'claude-code'`, so the cartesian product of
    // models x harnesses can never contain a pair outside
    // everObservedKeys — the null branch was never exercised. Seed a
    // second harness that has only ever run one of the two models.
    const executor = await createExecutor();
    await seedPortfolio(executor);
    await insertSession(executor, 's-sonnet-cc', 1000, null, 'claude-code');
    await insertGeneration(executor, 's-sonnet-cc', 'gen-1');
    await insertModelRequest(executor, 's-sonnet-cc', 'gen-1', 0, 'claude-sonnet', 1, 1);
    await insertSession(executor, 's-opus-codex', 1000, null, 'codex');
    await insertGeneration(executor, 's-opus-codex', 'gen-2');
    await insertModelRequest(executor, 's-opus-codex', 'gen-2', 0, 'claude-opus', 1, 1);

    const view = createPortfolioView(executor);
    const matrix = await view.getModelHarnessMatrix({ portfolioId: PORTFOLIO_ID });

    const sonnetOnCodex = matrix.cells.find(
      (c) => c.model === 'claude-sonnet' && c.harness === 'codex',
    );
    const opusOnClaudeCode = matrix.cells.find(
      (c) => c.model === 'claude-opus' && c.harness === 'claude-code',
    );
    // codex has never run claude-sonnet, and claude-code has never run
    // claude-opus — both pairs are missing (never jointly observed), never
    // a fabricated 0.
    expect(sonnetOnCodex?.sessionCount).toBeNull();
    expect(opusOnClaudeCode?.sessionCount).toBeNull();
    // The pairs that were actually run remain real measured values.
    const sonnetOnClaudeCode = matrix.cells.find(
      (c) => c.model === 'claude-sonnet' && c.harness === 'claude-code',
    );
    const opusOnCodex = matrix.cells.find(
      (c) => c.model === 'claude-opus' && c.harness === 'codex',
    );
    expect(sonnetOnClaudeCode?.sessionCount).toBe(1);
    expect(opusOnCodex?.sessionCount).toBe(1);
  });

  it('reports sessionCount: null for every cell when the portfolio has never run any model', async () => {
    const executor = await createExecutor();
    await seedPortfolio(executor);
    const view = createPortfolioView(executor);
    const matrix = await view.getModelHarnessMatrix({ portfolioId: PORTFOLIO_ID });
    expect(matrix.cells).toEqual([]);
    expect(matrix.models).toEqual([]);
  });
});

describe('PortfolioView.getInvocationsByDomain (issue #169 round 2, MCP not double-counted)', () => {
  it('sums per-kind counts to totalInvocations with only the four canonical kinds', async () => {
    const executor = await createExecutor();
    await seedPortfolio(executor);
    await insertSession(executor, 's1', 1000);
    await insertGeneration(executor, 's1', 'gen-1');
    await InvocationStore.insert(executor, {
      sessionId: 's1',
      generationId: 'gen-1',
      kind: 'tool',
      startId: 'start-tool-1',
      rootSessionId: 's1',
      status: 'completed',
    } as never);
    await InvocationStore.insert(executor, {
      sessionId: 's1',
      generationId: 'gen-1',
      kind: 'skill',
      startId: 'start-skill-1',
      rootSessionId: 's1',
      status: 'completed',
    } as never);

    const view = createPortfolioView(executor);
    const byDomain = await view.getInvocationsByDomain({ portfolioId: PORTFOLIO_ID });
    expect(byDomain.totalInvocations).toBe(2);
    expect(byDomain.rows.reduce((sum, r) => sum + r.count, 0)).toBe(2);
    expect(byDomain.rows.map((r) => r.kind).sort()).toEqual(['skill', 'tool']);
  });

  it('counts an MCP-server call inside the tool bucket, never as a fifth domain', async () => {
    // Per .agents/rules/analytics-domain-distinctions.md: MCP is a
    // sub-classification within the tool pool (component_identities.kind =
    // 'mcp_server'), not a peer invocation kind. The invocation row itself
    // is always stored with kind = 'tool'.
    const executor = await createExecutor();
    await seedPortfolio(executor);
    await insertSession(executor, 's1', 1000);
    await insertGeneration(executor, 's1', 'gen-1');
    const mcpComponentId = await ComponentIdentityStore.insert(executor, {
      portfolioId: PORTFOLIO_ID,
      kind: 'mcp_server',
      nativeId: 'mcp-server-1',
      canonicalSourceIdentity: 'mcp_server:mcp-server-1',
      displayName: 'My MCP Server',
    });
    await InvocationStore.insert(executor, {
      sessionId: 's1',
      generationId: 'gen-1',
      kind: 'tool',
      componentId: mcpComponentId,
      startId: 'start-mcp-1',
      rootSessionId: 's1',
      status: 'completed',
    } as never);
    await InvocationStore.insert(executor, {
      sessionId: 's1',
      generationId: 'gen-1',
      kind: 'skill',
      startId: 'start-skill-2',
      rootSessionId: 's1',
      status: 'completed',
    } as never);

    const view = createPortfolioView(executor);
    const byDomain = await view.getInvocationsByDomain({ portfolioId: PORTFOLIO_ID });
    expect(byDomain.totalInvocations).toBe(2);
    expect(byDomain.rows.reduce((sum, r) => sum + r.count, 0)).toBe(2);
    // No fifth "mcp" bucket — the MCP call is folded into "tool".
    expect(byDomain.rows.map((r) => r.kind).sort()).toEqual(['skill', 'tool']);
    const toolRow = byDomain.rows.find((r) => r.kind === 'tool');
    expect(toolRow?.count).toBe(1);
  });
});
