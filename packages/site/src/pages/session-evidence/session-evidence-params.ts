import type { AnalyticsQuery, EvidenceLink } from '@lucasschirm/sal-db';

export interface SessionEvidenceParams {
  returnContext?: string;
  view?: 'evidence' | 'transcript';
  cursor?: string;
  limit?: string;
  analysisRelease?: string;
  comparabilityGroup?: string;
  generation?: string;
}

const DEFAULT_PARAMS: SessionEvidenceParams = {};

export function parseSessionEvidenceHash(hash: string, _sessionId: string): SessionEvidenceParams {
  const clean = hash.replace(/^#/, '');
  const queryIndex = clean.indexOf('?');
  const query = queryIndex >= 0 ? clean.slice(queryIndex + 1) : '';
  if (!query) return { ...DEFAULT_PARAMS };

  const params = new URLSearchParams(query);
  const result: SessionEvidenceParams = { ...DEFAULT_PARAMS };

  if (params.get('returnContext')) result.returnContext = params.get('returnContext') ?? undefined;
  const view = params.get('view');
  if (view === 'evidence' || view === 'transcript') result.view = view;
  if (params.get('cursor')) result.cursor = params.get('cursor') ?? undefined;
  if (params.get('limit')) result.limit = params.get('limit') ?? undefined;
  if (params.get('analysisRelease'))
    result.analysisRelease = params.get('analysisRelease') ?? undefined;
  if (params.get('comparabilityGroup'))
    result.comparabilityGroup = params.get('comparabilityGroup') ?? undefined;
  if (params.get('generation')) result.generation = params.get('generation') ?? undefined;

  return result;
}

export function buildSessionEvidenceHash(
  params: SessionEvidenceParams,
  includeQuestionMark = true,
): string {
  const p = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') {
      p.set(key, value);
    }
  }
  const query = p.toString();
  return includeQuestionMark && query ? `?${query}` : query;
}

export function sessionEvidenceParamsToQuery(params: SessionEvidenceParams): AnalyticsQuery {
  const limitValue = params.limit ? Number(params.limit) : NaN;
  const limit = !Number.isNaN(limitValue) && limitValue > 0 ? limitValue : undefined;
  return {
    ...(params.analysisRelease ? { analysisReleaseId: params.analysisRelease } : {}),
    ...(params.comparabilityGroup ? { comparabilityGroupId: params.comparabilityGroup } : {}),
    ...(params.generation ? { generationId: params.generation } : {}),
    ...(params.cursor ? { cursor: params.cursor } : {}),
    ...(limit ? { limit } : {}),
  };
}

export function evidenceLinkHref(link: EvidenceLink, returnParams?: SessionEvidenceParams): string {
  switch (link.entityType) {
    case 'session':
      return `#/sessions/${link.entityId}${buildSessionEvidenceHash(returnParams ?? {})}`;
    case 'project':
      return `#/projects/${link.entityId}/behavior?returnContext=${encodeURIComponent(
        buildSessionEvidenceHash(returnParams ?? {}, false),
      )}`;
    case 'portfolio':
      return `#/portfolio`;
    case 'component':
      return `#/portfolio?component=${encodeURIComponent(link.entityId)}`;
    default:
      return `#/sessions/${link.entityId}`;
  }
}
