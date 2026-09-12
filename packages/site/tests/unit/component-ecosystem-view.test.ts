import type {
  AnalyticsToken,
  ComponentDistributionPage,
  ComponentDistributionRow,
  ComponentEcosystemSummary,
  ComponentIdentitySummary,
  ComponentProjectSessionPage,
  ComponentScopePage,
  ComponentUtilizationDetail,
  ComponentVersionPage,
  LifecycleComparisonPage,
  MetricValueDto,
} from '@lucasschirm/sal-db';
import type { LitElement } from 'lit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../../src/pages/component-ecosystem/component-ecosystem-view';
import type { ComponentEcosystemView } from '../../src/pages/component-ecosystem/component-ecosystem-view';

const componentMock = vi.hoisted(() => ({
  getSummary: vi.fn(),
  getIdentity: vi.fn(),
  getVersions: vi.fn(),
  getScopes: vi.fn(),
  getUtilization: vi.fn(),
  getDistributions: vi.fn(),
  getProjectsSessions: vi.fn(),
  getLifecycleComparisons: vi.fn(),
}));

const artifactMock = vi.hoisted(() => ({
  getDiff: vi.fn(),
  getMetadata: vi.fn(),
}));

vi.mock('../../src/db/analytics-client', () => ({
  AnalyticsClient: vi.fn(),
  analyticsClient: { component: componentMock, artifact: artifactMock },
}));

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

function tokenFixture(overrides: Partial<AnalyticsToken> = {}): AnalyticsToken {
  return {
    analysisReleaseId: 'rel-1',
    generationId: 'gen-1',
    comparabilityGroupId: 'cgrp-1',
    eligibleN: 100,
    knownN: 95,
    unknownCount: 5,
    coverage: 'complete',
    measurementClass: 'observed',
    confidence: 'high',
    metricVersion: '1.0.0',
    evidenceLinks: [],
    ...overrides,
  };
}

function metricValue(
  metricId: string,
  value: number | null,
  label: string,
  unit = 'count',
  overrides: Partial<MetricValueDto> = {},
): MetricValueDto {
  return {
    ...tokenFixture(),
    metricId,
    value,
    unit,
    label,
    isExact: true,
    ...overrides,
  };
}

function summaryFixture(
  overrides: Partial<ComponentEcosystemSummary> = {},
): ComponentEcosystemSummary {
  return {
    token: tokenFixture(),
    countsByKind: {
      tool: 5,
      mcp: 1,
      skill: 2,
      agent: 1,
      rule: 1,
      plugin: 1,
      setting: 1,
      model: 1,
      version: 3,
    },
    topByUtilization: [
      metricValue('component-utilization', 120, 'tool read_file'),
      metricValue('component-utilization', 80, 'skill code-review'),
      metricValue('component-utilization', 45, 'agent general-purpose'),
    ],
    ...overrides,
  };
}

function versionsFixture(overrides: Partial<ComponentVersionPage> = {}): ComponentVersionPage {
  return {
    items: [
      {
        version: 'v1.0.0',
        sessionCount: 10,
        projectCount: 2,
        firstSeen: '2024-01-01',
        lastSeen: '2024-01-10',
      },
      {
        version: 'v1.1.0',
        sessionCount: 6,
        projectCount: 1,
        firstSeen: '2024-02-01',
        lastSeen: '2024-02-05',
      },
    ],
    generationToken: 'gen-1',
    analysisReleaseToken: 'rel-1',
    ...overrides,
  };
}

function identityFixture(
  overrides: Partial<ComponentIdentitySummary> = {},
): ComponentIdentitySummary {
  return {
    componentId: 'read_file',
    kind: 'tool',
    name: 'tool/read_file',
    ...overrides,
  };
}

function scopesFixture(overrides: Partial<ComponentScopePage> = {}): ComponentScopePage {
  return {
    items: [
      { scope: 'global', installationCount: 5 },
      { scope: 'workspace', installationCount: 3 },
      { scope: 'session', installationCount: 2 },
    ],
    generationToken: 'gen-1',
    analysisReleaseToken: 'rel-1',
    ...overrides,
  };
}

