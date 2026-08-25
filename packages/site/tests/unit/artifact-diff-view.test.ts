import type {
  ArtifactVersionDiff,
  ArtifactVersionMetadata,
  ComponentDiff,
  DiffLine,
  MetadataChange,
  SideBySideDiff,
} from '@lucasschirm/sal-db';
import type { LitElement } from 'lit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../../src/pages/artifact-diff/artifact-diff-view';
import type { ArtifactDiffView } from '../../src/pages/artifact-diff/artifact-diff-view';

const artifactMock = vi.hoisted(() => ({
  getMetadata: vi.fn(),
  getDiff: vi.fn(),
}));

vi.mock('../../src/db/analytics-client', () => ({
  AnalyticsClient: vi.fn(),
  analyticsClient: { artifact: artifactMock },
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

function allShadowTexts(parent: ShadowRoot, selector: string): string[] {
  return Array.from(parent.querySelectorAll(selector)).map(
    (child) => ((child as LitElement).shadowRoot?.textContent ?? '') as string,
  );
}

function leftMetadata(): ArtifactVersionMetadata {
  return {
    artifactId: '.claude/settings.json',
    sha256: 'sha256-left',
    size: 1200,
    mediaType: 'application/json',
    captureTime: '2024-01-01T00:00:00.000Z',
    retentionClass: 'retained',
    sessionIds: ['s1', 's2'],
    componentIds: ['settings-1'],
  };
}

function rightMetadata(): ArtifactVersionMetadata {
  return {
    artifactId: '.claude/settings.json',
    sha256: 'sha256-right',
    size: 1300,
    mediaType: 'application/json',
    captureTime: '2024-02-01T00:00:00.000Z',
    retentionClass: 'retained',
    sessionIds: ['s2', 's3'],
    componentIds: ['settings-1'],
  };
}

function sideBySideDiff(): SideBySideDiff {
  const left: DiffLine[] = [
    { lineNumber: 1, text: 'old value', changeType: 'removed' },
    { lineNumber: 2, text: 'unchanged', changeType: 'unchanged' },
  ];
  const right: DiffLine[] = [
    { lineNumber: 1, text: 'new value', changeType: 'added' },
    { lineNumber: 2, text: 'unchanged', changeType: 'unchanged' },
  ];
  return { left, right };
}

function componentDiff(): ComponentDiff {
  return {
    componentId: 'settings-1',
    kind: 'settings',
    sourcePointer: '/settings/0',
    rawSha256: 'raw-settings',
    left: {
      kind: 'settings',
      sourcePointer: '/settings/0',
      rawSha256: 'raw-left',
      normalizedSha256: 'norm-left',
      behaviorSha256: 'beh-left',
      behaviorSummary: { model: 'claude-3-5-sonnet' },
      isPurged: false,
    },
    right: {
      kind: 'settings',
      sourcePointer: '/settings/0',
      rawSha256: 'raw-right',
      normalizedSha256: 'norm-right',
      behaviorSha256: 'beh-right',
      behaviorSummary: { model: 'claude-4-sonnet' },
      isPurged: false,
    },
    unifiedDiff: '- model: claude-3-5-sonnet\n+ model: claude-4-sonnet',
    metadataChanges: [
      { field: 'behavior.model', oldValue: '"claude-3-5-sonnet"', newValue: '"claude-4-sonnet"' },
    ],
  };
}

function fullDiff(): ArtifactVersionDiff {
  return {
    artifactId: '.claude/settings.json',
    leftVersion: 'v1.0.0',
    rightVersion: 'v1.1.0',
    unifiedDiff: '--- left\n+++ right\n@@ -1,2 +1,2 @@\n- old\n+ new',
    sideBySideDiff: sideBySideDiff(),
    metadataChanges: [
      { field: 'size', oldValue: '1200', newValue: '1300' },
      { field: 'behavior.model', oldValue: '"claude-3-5-sonnet"', newValue: '"claude-4-sonnet"' },
    ] as MetadataChange[],
    sessionExposure: { s1: 1, s2: 2, s3: 1 },
    contentAvailable: true,
    concurrentChanges: ['rule globs updated in the same snapshot'],
    observationalCohorts: [
      { sessionId: 's1', left: true, right: false },
      { sessionId: 's2', left: true, right: true },
      { sessionId: 's3', left: false, right: true },
    ],
    componentDiffs: [componentDiff()],
  };
}

function purgedDiff(): ArtifactVersionDiff {
  return {
    artifactId: '.claude/settings.json',
    leftVersion: 'v1.0.0',
    rightVersion: 'v1.1.0',
    metadataChanges: [
      { field: 'retentionClass', oldValue: '"retained"', newValue: '"purged"' },
      { field: 'isPurged', oldValue: 'false', newValue: 'true' },
    ] as MetadataChange[],
    sessionExposure: {},
    contentAvailable: false,
    concurrentChanges: [],
    observationalCohorts: [],
    componentDiffs: [],
  };
}

function tombstoneDiff(): ArtifactVersionDiff {
  return {
    artifactId: 'missing-artifact',
    leftVersion: 'v1.0.0',
    rightVersion: 'v1.1.0',
    metadataChanges: [
      { field: 'availability', oldValue: 'available', newValue: 'unavailable' },
    ] as MetadataChange[],
    sessionExposure: {},
    contentAvailable: false,
    concurrentChanges: [],
    observationalCohorts: [],
    componentDiffs: [],
  };
}

beforeEach(() => {
  window.location.hash =
    '#/artifact-diff?leftArtifact=ref-left&rightArtifact=ref-right&component=settings-1&origin=component&returnContext=project%3Dp1';
  artifactMock.getMetadata.mockImplementation((id: string) =>
    id === 'ref-left' ? Promise.resolve(leftMetadata()) : Promise.resolve(rightMetadata()),
  );
  artifactMock.getDiff.mockResolvedValue(fullDiff());
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.resetAllMocks();
});

describe('artifact-diff-view', () => {
  it('renders the artifact diff with unified text, metadata, and cohorts', async () => {
    const view = document.createElement('artifact-diff-view') as ArtifactDiffView;
    await mount(view);
    const root = view.shadowRoot as ShadowRoot;

    expect(root.textContent).toContain('.claude/settings.json');
    expect(root.textContent).toContain('v1.0.0');
    expect(root.textContent).toContain('v1.1.0');

    // Metadata cards
    const cardTexts = allShadowTexts(root, 'metrics-card').join(' ');
    expect(cardTexts).toContain('SHA-256');
    expect(cardTexts).toContain('sha256-left');
    expect(cardTexts).toContain('sha256-right');
    expect(cardTexts).toContain('2 sessions');

    // Metadata changes table
    expect(root.textContent).toContain('Changed metadata');
    expect(root.textContent).toContain('behavior.model');
    expect(root.textContent).toContain('claude-4-sonnet');

    // Cohorts
    const chartTexts = allShadowTexts(root, 'analytics-chart').join(' ');
    expect(chartTexts).toContain('Observational cohort distribution');
    expect(root.textContent).toContain('s1');
    expect(root.textContent).toContain('s2');
    expect(root.textContent).toContain('s3');
    expect(root.textContent).toContain('Yes');

    // Concurrent changes
    expect(root.textContent).toContain('Concurrent changes');
    expect(root.textContent).toContain('rule globs');

    // Unified diff
    expect(root.textContent).toContain('Artifact diff');
    expect(root.textContent).toContain('- old');
    expect(root.textContent).toContain('+ new');

    // Component-level diff
    expect(root.textContent).toContain('Component-level diffs');
    expect(root.textContent).toContain('settings — settings-1');
    expect(root.textContent).toContain('claude-3-5-sonnet');
    expect(root.textContent).toContain('claude-4-sonnet');

    expect(artifactMock.getMetadata).toHaveBeenCalledWith('ref-left', expect.any(Object));
    expect(artifactMock.getMetadata).toHaveBeenCalledWith('ref-right', expect.any(Object));
    expect(artifactMock.getDiff).toHaveBeenCalledWith(
      'ref-left',
      'ref-right',
      expect.objectContaining({
        filters: expect.arrayContaining([
          { field: 'componentId', operator: 'eq', value: 'settings-1' },
        ]),
      }),
    );
  });

  it('toggles between unified and side-by-side diff and updates the hash', async () => {
    const view = document.createElement('artifact-diff-view') as ArtifactDiffView;
    await mount(view);
    const root = view.shadowRoot as ShadowRoot;

    const sideButton = Array.from(root.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Side-by-side',
    );
    expect(sideButton).not.toBeNull();
    sideButton?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await flush(view);

    expect(window.location.hash).toMatch(/view=sideBySide/);
    expect(root.textContent).toContain('Left');
    expect(root.textContent).toContain('Right');
    expect(root.textContent).toContain('old value');
    expect(root.textContent).toContain('new value');

    const unifiedButton = Array.from(root.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Unified',
    );
    unifiedButton?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(window.location.hash).toMatch(/view=unified/);
  });

  it('preserves origin and return context in breadcrumbs', async () => {
    const view = document.createElement('artifact-diff-view') as ArtifactDiffView;
    await mount(view);
    const root = view.shadowRoot as ShadowRoot;

    const backLink = root.querySelector('.breadcrumbs a') as HTMLAnchorElement;
    expect(backLink).not.toBeNull();
    expect(backLink.getAttribute('href')).toContain('#/components/');
    expect(backLink.getAttribute('href')).toContain('project=p1');
  });

  it('shows metadata-only evidence when the source text is purged', async () => {
    artifactMock.getDiff.mockResolvedValue(purgedDiff());

    const view = document.createElement('artifact-diff-view') as ArtifactDiffView;
    await mount(view);
    const root = view.shadowRoot as ShadowRoot;

    expect(root.textContent).toContain('purged');
    expect(root.textContent).toContain('Source text is unavailable or purged');
    expect(root.textContent).not.toContain('- old');
    expect(root.textContent).not.toContain('+ new');
  });

  it('renders a tombstone for deleted or superseded evidence', async () => {
    artifactMock.getDiff.mockResolvedValue(tombstoneDiff());

    const view = document.createElement('artifact-diff-view') as ArtifactDiffView;
    await mount(view);
    const root = view.shadowRoot as ShadowRoot;

    expect(root.textContent).toContain('deleted or superseded');
    expect(root.textContent).toContain('availability');
    expect(root.textContent).not.toContain('+ new');
    expect(root.textContent).not.toContain('- old');
  });

  it('exposes accessible chart summaries and table fallbacks for cohorts', async () => {
    const view = document.createElement('artifact-diff-view') as ArtifactDiffView;
    await mount(view);
    const root = view.shadowRoot as ShadowRoot;

    const chart = root.querySelector(
      'analytics-chart[title="Observational cohort distribution"]',
    ) as LitElement;
    expect(chart).not.toBeNull();
    const shadow = chart.shadowRoot as ShadowRoot;
    expect(shadow.querySelector('.chart-summary')).not.toBeNull();

    const echartsBase = shadow.querySelector('echarts-base') as LitElement;
    expect(echartsBase).not.toBeNull();
    const echartsShadow = echartsBase.shadowRoot as ShadowRoot;
    expect(echartsShadow.querySelector('details')).not.toBeNull();
  });

  it('shows an empty state when no artifacts are specified', async () => {
    window.location.hash = '#/artifact-diff';
    const view = document.createElement('artifact-diff-view') as ArtifactDiffView;
    await mount(view);
    const root = view.shadowRoot as ShadowRoot;

    expect(root.textContent).toContain('Provide two artifact versions');
    expect(artifactMock.getMetadata).not.toHaveBeenCalled();
  });

  it('shows an error when the data source fails', async () => {
    artifactMock.getDiff.mockRejectedValue(new Error('Diff engine unavailable'));

    const view = document.createElement('artifact-diff-view') as ArtifactDiffView;
    await mount(view);
    const root = view.shadowRoot as ShadowRoot;

    expect(root.textContent).toContain('Diff engine unavailable');
  });
});
