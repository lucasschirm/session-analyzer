import type { AnalyticsQuery, EvidenceLink, Filter, TimeRange } from '@lucasschirm/sal-db';
import { componentHref } from '../component-ecosystem/component-ecosystem-params';

export type SessionsScope = 'all' | 'main' | 'sub_agents';

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