function utilizationFixture(
  overrides: Partial<ComponentUtilizationDetail> = {},
): ComponentUtilizationDetail {
  const token = tokenFixture({ knownN: 90, eligibleN: 120 });
  return {
    token,
    loadRate: metricValue('load-rate', 0.75, 'Load rate', 'ratio'),
    invokeRate: metricValue('invoke-rate', 12, 'Invocations per session', 'count'),
    overhead: metricValue('overhead', 150, 'Overhead latency', 'ms'),
    ...overrides,
  };
}

function distributionsFixture(
  overrides: Partial<ComponentDistributionPage> = {},
): ComponentDistributionPage {
  const row: ComponentDistributionRow = {
    metricId: 'outcome',
    values: [
      metricValue('success', 80, 'success'),
      metricValue('partial', 10, 'partial'),
      metricValue('failure', 5, 'failure'),
    ],
    bins: { success: 80, partial: 10, failure: 5 },
  };
  return {
    items: [row],
    generationToken: 'gen-1',
    analysisReleaseToken: 'rel-1',
    ...overrides,
  };
}

function projectSessionsFixture(
  overrides: Partial<ComponentProjectSessionPage> = {},
): ComponentProjectSessionPage {
  return {
    items: [
      {
        projectId: 'p1',
        sessionId: 's1',
        lastUsed: '2024-01-05',
        metricValues: [
          metricValue('invocations', 10, 'Invocations'),
          metricValue('payloads', 4, 'Payloads'),
          metricValue('payload-bytes', 1024, 'Payload bytes', 'bytes'),
        ],
      },
    ],
    generationToken: 'gen-1',
    analysisReleaseToken: 'rel-1',
    ...overrides,
  };
}

function lifecycleFixture(
  overrides: Partial<LifecycleComparisonPage> = {},
): LifecycleComparisonPage {
  return {
    items: [
      {
        eventId: 'ev1',
        changeType: 'updated',
        beforeVersion: 'v1.0.0',
        afterVersion: 'v1.1.0',
        affectedSessions: 4,
      },
    ],
    generationToken: 'gen-1',
    analysisReleaseToken: 'rel-1',
    ...overrides,
  };
}

function stubComponentLoad(): void {
  componentMock.getSummary.mockResolvedValue(summaryFixture());
  componentMock.getIdentity.mockResolvedValue(identityFixture());
  componentMock.getVersions.mockResolvedValue(versionsFixture());
  componentMock.getScopes.mockResolvedValue(scopesFixture());
  componentMock.getUtilization.mockResolvedValue(utilizationFixture());
  componentMock.getDistributions.mockResolvedValue(distributionsFixture());
  componentMock.getProjectsSessions.mockResolvedValue(projectSessionsFixture());
  componentMock.getLifecycleComparisons.mockResolvedValue(lifecycleFixture());
}

beforeEach(() => {
  stubComponentLoad();
  window.location.hash = '#/artifacts';
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.resetAllMocks();
});

function allShadowTexts(parent: ShadowRoot, selector: string): string[] {
  return Array.from(parent.querySelectorAll(selector)).map(
    (child) => ((child as LitElement).shadowRoot?.textContent ?? '') as string,
  );
}

