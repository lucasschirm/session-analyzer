import type { DevinToolCallLine } from '@lucasschirm/sal-devin-session-parser';
import type { NormalizedEvidenceRecord } from '@lucasschirm/sal-transformer-shared';
import { describe, expect, it } from 'vitest';
import { buildComponentEvidenceLinkRecords } from '../../src/component-evidence-links.js';
import { DevinTransformer } from '../../src/index.js';
import { buildToolInvocationRecords } from '../../src/tool-invocations.js';
import {
  componentsBundle,
  defaultContext,
  linearBundle,
  subagentBundle,
  usageAttributionBundle,
} from '../conformance/fixtures/index.js';

interface LinkPayload {
  readonly linkId: string;
  readonly componentId: string;
  readonly grainType: string;
  readonly grainId: string;
  readonly applicability: string;
}

function links(result: ReturnType<typeof DevinTransformer.transform>) {
  return result.evidence
    .filter((r) => r.recordType === 'component_evidence_link')
    .map((r) => ({ record: r, payload: r.payload as unknown as LinkPayload }));
}

function invocations(result: ReturnType<typeof DevinTransformer.transform>) {
  return result.evidence.filter((r) => r.recordType === 'invocation');
}

describe('Devin component evidence links (usage attribution)', () => {
  it('links an invoked builtin tool to the component identity it earned', () => {
    const result = DevinTransformer.transform(usageAttributionBundle, defaultContext);
    const componentIds = new Set(result.componentSummaries.map((c) => c.componentId));
    const rows = links(result);

    const execLinks = rows.filter((l) => l.payload.componentId.includes('"exec"'));
    expect(execLinks).toHaveLength(1);
    expect(execLinks[0]?.payload.grainType).toBe('invocation');
    expect(execLinks[0]?.payload.applicability).toBe('tool_call_state:tool');
    // Every emitted componentId must exist in componentSummaries, or ingestion
    // cannot resolve it and the usage silently disappears again.
    for (const row of rows) {
      expect(componentIds.has(row.payload.componentId)).toBe(true);
    }
  });

  it('attributes a skill invocation to the skill component, never a tool component', () => {
    const result = DevinTransformer.transform(usageAttributionBundle, defaultContext);
    const skillId = result.componentSummaries.find(
      (c) => c.kind === 'skill' && c.identity.nativeId === 'add-e2e-test',
    )?.componentId;
    expect(skillId).toBeDefined();
    const skillLinks = links(result).filter((l) => l.payload.componentId === skillId);
    expect(skillLinks).toHaveLength(1);
    expect(skillLinks[0]?.payload.applicability).toBe('tool_call_state:skill');
    expect(
      result.componentSummaries.some(
        (c) => c.kind === 'tool' && c.identity.nativeId === 'add-e2e-test',
      ),
    ).toBe(false);
  });

  it('emits exactly one link per root-session invocation', () => {
    for (const bundle of [linearBundle, componentsBundle, usageAttributionBundle]) {
      const result = DevinTransformer.transform(bundle, defaultContext);
      const sessionId = result.sessionSummaries[0]?.sessionId ?? '';
      const rootInvocations = invocations(result).filter((r) => r.sessionId === sessionId);
      expect(links(result)).toHaveLength(rootInvocations.length);
    }
  });

  it('links each call of a repeatedly-invoked tool to the same component', () => {
    const result = DevinTransformer.transform(usageAttributionBundle, defaultContext);
    const rows = links(result).filter((l) => l.payload.componentId.includes('"exec"'));
    const grainIds = new Set(rows.map((l) => l.payload.grainId));
    // One link per distinct invocation, and every link id is unique so the
    // aggregation in ingestion never collides.
    expect(rows.map((l) => l.record.recordId)).toEqual([
      ...new Set(rows.map((l) => l.record.recordId)),
    ]);
    expect(grainIds.size).toBe(rows.length);
  });

  it('never absorbs a child subagent session invocation into the root links', () => {
    // Synthetic stand-in for the decomposed shape: the real subagentBundle's
    // child tool calls live in chat_message nodes rather than tool_call_state
    // rows, so the per-session filter is exercised directly here.
    const toolCalls = [
      { toolCallId: 'tc-root', call: { title: 'exec', rawInput: {} }, update: null },
      { toolCallId: 'tc-child', call: { title: 'grep', rawInput: {} }, update: null },
    ] as unknown as DevinToolCallLine[];
    const root = buildToolInvocationRecords(
      'root-sess',
      [toolCalls[0] as DevinToolCallLine],
      'art',
    );
    const child = buildToolInvocationRecords(
      'child-sess',
      [toolCalls[1] as DevinToolCallLine],
      'art',
    );
    const invocationRecords = [...root.records, ...child.records];
    const components = [
      {
        componentId: 'tool:exec',
        kind: 'tool' as const,
        identity: { canonicalId: 'tool:exec', nativeId: 'exec' },
        sourceArtifactIds: ['art'],
        sessionScoped: true,
      },
      {
        componentId: 'tool:grep',
        kind: 'tool' as const,
        identity: { canonicalId: 'tool:grep', nativeId: 'grep' },
        sourceArtifactIds: ['art'],
        sessionScoped: true,
      },
    ];

    const rows = buildComponentEvidenceLinkRecords(
      'root-sess',
      components,
      invocationRecords,
      'art',
    ).map((r) => r.payload as unknown as LinkPayload);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.componentId).toBe('tool:exec');
    // Metric disjointness: the child's own activity is never attributed to the
    // root, and the root's exposures are never widened by a descendant.
    expect(rows.some((p) => p.componentId === 'tool:grep')).toBe(false);
  });

  it('links nothing when the bundle decomposes subagents (root-only invocations still link)', () => {
    const result = DevinTransformer.transform(subagentBundle, defaultContext);
    const sessionId = result.sessionSummaries[0]?.sessionId ?? '';
    const rootInvocations = invocations(result).filter((r) => r.sessionId === sessionId);
    const rows = links(result);
    expect(rows).toHaveLength(rootInvocations.length);
    for (const row of rows) {
      expect(row.record.sessionId).toBe(sessionId);
    }
  });

  it('is deterministic across runs of the same bundle', () => {
    const sortKey = (rows: readonly { record: NormalizedEvidenceRecord }[]) =>
      rows.map((r) => r.record.recordId).sort();
    const first = links(DevinTransformer.transform(usageAttributionBundle, defaultContext));
    const second = links(DevinTransformer.transform(usageAttributionBundle, defaultContext));
    expect(sortKey(first)).toEqual(sortKey(second));
  });
});
