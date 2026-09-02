import { beforeAll, describe, expect, it } from 'vitest';
import {
  EnvironmentStore,
  IngestionSourceStore,
  PortfolioStore,
  ProjectStore,
  SourceProjectStore,
  TenantStore,
} from '../../src/identity.js';
import { FRESH_SCHEMA_SQL } from '../../src/schema.js';
import { SessionStore } from '../../src/session-evidence.js';
import { TurnTimelineStore } from '../../src/turn-timeline.js';
import { getSqlite3, WasmSqliteExecutor } from '../helpers/sqlite-wasm-adapter.js';

beforeAll(async () => {
  await getSqlite3();
});

async function seed(): Promise<{ executor: WasmSqliteExecutor; projectId: string }> {
  const executor = await WasmSqliteExecutor.create();
  await executor.exec(FRESH_SCHEMA_SQL);
  const tenantId = 'tt-tenant';
  const portfolioId = 'tt-portfolio';
  const ingestionSourceId = 'tt-ingestion';
  const environmentId = 'tt-environment';
  const projectId = 'tt-project';

  await TenantStore.insert(executor, { id: tenantId, name: 'T', createdAt: 1, updatedAt: 1 });
  await PortfolioStore.insert(executor, {
    id: portfolioId,
    tenantId,
    name: 'P',
    createdAt: 1,
    updatedAt: 1,
  });
  await IngestionSourceStore.insert(executor, {
    id: ingestionSourceId,
    portfolioId,
    nativeSourceId: 'claude-local',
    displayName: 'Claude',
    type: 'claude_code',
    authority: 'local',
    createdAt: 1,
    updatedAt: 1,
  });
  await EnvironmentStore.insert(executor, portfolioId, {
    id: environmentId,
    ingestionSourceId,
    nativeEnvironmentId: 'env',
    createdAt: 1,
    updatedAt: 1,
  });
  await ProjectStore.insert(executor, {
    id: projectId,
    portfolioId,
    name: 'tt-project',
    createdAt: 1,
    updatedAt: 1,
  });
  await SourceProjectStore.insert(executor, portfolioId, {
    projectId,
    ingestionSourceId,
    nativeProjectId: 'native-tt-project',
    createdAt: 1,
    updatedAt: 1,
  });
  return { executor, projectId };
}

describe('TurnTimelineStore.getSessionWindow', () => {
  it('returns the session start/end bounds when both are recorded', async () => {
    const { executor, projectId } = await seed();
    await SessionStore.insert(executor, {
      id: 'tt-session-1',
      projectId,
      ingestionSourceId: 'tt-ingestion',
      environmentId: 'tt-environment',
      harness: 'claude-code',
      nativeSessionId: 'tt-session-1',
      finality: 'final',
      startTime: 100,
      endTime: 900,
    } as never);

    const window = await TurnTimelineStore.getSessionWindow(executor, 'tt-session-1');
    expect(window).toEqual({ startTime: 100, endTime: 900 });
  });

  it('reports a missing bound as null, never coerced to 0', async () => {
    const { executor, projectId } = await seed();
    await SessionStore.insert(executor, {
      id: 'tt-session-2',
      projectId,
      ingestionSourceId: 'tt-ingestion',
      environmentId: 'tt-environment',
      harness: 'claude-code',
      nativeSessionId: 'tt-session-2',
      finality: 'final',
      startTime: null,
      endTime: null,
    } as never);

    const window = await TurnTimelineStore.getSessionWindow(executor, 'tt-session-2');
    expect(window?.startTime).toBeNull();
    expect(window?.endTime).toBeNull();
    expect(window?.startTime).not.toBe(0);
  });

  it('returns null for an unknown session id (missing, not an empty object)', async () => {
    const { executor } = await seed();
    expect(await TurnTimelineStore.getSessionWindow(executor, 'does-not-exist')).toBeNull();
  });
});