describe('component-ecosystem-view', () => {
  it('renders the summary with counts by kind and top components', async () => {
    const view = document.createElement('component-ecosystem-view') as ComponentEcosystemView;
    await mount(view);
    const root = view.shadowRoot as ShadowRoot;

    expect(root.textContent).toContain('Artifact Ecosystem');

    const cardTexts = allShadowTexts(root, 'metrics-card').join(' ');
    expect(cardTexts).toContain('Total components');
    expect(cardTexts).toContain('tool components');

    const echartsTexts: string[] = [];
    for (const chart of root.querySelectorAll('analytics-chart')) {
      const echarts = (chart as LitElement).shadowRoot?.querySelector('echarts-base') as
        | LitElement
        | undefined;
      if (echarts?.shadowRoot) {
        echartsTexts.push(echarts.shadowRoot.textContent ?? '');
      }
    }
    const chartText = echartsTexts.join(' ');
    expect(chartText).toContain('read_file');
    expect(chartText).toContain('code-review');

    const summaries = allShadowTexts(root, 'analytics-chart');
    expect(summaries.length).toBeGreaterThanOrEqual(2);
  });

  it('filters by kind and updates the hash', async () => {
    const view = document.createElement('component-ecosystem-view') as ComponentEcosystemView;
    await mount(view);
    const root = view.shadowRoot as ShadowRoot;

    const kindInput = root.querySelector('input') as HTMLInputElement;
    kindInput.value = 'tool';
    kindInput.dispatchEvent(new Event('change'));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(window.location.hash).toMatch(/kind=tool/);
    expect(componentMock.getSummary).toHaveBeenCalled();
  });

  it('includes the componentId filter in the very first detail-page query, not just this.componentId itself', async () => {
    // Regression coverage: `filters` used to be computed from a field
    // initializer, which runs during element construction -- before the
    // (now-fixed) component-id attribute has populated `componentId` (the
    // Custom Elements upgrade algorithm only calls attributeChangedCallback
    // after the constructor returns). `componentId` itself was still passed
    // correctly to component.getVersions() etc. as the first positional
    // argument, but `componentEcosystemParamsToQuery(this.filters)`'s
    // `componentId` query filter (component-ecosystem-params.ts:103-104)
    // silently stayed unset on the first load.
    window.location.hash = '#/artifacts/read_file';
    const view = Object.assign(document.createElement('component-ecosystem-view'), {
      componentId: 'read_file',
    }) as ComponentEcosystemView;
    await mount(view);

    expect(componentMock.getVersions).toHaveBeenCalledWith(
      'read_file',
      expect.objectContaining({
        filters: expect.arrayContaining([
          { field: 'componentId', operator: 'eq', value: 'read_file' },
        ]),
      }),
    );
  });

  it('does not double-fetch on a normal initial mount via the real attribute-binding path', async () => {
    // Regression coverage: `willUpdate()`'s componentId-changed hook (added
    // for the stale-componentId race) must not also fire on the component's
    // very first update -- `componentId` is reported as "changed" there too
    // (any set reactive property is, on first update per Lit's own
    // semantics), which would otherwise race connectedCallback()'s own
    // initial load() and double-fetch every one of the seven detail-panel
    // endpoints on every ordinary navigation into a component-detail route.
    // Uses `setAttribute` (matching app-root.ts's real
    // `component-id=${...}` template binding), not direct property
    // assignment, since that's the actual production wiring this guards.
    //
    // Settle first: `beforeEach`'s own `window.location.hash = '#/artifacts'`
    // (resetting state left over from a prior test) triggers this test
    // environment's own async hashchange-like reaction, which can otherwise
    // land inside this test's own mount window and fire a second, entirely
    // unrelated load() via the existing hashchange listener -- a test-only
    // artifact, not a reproduction of production behavior (a page's real
    // first load never fires `hashchange` for its own initial hash).
    await new Promise((resolve) => setTimeout(resolve, 0));

    const view = document.createElement('component-ecosystem-view') as ComponentEcosystemView;
    view.setAttribute('component-id', 'read_file');
    await mount(view);

    expect(componentMock.getVersions).toHaveBeenCalledTimes(1);
    expect(componentMock.getSummary).toHaveBeenCalledTimes(1);
  });

  it('does not double-fetch on a normal initial mount via the real property-set path', async () => {
    // Same guard as the attribute-binding test above, but exercising the
    // property-set path that code and other tests also use. willUpdate()
    // must not fire on the first update no matter how componentId is set.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const view = Object.assign(document.createElement('component-ecosystem-view'), {
      componentId: 'read_file',
    }) as ComponentEcosystemView;
    await mount(view);

    expect(componentMock.getVersions).toHaveBeenCalledTimes(1);
    expect(componentMock.getSummary).toHaveBeenCalledTimes(1);
  });

  it('reloads with the new component when componentId changes on an already-mounted instance', async () => {
    // Regression coverage: navigating directly between two different
    // populated :componentId routes (e.g. browser back/forward) on an
    // already-mounted instance. In the real app, a parent's own reactive
    // re-render patches this element's `component-id` attribute in place
    // (no full remount) -- it never dispatches a `hashchange` event itself,
    // so the existing `handleHashChange()` listener (which only fires on
    // an actual 'hashchange' event) cannot pick this transition up on its
    // own. Simulate exactly that: change the property directly with no
    // navigation API involved at all (deliberately not touching
    // window.location/history -- doing so triggers this test
    // environment's own hashchange-like reaction, which would confound
    // this test with the unrelated hashchange-listener path this test
    // does not intend to exercise), isolating `willUpdate`'s own
    // reactivity to the componentId change.
    window.location.hash = '#/artifacts/read_file';
    const view = Object.assign(document.createElement('component-ecosystem-view'), {
      componentId: 'read_file',
    }) as ComponentEcosystemView;
    await mount(view);
    expect(componentMock.getVersions).toHaveBeenCalledWith('read_file', expect.anything());

    componentMock.getVersions.mockClear();
    view.componentId = 'code-review';
    await view.updateComplete;
    await new Promise((resolve) => setTimeout(resolve, 0));
    await view.updateComplete;

    expect(componentMock.getVersions).toHaveBeenCalledWith('code-review', expect.anything());
  });

  it("renders the new component's data, not a stale one's, when a hashchange-triggered load for the OLD component is still in flight", async () => {
    // Regression coverage for the full real-world race: a `hashchange`
    // event firing while `componentId` is still the OLD value (matching
    // the router's real async attribute-update timing) starts load() for
    // the WRONG component first, setting `this.loading = true` before
    // willUpdate's own load() for the correct new component ever runs.
    // Without `load()`'s `reloadPending` coalescing, that second call
    // would be silently dropped by load()'s own `if (this.loading)`
    // guard -- the header would show the new component while the data
    // panels kept showing the previous one's results.
    window.location.hash = '#/artifacts/read_file';
    const view = Object.assign(document.createElement('component-ecosystem-view'), {
      componentId: 'read_file',
    }) as ComponentEcosystemView;
    await mount(view);

    componentMock.getVersions.mockClear();
    // The stale ('read_file') call is deliberately held open via a
    // manually-resolved promise, so this test doesn't depend on incidental
    // microtask-timing luck to force the actual hazardous interleaving:
    // willUpdate's own load() call for the new component is guaranteed to
    // run while the stale load is still genuinely in flight (`this.loading`
    // still true), which is exactly the condition `reloadPending` exists
    // to handle.
    let resolveStale: (() => void) | undefined;
    componentMock.getVersions.mockImplementation(async (id: string) => {
      if (id === 'read_file') {
        await new Promise<void>((resolve) => {
          resolveStale = resolve;
        });
        return versionsFixture({
          items: [{ ...versionsFixture().items[0], version: 'STALE-read_file' }],
        });
      }
      return versionsFixture({
        items: [{ ...versionsFixture().items[0], version: 'FRESH-code-review' }],
      });
    });

    // Fire the stale hashchange first, still reading the OLD componentId --
    // exactly as the router's own, separately-registered hashchange
    // listener would in production. This starts load() for 'read_file' and
    // blocks it on the deferred promise above, so `this.loading` stays
    // `true` until this test explicitly releases it. Deliberately not
    // touching window.location/history here (unlike a real navigation) --
    // both trigger this test environment's own hashchange-like reaction
    // asynchronously, which would fire a second, non-stale hashchange
    // dispatch later and mask the very staleness this test needs to force.
    // `handleHashChange()` only checks the hash *prefix*, so dispatching
    // against the unchanged '#/artifacts/read_file' still satisfies it.
    window.dispatchEvent(new HashChangeEvent('hashchange'));

    // Now simulate the parent's deferred attribute update completing,
    // *while the stale load is still genuinely blocked*. Without
    // `reloadPending`, this call is silently dropped here.
    view.componentId = 'code-review';
    await view.updateComplete;

    // Release the stale load so it can finish, then let the coalesced
    // reload (if any) run to completion.
    resolveStale?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await view.updateComplete;
    await new Promise((resolve) => setTimeout(resolve, 0));
    await view.updateComplete;

    // Both loads ran (the stale one, then the coalesced correct one) -- and
    // critically, the rendered state reflects the correct, most-recent
    // component's data, not the stale one's.
    const root = view.shadowRoot as ShadowRoot;
    expect(root.textContent).toContain('FRESH-code-review');
    expect(root.textContent).not.toContain('STALE-read_file');
  });

  it('does not start a coalesced reload after the component has been disconnected', async () => {
    // Regression coverage for reloadIfPending()'s isConnected guard: a
    // component can be removed from the DOM while its in-flight load() is
    // still running (e.g. the user navigates away before a slow fetch
    // resolves). If a reload was queued (reloadPending) before that
    // disconnect, firing it anyway would start a fresh network fetch for
    // panels nobody will ever see rendered.
    window.location.hash = '#/artifacts/read_file';
    const view = Object.assign(document.createElement('component-ecosystem-view'), {
      componentId: 'read_file',
    }) as ComponentEcosystemView;
    await mount(view);

    componentMock.getVersions.mockClear();
    let resolveStale: (() => void) | undefined;
    componentMock.getVersions.mockImplementation(async (id: string) => {
      if (id === 'read_file') {
        await new Promise<void>((resolve) => {
          resolveStale = resolve;
        });
      }
      return versionsFixture();
    });

    // Start a load for the old component and block it in flight, exactly
    // as in the sibling race test above.
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    // Queue a reload for the new component while the stale one is still
    // blocked -- this sets reloadPending, same as the sibling test.
    view.componentId = 'code-review';
    await view.updateComplete;

    // Disconnect before the stale load resolves.
    view.remove();
    expect(view.isConnected).toBe(false);

    // Release the stale load and let it run to completion.
    resolveStale?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The queued reload for 'code-review' must not have fired a fresh
    // fetch after disconnect.
    const calls = componentMock.getVersions.mock.calls.map((c) => c[0]);
    expect(calls).not.toContain('code-review');
  });

  it('keeps the componentId in the URL when a filter changes on a component-detail route', async () => {
    // Regression coverage: filters used to be computed from a field
    // initializer that ran before the (now-fixed) component-id attribute
    // populated `componentId`, and updateFilter()/selectVersion()/
    // compareVersions()/goToPage() didn't consistently re-attach `component`
    // to the navigated hash. Either bug bounces the user from a component
    // detail page back to the generic Artifact Ecosystem summary on the
    // very next filter/pagination interaction.
    window.location.hash = '#/artifacts/read_file';
    const view = Object.assign(document.createElement('component-ecosystem-view'), {
      componentId: 'read_file',
    }) as ComponentEcosystemView;
    await mount(view);
    const root = view.shadowRoot as ShadowRoot;

    const kindInput = root.querySelector('input') as HTMLInputElement;
    kindInput.value = 'tool';
    kindInput.dispatchEvent(new Event('change'));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(window.location.hash).toContain('#/artifacts/read_file');
    expect(window.location.hash).toMatch(/kind=tool/);
  });

  it('navigates to a component detail from the top-components chart', async () => {
    const view = document.createElement('component-ecosystem-view') as ComponentEcosystemView;
    await mount(view);
    const root = view.shadowRoot as ShadowRoot;

    const chart = root.querySelector(
      'analytics-chart[title="Invocations per component"]',
    ) as LitElement;
    chart.dispatchEvent(
      new CustomEvent('point-click', {
        detail: { label: 'Open read_file', href: '#/artifacts/read_file?kind=tool' },
        bubbles: true,
        composed: true,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(window.location.hash).toContain('#/artifacts/read_file');
  });

  it('renders a component detail with all panels', async () => {
    window.location.hash =
      '#/artifacts/read_file?kind=tool&returnContext=project%3Dp1&origin=portfolio';
    const view = Object.assign(document.createElement('component-ecosystem-view'), {
      componentId: 'read_file',
    }) as ComponentEcosystemView;
    await mount(view);
    const root = view.shadowRoot as ShadowRoot;

    // Never the raw componentId as the primary label -- see
    // never-display-raw-ids.md. `identityFixture()`'s resolved name
    // ('tool/read_file') is what must render, both in the h1 and the
    // breadcrumb's "current" span.
    expect(root.textContent).toContain('Artifact: tool/read_file');
    expect(root.textContent).not.toContain('Artifact: read_file');
    expect(root.textContent).toContain('Versions');
    expect(root.textContent).toContain('Installation scope');
    expect(root.textContent).toContain('Utilization');
    expect(root.textContent).toContain('Payload distributions');
    expect(root.textContent).toContain('Project / session evidence');
    expect(root.textContent).toContain('Lifecycle timing');

    const cards = allShadowTexts(root, 'metrics-card').join(' ');
    expect(cards).toContain('Load rate');
    expect(cards).toContain('Invocations per session');
    expect(cards).toContain('Overhead latency');

    const projectLink = root.querySelector('a[href^="#/projects/"]') as HTMLAnchorElement;
    expect(projectLink).not.toBeNull();
    expect(projectLink.getAttribute('href')).toMatch(/returnContext=/);

    const sessionLink = root.querySelector('a[href^="#/sessions/"]') as HTMLAnchorElement;
    expect(sessionLink).not.toBeNull();
  });

  it('never renders the raw componentId, in the h1 or the breadcrumb, once identity resolves', async () => {
    window.location.hash = '#/artifacts/comp-7b749f662cc27c79?kind=tool';
    componentMock.getIdentity.mockResolvedValue(
      identityFixture({ componentId: 'comp-7b749f662cc27c79', name: 'tool/multi-issue-agent' }),
    );
    const view = Object.assign(document.createElement('component-ecosystem-view'), {
      componentId: 'comp-7b749f662cc27c79',
    }) as ComponentEcosystemView;
    await mount(view);
    const root = view.shadowRoot as ShadowRoot;

    expect(root.textContent).toContain('tool/multi-issue-agent');
    expect(root.textContent).not.toContain('comp-7b749f662cc27c79');
  });

  it('falls back to a generic label, never the raw componentId, while identity is unresolved', async () => {
    window.location.hash = '#/artifacts/comp-7b749f662cc27c79?kind=tool';
    componentMock.getIdentity.mockResolvedValue(undefined);
    const view = Object.assign(document.createElement('component-ecosystem-view'), {
      componentId: 'comp-7b749f662cc27c79',
    }) as ComponentEcosystemView;
    await mount(view);
    const root = view.shadowRoot as ShadowRoot;

    expect(root.textContent).toContain('Artifact');
    expect(root.textContent).not.toContain('comp-7b749f662cc27c79');
  });

  it('preserves originating filters in breadcrumbs', async () => {
    window.location.hash =
      '#/artifacts/read_file?kind=tool&returnContext=project%3Dp1&origin=portfolio';
    const view = Object.assign(document.createElement('component-ecosystem-view'), {
      componentId: 'read_file',
    }) as ComponentEcosystemView;
    await mount(view);
    const root = view.shadowRoot as ShadowRoot;

    const originLink = root.querySelector('a[href^="#/"]') as HTMLAnchorElement;
    expect(originLink).not.toBeNull();
    expect(originLink.getAttribute('href')).toBe('#/?project=p1');
  });

  it('renders a funnel chart for payload distributions', async () => {
    window.location.hash = '#/artifacts/read_file';
    const view = Object.assign(document.createElement('component-ecosystem-view'), {
      componentId: 'read_file',
    }) as ComponentEcosystemView;
    await mount(view);
    const root = view.shadowRoot as ShadowRoot;

    const chart = root.querySelector('analytics-chart[title^="Distribution:"]') as LitElement;
    expect(chart).not.toBeNull();
    const shadow = chart.shadowRoot as ShadowRoot;
    expect(shadow.textContent).toContain('Distribution:');
  });

  it('renders lifecycle timing and a diff link', async () => {
    window.location.hash = '#/artifacts/read_file';
    const view = Object.assign(document.createElement('component-ecosystem-view'), {
      componentId: 'read_file',
    }) as ComponentEcosystemView;
    await mount(view);
    const root = view.shadowRoot as ShadowRoot;

    expect(root.textContent).toContain('Lifecycle timing');
    expect(root.textContent).toContain('v1.0.0');
    expect(root.textContent).toContain('v1.1.0');
    expect(root.textContent).toContain('View diff');

    const diffLink = root.querySelector('a.diff-link') as HTMLAnchorElement;
    expect(diffLink).not.toBeNull();
    expect(diffLink.getAttribute('href')).toMatch(/leftVersion=v1\.0\.0/);
    expect(diffLink.getAttribute('href')).toMatch(/rightVersion=v1\.1\.0/);
  });

  it('exposes accessible chart fallbacks and summaries', async () => {
    const view = document.createElement('component-ecosystem-view') as ComponentEcosystemView;
    await mount(view);
    const root = view.shadowRoot as ShadowRoot;

    const charts = root.querySelectorAll('analytics-chart');
    expect(charts.length).toBeGreaterThan(0);
    for (const chart of charts) {
      const shadow = (chart as LitElement).shadowRoot as ShadowRoot;
      expect(shadow.querySelector('.summary-toggle')).not.toBeNull();

      const echartsBase = shadow.querySelector('echarts-base') as LitElement;
      expect(echartsBase).not.toBeNull();
      const echartsShadow = echartsBase.shadowRoot as ShadowRoot;
      expect(echartsShadow.querySelector('details')).not.toBeNull();
    }
  });

  it('enters a partial state when one detail panel fails', async () => {
    componentMock.getUtilization.mockRejectedValue(new Error('utilization down'));
    window.location.hash = '#/artifacts/read_file';
    const view = Object.assign(document.createElement('component-ecosystem-view'), {
      componentId: 'read_file',
    }) as ComponentEcosystemView;
    await mount(view);
    const root = view.shadowRoot as ShadowRoot;

    expect(root.textContent).toContain('utilization down');
    expect(root.textContent).toContain('Versions');
  });

  it('shows empty states when no data is returned', async () => {
    componentMock.getSummary.mockResolvedValue(
      summaryFixture({ countsByKind: {}, topByUtilization: [] }),
    );
    componentMock.getVersions.mockResolvedValue({
      items: [],
      generationToken: 'gen-1',
      analysisReleaseToken: 'rel-1',
    });
    componentMock.getScopes.mockResolvedValue({
      items: [],
      generationToken: 'gen-1',
      analysisReleaseToken: 'rel-1',
    });
    componentMock.getDistributions.mockResolvedValue({
      items: [],
      generationToken: 'gen-1',
      analysisReleaseToken: 'rel-1',
    });
    componentMock.getProjectsSessions.mockResolvedValue({
      items: [],
      generationToken: 'gen-1',
      analysisReleaseToken: 'rel-1',
    });
    componentMock.getLifecycleComparisons.mockResolvedValue({
      items: [],
      generationToken: 'gen-1',
      analysisReleaseToken: 'rel-1',
    });
    window.location.hash = '#/artifacts/read_file';
    const view = Object.assign(document.createElement('component-ecosystem-view'), {
      componentId: 'read_file',
    }) as ComponentEcosystemView;
    await mount(view);
    const root = view.shadowRoot as ShadowRoot;

    expect(root.textContent).toContain('No versions found');
    expect(root.textContent).toContain('No installation scopes found');
    expect(root.textContent).toContain('No distributions found');
    expect(root.textContent).toContain('No project or session evidence found');
    expect(root.textContent).toContain('No lifecycle events found');
  });

  it('loads an artifact diff when left and right versions are selected', async () => {
    artifactMock.getDiff.mockResolvedValue({
      artifactId: 'art-1',
      leftVersion: 'v1.0.0',
      rightVersion: 'v1.1.0',
      unifiedDiff: '- old\n+ new',
      metadataChanges: [{ field: 'version', oldValue: 'v1.0.0', newValue: 'v1.1.0' }],
      sessionExposure: {},
    });

    window.location.hash = '#/artifacts/read_file?leftVersion=v1.0.0&rightVersion=v1.1.0';
    const view = Object.assign(document.createElement('component-ecosystem-view'), {
      componentId: 'read_file',
    }) as ComponentEcosystemView;
    await mount(view);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await flush(view);

    expect(artifactMock.getDiff).toHaveBeenCalledWith('v1.0.0', 'v1.1.0', expect.any(Object));
    const root = view.shadowRoot as ShadowRoot;
    expect(root.textContent).toContain('Artifact diff');
    expect(root.textContent).toContain('+ new');
    expect(root.textContent).toContain('- old');
  });
});
