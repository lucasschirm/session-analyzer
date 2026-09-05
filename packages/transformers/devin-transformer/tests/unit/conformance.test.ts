import { runTransformerConformanceSuite } from '@lucasschirm/sal-transformer-shared/conformance';
import { describe, expect, it } from 'vitest';
import { DEVIN_CONFORMANCE_PROFILE, DevinTransformer } from '../../src/index.js';
import { devinConformanceFixtures } from '../conformance/fixtures/index.js';

describe('DevinTransformer conformance', () => {
  it('passes the shared transformer conformance suite (strict: unverified fails)', () => {
    const report = runTransformerConformanceSuite(DevinTransformer, devinConformanceFixtures, {
      profile: DEVIN_CONFORMANCE_PROFILE,
      strict: true,
    });
    for (const inv of report.invariants) {
      if (inv.status !== 'passed') {
        console.log(`[${inv.status}] ${inv.code}: ${inv.details.join('; ')}`);
      }
    }
    expect(report.passed).toBe(true);
    // #308: every canonical invariant must actually execute for devin —
    // `unverified` means a missing fixture silently disabled a check.
    expect(report.invariants.filter((i) => i.status === 'unverified')).toEqual([]);
  });

  for (const fixture of devinConformanceFixtures.fixtures) {
    it(`fixture ${fixture.name} can be classified and transformed`, () => {
      const classification = DevinTransformer.classifyArtifacts(fixture.bundle);
      expect(classification).toBeDefined();
      expect(Array.isArray(classification.artifacts)).toBe(true);
      expect(classification.configurationSnapshot).toBeDefined();

      const capabilities = DevinTransformer.getCapabilities(fixture.bundle);
      expect(Array.isArray(capabilities)).toBe(true);

      const result = DevinTransformer.transform(fixture.bundle, fixture.context);
      expect(result).toBeDefined();
      expect(Array.isArray(result.metricValues)).toBe(true);
      expect(Array.isArray(result.evidence)).toBe(true);
      expect(
        result.metricValues.length > 0 ||
          result.unavailableReasons.length > 0 ||
          result.errors.length > 0,
      ).toBe(true);
    });
  }

  it('DS-B25 (#285): the model-switch fixture emits one model_usage record per agent step with distinct models, and token totals still balance', () => {
    const fixture = devinConformanceFixtures.fixtures.find((f) => f.name === 'model-switch');
    expect(fixture).toBeDefined();
    if (!fixture) return;
    const result = DevinTransformer.transform(fixture.bundle, fixture.context);

    const usageRecords = result.evidence.filter((r) => r.recordType === 'model_usage');
    expect(usageRecords).toHaveLength(2);
    const models = usageRecords.map((r) => (r.payload as { model: string }).model);
    expect(new Set(models).size).toBe(2);
    expect(models).toEqual(['glm-5-2', 'swe-1-7']);

    const inputSum = usageRecords.reduce(
      (sum, r) => sum + ((r.payload as { inputTokens: number }).inputTokens ?? 0),
      0,
    );
    const outputSum = usageRecords.reduce(
      (sum, r) => sum + ((r.payload as { outputTokens: number }).outputTokens ?? 0),
      0,
    );
    const cachedSum = usageRecords.reduce(
      (sum, r) => sum + ((r.payload as { cacheReadTokens: number }).cacheReadTokens ?? 0),
      0,
    );
    expect(inputSum).toBe(35104);
    expect(outputSum).toBe(96);
    expect(cachedSum).toBe(23010);
  });

  it('DS-B31 (#290): the model-switch fixture attaches a non-null, label-derived effort to both steps and reports one transition', () => {
    const fixture = devinConformanceFixtures.fixtures.find((f) => f.name === 'model-switch');
    expect(fixture).toBeDefined();
    if (!fixture) return;
    const result = DevinTransformer.transform(fixture.bundle, fixture.context);

    const usageRecords = result.evidence.filter((r) => r.recordType === 'model_usage');
    const efforts = usageRecords.map(
      (r) => (r.payload as { effort: string | null; normalizedEffort: string | null }).effort,
    );
    expect(efforts).toEqual(['High', 'Max']);
    const normalized = usageRecords.map(
      (r) => (r.payload as { normalizedEffort: string | null }).normalizedEffort,
    );
    expect(normalized).toEqual(['high', 'max']);

    const rootTransitions = result.metricValues.find(
      (m) => m.metricId === 'devin:effort:changes:root_only',
    );
    expect(rootTransitions?.value).toBe(1);
  });

  it('reports complete skill/tool/agent completeness for the session-components fixture', () => {
    const fixture = devinConformanceFixtures.fixtures.find((f) => f.name === 'session-components');
    expect(fixture).toBeDefined();
    if (!fixture) return;
    const result = DevinTransformer.transform(fixture.bundle, fixture.context);
    expect(result.configurationSnapshot.completeness.skill).toBe('complete');
    expect(result.configurationSnapshot.completeness.tool).toBe('complete');
    expect(result.configurationSnapshot.completeness.agent).toBe('complete');
    expect(result.configurationSnapshot.temporalRole).toBe('runtime');
  });

  it('DS-B28 (#294): the subagent-evidence fixture produces subagent_turn evidence for both the foreground and background invocation, with clean main-chain turnOrdinal', () => {
    const fixture = devinConformanceFixtures.fixtures.find((f) => f.name === 'subagent-evidence');
    expect(fixture).toBeDefined();
    if (!fixture) return;
    const result = DevinTransformer.transform(fixture.bundle, fixture.context);

    const subagentTurns = result.evidence.filter(
      (r) =>
        r.recordType === 'normalized_event' &&
        (r.payload as { category?: string }).category === 'subagent_turn',
    );
    expect(subagentTurns).toHaveLength(4); // 2 prompts + 2 results (foreground + background)

    const byAgent = new Map<string, typeof subagentTurns>();
    for (const record of subagentTurns) {
      const payload = record.payload as { agentId: string };
      byAgent.set(payload.agentId, [...(byAgent.get(payload.agentId) ?? []), record]);
    }
    expect(byAgent.get('44472e00')).toHaveLength(2);
    expect(byAgent.get('55c47591')).toHaveLength(2);

    const backgroundResult = subagentTurns.find((r) => {
      const p = r.payload as { agentId: string; kind: string };
      return p.agentId === '55c47591' && p.kind === 'result';
    });
    const backgroundPayload = backgroundResult?.payload as {
      content?: string;
      isBackground?: boolean;
    };
    // The real report, sourced from the untagged notification node -- not
    // the "started" pointer text (finding #3).
    expect(backgroundPayload.content).toBe(
      '<subagent_completion_notification>\n[Background subagent with agent_id=55c47591 completed]\n\nfull background report',
    );
    expect(backgroundPayload.isBackground).toBe(true);

    // No fabricated token/cache/cost/model-id fields anywhere.
    for (const record of subagentTurns) {
      const payload = record.payload as Record<string, unknown>;
      expect(payload).not.toHaveProperty('tokens');
      expect(payload).not.toHaveProperty('cost');
      expect(payload).not.toHaveProperty('cachedTokens');
    }

    // The generic orphan tree (finding #5) is captured too, but never
    // claims a subagent correlation it can't back up.
    const detached = result.evidence.filter(
      (r) =>
        r.recordType === 'normalized_event' &&
        (r.payload as { category?: string }).category === 'detached_conversation',
    );
    expect(detached).toHaveLength(1);
    expect((detached[0].payload as { rootNodeId: number }).rootNodeId).toBe(317);

    // Finding #4 (duplicate node pair) and finding #5 (orphan tree) do not
    // corrupt main turnOrdinal: exactly one turn per real, deduped,
    // main-chain node id, never inflated by the duplicate or the orphan.
    const turnRecords = result.evidence.filter((r) => r.recordType === 'turn');
    const ordinals = turnRecords.map((r) => (r.payload as { ordinal: number }).ordinal);
    expect(new Set(ordinals).size).toBe(ordinals.length); // no duplicate ordinals
    const turnNodeIds = turnRecords.map((r) => (r.payload as { nodeId: number }).nodeId);
    expect(turnNodeIds).not.toContain(249); // the dropped duplicate
    expect(turnNodeIds).not.toContain(317); // the orphan tree's root

    // DS-B28 design item 1's "wherever present" acceptance criterion: the
    // real foreground-tagged node (178) is naturally part of the MAIN
    // chain (never detached), so it must surface its subagent/* tags on
    // its own ordinary `message` record too -- not only via the synthetic
    // subagent_turn records built from detachedMessages.
    const messageRecords = result.evidence.filter((r) => r.recordType === 'message');
    const taggedMainChainMessage = messageRecords.find(
      (r) => (r.payload as { nodeId: number }).nodeId === 178,
    );
    expect(taggedMainChainMessage?.payload).toMatchObject({
      subagentAgentId: '44472e00',
      subagentProfileName: 'Explore',
      subagentModel: 'Subagent Default',
      subagentChainNodeId: 176,
    });
  });
});
