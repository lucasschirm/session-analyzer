import type { AnalyticsQuery, EvidenceLink, Filter, TimeRange } from '@lucasschirm/sal-db';
import { componentHref } from '../component-ecosystem/component-ecosystem-params';

export type SessionsScope = 'all' | 'main' | 'sub_agents';

/** Time-range segmented-control presets (issue #167). */
export type RangePreset = '7d' | '30d' | '90d' | 'all';

/** What the segmented control should display as selected — a known preset,
 * or `custom` when the current `timeStart`/`timeEnd` don't match any preset
 * window (e.g. an old bookmarked hash with an arbitrary explicit range). */
export type RangeSelection = RangePreset | 'custom';

export interface PortfolioParams {
  project?: string;
  harness?: string;
  model?: string;
  mode?: string;
  component?: string;
  search?: string;
  timeStart?: string;
  timeEnd?: string;
  analysisRelease?: string;
  comparabilityGroup?: string;
  generation?: string;
  sessions?: SessionsScope;
}

const DEFAULT_PARAMS: PortfolioParams = { sessions: 'main' };

/** Preset window length in days; `all` has no length — both bounds are omitted. */
const PRESET_DAYS: Record<Exclude<RangePreset, 'all'>, number> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
};

/** Tolerance for matching an explicit `timeStart`/`timeEnd` pair back to the
 * preset that produced it: the preset serializes an absolute window at
 * selection time, so a reload/back-navigation minutes later must still be
 * recognized as "that preset", not drift into `custom`. */
const PRESET_MATCH_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * Resolves a range preset to an explicit `{ timeStart, timeEnd }` window,
 * anchored at `now`. `all` resolves to both bounds omitted — the unbounded
 * window — per the URL-param backward-compatibility contract.
 */
export function resolveRangePreset(
  preset: RangePreset,
  now: Date = new Date(),
): Pick<PortfolioParams, 'timeStart' | 'timeEnd'> {
  if (preset === 'all') return { timeStart: undefined, timeEnd: undefined };

  const days = PRESET_DAYS[preset];
  const end = now;
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
  return { timeStart: start.toISOString(), timeEnd: end.toISOString() };
}

/**
 * Determines which segment the time-range switch should show as selected
 * for the current params: a known preset if `timeStart`/`timeEnd` matches
 * that preset's resolved window within tolerance, `all` when both are
 * omitted, or `custom` (an old bookmarked hash with an arbitrary range).
 */
export function detectRangeSelection(
  params: Pick<PortfolioParams, 'timeStart' | 'timeEnd'>,
  now: Date = new Date(),
): RangeSelection {
  if (!params.timeStart && !params.timeEnd) return 'all';
  if (!params.timeStart || !params.timeEnd) return 'custom';

  const start = Date.parse(params.timeStart);
  const end = Date.parse(params.timeEnd);
  if (Number.isNaN(start) || Number.isNaN(end)) return 'custom';

  for (const preset of Object.keys(PRESET_DAYS) as Array<Exclude<RangePreset, 'all'>>) {
    if (matchesPreset(preset, start, end, now)) return preset;
  }
  return 'custom';
}

function matchesPreset(
  preset: Exclude<RangePreset, 'all'>,
  start: number,
  end: number,
  now: Date,
): boolean {
  const expectedDurationMs = PRESET_DAYS[preset] * 24 * 60 * 60 * 1000;
  const durationOk = Math.abs(end - start - expectedDurationMs) < PRESET_MATCH_TOLERANCE_MS;
  const endIsRecent = Math.abs(now.getTime() - end) < PRESET_MATCH_TOLERANCE_MS;
  return durationOk && endIsRecent;
}

export function parsePortfolioHash(hash: string): PortfolioParams {
  const clean = hash.replace(/^#/, '');
  const queryIndex = clean.indexOf('?');
  const query = queryIndex >= 0 ? clean.slice(queryIndex + 1) : '';
  if (!query) return { ...DEFAULT_PARAMS };

  const params = new URLSearchParams(query);
  const result: PortfolioParams = { ...DEFAULT_PARAMS };

  if (params.get('project')) result.project = params.get('project') ?? undefined;
  if (params.get('harness')) result.harness = params.get('harness') ?? undefined;
  if (params.get('model')) result.model = params.get('model') ?? undefined;
  if (params.get('mode')) result.mode = params.get('mode') ?? undefined;
  if (params.get('component')) result.component = params.get('component') ?? undefined;
  if (params.get('search')) result.search = params.get('search') ?? undefined;
  if (params.get('timeStart')) result.timeStart = params.get('timeStart') ?? undefined;
  if (params.get('timeEnd')) result.timeEnd = params.get('timeEnd') ?? undefined;
  if (params.get('analysisRelease'))
    result.analysisRelease = params.get('analysisRelease') ?? undefined;
  if (params.get('comparabilityGroup'))
    result.comparabilityGroup = params.get('comparabilityGroup') ?? undefined;
  if (params.get('generation')) result.generation = params.get('generation') ?? undefined;
  if (params.get('sessions')) result.sessions = (params.get('sessions') as SessionsScope) ?? 'main';

  return result;
}

export function buildPortfolioHash(params: PortfolioParams): string {
  const p = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') {
      p.set(key, value);
    }
  }
  const query = p.toString();
  return query ? `?${query}` : '';
}

export function portfolioParamsToQuery(params: PortfolioParams): AnalyticsQuery {
  const filters: Filter[] = [];
  if (params.project) filters.push({ field: 'projectId', operator: 'eq', value: params.project });
  if (params.harness) filters.push({ field: 'harness', operator: 'eq', value: params.harness });
  if (params.model) filters.push({ field: 'model', operator: 'eq', value: params.model });
  if (params.mode) filters.push({ field: 'mode', operator: 'eq', value: params.mode });
  if (params.component)
    filters.push({ field: 'componentId', operator: 'eq', value: params.component });
  if (params.search) filters.push({ field: 'search', operator: 'contains', value: params.search });

  const timeRange: TimeRange | undefined =
    params.timeStart && params.timeEnd
      ? { start: params.timeStart, end: params.timeEnd }
      : undefined;

  return {
    analysisReleaseId: params.analysisRelease,
    comparabilityGroupId: params.comparabilityGroup,
    generationId: params.generation,
    timeRange,
    filters,
  };
}

export function evidenceLinkHref(link: EvidenceLink, returnParams?: PortfolioParams): string {
  switch (link.entityType) {
    case 'project':
      return `#/projects/${link.entityId}?returnContext=${encodeURIComponent(
        buildPortfolioHash(returnParams ?? {}).slice(1),
      )}`;
    case 'session':
      return `#/sessions/${link.entityId}`;
    case 'component':
      return componentHref(link.entityId, {
        ...returnParams,
        origin: 'portfolio',
        returnContext: buildPortfolioHash(returnParams ?? {}).slice(1) || undefined,
      });
    case 'portfolio':
      return `#/${buildPortfolioHash(returnParams ?? {})}`;
    default:
      return `#/${buildPortfolioHash(returnParams ?? {})}`;
  }
}
