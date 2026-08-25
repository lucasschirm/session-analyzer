import type { AnalyticsQuery, EvidenceLink, Filter, TimeRange } from '@lucasschirm/sal-db';

export interface ProjectBehaviorParams {
  projectId: string;
  returnContext?: string;
  timeStart?: string;
  timeEnd?: string;
  harness?: string;
  model?: string;
  mode?: string;
  component?: string;
  taskCohort?: string;
  scope?: 'root' | 'inclusive';
  confidence?: string;
  analysisRelease?: string;
  comparabilityGroup?: string;
  generation?: string;
}

const DEFAULT_PARAMS: Omit<ProjectBehaviorParams, 'projectId'> = {};

export function parseProjectBehaviorHash(hash: string): ProjectBehaviorParams {
  const clean = hash.replace(/^#/, '');
  const queryIndex = clean.indexOf('?');
  const path = queryIndex >= 0 ? clean.slice(0, queryIndex) : clean;
  const query = queryIndex >= 0 ? clean.slice(queryIndex + 1) : '';

  const match = path.match(/^\/projects\/([^/]+)\/behavior(?:\/.*)?$/);
  const projectId = match?.[1] ?? '';

  const params = new URLSearchParams(query);
  const result: ProjectBehaviorParams = { projectId, ...DEFAULT_PARAMS };

  if (params.get('returnContext')) result.returnContext = params.get('returnContext') ?? undefined;
  if (params.get('timeStart')) result.timeStart = params.get('timeStart') ?? undefined;
  if (params.get('timeEnd')) result.timeEnd = params.get('timeEnd') ?? undefined;
  if (params.get('harness')) result.harness = params.get('harness') ?? undefined;
  if (params.get('model')) result.model = params.get('model') ?? undefined;
  if (params.get('mode')) result.mode = params.get('mode') ?? undefined;
  if (params.get('component')) result.component = params.get('component') ?? undefined;
  if (params.get('taskCohort')) result.taskCohort = params.get('taskCohort') ?? undefined;
  if (params.get('scope'))
    result.scope = (params.get('scope') as 'root' | 'inclusive') ?? undefined;
  if (params.get('confidence')) result.confidence = params.get('confidence') ?? undefined;
  if (params.get('analysisRelease'))
    result.analysisRelease = params.get('analysisRelease') ?? undefined;
  if (params.get('comparabilityGroup'))
    result.comparabilityGroup = params.get('comparabilityGroup') ?? undefined;
  if (params.get('generation')) result.generation = params.get('generation') ?? undefined;

  return result;
}

export function buildProjectBehaviorHash(params: ProjectBehaviorParams): string {
  const p = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (key === 'projectId') continue;
    if (value !== undefined && value !== '') {
      p.set(key, value);
    }
  }
  const query = p.toString();
  return query ? `?${query}` : '';
}

export function projectBehaviorParamsToQuery(params: ProjectBehaviorParams): AnalyticsQuery {
  const filters: Filter[] = [];
  if (params.harness) filters.push({ field: 'harness', operator: 'eq', value: params.harness });
  if (params.model) filters.push({ field: 'model', operator: 'eq', value: params.model });
  if (params.mode) filters.push({ field: 'mode', operator: 'eq', value: params.mode });
  if (params.component)
    filters.push({ field: 'componentId', operator: 'eq', value: params.component });
  if (params.taskCohort)
    filters.push({ field: 'taskCohort', operator: 'eq', value: params.taskCohort });
  if (params.scope) filters.push({ field: 'scope', operator: 'eq', value: params.scope });
  if (params.confidence)
    filters.push({ field: 'confidence', operator: 'eq', value: params.confidence });

  const timeRange: TimeRange | undefined =
    params.timeStart && params.timeEnd
      ? { start: params.timeStart, end: params.timeEnd }
      : undefined;

  return {
    analysisReleaseId: params.analysisRelease,
    comparabilityGroupId: params.comparabilityGroup ?? params.taskCohort,
    generationId: params.generation,
    timeRange,
    filters,
  };
}

export function evidenceLinkHref(link: EvidenceLink, returnParams?: ProjectBehaviorParams): string {
  switch (link.entityType) {
    case 'session':
      return `#/sessions/${link.entityId}`;
    case 'project':
      return `#/projects/${link.entityId}/behavior${buildProjectBehaviorHash({
        ...returnParams,
        projectId: link.entityId,
      })}`;
    case 'portfolio':
      return '#/portfolio';
    default:
      return '#';
  }
}
