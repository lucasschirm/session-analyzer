import { beforeAll, describe, expect, it } from 'vitest';
import { ComponentIdentityStore } from '../../src/component-ecosystem.js';
import { DimensionDomainStore } from '../../src/dimension-domains.js';
import {
  EnvironmentStore,
  IngestionSourceStore,
  PortfolioStore,
  ProjectStore,
  SourceProjectStore,
  TenantStore,
} from '../../src/identity.js';
import { FRESH_SCHEMA_SQL } from '../../src/schema.js';
import {
  PAYLOAD_TRUNCATION_BYTES,
  SessionEventsDetailStore,
} from '../../src/session-events-detail.js';
import {
  InvocationPayloadStore,
  InvocationStore,
  MessageStore,
  PayloadStore,
  SessionStore,
  TurnStore,
} from '../../src/session-evidence.js';
import { getSqlite3, WasmSqliteExecutor } from '../helpers/sqlite-wasm-adapter.js';

beforeAll(async () => {
  await getSqlite3();
});

interface SeedResult {
  executor: WasmSqliteExecutor;
  portfolioId: string;
  sessionId: string;
  generationId: string;
  agentComponentId: string;
}

async function createSeededExecutor(): Promise<SeedResult> {
  const executor = await WasmSqliteExecutor.create();
  await executor.exec(FRESH_SCHEMA_SQL);

  const tenantId = 'sed-tenant';
  const portfolioId = 'sed-portfolio';
  const ingestionSourceId = 'sed-ingestion';
  const environmentId = 'sed-environment';
  const projectId = 'sed-project';
  const sessionId = 'sed-session-1';

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
    name: 'sed-project',
    createdAt: 1,
    updatedAt: 1,
  });
  await SourceProjectStore.insert(executor, portfolioId, {
    projectId,
    ingestionSourceId,
    nativeProjectId: 'native-sed-project',
    createdAt: 1,
    updatedAt: 1,
  });

  const analysisReleaseId = 'sed-ar';
  await executor.exec(
    `INSERT INTO analysis_releases (
      id, ontology_version, metric_registry_version, statistical_policy_version,
      rollup_policy_version, mapping_version, created_at, is_default
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [analysisReleaseId, '1', '1', '1', '1', '1', 1, 0],
  );
  const generationId = 'sed-gen';
  await executor.exec(
    `INSERT INTO transformation_generations (
      id, session_id, analysis_release_id, parser_version, transformer_version,
      ontology_version, metric_version, schema_version, status, source_availability, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [generationId, sessionId, analysisReleaseId, '1', '1', '1', '1', '1', 'committed', 'local', 1],
  );

  await SessionStore.insert(executor, {
    id: sessionId,
    projectId,
    ingestionSourceId,
    environmentId,
    harness: 'claude-code',
    nativeSessionId: sessionId,
    currentGenerationId: generationId,
    occurrenceTime: null,
    finality: 'final',
    mode: null,
    taskCohort: null,
    startTime: null,
    endTime: null,
    aiTitle: null,
    slug: null,
    agentName: null,
    cwd: null,
    gitBranch: null,
    cliVersions: null,
    isSidechain: false,
    agentId: null,
    outcome: null,
  } as never);

  const agentComponentId = await ComponentIdentityStore.insert(executor, {
    portfolioId,
    kind: 'tool',
    canonicalSourceIdentity: 'Read',
    nativeId: 'Read',
    displayName: 'Read file',
    createdAt: 1,
    updatedAt: 1,
  } as never);

  return { executor, portfolioId, sessionId, generationId, agentComponentId };
}

