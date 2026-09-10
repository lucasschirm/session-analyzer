import type { ScopeUtilizationReportDto } from '@lucasschirm/sal-db';
import type { LitElement } from 'lit';
import { afterEach, describe, expect, it } from 'vitest';
import '../../src/components/component-utilization-panel';
import type { ComponentUtilizationPanel } from '../../src/components/component-utilization-panel';

async function flush(element: LitElement): Promise<void> {
  await element.updateComplete;
  const children = element.shadowRoot?.querySelectorAll('*') ?? [];
  for (const child of children) {
    const litChild = child as LitElement;
    if (typeof litChild.updateComplete?.then === 'function') {
      await litChild.updateComplete;
    }
  }
}

async function mount<T extends LitElement>(element: T): Promise<T> {
  document.body.appendChild(element);
  await flush(element);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await flush(element);
  await flush(element);
  return element;
}

function mockToken() {
  return {
    analysisReleaseId: 'rel-1',
    generationId: 'gen-1',
    comparabilityGroupId: 'utilization-metrics',
    eligibleN: 10,
    knownN: 10,
    unknownCount: 0,
    coverage: 'complete' as const,
    measurementClass: 'derived' as const,
    confidence: 'high' as const,
    metricVersion: '0.1.0',
    evidenceLinks: [],
  };
}

describe('component-utilization-panel', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders aggregate utilization matrix with disjoint tiers', async () => {
    const report: ScopeUtilizationReportDto = {
      scopeType: 'project',
      scopeId: 'proj-1',
      token: mockToken(),
      domains: {
        tool: {
          domain: 'tool',
          tiers: {
            totalAvailable: 5,
            totalUsed: 3,
            totalUnused: 1,
            usedLt10Pct: 0,
            usedLt25Pct: 1,
            usedLt50Pct: 1,
            usedGte50Pct: 1,
            insufficientSample: 1,
          },
          sampleSessions: 10,
          eligibleSessions: 10,
          minSampleSizeConfig: 5,
          components: [
            {
              componentId: 't1',
              kind: 'tool',
              displayName: 'tool/Bash',
              offeredSessions: 10,
              usedSessions: 7,
              usageRate: 0.7,
              tier: 'gte50',
            },
            {
              componentId: 't2',
              kind: 'tool',
              displayName: 'tool/Edit',
              offeredSessions: 10,
              usedSessions: 0,
              usageRate: 0,
              tier: 'unused',
            },
          ],
        },
        skill: {
          domain: 'skill',
          tiers: {
            totalAvailable: 2,
            totalUsed: 1,
            totalUnused: 1,
            usedLt10Pct: 0,
            usedLt25Pct: 0,
            usedLt50Pct: 0,
            usedGte50Pct: 1,
            insufficientSample: 0,
          },
          sampleSessions: 10,
          eligibleSessions: 10,
          minSampleSizeConfig: 5,
          components: [],
        },
        agent: {
          domain: 'agent',
          tiers: {
            totalAvailable: 1,
            totalUsed: 1,
            totalUnused: 0,
            usedLt10Pct: 0,
            usedLt25Pct: 0,
            usedLt50Pct: 0,
            usedGte50Pct: 1,
            insufficientSample: 0,
          },
          sampleSessions: 10,
          eligibleSessions: 10,
          minSampleSizeConfig: 5,
          components: [],
        },
      },
    };

    const panel = Object.assign(document.createElement('component-utilization-panel'), {
      report,
      heading: 'Project Component Utilization',
    }) as ComponentUtilizationPanel;

    await mount(panel);
    const root = panel.shadowRoot as ShadowRoot;

    expect(root.textContent).toContain('Project Component Utilization');
    expect(root.textContent).toContain('10 sessions evaluated');
    expect(root.textContent).toContain('Tools');
    expect(root.textContent).toContain('Skills');
    expect(root.textContent).toContain('Agents');
    expect(root.textContent).toContain('tool/Bash');
    expect(root.textContent).toContain('≥ 50% (7/10)');
    expect(root.textContent).toContain('tool/Edit');
    expect(root.textContent).toContain('Unused (0%) (0/10)');
  });

  it('renders session binary availability and invocations', async () => {
    const report: ScopeUtilizationReportDto = {
      scopeType: 'session',
      scopeId: 'sess-abc',
      token: mockToken(),
      domains: {
        tool: {
          domain: 'tool',
          tiers: {
            totalAvailable: 2,
            totalUsed: 1,
            totalUnused: 1,
            usedLt10Pct: 0,
            usedLt25Pct: 0,
            usedLt50Pct: 0,
            usedGte50Pct: 0,
            insufficientSample: 0,
          },
          sampleSessions: 1,
          eligibleSessions: 1,
          minSampleSizeConfig: 5,
          components: [],
        },
        skill: {
          domain: 'skill',
          tiers: {
            totalAvailable: 1,
            totalUsed: 0,
            totalUnused: 1,
            usedLt10Pct: 0,
            usedLt25Pct: 0,
            usedLt50Pct: 0,
            usedGte50Pct: 0,
            insufficientSample: 0,
          },
          sampleSessions: 1,
          eligibleSessions: 1,
          minSampleSizeConfig: 5,
          components: [],
        },
        agent: {
          domain: 'agent',
          tiers: {
            totalAvailable: 0,
            totalUsed: 0,
            totalUnused: 0,
            usedLt10Pct: 0,
            usedLt25Pct: 0,
            usedLt50Pct: 0,
            usedGte50Pct: 0,
            insufficientSample: 0,
          },
          sampleSessions: 1,
          eligibleSessions: 1,
          minSampleSizeConfig: 5,
          components: [],
        },
      },
      sessionDomains: {
        tool: {
          domain: 'tool',
          availableCount: 2,
          usedCount: 1,
          unusedCount: 1,
          availableComponents: ['tool/Bash', 'tool/Edit'],
          usedComponents: ['tool/Bash'],
          unusedComponents: ['tool/Edit'],
        },
        skill: {
          domain: 'skill',
          availableCount: 1,
          usedCount: 0,
          unusedCount: 1,
          availableComponents: ['skill/pr-review'],
          usedComponents: [],
          unusedComponents: ['skill/pr-review'],
        },
        agent: {
          domain: 'agent',
          availableCount: 0,
          usedCount: 0,
          unusedCount: 0,
          availableComponents: [],
          usedComponents: [],
          unusedComponents: [],
        },
      },
    };

    const panel = Object.assign(document.createElement('component-utilization-panel'), {
      report,
      heading: 'Session Component Availability',
    }) as ComponentUtilizationPanel;

    await mount(panel);
    const root = panel.shadowRoot as ShadowRoot;

    expect(root.textContent).toContain('Session Component Availability');
    expect(root.textContent).toContain('Binary observation for session sess-abc');
    expect(root.textContent).toContain('Used in this session (1)');
    expect(root.textContent).toContain('tool/Bash');
    expect(root.textContent).toContain('Unused in this session (1)');
    expect(root.textContent).toContain('tool/Edit');
  });
});
