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
    analysisReleaseId: 'ar-pipe019',
  });
  return { harness, orchestrator };
}

describe('PIPE-020: devin file-backed skill/agent/rule config components (#342)', () => {
  it('classifies .devin/skills|agents|rules/** and surfaces resolved component labels through the Component Ecosystem view', async () => {
    const { harness, orchestrator } = await setupPipeline();
    const { bundle } = await buildDevinManifestBundle({ useConfigComponentsBundle: true });

    const receipt = await orchestrator.ingestManifest(bundle);
    expect(receipt.status).toBe('committed');
    expect(receipt.issueIds).toEqual([]);

    const dataSource = createAnalyticsDataSource(harness);

    // The Component Ecosystem view (getComponentUtilization) reads from
    // session_component_exposures, populated at ingestion from
    // configurationSnapshot.components. The file-backed skill/agent/rule
    // components (classify-time, #342) must all reach it with
    // human-readable labels (`.agents/rules/never-display-raw-ids.md`)
    // rather than raw component ids — using DIFFERENT example names than
    // PIPE-015's cog-derived `add-e2e-test`/`pr-review` fixture, so
    // file-derived and cog-derived components stay visually distinct.
    const utilization = await dataSource.portfolio.getComponentUtilization({});
    const byKind = new Map<string, typeof utilization.items>();
    for (const item of utilization.items) {
      byKind.set(item.kind, [...(byKind.get(item.kind) ?? []), item]);
    }

    const skillItems = byKind.get('skill') ?? [];
    expect(skillItems).toHaveLength(1);
    expect(skillItems[0]?.name).toBe('skill/draft-release-notes');
    expect(skillItems[0]?.name).not.toBe(skillItems[0]?.componentId);

    const agentItems = byKind.get('agent') ?? [];
    expect(agentItems).toHaveLength(1);
    expect(agentItems[0]?.name).toBe('agent/changelog-curator');
    expect(agentItems[0]?.name).not.toBe(agentItems[0]?.componentId);

    // The rule component is keyed on its file's stable basename, not a
    // content-derived title (PR #375 review, second round) — a raw path or
    // hash would violate never-display-raw-ids.md, but a title derived from
    // heading/description text would violate component-identity-not-
    // display-name.md by churning the componentId on ordinary content edits.
    const ruleItems = byKind.get('rule') ?? [];
    expect(ruleItems).toHaveLength(1);
    expect(ruleItems[0]?.name).toBe('rule/changelog-style');
    expect(ruleItems[0]?.name).not.toBe(ruleItems[0]?.componentId);
  });

  it('resolves the same skill/agent/rule componentIds across two sessions from the same source (stable identity)', async () => {
    const { harness, orchestrator } = await setupPipeline();

    const first = await buildDevinManifestBundle({
      useConfigComponentsBundle: true,
      sessionId: 'devin-config-session-1',
    });
    const second = await buildDevinManifestBundle({
      useConfigComponentsBundle: true,
      sessionId: 'devin-config-session-2',
    });

    const receiptA = await orchestrator.ingestManifest(first.bundle);
    const receiptB = await orchestrator.ingestManifest(second.bundle);
    expect(receiptA.status).toBe('committed');
    expect(receiptB.status).toBe('committed');

    const dataSource = createAnalyticsDataSource(harness);
    const utilization = await dataSource.portfolio.getComponentUtilization({});

    // Same source+scope+path+name (`.agents/rules/component-identity-not-
    // display-name.md`) across two sessions must resolve to one componentId
    // each, not fragment into per-session duplicates.
    const skillItems = utilization.items.filter((i) => i.kind === 'skill');
    expect(skillItems).toHaveLength(1);
    expect(skillItems[0]?.sessionCount).toBe(2);

    const agentItems = utilization.items.filter((i) => i.kind === 'agent');
    expect(agentItems).toHaveLength(1);
    expect(agentItems[0]?.sessionCount).toBe(2);

    const ruleItems = utilization.items.filter((i) => i.kind === 'rule');
    expect(ruleItems).toHaveLength(1);
    expect(ruleItems[0]?.sessionCount).toBe(2);
  });

  it('exposes exactly the three file-backed components — no bogus or duplicate entries leak through', async () => {
    const { harness, orchestrator } = await setupPipeline();
    const { bundle } = await buildDevinManifestBundle({ useConfigComponentsBundle: true });

    const receipt = await orchestrator.ingestManifest(bundle);
    expect(receipt.status).toBe('committed');

    const dataSource = createAnalyticsDataSource(harness);
    const utilization = await dataSource.portfolio.getComponentUtilization({});
    expect(utilization.items).toHaveLength(3);
    expect(utilization.items.map((i) => i.kind).sort()).toEqual(['agent', 'rule', 'skill']);
  });
});
