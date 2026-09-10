import {
  ComponentIdentityStore,
  EnvironmentStore,
  FRESH_SCHEMA_SQL,
  IngestionSourceStore,
  PortfolioStore,
  ProjectStore,
  SessionComponentExposureStore,
  SessionComponentStatStore,
  SessionStore,
  TenantStore,
} from '@lucasschirm/sal-db-core';
import { beforeEach, describe, expect, it } from 'vitest';
import { WasmSqliteExecutor } from '../../../db-core/tests/helpers/sqlite-wasm-adapter.js';
import { createAnalyticsDataSource } from '../../src/analytics.js';
import {
  getHarnessUtilizationReport,
  getPortfolioUtilizationReport,
  getProjectUtilizationReport,
  getSessionUtilizationReport,
} from '../../src/analytics-utilization.js';
import { setProjectConfiguration } from '../../src/project-configuration.js';

const TENANT_ID = 'tenant-util';
const PORTFOLIO_ID = 'portfolio-util';
const SOURCE_ID = 'source-util';
const ENV_ID = 'env-util';
const PROJECT1_ID = 'project-util-1';
const PROJECT2_ID = 'project-util-2';
const BASE_TIME = new Date('2026-09-01T12:00:00Z').getTime();

describe('analytics-utilization', () => {
  let executor: WasmSqliteExecutor;

  beforeEach(async () => {
    executor = await WasmSqliteExecutor.create();
    await executor.exec(FRESH_SCHEMA_SQL);

    await TenantStore.insert(executor, { id: TENANT_ID, name: 'Test Tenant' });
    await PortfolioStore.insert(executor, {
      id: PORTFOLIO_ID,
      tenantId: TENANT_ID,
      name: 'Test Portfolio',
    });
    await IngestionSourceStore.insert(executor, {
      id: SOURCE_ID,
      portfolioId: PORTFOLIO_ID,
      nativeSourceId: 'src-1',
      displayName: 'Source 1',
      type: 'test',
      authority: 'local',
    });
    await EnvironmentStore.insert(executor, PORTFOLIO_ID, {
      id: ENV_ID,
      ingestionSourceId: SOURCE_ID,
      nativeEnvironmentId: 'env-1',
    });
    await ProjectStore.insert(executor, {
      id: PROJECT1_ID,
      portfolioId: PORTFOLIO_ID,
      name: 'Project Alpha',
    });
    await ProjectStore.insert(executor, {
      id: PROJECT2_ID,
      portfolioId: PORTFOLIO_ID,
      name: 'Project Beta',
    });
    await executor.exec(
      `INSERT INTO analysis_releases
       (id, ontology_version, metric_registry_version, statistical_policy_version,
        rollup_policy_version, mapping_version, created_at, is_default)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['ar-util', '0.1.0', '0.1.0', '0.1.0', '0.1.0', '0.1.0', BASE_TIME, 0],
    );
  });

  async function createGeneration(sessionId: string, generationId: string): Promise<void> {
    await executor.exec(
      `INSERT INTO transformation_generations
       (id, session_id, analysis_release_id, parser_version, transformer_version,
        ontology_version, metric_version, schema_version, status, source_availability, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        generationId,
        sessionId,
        'ar-util',
        '0.1.0',
        '0.1.0',
        '0.1.0',
        '0.1.0',
        '0.1.0',
        'committed',
        'local',
        BASE_TIME,
      ],
    );
  }

  it('generates binary session utilization report', async () => {
    const sessionId = 'session-1';
    await SessionStore.insert(executor, {
      id: sessionId,
      projectId: PROJECT1_ID,
      ingestionSourceId: SOURCE_ID,
      nativeSessionId: sessionId,
      harness: 'claude-code',
      occurrenceTime: BASE_TIME,
      finality: 'final',
    });

    const bashToolId = await ComponentIdentityStore.insert(executor, {
      id: 'tool-bash',
      portfolioId: PORTFOLIO_ID,
      kind: 'tool',
      nativeId: 'Bash',
      displayName: 'Bash',
      canonicalSourceIdentity: 'tool:bash',
    });

    const editToolId = await ComponentIdentityStore.insert(executor, {
      id: 'tool-edit',
      portfolioId: PORTFOLIO_ID,
      kind: 'tool',
      nativeId: 'Edit',
      displayName: 'Edit',
      canonicalSourceIdentity: 'tool:edit',
    });

    const prSkillId = await ComponentIdentityStore.insert(executor, {
      id: 'skill-pr',
      portfolioId: PORTFOLIO_ID,
      kind: 'skill',
      nativeId: 'pr-review',
      displayName: 'PR Review Skill',
      canonicalSourceIdentity: 'skill:pr-review',
    });

    // Expose Bash and Edit and PR Review to session-1
    await SessionComponentExposureStore.insert(executor, {
      sessionId,
      componentId: bashToolId,
      environmentId: ENV_ID,
      status: 'available_not_loaded',
      startSequence: 0,
      startTime: BASE_TIME,
    });
    await SessionComponentExposureStore.insert(executor, {
      sessionId,
      componentId: editToolId,
      environmentId: ENV_ID,
      status: 'available_not_loaded',
      startSequence: 1,
      startTime: BASE_TIME,
    });
    await SessionComponentExposureStore.insert(executor, {
      sessionId,
      componentId: prSkillId,
      environmentId: ENV_ID,
      status: 'available_not_loaded',
      startSequence: 2,
      startTime: BASE_TIME,
    });

    // Bash was invoked, Edit was not
    await createGeneration(sessionId, 'gen-1');
    await SessionComponentStatStore.insert(executor, {
      sessionId,
      componentId: bashToolId,
      invocationCount: 3,
      loadCount: 1,
      generationId: 'gen-1',
    });

    const report = await getSessionUtilizationReport(executor, sessionId);

    expect(report.scopeType).toBe('session');
    expect(report.scopeId).toBe(sessionId);
    expect(report.sessionDomains).toBeDefined();

    const toolDomain = report.sessionDomains?.tool;
    expect(toolDomain?.availableCount).toBe(2);
    expect(toolDomain?.usedCount).toBe(1);
    expect(toolDomain?.unusedCount).toBe(1);
    expect(toolDomain?.usedComponents).toContain('tool/Bash');
    expect(toolDomain?.unusedComponents).toContain('tool/Edit');

    const skillDomain = report.sessionDomains?.skill;
    expect(skillDomain?.availableCount).toBe(1);
    expect(skillDomain?.usedCount).toBe(0);
    expect(skillDomain?.unusedCount).toBe(1);
    expect(skillDomain?.unusedComponents).toContain('skill/pr-review');

    const agentDomain = report.sessionDomains?.agent;
    expect(agentDomain?.availableCount).toBe(0);
    expect(agentDomain?.usedCount).toBe(0);
    expect(agentDomain?.unusedCount).toBe(0);
  });

  it('generates project utilization report with disjoint tiers and min_sample logic', async () => {
    // Insert 10 sessions into PROJECT1_ID
    const sessionIds: string[] = [];
    for (let i = 1; i <= 10; i++) {
      const sId = `session-p1-${i}`;
      sessionIds.push(sId);
      await SessionStore.insert(executor, {
        id: sId,
        projectId: PROJECT1_ID,
        ingestionSourceId: SOURCE_ID,
        nativeSessionId: sId,
        harness: 'claude-code',
        occurrenceTime: BASE_TIME + i * 1000,
        finality: 'final',
      });
    }

    // Component A (Tool): offered in all 10 sessions, used in 0 -> strictly unused (0%)
    const toolUnused = await ComponentIdentityStore.insert(executor, {
      id: 'tool-unused',
      portfolioId: PORTFOLIO_ID,
      kind: 'tool',
      nativeId: 'UnusedTool',
      displayName: 'Unused Tool',
      canonicalSourceIdentity: 'tool:unused',
    });

    const tool10Pct = await ComponentIdentityStore.insert(executor, {
      id: 'tool-10pct',
      portfolioId: PORTFOLIO_ID,
      kind: 'tool',
      nativeId: 'Tool10Pct',
      displayName: 'Tool 10%',
      canonicalSourceIdentity: 'tool:10pct',
    });

    // Component C (Tool): offered in 10 sessions, used in 3 (30% -> usedLt50Pct [0.25, 0.50))
    const tool30Pct = await ComponentIdentityStore.insert(executor, {
      id: 'tool-30pct',
      portfolioId: PORTFOLIO_ID,
      kind: 'tool',
      nativeId: 'Tool30Pct',
      displayName: 'Tool 30%',
      canonicalSourceIdentity: 'tool:30pct',
    });

    // Component D (Tool): offered in 10 sessions, used in 7 (70% -> usedGte50Pct [0.50, 1.0])
    const tool70Pct = await ComponentIdentityStore.insert(executor, {
      id: 'tool-70pct',
      portfolioId: PORTFOLIO_ID,
      kind: 'tool',
      nativeId: 'Tool70Pct',
      displayName: 'Tool 70%',
      canonicalSourceIdentity: 'tool:70pct',
    });

    // Component E (Tool): offered in only 3 sessions (< min_sample 5) -> insufficientSample
    const toolYoung = await ComponentIdentityStore.insert(executor, {
      id: 'tool-young',
      portfolioId: PORTFOLIO_ID,
      kind: 'tool',
      nativeId: 'ToolYoung',
      displayName: 'Tool Young',
      canonicalSourceIdentity: 'tool:young',
    });

    // Expose toolUnused in all 10 sessions, no stats
    for (const sId of sessionIds) {
      await SessionComponentExposureStore.insert(executor, {
        sessionId: sId,
        componentId: toolUnused,
        environmentId: ENV_ID,
        status: 'available_not_loaded',
        startSequence: 0,
        startTime: BASE_TIME,
      });
      await SessionComponentExposureStore.insert(executor, {
        sessionId: sId,
        componentId: tool10Pct,
        environmentId: ENV_ID,
        status: 'available_not_loaded',
        startSequence: 1,
        startTime: BASE_TIME,
      });
      await SessionComponentExposureStore.insert(executor, {
        sessionId: sId,
        componentId: tool30Pct,
        environmentId: ENV_ID,
        status: 'available_not_loaded',
        startSequence: 2,
        startTime: BASE_TIME,
      });
      await SessionComponentExposureStore.insert(executor, {
        sessionId: sId,
        componentId: tool70Pct,
        environmentId: ENV_ID,
        status: 'available_not_loaded',
        startSequence: 3,
        startTime: BASE_TIME,
      });
    }

    // Expose toolYoung in only 3 sessions
    for (let i = 0; i < 3; i++) {
      await SessionComponentExposureStore.insert(executor, {
        sessionId: sessionIds[i],
        componentId: toolYoung,
        environmentId: ENV_ID,
        status: 'available_not_loaded',
        startSequence: 4,
        startTime: BASE_TIME,
      });
    }

    for (const sId of sessionIds) {
      await createGeneration(sId, `gen-${sId}`);
    }

    // Record stats:
    // tool10Pct in 1 session
    await SessionComponentStatStore.insert(executor, {
      sessionId: sessionIds[0],
      componentId: tool10Pct,
      invocationCount: 1,
      loadCount: 1,
      generationId: `gen-${sessionIds[0]}`,
    });

    // tool30Pct in 3 sessions
    for (let i = 0; i < 3; i++) {
      await SessionComponentStatStore.insert(executor, {
        sessionId: sessionIds[i],
        componentId: tool30Pct,
        invocationCount: 2,
        loadCount: 1,
        generationId: `gen-${sessionIds[i]}`,
      });
    }

    // tool70Pct in 7 sessions
    for (let i = 0; i < 7; i++) {
      await SessionComponentStatStore.insert(executor, {
        sessionId: sessionIds[i],
        componentId: tool70Pct,
        invocationCount: 5,
        loadCount: 1,
        generationId: `gen-${sessionIds[i]}`,
      });
    }

    const report = await getProjectUtilizationReport(executor, PROJECT1_ID);
    expect(report.scopeType).toBe('project');
    expect(report.scopeId).toBe(PROJECT1_ID);

    const toolsSummary = report.domains.tool;
    expect(toolsSummary.eligibleSessions).toBe(10);
    expect(toolsSummary.sampleSessions).toBe(10);

    const tiers = toolsSummary.tiers;
    // Total available = 5 (tool10Pct, tool30Pct, tool70Pct, toolZero, toolYoung)
    expect(tiers.totalAvailable).toBe(5);
    // tool10Pct: 1/10 = 10% -> disjoint: tier25 (since 10% <= rate < 25%)
    expect(tiers.usedLt25Pct).toBe(1);
    // tool30Pct: 3/10 = 30% -> disjoint: tier50 (25% <= rate < 50%)
    expect(tiers.usedLt50Pct).toBe(1);
    // tool70Pct: 7/10 = 70% -> disjoint: tierGte50 (>= 50%)
    expect(tiers.usedGte50Pct).toBe(1);
    // toolZero: 0/10 = 0% -> disjoint: totalUnused (rate === 0)
    expect(tiers.totalUnused).toBe(1);
    // toolYoung: offered in only 3 sessions < min_sample (5) -> insufficientSample
    expect(tiers.insufficientSample).toBe(1);
    // lessThan10Pct: none strictly between 0 and 10%
    expect(tiers.usedLt10Pct).toBe(0);

    // Verify disjoint sum equals totalAvailable
    const sumTiers =
      tiers.totalUnused +
      tiers.usedLt10Pct +
      tiers.usedLt25Pct +
      tiers.usedLt50Pct +
      tiers.usedGte50Pct +
      tiers.insufficientSample;
    expect(sumTiers).toBe(tiers.totalAvailable);

    // Custom configuration: change min_sample to 2
    await setProjectConfiguration(executor, PROJECT1_ID, 'utilization_min_session_sample_size', 2);
    const updatedReport = await getProjectUtilizationReport(executor, PROJECT1_ID);
    const updatedTiers = updatedReport.domains.tool.tiers;
    // toolYoung was offered in 3 sessions (>= 2), used in 0 -> becomes totalUnused instead of insufficientSample!
    expect(updatedTiers.insufficientSample).toBe(0);
    expect(updatedTiers.totalUnused).toBe(2);
    expect(updatedTiers.totalAvailable).toBe(5);
  });

  it('exposes getUtilizationReport via AnalyticsDataSource views and direct call', async () => {
    const directPortfolioReport = await getPortfolioUtilizationReport(executor);
    expect(directPortfolioReport.scopeType).toBe('portfolio');
    expect(directPortfolioReport.domains).toBeDefined();

    const ds = createAnalyticsDataSource(executor);
    const portfolioReport = await ds.portfolio.getUtilizationReport();
    expect(portfolioReport.scopeType).toBe('portfolio');
    expect(portfolioReport.domains).toBeDefined();

    const projectReport = await ds.project.getUtilizationReport(PROJECT1_ID);
    expect(projectReport.scopeType).toBe('project');
    expect(projectReport.scopeId).toBe(PROJECT1_ID);

    const sessionReport = await ds.session.getUtilizationReport('unknown-session');
    expect(sessionReport.scopeType).toBe('session');
    expect(sessionReport.sessionDomains).toBeDefined();
  });

  it('generates harness utilization report filtered by harness', async () => {
    const claudeReport = await getHarnessUtilizationReport(executor, 'claude-code');
    expect(claudeReport.scopeType).toBe('harness');
    expect(claudeReport.scopeId).toBe('claude-code');
    expect(claudeReport.domains).toBeDefined();

    const devinReport = await getHarnessUtilizationReport(executor, 'devin');
    expect(devinReport.scopeType).toBe('harness');
    expect(devinReport.scopeId).toBe('devin');
    expect(devinReport.domains.tool.tiers.totalAvailable).toBe(0);
  });
});
