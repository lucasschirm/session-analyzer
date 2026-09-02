import type { AnalyticsQuery, Filter } from '@lucasschirm/sal-db';

export type ArtifactDiffOrigin = 'portfolio' | 'project' | 'component' | 'session';
export type ArtifactDiffViewMode = 'unified' | 'sideBySide';

export interface ArtifactDiffParams {
  leftArtifact: string;
  rightArtifact: string;
  component?: string;
  project?: string;
  origin?: ArtifactDiffOrigin;
  returnContext?: string;
  analysisRelease?: string;
  comparabilityGroup?: string;
  generation?: string;
  view?: ArtifactDiffViewMode;
}

export function parseArtifactDiffHash(hash: string): ArtifactDiffParams {
  const clean = hash.replace(/^#/, '');
  const queryIndex = clean.indexOf('?');
  const query = queryIndex >= 0 ? clean.slice(queryIndex + 1) : '';
  const params = new URLSearchParams(query);

  const result: ArtifactDiffParams = {
    leftArtifact: params.get('leftArtifact') ?? '',
    rightArtifact: params.get('rightArtifact') ?? '',
  };

  if (params.get('component')) result.component = params.get('component') ?? undefined;
  if (params.get('project')) result.project = params.get('project') ?? undefined;
  if (params.get('origin')) result.origin = params.get('origin') as ArtifactDiffOrigin;
  if (params.get('returnContext')) result.returnContext = params.get('returnContext') ?? undefined;
  if (params.get('analysisRelease'))
    result.analysisRelease = params.get('analysisRelease') ?? undefined;
  if (params.get('comparabilityGroup'))
    result.comparabilityGroup = params.get('comparabilityGroup') ?? undefined;
  if (params.get('generation')) result.generation = params.get('generation') ?? undefined;
  if (params.get('view')) result.view = params.get('view') as ArtifactDiffViewMode;

  return result;
}

export function buildArtifactDiffHash(params: ArtifactDiffParams): string {
  const p = new URLSearchParams();
  const entries: [keyof ArtifactDiffParams, string | undefined][] = [
    ['leftArtifact', params.leftArtifact],
    ['rightArtifact', params.rightArtifact],
    ['component', params.component],
    ['project', params.project],
    ['origin', params.origin],
    ['returnContext', params.returnContext],
    ['analysisRelease', params.analysisRelease],
    ['comparabilityGroup', params.comparabilityGroup],
    ['generation', params.generation],
    ['view', params.view],
  ];
  for (const [key, value] of entries) {
    if (value !== undefined && value !== '') {
      p.set(key, value);
    }
  }
  const query = p.toString();
  return query ? `#/artifact-diff?${query}` : '#/artifact-diff';
}

export function artifactDiffParamsToQuery(params: ArtifactDiffParams): AnalyticsQuery {
  const filters: Filter[] = [];
  if (params.component)
    filters.push({ field: 'componentId', operator: 'eq', value: params.component });
  if (params.project) filters.push({ field: 'projectId', operator: 'eq', value: params.project });

  return {
    analysisReleaseId: params.analysisRelease,
    comparabilityGroupId: params.comparabilityGroup,
    generationId: params.generation,
    filters,
  };
}

export function originHref(params: ArtifactDiffParams): string | null {
  if (!params.origin || !params.returnContext) return null;

  const context = params.returnContext;
  switch (params.origin) {
    case 'portfolio':
      return `#/?${context}`;
    case 'project': {
      const projectId = params.project ?? new URLSearchParams(context).get('project') ?? '';
      return projectId ? `#/projects/${projectId}?${context}` : null;
    }
    case 'component':
      return params.component
        ? `#/artifacts/${encodeURIComponent(params.component)}?${context}`
        : '#/artifacts';
    case 'session':
      return params.project ? `#/sessions/${params.project}` : null;
    default:
      return null;
  }
}
