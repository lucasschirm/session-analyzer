import type { SqliteExecutor, SqliteTransaction, SqliteValue } from '@lucasschirm/sal-db-core';
import type { AnalyticsQuery } from './analytics.js';
import type {
  AnalyticsToken,
  ComponentDomain,
  ComponentUtilizationItemDto,
  ComponentUtilizationTiersDto,
  DomainUtilizationSummaryDto,
  ScopeUtilizationReportDto,
  SessionDomainUtilizationDto,
} from './dto.js';
import {
  getProjectUtilizationConfig,
  type ProjectUtilizationConfig,
} from './project-configuration.js';

type Queryable = SqliteExecutor | SqliteTransaction;

const DOMAINS: readonly ComponentDomain[] = ['tool', 'skill', 'agent'];

function asString(value: SqliteValue): string {
  return value === null || value === undefined ? '' : String(value);
}

function asOptionalString(value: SqliteValue): string | null {
  return value === null || value === undefined ? null : String(value);
}

function asNumber(value: SqliteValue): number {
  return value === null || value === undefined ? 0 : Number(value);
}

function componentLabel(
  kind: string,
  nativeId: string | null,
  displayName: string | null,
  componentId: string,
): string {
  const name = nativeId || displayName || componentId;
  return `${kind}/${name}`;
}

function emptyTiers(): ComponentUtilizationTiersDto {
  return {
    totalAvailable: 0,
    totalUsed: 0,
    totalUnused: 0,
    usedLt10Pct: 0,
    usedLt25Pct: 0,
    usedLt50Pct: 0,
    usedGte50Pct: 0,
    insufficientSample: 0,
  };
}

function emptyDomainSummary(
  domain: ComponentDomain,
  minSample: number,
): DomainUtilizationSummaryDto {
  return {
    domain,
    tiers: emptyTiers(),
    sampleSessions: 0,
    eligibleSessions: 0,
    minSampleSizeConfig: minSample,
    components: [],
  };
}

function emptySessionDomain(domain: ComponentDomain): SessionDomainUtilizationDto {
  return {
    domain,
    availableCount: 0,
    usedCount: 0,
    unusedCount: 0,
    availableComponents: [],
    usedComponents: [],
    unusedComponents: [],
  };
}

function makeToken(
  query: AnalyticsQuery | undefined,
  scopeType: string,
  scopeId: string,
  knownN: number,
  eligibleN: number,
): AnalyticsToken {
  return {
    analysisReleaseId: query?.analysisReleaseId ?? 'unknown',
    generationId: query?.generationId ?? 'unknown',
    comparabilityGroupId: 'utilization-metrics',
    eligibleN,
    knownN,
    unknownCount: Math.max(0, eligibleN - knownN),
    coverage: knownN > 0 ? 'complete' : 'unknown',
    measurementClass: 'derived',
    confidence: 'high',
    metricVersion: '0.1.0',
    evidenceLinks: [
      {
        evidenceId: `${scopeType}:${scopeId}`,
        entityType: scopeType,
        entityId: scopeId,
        label: `${scopeType} ${scopeId} utilization`,
      },
    ],
  };
}

/**
 * Derives binary Available vs Used vs Unused counts for an individual session (Option B).
 */
