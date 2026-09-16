import { FRESH_SCHEMA_SQL } from '@lucasschirm/sal-db-core';
import { createDefaultRegistry } from '@lucasschirm/sal-transformer-registry';
import type { UnknownArtifactBundle } from '@lucasschirm/sal-transformer-shared';
import { describe, expect, it } from 'vitest';
import { WasmSqliteExecutor } from '../../../db-core/tests/helpers/sqlite-wasm-adapter.js';
import { usageAttributionBundle } from '../../../transformers/devin-transformer/tests/conformance/fixtures/index.js';
import { createAnalyticsDataSource } from '../../src/analytics.js';
import { createSha256ContentHasher, DefaultIngestionOrchestrator } from '../../src/ingestion.js';
import { buildDevinManifestBundle } from '../fixtures/devin-manifest.js';
import { FailureInjectionExecutor } from './harness.js';

async function setupPipeline() {
  const inner = await WasmSqliteExecutor.create();
  await inner.exec(FRESH_SCHEMA_SQL);
  const harness = new FailureInjectionExecutor(inner);
  harness.setInjection(undefined);
  const orchestrator = new DefaultIngestionOrchestrator({
    executor: harness,
    hasher: createSha256ContentHasher(),
    registry: createDefaultRegistry(),
    resolver: { resolve: async (ref) => ({ ...ref, content: new Uint8Array(0) }) },
    analysisReleaseId: 'ar-pipe024',
  });
  return { harness, orchestrator };
}

async function ingestUsageSession(bundle: UnknownArtifactBundle = usageAttributionBundle) {
  const { harness, orchestrator } = await setupPipeline();
  const { bundle: manifest } = await buildDevinManifestBundle({ sourceBundle: bundle });
  const receipt = await orchestrator.ingestManifest(manifest);
  expect(receipt.status).toBe('committed');
  expect(receipt.issueIds).toEqual([]);
  return { harness, dataSource: createAnalyticsDataSource(harness), sessionId: receipt.sessionId };
}

describe('PIPE-024: devin component usage attribution reaches the utilization views', () => {
  it('reports an invoked component as Used (not 0) in the session availability report', async () => {
    const { dataSource, sessionId } = await ingestUsageSession();

    const report = await dataSource.session.getUtilizationReport(sessionId, {});
    expect(report.scopeType).toBe('session');
    const domains = report.sessionDomains;
    expect(domains).toBeDefined();

    // The regression this guards: every Devin component used to report
    // available-but-unused no matter how often it ran, because the transformer
    // emitted no component_evidence_link records and `session_component_stats`
    // stayed empty.
    expect(domains?.skill).toMatchObject({ availableCount: 1, usedCount: 1, unusedCount: 0 });
    expect(domains?.skill?.usedComponents).toEqual(['skill/add-e2e-test']);
    expect(domains?.skill?.unusedComponents).toEqual([]);

    // `exec` is invoked but offered by no promoted availability list: usage
    // proves availability, so it is available AND used — the 4 MCP wrappers stay
    // declared-but-unused.
    expect(domains?.tool?.usedComponents).toEqual(['tool/exec']);
    expect(domains?.tool?.availableCount).toBe(5);
    expect(domains?.tool?.usedCount).toBe(1);
    expect(domains?.tool?.unusedCount).toBe(4);
    expect(domains?.tool?.unusedComponents.slice().sort()).toEqual([
      'tool/mcp_call_tool',
      'tool/mcp_list_servers',
      'tool/mcp_list_tools',
      'tool/mcp_read_resource',
    ]);

    // Nothing invoked a subagent in this fixture, so the Agent domain stays
    // empty rather than being padded with a fake entry.
    expect(domains?.agent?.availableCount).toBe(0);
    expect(domains?.agent?.usedCount).toBe(0);
  });

  it('populates the session Tool / Skill / Agent activity drill-down with per-component invocation counts', async () => {
    const { dataSource, sessionId } = await ingestUsageSession();

    const facts = await dataSource.session.getComponentFacts(sessionId, {});
    const byName = new Map(facts.items.map((item) => [item.displayName, item]));
    expect([...byName.keys()].sort()).toEqual(['skill/add-e2e-test', 'tool/exec']);
    expect(byName.get('tool/exec')?.invocationCount).toBe(1);
    expect(byName.get('tool/exec')?.kind).toBe('tool');
    // `.agents/rules/never-display-raw-ids.md`: the row label the session page
    // renders is a `kind/nativeId` pair, never the canonical component id.
    expect(byName.get('tool/exec')?.displayName).not.toBe(byName.get('tool/exec')?.componentId);
  });

  it('surfaces the per-message Tool/Skill/Agent classification on context growth points', async () => {
    const { dataSource, sessionId } = await ingestUsageSession();

    const series = await dataSource.session.getContextTimingSeries(sessionId, {});
    const byRole = series.points.map((point) => ({
      role: point.role,
      invocationKind: point.invocationKind,
    }));
    // user prompt stays unclassified; the two assistant dispatchers and the
    // answering tool node each carry their domain.
    expect(byRole).toEqual([
      { role: 'user', invocationKind: undefined },
      { role: 'assistant', invocationKind: 'tool' },
      { role: 'tool', invocationKind: 'tool' },
      { role: 'assistant', invocationKind: 'skill' },
    ]);
  });

  it('counts the session as a used session for the invoked component in project rollups', async () => {
    const { harness, orchestrator } = await setupPipeline();
    const { bundle } = await buildDevinManifestBundle({ sourceBundle: usageAttributionBundle });
    const receipt = await orchestrator.ingestManifest(bundle);
    const dataSource = createAnalyticsDataSource(harness);
    const { rows } = await harness.exec('SELECT project_id FROM sessions WHERE id = ?', [
      receipt.sessionId,
    ]);
    const projectId = String(rows[0]?.project_id);

    const report = await dataSource.project.getUtilizationReport(projectId, {});
    const exec = report.domains.tool?.components.find((c) => c.nativeId === 'exec');
    expect(exec).toBeDefined();
    expect(exec?.offeredSessions).toBe(1);
    // Declared-but-never-invoked MCP wrapper: offered, and correctly unused.
    const mcp = report.domains.tool?.components.find((c) => c.nativeId === 'mcp_list_tools');
    expect(mcp?.usedSessions).toBe(0);
    expect(exec?.usedSessions).toBe(1);
  });
});
