import type { AnalyticsQuery, EvidenceLink, Filter, TimeRange } from '@lucasschirm/sal-db';

export type ComponentEcosystemOrigin = 'portfolio' | 'project' | 'session' | 'component';

export interface ComponentEcosystemParams {
  component?: string;
  kind?: string;
  project?: string;
  harness?: string;
  model?: string;
  mode?: string;
  version?: string;
  leftVersion?: string;
  rightVersion?: string;
  timeStart?: string;
  timeEnd?: string;
  analysisRelease?: string;
  comparabilityGroup?: string;
  generation?: string;
  cursor?: string;
  origin?: ComponentEcosystemOrigin;
  returnContext?: string;
}

const DEFAULT_PARAMS: ComponentEcosystemParams = {};

export function parseComponentEcosystemHash(
  hash: string,
  routeComponentId = '',
): ComponentEcosystemParams {
  const clean = hash.replace(/^#/, '');
  const queryIndex = clean.indexOf('?');
  const query = queryIndex >= 0 ? clean.slice(queryIndex + 1) : '';
  const params = new URLSearchParams(query);

  const result: ComponentEcosystemParams = { ...DEFAULT_PARAMS };
  const component = routeComponentId || (params.get('component') ?? '');
  if (component) result.component = component;
  if (params.get('kind')) result.kind = params.get('kind') ?? undefined;
  if (params.get('project')) result.project = params.get('project') ?? undefined;
  if (params.get('harness')) result.harness = params.get('harness') ?? undefined;
  if (params.get('model')) result.model = params.get('model') ?? undefined;
  if (params.get('mode')) result.mode = params.get('mode') ?? undefined;
  if (params.get('version')) result.version = params.get('version') ?? undefined;
  if (params.get('leftVersion')) result.leftVersion = params.get('leftVersion') ?? undefined;
  if (params.get('rightVersion')) result.rightVersion = params.get('rightVersion') ?? undefined;
  if (params.get('timeStart')) result.timeStart = params.get('timeStart') ?? undefined;
  if (params.get('timeEnd')) result.timeEnd = params.get('timeEnd') ?? undefined;
  if (params.get('analysisRelease'))
    result.analysisRelease = params.get('analysisRelease') ?? undefined;
  if (params.get('comparabilityGroup'))
    result.comparabilityGroup = params.get('comparabilityGroup') ?? undefined;
  if (params.get('generation')) result.generation = params.get('generation') ?? undefined;
  if (params.get('cursor')) result.cursor = params.get('cursor') ?? undefined;
  const origin = params.get('origin') as ComponentEcosystemOrigin | null;
  if (origin) result.origin = origin;
  if (params.get('returnContext')) result.returnContext = params.get('returnContext') ?? undefined;
  return result;
}

function encodeValue(value: string | undefined): string {
  return value === undefined ? '' : value;
}

export function buildComponentEcosystemHash(params: ComponentEcosystemParams): string {
  const p = new URLSearchParams();
  const entries: [keyof ComponentEcosystemParams, string | undefined][] = [
    ['kind', params.kind],
    ['project', params.project],
    ['harness', params.harness],
    ['model', params.model],
    ['mode', params.mode],
    ['version', params.version],
    ['leftVersion', params.leftVersion],
    ['rightVersion', params.rightVersion],
    ['timeStart', params.timeStart],
    ['timeEnd', params.timeEnd],
    ['analysisRelease', params.analysisRelease],
    ['comparabilityGroup', params.comparabilityGroup],
    ['generation', params.generation],
    ['cursor', params.cursor],
    ['origin', params.origin],
    ['returnContext', params.returnContext],
  ];
  for (const [key, value] of entries) {
    if (value !== undefined && value !== '') {
      p.set(key, encodeValue(value));
    }
  }
  const query = p.toString();
  if (params.component) {
    return `#/components/${encodeURIComponent(params.component)}${query ? `?${query}` : ''}`;
  }
  return `#/components${query ? `?${query}` : ''}`;
}

export function componentEcosystemParamsToQuery(params: ComponentEcosystemParams): AnalyticsQuery {
  const filters: Filter[] = [];
  if (params.project) filters.push({ field: 'projectId', operator: 'eq', value: params.project });
  if (params.harness) filters.push({ field: 'harness', operator: 'eq', value: params.harness });
  if (params.model) filters.push({ field: 'model', operator: 'eq', value: params.model });
  if (params.mode) filters.push({ field: 'mode', operator: 'eq', value: params.mode });
  if (params.component)
    filters.push({ field: 'componentId', operator: 'eq', value: params.component });
  if (params.kind) filters.push({ field: 'kind', operator: 'eq', value: params.kind });

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
    cursor: params.cursor,
  };
}

export function buildComponentEcosystemQueryString(params: ComponentEcosystemParams): string {
  const hash = buildComponentEcosystemHash(params);
  const queryIndex = hash.indexOf('?');
  return queryIndex >= 0 ? hash.slice(queryIndex + 1) : '';
}

export function componentHref(componentId: string, returnParams: ComponentEcosystemParams): string {
  return buildComponentEcosystemHash({ ...returnParams, component: componentId });
}

export function evidenceLinkHref(
  link: EvidenceLink,
  returnParams: ComponentEcosystemParams,
): string {
  switch (link.entityType) {
    case 'project':
      return `#/projects/${link.entityId}/behavior?returnContext=${encodeURIComponent(
        buildComponentEcosystemQueryString(returnParams),
      )}`;
    case 'session':
      return `#/sessions/${link.entityId}?returnContext=${encodeURIComponent(
        buildComponentEcosystemQueryString(returnParams),
      )}`;
    case 'component':
      return componentHref(link.entityId, { ...returnParams, kind: returnParams.kind });
    case 'portfolio':
      return '#/portfolio';
    default:
      return buildComponentEcosystemHash(returnParams);
  }
}

export function originHref(params: ComponentEcosystemParams): string | null {
  if (!params.origin || !params.returnContext) return null;
  switch (params.origin) {
    case 'portfolio':
      return `#/portfolio?${params.returnContext}`;
    case 'project':
      return params.project
        ? `#/projects/${params.project}/behavior?returnContext=${encodeURIComponent(params.returnContext)}`
        : null;
    case 'session':
      return params.project ? `#/sessions/${params.project}` : null;
    default:
      return null;
  }
}
