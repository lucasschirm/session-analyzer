import { serialize } from 'node:v8';
import {
  EnvironmentStore,
  FRESH_SCHEMA_SQL,
  IngestionSourceStore,
  InvocationStore,
  PortfolioStore,
  ProjectStore,
  SessionStore,
  SourceProjectStore,
  TenantStore,
} from '@lucasschirm/sal-db-core';
import { describe, expect, it } from 'vitest';
import { WasmSqliteExecutor } from '../../../db-core/tests/helpers/sqlite-wasm-adapter.js';
import { createSessionEvidenceView } from '../../src/analytics-session.js';

/**
 * CI-enforced transfer-size gate for the session-events worker response
 * (issue #169): a 5k-event fixture must stay under a 20MB structured-clone
 * bound. `node:v8`'s `serialize` uses the same structured-clone algorithm
 * the browser's postMessage boundary uses, so its output size is a faithful
 * stand-in for what actually crosses the worker boundary.
 */
const FIXTURE_EVENT_COUNT = 5000;
const TRANSFER_SIZE_LIMIT_BYTES = 20 * 1024 * 1024;

const PORTFOLIO_ID = 'portfolio-transfer';
const SOURCE_ID = 'source-transfer';
const ENV_ID = 'env-transfer';
const PROJECT_ID = 'project-transfer';
const SESSION_ID = 'session-transfer';

async function seedLargeSession(): Promise<WasmSqliteExecutor> {
  const executor = await WasmSqliteExecutor.create();
  await executor.exec(FRESH_SCHEMA_SQL);
  await TenantStore.insert(executor, { id: 'tenant-transfer', name: 'T' });
  await PortfolioStore.insert(executor, {
    id: PORTFOLIO_ID,
    tenantId: 'tenant-transfer',
    name: 'P',
  });
  await IngestionSourceStore.insert(executor, {
    id: SOURCE_ID,
    portfolioId: PORTFOLIO_ID,
    nativeSourceId: 'src',
    displayName: 'Source',
    type: 'claude_code',
    authority: 'local',
  });
  await EnvironmentStore.insert(executor, PORTFOLIO_ID, {
    id: ENV_ID,
    ingestionSourceId: SOURCE_ID,
    nativeEnvironmentId: 'env-native',
  });
  await ProjectStore.insert(executor, { id: PROJECT_ID, portfolioId: PORTFOLIO_ID, name: 'p' });
  await SourceProjectStore.insert(executor, PORTFOLIO_ID, {
    projectId: PROJECT_ID,
    ingestionSourceId: SOURCE_ID,
    nativeProjectId: 'native-p',
  });
  await SessionStore.insert(executor, {
    id: SESSION_ID,
    projectId: PROJECT_ID,
    ingestionSourceId: SOURCE_ID,
    nativeSessionId: SESSION_ID,
    harness: 'claude-code',
    finality: 'final',
  });

  const analysisReleaseId = 'ar-transfer';
  await executor.exec(
    `INSERT INTO analysis_releases (
      id, ontology_version, metric_registry_version, statistical_policy_version,
      rollup_policy_version, mapping_version, created_at, is_default
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [analysisReleaseId, '1', '1', '1', '1', '1', 1, 0],
  );
  const generationId = 'gen-transfer';
  await executor.exec(
    `INSERT INTO transformation_generations (
      id, session_id, analysis_release_id, parser_version, transformer_version,
      ontology_version, metric_version, schema_version, status, source_availability, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [generationId, SESSION_ID, analysisReleaseId, '1', '1', '1', '1', '1', 'committed', 'local', 1],
  );

  const kinds = ['tool', 'skill', 'agent', 'sub_agent'] as const;
  for (let i = 0; i < FIXTURE_EVENT_COUNT; i++) {
    await InvocationStore.insert(executor, {
      sessionId: SESSION_ID,
      generationId,
      kind: kinds[i % kinds.length],
      startId: `start-${i}`,
      status: 'completed',
      latencyMs: 100 + i,
      rootSessionId: SESSION_ID,
      origin: 'root',
      createdAt: i,
    } as never);
  }
  return executor;
}

describe('session-events transfer size (issue #169, CI-enforced)', () => {
  it(`keeps the structured-clone size of a ${FIXTURE_EVENT_COUNT}-event session under ${TRANSFER_SIZE_LIMIT_BYTES} bytes`, async () => {
    const executor = await seedLargeSession();
    const view = createSessionEvidenceView(executor);
    const detail = await view.getSessionEvents(SESSION_ID);

    expect(detail.events).toHaveLength(FIXTURE_EVENT_COUNT);
    const cloneSize = serialize(detail).length;
    expect(cloneSize).toBeLessThanOrEqual(TRANSFER_SIZE_LIMIT_BYTES);
  }, 30000);
});