export async function getSessionUtilizationReport(
  queryable: Queryable,
  sessionId: string,
  query?: AnalyticsQuery,
): Promise<ScopeUtilizationReportDto> {
  const { rows: sessionRows } = await queryable.exec(
    'SELECT id, project_id, harness FROM sessions WHERE id = ?',
    [sessionId],
  );
  if (sessionRows.length === 0) {
    const emptyToken = makeToken(query, 'session', sessionId, 0, 0);
    return {
      scopeType: 'session',
      scopeId: sessionId,
      token: emptyToken,
      domains: {
        tool: emptyDomainSummary('tool', 5),
        skill: emptyDomainSummary('skill', 5),
        agent: emptyDomainSummary('agent', 5),
      },
      sessionDomains: {
        tool: emptySessionDomain('tool'),
        skill: emptySessionDomain('skill'),
        agent: emptySessionDomain('agent'),
      },
    };
  }

  // 1. Available components in this session
  const { rows: availRows } = await queryable.exec(
    `SELECT DISTINCT
       ci.id AS component_id,
       ci.kind,
       ci.native_id,
       ci.display_name
     FROM session_component_exposures sce
     JOIN component_identities ci ON ci.id = sce.component_id
     WHERE sce.session_id = ?
       AND ci.kind IN ('tool', 'skill', 'agent')`,
    [sessionId],
  );

  // 2. Used components in this session
  const { rows: usedRows } = await queryable.exec(
    `SELECT DISTINCT sce.component_id
     FROM session_component_exposures sce
     LEFT JOIN session_component_stats scs
       ON scs.session_id = sce.session_id AND scs.component_id = sce.component_id
     LEFT JOIN invocations inv
       ON inv.session_id = sce.session_id AND inv.component_id = sce.component_id
     WHERE sce.session_id = ?
       AND (
         COALESCE(scs.invocation_count, 0) > 0
         OR inv.id IS NOT NULL
         OR sce.status = 'loaded'
       )`,
    [sessionId],
  );
  const usedIdSet = new Set(usedRows.map((r) => asString(r.component_id)));

  const sessionDomains: Record<ComponentDomain, SessionDomainUtilizationDto> = {
    tool: emptySessionDomain('tool'),
    skill: emptySessionDomain('skill'),
    agent: emptySessionDomain('agent'),
  };

  const domainSummaries: Record<ComponentDomain, DomainUtilizationSummaryDto> = {
    tool: emptyDomainSummary('tool', 5),
    skill: emptyDomainSummary('skill', 5),
    agent: emptyDomainSummary('agent', 5),
  };

  for (const row of availRows) {
    const kind = asString(row.kind) as ComponentDomain;
    if (!DOMAINS.includes(kind)) continue;

    const componentId = asString(row.component_id);
    const label = componentLabel(
      kind,
      asOptionalString(row.native_id),
      asOptionalString(row.display_name),
      componentId,
    );
    const isUsed = usedIdSet.has(componentId);

    const sd = sessionDomains[kind];
    const availList = [...sd.availableComponents, label];
    const usedList = isUsed ? [...sd.usedComponents, label] : sd.usedComponents;
    const unusedList = !isUsed ? [...sd.unusedComponents, label] : sd.unusedComponents;

    sessionDomains[kind] = {
      domain: kind,
      availableCount: availList.length,
      usedCount: usedList.length,
      unusedCount: unusedList.length,
      availableComponents: availList,
      usedComponents: usedList,
      unusedComponents: unusedList,
    };
  }

  // Populate basic summary tiers from session domain counts
  for (const domain of DOMAINS) {
    const sd = sessionDomains[domain];
    domainSummaries[domain] = {
      domain,
      tiers: {
        totalAvailable: sd.availableCount,
        totalUsed: sd.usedCount,
        totalUnused: sd.unusedCount,
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
    };
  }

  const token = makeToken(query, 'session', sessionId, 1, 1);
  return {
    scopeType: 'session',
    scopeId: sessionId,
    token,
    domains: domainSummaries,
    sessionDomains,
  };
}

interface ComponentStatRow {
  readonly component_id: string;
  readonly kind: string;
  readonly native_id: string | null;
  readonly display_name: string | null;
  readonly offered_sessions: number;
  readonly used_sessions: number;
}

function computeDisjointTiers(
  rows: readonly ComponentStatRow[],
  config: ProjectUtilizationConfig,
  totalSessions: number,
): Record<ComponentDomain, DomainUtilizationSummaryDto> {
  const result: Record<ComponentDomain, DomainUtilizationSummaryDto> = {
    tool: emptyDomainSummary('tool', config.minSessionSampleSize),
    skill: emptyDomainSummary('skill', config.minSessionSampleSize),
    agent: emptyDomainSummary('agent', config.minSessionSampleSize),
  };

  const domainComponents: Record<ComponentDomain, ComponentUtilizationItemDto[]> = {
    tool: [],
    skill: [],
    agent: [],
  };

  for (const row of rows) {
    const kind = row.kind as ComponentDomain;
    if (!DOMAINS.includes(kind)) continue;

    const componentId = row.component_id;
    const nativeId = row.native_id ?? undefined;
    const displayName = componentLabel(kind, row.native_id, row.display_name, componentId);
    const offeredSessions = row.offered_sessions;
    const usedSessions = row.used_sessions;
    const usageRate = offeredSessions > 0 ? usedSessions / offeredSessions : 0;

    let tier: ComponentUtilizationItemDto['tier'];
    if (offeredSessions < config.minSessionSampleSize) {
      tier = 'insufficient_sample';
    } else if (usedSessions === 0) {
      tier = 'unused';
    } else if (usageRate < config.tier1UpperBound) {
      tier = 'lt10';
    } else if (usageRate < config.tier2UpperBound) {
      tier = 'lt25';
    } else if (usageRate < config.tier3UpperBound) {
      tier = 'lt50';
    } else {
      tier = 'gte50';
    }

    domainComponents[kind].push({
      componentId,
      kind,
      displayName,
      nativeId,
      offeredSessions,
      usedSessions,
      usageRate,
      tier,
    });
  }

  for (const domain of DOMAINS) {
    const items = domainComponents[domain];
    const totalAvailable = items.length;
    let totalUnused = 0;
    let usedLt10Pct = 0;
    let usedLt25Pct = 0;
    let usedLt50Pct = 0;
    let usedGte50Pct = 0;
    let insufficientSample = 0;

    for (const item of items) {
      switch (item.tier) {
        case 'unused':
          totalUnused++;
          break;
        case 'lt10':
          usedLt10Pct++;
          break;
        case 'lt25':
          usedLt25Pct++;
          break;
        case 'lt50':
          usedLt50Pct++;
          break;
        case 'gte50':
          usedGte50Pct++;
          break;
        case 'insufficient_sample':
          insufficientSample++;
          break;
      }
    }

    const totalUsed = items.filter((item) => item.usedSessions > 0).length;

    result[domain] = {
      domain,
      tiers: {
        totalAvailable,
        totalUsed,
        totalUnused,
        usedLt10Pct,
        usedLt25Pct,
        usedLt50Pct,
        usedGte50Pct,
        insufficientSample,
      },
      sampleSessions: totalSessions,
      eligibleSessions: totalSessions,
      minSampleSizeConfig: config.minSessionSampleSize,
      components: items,
    };
  }

  return result;
}

/**
 * Derives disjoint utilization indicators for a project.
 */
export async function getProjectUtilizationReport(
  queryable: Queryable,
  projectId: string,
  query?: AnalyticsQuery,
): Promise<ScopeUtilizationReportDto> {
  const config = await getProjectUtilizationConfig(queryable, projectId);

  const { rows: countRows } = await queryable.exec(
    'SELECT COUNT(DISTINCT id) AS n FROM sessions WHERE project_id = ?',
    [projectId],
  );
  const totalSessions = asNumber(countRows[0]?.n);

  const { rows } = await queryable.exec(
    `SELECT
       ci.id AS component_id,
       ci.kind,
       ci.native_id,
       ci.display_name,
       COUNT(DISTINCT sce.session_id) AS offered_sessions,
       COUNT(DISTINCT CASE
         WHEN COALESCE(scs.invocation_count, 0) > 0
              OR inv.id IS NOT NULL
              OR sce.status = 'loaded'
         THEN sce.session_id
       END) AS used_sessions
     FROM session_component_exposures sce
     JOIN sessions s ON s.id = sce.session_id
     JOIN component_identities ci ON ci.id = sce.component_id
     LEFT JOIN session_component_stats scs
       ON scs.session_id = sce.session_id AND scs.component_id = sce.component_id
     LEFT JOIN invocations inv
       ON inv.session_id = sce.session_id AND inv.component_id = sce.component_id
     WHERE s.project_id = ?
       AND ci.kind IN ('tool', 'skill', 'agent')
     GROUP BY ci.id, ci.kind, ci.native_id, ci.display_name`,
    [projectId],
  );

  const statRows: ComponentStatRow[] = rows.map((r) => ({
    component_id: asString(r.component_id),
    kind: asString(r.kind),
    native_id: asOptionalString(r.native_id),
    display_name: asOptionalString(r.display_name),
    offered_sessions: asNumber(r.offered_sessions),
    used_sessions: asNumber(r.used_sessions),
  }));

  const domains = computeDisjointTiers(statRows, config, totalSessions);
  const token = makeToken(query, 'project', projectId, totalSessions, totalSessions);

  return {
    scopeType: 'project',
    scopeId: projectId,
    token,
    domains,
  };
}

/**
 * Derives disjoint utilization indicators aggregated by harness across projects.
 */
export async function getHarnessUtilizationReport(
  queryable: Queryable,
  harness: string,
  query?: AnalyticsQuery,
): Promise<ScopeUtilizationReportDto> {
  const config = await getProjectUtilizationConfig(queryable, null);

  const { rows: countRows } = await queryable.exec(
    'SELECT COUNT(DISTINCT id) AS n FROM sessions WHERE harness = ?',
    [harness],
  );
  const totalSessions = asNumber(countRows[0]?.n);

  const { rows } = await queryable.exec(
    `SELECT
       ci.id AS component_id,
       ci.kind,
       ci.native_id,
       ci.display_name,
       COUNT(DISTINCT sce.session_id) AS offered_sessions,
       COUNT(DISTINCT CASE
         WHEN COALESCE(scs.invocation_count, 0) > 0
              OR inv.id IS NOT NULL
              OR sce.status = 'loaded'
         THEN sce.session_id
       END) AS used_sessions
     FROM session_component_exposures sce
     JOIN sessions s ON s.id = sce.session_id
     JOIN component_identities ci ON ci.id = sce.component_id
     LEFT JOIN session_component_stats scs
       ON scs.session_id = sce.session_id AND scs.component_id = sce.component_id
     LEFT JOIN invocations inv
       ON inv.session_id = sce.session_id AND inv.component_id = sce.component_id
     WHERE s.harness = ?
       AND ci.kind IN ('tool', 'skill', 'agent')
     GROUP BY ci.id, ci.kind, ci.native_id, ci.display_name`,
    [harness],
  );

  const statRows: ComponentStatRow[] = rows.map((r) => ({
    component_id: asString(r.component_id),
    kind: asString(r.kind),
    native_id: asOptionalString(r.native_id),
    display_name: asOptionalString(r.display_name),
    offered_sessions: asNumber(r.offered_sessions),
    used_sessions: asNumber(r.used_sessions),
  }));

  const domains = computeDisjointTiers(statRows, config, totalSessions);
  const token = makeToken(query, 'harness', harness, totalSessions, totalSessions);

  return {
    scopeType: 'harness',
    scopeId: harness,
    token,
    domains,
  };
}

/**
 * Derives disjoint utilization indicators aggregated for the entire portfolio.
 */
export async function getPortfolioUtilizationReport(
  queryable: Queryable,
  query?: AnalyticsQuery,
): Promise<ScopeUtilizationReportDto> {
  const config = await getProjectUtilizationConfig(queryable, null);

  const harnessFilter =
    (query as { harness?: string } | undefined)?.harness ??
    (query?.filters?.find((f) => f.field === 'harness' && f.operator === 'eq')?.value as string) ??
    null;

  let sessionCountSql = 'SELECT COUNT(DISTINCT id) AS n FROM sessions';
  const sessionCountParams: (string | null)[] = [];
  if (harnessFilter) {
    sessionCountSql += ' WHERE harness = ?';
    sessionCountParams.push(harnessFilter);
  }
  const { rows: countRows } = await queryable.exec(sessionCountSql, sessionCountParams);
  const totalSessions = asNumber(countRows[0]?.n);

  let querySql = `
    SELECT
      ci.id AS component_id,
      ci.kind,
      ci.native_id,
      ci.display_name,
      COUNT(DISTINCT sce.session_id) AS offered_sessions,
      COUNT(DISTINCT CASE
        WHEN COALESCE(scs.invocation_count, 0) > 0
             OR inv.id IS NOT NULL
             OR sce.status = 'loaded'
        THEN sce.session_id
      END) AS used_sessions
    FROM session_component_exposures sce
    JOIN sessions s ON s.id = sce.session_id
    JOIN component_identities ci ON ci.id = sce.component_id
    LEFT JOIN session_component_stats scs
      ON scs.session_id = sce.session_id AND scs.component_id = sce.component_id
    LEFT JOIN invocations inv
      ON inv.session_id = sce.session_id AND inv.component_id = sce.component_id
    WHERE ci.kind IN ('tool', 'skill', 'agent')
  `;
  const queryParams: (string | null)[] = [];
  if (harnessFilter) {
    querySql += ' AND s.harness = ?';
    queryParams.push(harnessFilter);
  }
  querySql += ' GROUP BY ci.id, ci.kind, ci.native_id, ci.display_name';

  const { rows } = await queryable.exec(querySql, queryParams);

  const statRows: ComponentStatRow[] = rows.map((r) => ({
    component_id: asString(r.component_id),
    kind: asString(r.kind),
    native_id: asOptionalString(r.native_id),
    display_name: asOptionalString(r.display_name),
    offered_sessions: asNumber(r.offered_sessions),
    used_sessions: asNumber(r.used_sessions),
  }));

  const domains = computeDisjointTiers(statRows, config, totalSessions);
  const scopeId = harnessFilter ? `portfolio:harness=${harnessFilter}` : 'portfolio';
  const token = makeToken(query, 'portfolio', scopeId, totalSessions, totalSessions);

  return {
    scopeType: 'portfolio',
    scopeId,
    token,
    domains,
  };
}
