import { FRESH_SCHEMA_SQL } from '@lucasschirm/sal-db-core';
import { createDefaultRegistry } from '@lucasschirm/sal-transformer-registry';
import { describe, expect, it } from 'vitest';
import { WasmSqliteExecutor } from '../../../db-core/tests/helpers/sqlite-wasm-adapter.js';
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
    analysisReleaseId: 'ar-pipe015',
  });
  return { harness, orchestrator };
}

describe('PIPE-015: devin cogs_json-derived components and skill/agent invocation metrics', () => {
  it('surfaces real skill/agent invocation counts and portfolio component utilization end-to-end', async () => {
    const { harness, orchestrator } = await setupPipeline();
    const { bundle } = await buildDevinManifestBundle({ useComponentsBundle: true });

    const receipt = await orchestrator.ingestManifest(bundle);
    expect(receipt.status).toBe('committed');
    expect(receipt.issueIds).toEqual([]);

    const dataSource = createAnalyticsDataSource(harness);

    // Two previously-unavailable metrics (DS-F11 (#288)) now carry real,
    // exact values through the full pipeline (parse -> transform -> ingest
    // -> session summary), not just in the transformer's own unit tests.
    const sessionSummary = await dataSource.session.getSummary(receipt.sessionId, {});
    const skillMetric = sessionSummary.headlineMetrics.find(
      (m) => m.metricId === 'devin:invocations:skill:root_only',
    );
    const agentMetric = sessionSummary.headlineMetrics.find(
      (m) => m.metricId === 'devin:invocations:agent:root_only',
    );
    expect(skillMetric?.value).toBe(1);
    expect(skillMetric?.eligibleN).toBeGreaterThanOrEqual(1);
    expect(agentMetric?.value).toBe(1);
    expect(agentMetric?.eligibleN).toBeGreaterThanOrEqual(1);

    // The Component Ecosystem view (getComponentUtilization) reads from
    // session_component_exposures, populated at ingestion from
    // configurationSnapshot.components. The cogs_json-derived skill and MCP
    // wrapper tool components, and the tool_call_state-derived agent
    // component, must all reach it with human-readable labels
    // (`.agents/rules/never-display-raw-ids.md`) rather than raw component
    // ids.
    const utilization = await dataSource.portfolio.getComponentUtilization({});
    const byKind = new Map<string, typeof utilization.items>();
    for (const item of utilization.items) {
      byKind.set(item.kind, [...(byKind.get(item.kind) ?? []), item]);
    }

    // componentDisplayName(kind, nativeId, displayName, id) prefers
    // `kind/nativeId` per never-display-raw-ids.md.
    const skillItems = byKind.get('skill') ?? [];
    expect(skillItems).toHaveLength(1);
    expect(skillItems[0]?.name).toBe('skill/add-e2e-test');
    expect(skillItems[0]?.name).not.toBe(skillItems[0]?.componentId);

    const agentItems = byKind.get('agent') ?? [];
    expect(agentItems).toHaveLength(1);
    expect(agentItems[0]?.name).toBe('agent/pr-review');
    expect(agentItems[0]?.name).not.toBe(agentItems[0]?.componentId);

    const toolItems = byKind.get('tool') ?? [];
    expect(toolItems).toHaveLength(4);
    const toolNames = toolItems.map((t) => t.name).sort();
    expect(toolNames).toEqual([
      'tool/mcp_call_tool',
      'tool/mcp_list_servers',
      'tool/mcp_list_tools',
      'tool/mcp_read_resource',
    ]);
  });

  it('resolves the same skill/agent/tool componentIds across two sessions from the same source (stable identity)', async () => {
    const { harness, orchestrator } = await setupPipeline();

    const first = await buildDevinManifestBundle({
      useComponentsBundle: true,
      sessionId: 'devin-session-1',
    });
    const second = await buildDevinManifestBundle({
      useComponentsBundle: true,
      sessionId: 'devin-session-2',
    });

    const receiptA = await orchestrator.ingestManifest(first.bundle);
    const receiptB = await orchestrator.ingestManifest(second.bundle);
    expect(receiptA.status).toBe('committed');
    expect(receiptB.status).toBe('committed');

    const dataSource = createAnalyticsDataSource(harness);
    const utilization = await dataSource.portfolio.getComponentUtilization({});

    // The same skill/agent/tool invoked across two distinct sessions from
    // the same ingestion source must resolve to one componentId each (not a
    // fresh identity per session), so utilization aggregates across both
    // sessions instead of fragmenting into per-session duplicates
    // (`.agents/rules/component-identity-not-display-name.md`).
    const skillItems = utilization.items.filter((i) => i.kind === 'skill');
    expect(skillItems).toHaveLength(1);
    expect(skillItems[0]?.sessionCount).toBe(2);

    const agentItems = utilization.items.filter((i) => i.kind === 'agent');
    expect(agentItems).toHaveLength(1);
    expect(agentItems[0]?.sessionCount).toBe(2);
  });
});