describe('SessionEventsDetailStore', () => {
  it('returns an empty list for a session with no evidence (empty range)', async () => {
    const { executor, sessionId } = await createSeededExecutor();
    expect(await SessionEventsDetailStore.listInvocationEvents(executor, sessionId)).toEqual([]);
    expect(await SessionEventsDetailStore.listMessageEvents(executor, sessionId)).toEqual([]);
  });

  it('shapes invocation rows with component identity, status, latency and payloads', async () => {
    const { executor, sessionId, generationId, agentComponentId } = await createSeededExecutor();

    const payloadId = await PayloadStore.insert(executor, {
      sessionId,
      generationId,
      payloadType: 'input',
      exactTokens: 12,
      estimatedTokens: null,
      sizeBytes: 5,
      truncated: false,
      mediaCount: 0,
      structureCount: 1,
      rawContent: new TextEncoder().encode('hello'),
      retainRaw: true,
      createdAt: 1,
      updatedAt: 1,
    });

    const invocationId = await InvocationStore.insert(executor, {
      sessionId,
      generationId,
      kind: 'tool',
      componentId: agentComponentId,
      componentVersionId: null,
      startId: 'start-1',
      resultId: null,
      status: 'completed',
      latencyMs: 250,
      rootSessionId: sessionId,
      parentInvocationId: null,
      origin: 'root',
      createdAt: 5,
      updatedAt: 5,
    });

    await InvocationPayloadStore.insert(executor, {
      invocationId,
      payloadId,
      sessionId,
      generationId,
      attributionType: 'exact',
      isInput: true,
      isResult: false,
      isContext: false,
      attributionShare: null,
      createdAt: 1,
      updatedAt: 1,
    });

    const rows = await SessionEventsDetailStore.listInvocationEvents(executor, sessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: invocationId,
      kind: 'tool',
      status: 'completed',
      latencyMs: 250,
      componentKind: 'tool',
      nativeId: 'Read',
      // turnOrdering is always missing (null) for invocations today — see
      // the documented limitation in session-events-detail.ts.
      turnOrdering: null,
    });
    expect(rows[0].inputPayload).toMatchObject({
      payloadId,
      content: 'hello',
      exactTokens: 12,
      storedTruncated: false,
    });
    expect(rows[0].resultPayload).toBeNull();
  });

  it('never reports a missing latency as zero', async () => {
    const { executor, sessionId, generationId, agentComponentId } = await createSeededExecutor();
    await InvocationStore.insert(executor, {
      sessionId,
      generationId,
      kind: 'skill',
      componentId: agentComponentId,
      componentVersionId: null,
      startId: 's',
      resultId: null,
      status: 'started',
      latencyMs: null,
      rootSessionId: sessionId,
      parentInvocationId: null,
      origin: 'root',
      createdAt: 1,
      updatedAt: 1,
    });
    const rows = await SessionEventsDetailStore.listInvocationEvents(executor, sessionId);
    expect(rows[0].latencyMs).toBeNull();
    expect(rows[0].latencyMs).not.toBe(0);
  });

  it('shapes user/assistant message rows with a real turn ordering', async () => {
    const { executor, sessionId, generationId } = await createSeededExecutor();
    const turnId = await TurnStore.insert(executor, {
      sessionId,
      generationId,
      ordering: 3,
      role: 'human',
      sourceIdentityId: null,
      startTime: 10,
      endTime: 20,
      createdAt: 1,
      updatedAt: 1,
    });
    await MessageStore.insert(executor, {
      sessionId,
      generationId,
      turnId,
      parentMessageId: null,
      ordering: 1,
      role: 'user',
      messageType: 'text',
      sourceIdentityId: null,
      timestamp: 15,
      retainedContent: 'Hi',
      retainContent: true,
      createdAt: 1,
      updatedAt: 1,
    });

    const rows = await SessionEventsDetailStore.listMessageEvents(executor, sessionId);
    expect(rows).toEqual([
      expect.objectContaining({ role: 'user', timestamp: 15, turnOrdering: 3 }),
    ]);
  });

  it('caps payload content transferred inline and reports getPayloadContent for the full body', async () => {
    const { executor, sessionId, generationId } = await createSeededExecutor();
    const big = 'x'.repeat(PAYLOAD_TRUNCATION_BYTES + 500);
    const payloadId = await PayloadStore.insert(executor, {
      sessionId,
      generationId,
      payloadType: 'result',
      exactTokens: null,
      estimatedTokens: 900,
      sizeBytes: big.length,
      truncated: false,
      mediaCount: 0,
      structureCount: 1,
      rawContent: new TextEncoder().encode(big),
      retainRaw: true,
      createdAt: 1,
      updatedAt: 1,
    });

    const full = await SessionEventsDetailStore.getPayloadContent(executor, payloadId);
    expect(full?.content).toHaveLength(big.length);
    expect(full?.content?.length).toBeGreaterThan(PAYLOAD_TRUNCATION_BYTES);
  });

  it('returns null for an unknown payload id (missing, not an empty string)', async () => {
    const { executor } = await createSeededExecutor();
    expect(await SessionEventsDetailStore.getPayloadContent(executor, 'does-not-exist')).toBeNull();
  });
});

describe('DimensionDomainStore', () => {
  it('reports the seeded project and harness, and an empty model domain (not an error)', async () => {
    const { executor, portfolioId } = await createSeededExecutor();
    expect(await DimensionDomainStore.getProjectDomain(executor, portfolioId)).toEqual([
      'sed-project',
    ]);
    expect(await DimensionDomainStore.getHarnessDomain(executor, portfolioId)).toEqual([
      'claude-code',
    ]);
    expect(await DimensionDomainStore.getModelDomain(executor, portfolioId)).toEqual([]);
  });

  it('lists distinct harnesses observed across sessions', async () => {
    const { executor, portfolioId, sessionId } = await createSeededExecutor();
    await executor.exec('UPDATE sessions SET harness = ? WHERE id = ?', ['claude-code', sessionId]);
    expect(await DimensionDomainStore.getHarnessDomain(executor, portfolioId)).toEqual([
      'claude-code',
    ]);
  });
});
