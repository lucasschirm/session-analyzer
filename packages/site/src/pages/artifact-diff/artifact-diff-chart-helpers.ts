import type {
  ArtifactVersionDiff,
  ArtifactVersionMetadata,
  ComponentCanonicalizationResult,
  ComponentDiff,
  MetadataChange,
  SideBySideDiff,
} from '@lucasschirm/sal-db';
import type { ChartBucket, ChartSeries } from '../../components/charts/chart-types';
import { formatChartValue } from '../../components/charts/chart-types';

export interface MetricCardView {
  metricId: string;
  label: string;
  value: string;
  sub: string;
  icon?: string;
  href?: string;
}

export interface SessionExposureRow {
  sessionId: string;
  count: number;
  left: boolean;
  right: boolean;
  href: string;
}

export interface CohortCounts {
  leftOnly: number;
  both: number;
  rightOnly: number;
}

export interface ComponentDiffRowView {
  sourcePointer: string;
  kind: string;
  componentId?: string;
  left: ComponentCanonicalizationResult;
  right: ComponentCanonicalizationResult;
  metadataChanges: readonly MetadataChange[];
  unifiedDiff?: string;
  sideBySideDiff?: SideBySideDiff;
  isPurged: boolean;
}

function truncate(value: string, max = 64): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}

export function isTombstoneMetadata(meta: ArtifactVersionMetadata): boolean {
  return meta.sha256 === '' && meta.size === 0 && meta.mediaType === 'unknown';
}

export function metadataToMetricCards(
  side: 'left' | 'right',
  meta: ArtifactVersionMetadata,
): MetricCardView[] {
  const prefix = side === 'left' ? 'left' : 'right';
  const sessionCount = meta.sessionIds.length;
  const componentCount = meta.componentIds.length;

  return [
    {
      metricId: `${prefix}-path`,
      label: `${side === 'left' ? 'Left' : 'Right'} path`,
      value: meta.artifactId || '—',
      sub: isTombstoneMetadata(meta) ? 'No metadata available' : 'Artifact path',
    },
    {
      metricId: `${prefix}-sha256`,
      label: 'SHA-256',
      value: meta.sha256 ? truncate(meta.sha256, 16) : '—',
      sub: 'Content hash',
    },
    {
      metricId: `${prefix}-size`,
      label: 'Size',
      value: meta.size > 0 ? formatChartValue(meta.size, 'bytes') : '—',
      sub: 'Retained bytes',
    },
    {
      metricId: `${prefix}-media`,
      label: 'Media type',
      value: meta.mediaType || '—',
      sub: 'Detected media',
    },
    {
      metricId: `${prefix}-capture`,
      label: 'Capture time',
      value: meta.captureTime ?? '—',
      sub: 'When the artifact was captured',
    },
    {
      metricId: `${prefix}-retention`,
      label: 'Retention',
      value: meta.retentionClass || '—',
      sub: 'Retention class',
    },
    {
      metricId: `${prefix}-sessions`,
      label: 'Sessions exposed',
      value: formatChartValue(sessionCount, 'count'),
      sub: sessionCount === 1 ? '1 session' : `${sessionCount} sessions`,
    },
    {
      metricId: `${prefix}-components`,
      label: 'Artifacts',
      value: formatChartValue(componentCount, 'count'),
      sub: componentCount === 1 ? '1 artifact' : `${componentCount} artifacts`,
    },
  ];
}

export function countCohorts(diff: ArtifactVersionDiff): CohortCounts {
  const cohorts = diff.observationalCohorts ?? [];
  let leftOnly = 0;
  let both = 0;
  let rightOnly = 0;
  for (const c of cohorts) {
    if (c.left && c.right) {
      both++;
    } else if (c.left) {
      leftOnly++;
    } else if (c.right) {
      rightOnly++;
    }
  }
  return { leftOnly, both, rightOnly };
}

export function cohortsToChartSeries(diff: ArtifactVersionDiff): ChartSeries {
  const { leftOnly, both, rightOnly } = countCohorts(diff);
  const buckets: ChartBucket[] = [
    {
      x: 'Left only',
      y: leftOnly,
      label: `${leftOnly} session(s) saw only the left version`,
      series: 'Sessions',
    },
    { x: 'Both', y: both, label: `${both} session(s) saw both versions`, series: 'Sessions' },
    {
      x: 'Right only',
      y: rightOnly,
      label: `${rightOnly} session(s) saw only the right version`,
      series: 'Sessions',
    },
  ];

  return {
    seriesId: 'artifact-diff-cohorts',
    label: 'Observational cohort distribution',
    chartType: 'stacked_bar',
    xLabel: 'Cohort',
    yLabel: 'Sessions',
    unit: 'count',
    buckets,
  };
}

export function sessionExposureRows(diff: ArtifactVersionDiff): SessionExposureRow[] {
  const cohorts = new Map<string, { left: boolean; right: boolean }>();
  for (const c of diff.observationalCohorts ?? []) {
    cohorts.set(c.sessionId, { left: c.left, right: c.right });
  }

  const rows: SessionExposureRow[] = [];
  for (const [sessionId, count] of Object.entries(diff.sessionExposure)) {
    const flags = cohorts.get(sessionId) ?? { left: false, right: false };
    rows.push({
      sessionId,
      count,
      ...flags,
      href: `#/sessions/${sessionId}`,
    });
  }
  return rows.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
}

export function metadataChangesTable(diff: ArtifactVersionDiff): readonly MetadataChange[] {
  return diff.metadataChanges ?? [];
}

export function componentDiffRows(diff: ArtifactVersionDiff): ComponentDiffRowView[] {
  return (diff.componentDiffs ?? []).map((cd: ComponentDiff) => ({
    sourcePointer: cd.sourcePointer,
    kind: cd.kind,
    componentId: cd.componentId,
    left: cd.left,
    right: cd.right,
    metadataChanges: cd.metadataChanges,
    unifiedDiff: cd.unifiedDiff,
    sideBySideDiff: cd.sideBySideDiff,
    isPurged: Boolean(cd.left.isPurged || cd.right.isPurged),
  }));
}

export function isPurgedComponent(
  left: ComponentCanonicalizationResult,
  right: ComponentCanonicalizationResult,
): boolean {
  return Boolean(left.isPurged || right.isPurged);
}

export function diffSummary(diff: ArtifactVersionDiff): string {
  const counts = countCohorts(diff);
  const sessions = Object.keys(diff.sessionExposure).length;
  const components = (diff.componentDiffs ?? []).length;
  const metadata = diff.metadataChanges.length;
  const available = diff.contentAvailable
    ? 'content is available'
    : 'content is purged (metadata only)';
  return `Comparing ${diff.leftVersion} to ${diff.rightVersion} for ${diff.artifactId}: ${available}; ${sessions} session(s) exposed; ${components} component diff(s); ${metadata} metadata change(s); ${counts.leftOnly} left-only, ${counts.both} both, ${counts.rightOnly} right-only.`;
}
