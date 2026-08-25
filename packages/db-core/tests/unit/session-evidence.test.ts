import { beforeAll, describe, expect, it } from 'vitest';
import { ComponentIdentityStore } from '../../src/component-ecosystem.js';
import {
  EnvironmentStore,
  IngestionSourceStore,
  PortfolioStore,
  ProjectStore,
  SourceProjectStore,
  TenantStore,
  WorkspaceStore,
} from '../../src/identity.js';
import { FRESH_SCHEMA_SQL } from '../../src/schema.js';
import {
  CommandExecutionStore,
  ComponentEvidenceLinkStore,
  FileOperationStore,
  INVOCATION_KINDS,
  type InsertSessionInput,
  type InvocationKind,
  InvocationStore,
  MessageStore,
  ModelCapabilityStore,
  ModelRequestStore,
  ModelUsageStore,
  NormalizedEventStore,
  PayloadStore,
  PermissionEventStore,
  PricingVersionStore,
  SessionRelationStore,
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
  projectId: string;
  ingestionSourceId: string;
  environmentId: string;
  workspaceId: string;
  agentComponentId: string;
  generationId: string;
}

async function createSeededExecutor(): Promise<SeedResult> {
  const executor = await WasmSqliteExecutor.create();
  await executor.exec(FRESH_SCHEMA_SQL);

  const tenantId = 'tenant-session';
  const portfolioId = 'portfolio-session';
  const ingestionSourceId = 'ingestion-session';
  const environmentId = 'environment-session';
  const projectId = 'project-session';
  const workspaceId = 'workspace-session';

  await TenantStore.insert(executor, {
    id: tenantId,
    name: 'Session Tenant',
    createdAt: 1,
    updatedAt: 1,
  });
  await PortfolioStore.insert(executor, {
    id: portfolioId,
    tenantId,
    name: 'Session Portfolio',
    createdAt: 1,
    updatedAt: 1,
  });
  await IngestionSourceStore.insert(executor, {
    id: ingestionSourceId,
    portfolioId,
    nativeSourceId: 'claude-local',
    displayName: 'Claude Local',
    type: 'claude_code',
    authority: 'local',
    createdAt: 1,
    updatedAt: 1,
  });
  await EnvironmentStore.insert(executor, portfolioId, {
    id: environmentId,
    ingestionSourceId,
    nativeEnvironmentId: 'env-session',
    createdAt: 1,
    updatedAt: 1,
  });
  await ProjectStore.insert(executor, {
    id: projectId,
    portfolioId,
    name: 'session-project',
    createdAt: 1,
    updatedAt: 1,
  });
  await SourceProjectStore.insert(executor, portfolioId, {
    projectId,
    ingestionSourceId,
    nativeProjectId: 'native-session-project',
    createdAt: 1,
    updatedAt: 1,
  });
  await WorkspaceStore.insert(executor, portfolioId, {
    id: workspaceId,
    projectId,
    nativeWorkspaceId: 'ws-session',
    createdAt: 1,
    updatedAt: 1,
  });

  const agentComponentId = await ComponentIdentityStore.insert(executor, {
    portfolioId,
    kind: 'agent',
    canonicalSourceIdentity: 'agent-1',
    displayName: 'Test Agent',
    createdAt: 1,
    updatedAt: 1,
  });

  const analysisReleaseId = 'ar-session';
  await executor.exec(
    `INSERT INTO analysis_releases (
      id, ontology_version, metric_registry_version, statistical_policy_version,
      rollup_policy_version, mapping_version, created_at, is_default
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [analysisReleaseId, '1', '1', '1', '1', '1', 1, 0],
  );

  const sessionInput: InsertSessionInput = {
    id: 'session-1',
    projectId,
    ingestionSourceId,
    environmentId,
    harness: 'claude_code',
    nativeSessionId: 'native-session-1',
    currentGenerationId: null,
    occurrenceTime: 1,
    finality: 'open',
    mode: null,
    taskCohort: null,
    startTime: 1,
    endTime: null,
    aiTitle: null,
    slug: null,
    agentName: null,
    cwd: null,
    gitBranch: null,
    cliVersions: null,
    isSidechain: false,
    agentId: null,
    createdAt: 1,
    updatedAt: 1,
  };
  await SessionStore.insert(executor, sessionInput);

  const generationId = 'gen-session-1';
  await executor.exec(
    `INSERT INTO transformation_generations (
      id, session_id, analysis_release_id, parser_version, transformer_version,
      ontology_version, metric_version, schema_version, status,
      source_availability, created_at, committed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      generationId,
      'session-1',
      analysisReleaseId,
      'p1',
      't1',
      'o1',
      'm1',
      's1',
      'committed',
      'local',
      1,
      1,
    ],
  );
  await SessionStore.update(executor, projectId, 'session-1', {
    currentGenerationId: generationId,
  });

  return {
    executor,
    portfolioId,
    projectId,
    ingestionSourceId,
    environmentId,
    workspaceId,
    agentComponentId,
    generationId,
  };
}

describe('session evidence schema and stores', () => {
  it('creates all session evidence tables', async () => {
    const { executor } = await createSeededExecutor();
    const { rows } = await executor.exec(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    );
    const names = rows.map((row) => String(row.name));

    expect(names).toContain('sessions');
    expect(names).toContain('session_relations');
    expect(names).toContain('turns');
    expect(names).toContain('messages');
    expect(names).toContain('model_requests');
    expect(names).toContain('model_usage');
    expect(names).toContain('model_capabilities');
    expect(names).toContain('pricing_versions');
    expect(names).toContain('invocations');
    expect(names).toContain('payloads');
    expect(names).toContain('invocation_payloads');
    expect(names).toContain('permission_events');
    expect(names).toContain('mode_events');
    expect(names).toContain('hook_executions');
    expect(names).toContain('normalized_events');
    expect(names).toContain('tasks');
    expect(names).toContain('task_events');
    expect(names).toContain('validations');
    expect(names).toContain('file_operations');
    expect(names).toContain('command_executions');
    expect(names).toContain('component_evidence_links');
  });

  it('extends sessions with evidence columns and agent_id foreign key', async () => {
    const { executor } = await createSeededExecutor();
    const { rows } = await executor.exec('PRAGMA table_info(sessions)');
    const columns = new Set(rows.map((row) => String(row.name)));
    expect(columns).toContain('start_time');
    expect(columns).toContain('end_time');
    expect(columns).toContain('ai_title');
    expect(columns).toContain('slug');
    expect(columns).toContain('agent_name');
    expect(columns).toContain('cwd');
    expect(columns).toContain('git_branch');
    expect(columns).toContain('cli_versions');
    expect(columns).toContain('is_sidechain');
    expect(columns).toContain('agent_id');
  });

  describe('SessionStore', () => {
    it('performs a full round trip scoped by project', async () => {
      const { executor, projectId, agentComponentId, generationId } = await createSeededExecutor();

      const inserted = await SessionStore.getById(executor, projectId, 'session-1');
      expect(inserted).toEqual(
        expect.objectContaining({
          id: 'session-1',
          projectId,
          harness: 'claude_code',
          isSidechain: false,
          currentGenerationId: generationId,
        }),
      );

      await SessionStore.update(executor, projectId, 'session-1', {
        aiTitle: 'Test Session',
        agentId: agentComponentId,
        isSidechain: true,
        endTime: 2,
      });

      const updated = await SessionStore.getById(executor, projectId, 'session-1');
      expect(updated?.aiTitle).toBe('Test Session');
      expect(updated?.agentId).toBe(agentComponentId);
      expect(updated?.isSidechain).toBe(true);
      expect(updated?.endTime).toBe(2);

      const all = await SessionStore.listByProject(executor, projectId);
      expect(all).toHaveLength(1);
      expect(all[0].id).toBe('session-1');

      await SessionStore.delete(executor, projectId, 'session-1');
      expect(await SessionStore.getById(executor, projectId, 'session-1')).toBeUndefined();
    });
  });

  describe('turns and messages', () => {
    it('performs round trips and enforces turn/message ordering and parent relationship', async () => {
      const { executor, generationId, agentComponentId } = await createSeededExecutor();

      const turnId = await TurnStore.insert(executor, {
        sessionId: 'session-1',
        generationId,
        ordering: 1,
        role: 'human',
        sourceIdentityId: agentComponentId,
        startTime: 1,
        endTime: 2,
        createdAt: 1,
        updatedAt: 1,
      });

      const turn = await TurnStore.getById(executor, 'session-1', turnId);
      expect(turn).toEqual(
        expect.objectContaining({
          sessionId: 'session-1',
          role: 'human',
          ordering: 1,
        }),
      );

      const messageId = await MessageStore.insert(executor, {
        sessionId: 'session-1',
        generationId,
        turnId,
        parentMessageId: null,
        ordering: 1,
        role: 'user',
        messageType: 'text',
        sourceIdentityId: null,
        timestamp: 1,
        retainedContent: 'Hello',
        retainContent: true,
        createdAt: 1,
        updatedAt: 1,
      });

      const message = await MessageStore.getById(executor, 'session-1', messageId);
      expect(message).toEqual(
        expect.objectContaining({
          turnId,
          role: 'user',
          retainedContent: 'Hello',
          retainContent: true,
        }),
      );

      const turns = await TurnStore.listBySession(executor, 'session-1');
      expect(turns).toHaveLength(1);
      const messages = await MessageStore.listBySession(executor, 'session-1');
      expect(messages).toHaveLength(1);

      await expect(
        MessageStore.insert(executor, {
          sessionId: 'session-1',
          generationId,
          turnId: 'turn-does-not-exist',
          parentMessageId: null,
          ordering: 2,
          role: 'assistant',
          messageType: 'text',
          sourceIdentityId: null,
          timestamp: 2,
          retainedContent: null,
          retainContent: false,
          createdAt: 1,
          updatedAt: 1,
        }),
      ).rejects.toThrow();

      await TurnStore.delete(executor, 'session-1', turnId);
      expect(await MessageStore.getById(executor, 'session-1', messageId)).toBeUndefined();
    });

    it('rejects retained content without the retain flag', async () => {
      const { executor, generationId } = await createSeededExecutor();
      const turnId = await TurnStore.insert(executor, {
        sessionId: 'session-1',
        generationId,
        ordering: 1,
        role: 'human',
        sourceIdentityId: null,
        startTime: 1,
        endTime: 2,
        createdAt: 1,
        updatedAt: 1,
      });

      await expect(
        MessageStore.insert(executor, {
          sessionId: 'session-1',
          generationId,
          turnId,
          parentMessageId: null,
          ordering: 1,
          role: 'user',
          messageType: 'text',
          sourceIdentityId: null,
          timestamp: 1,
          retainedContent: 'secret',
          retainContent: false,
          createdAt: 1,
          updatedAt: 1,
        }),
      ).rejects.toThrow();
    });
  });

  describe('model requests and usage', () => {
    it('performs round trips and correlates model usage to requests', async () => {
      const { executor, generationId } = await createSeededExecutor();

      const capabilityId = await ModelCapabilityStore.insert(executor, {
        model: 'claude-3-5-sonnet',
        provider: 'anthropic',
        version: '20241022',
        contextLimitTokens: 200_000,
        maxOutputTokens: 8_192,
        providerMetadata: null,
        generationId,
        createdAt: 1,
        updatedAt: 1,
      });

      const pricingId = await PricingVersionStore.insert(executor, {
        provider: 'anthropic',
        model: 'claude-3-5-sonnet',
        currency: 'USD',
        effectiveDate: '2024-10-22',
        inputPricePerToken: 0.000_003,
        outputPricePerToken: 0.000_015,
        cacheCreationPricePerToken: null,
        cacheReadPricePerToken: null,
        generationId,
        createdAt: 1,
        updatedAt: 1,
      });

      const requestId = await ModelRequestStore.insert(executor, {
        sessionId: 'session-1',
        generationId,
        requestOrder: 1,
        model: 'claude-3-5-sonnet',
        provider: 'anthropic',
        contextVolumeTokens: 1_000,
        inputTokens: 500,
        outputTokens: 200,
        startTime: 1,
        endTime: 2,
        correlationId: 'corr-1',
        parentRequestId: null,
        modelCapabilityId: capabilityId,
        status: 'success',
        createdAt: 1,
        updatedAt: 1,
      });

      const request = await ModelRequestStore.getById(executor, 'session-1', requestId);
      expect(request?.modelCapabilityId).toBe(capabilityId);

      await ModelUsageStore.insert(executor, {
        sessionId: 'session-1',
        requestId,
        generationId,
        tokenClass: 'output',
        tokenCount: 200,
        isEstimated: false,
        cost: 0.003,
        pricingVersionId: pricingId,
        createdAt: 1,
        updatedAt: 1,
      });

      const usage = (await ModelUsageStore.listBySession(executor, 'session-1'))[0];
      expect(usage.requestId).toBe(requestId);
      expect(usage.pricingVersionId).toBe(pricingId);
      expect(usage.isEstimated).toBe(false);

      await ModelRequestStore.delete(executor, 'session-1', requestId);
      expect(await ModelUsageStore.listBySession(executor, 'session-1')).toHaveLength(0);
    });
  });

  describe('invocations', () => {
    it('keeps tool, skill, agent and sub_agent distinct and rejects other kinds', async () => {
      const { executor, generationId, agentComponentId } = await createSeededExecutor();

      const kinds: InvocationKind[] = ['tool', 'skill', 'agent', 'sub_agent'];
      for (const [index, kind] of kinds.entries()) {
        const id = await InvocationStore.insert(executor, {
          sessionId: 'session-1',
          generationId,
          kind,
          componentId: agentComponentId,
          componentVersionId: null,
          startId: `start-${index}`,
          resultId: `result-${index}`,
          status: 'completed',
          latencyMs: 100,
          rootSessionId: 'session-1',
          parentInvocationId: null,
          origin: 'root',
          createdAt: 1,
          updatedAt: 1,
        });

        const invocation = await InvocationStore.getById(executor, 'session-1', id);
        expect(invocation?.kind).toBe(kind);
      }

      expect(() =>
        executor.exec(
          `INSERT INTO invocations (
            id, session_id, generation_id, kind, component_id,
            start_id, result_id, status, latency_ms, root_session_id,
            parent_invocation_id, origin, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            'inv-bad',
            'session-1',
            generationId,
            'function',
            agentComponentId,
            's',
            'r',
            'completed',
            0,
            'session-1',
            null,
            'root',
            1,
            1,
          ],
        ),
      ).toThrow();

      const byKind = await InvocationStore.listBySession(executor, 'session-1');
      expect(byKind).toHaveLength(4);
      expect(new Set(byKind.map((i) => i.kind))).toEqual(new Set(INVOCATION_KINDS));
    });
  });

  describe('payloads', () => {
    it('retains raw content only when the retain flag is set', async () => {
      const { executor, generationId } = await createSeededExecutor();
      const raw = new TextEncoder().encode('raw payload bytes');

      const id = await PayloadStore.insert(executor, {
        sessionId: 'session-1',
        generationId,
        payloadType: 'input',
        exactTokens: 10,
        estimatedTokens: null,
        sizeBytes: raw.length,
        truncated: false,
        mediaCount: 0,
        structureCount: 1,
        rawContent: raw,
        retainRaw: true,
        createdAt: 1,
        updatedAt: 1,
      });

      const payload = await PayloadStore.getById(executor, 'session-1', id);
      expect(payload?.exactTokens).toBe(10);
      expect(payload?.retainRaw).toBe(true);
      expect(payload?.rawContent).toBeInstanceOf(Uint8Array);
      expect(new TextDecoder().decode(payload?.rawContent as Uint8Array)).toBe('raw payload bytes');

      await expect(
        PayloadStore.insert(executor, {
          sessionId: 'session-1',
          generationId,
          payloadType: 'result',
          exactTokens: 5,
          estimatedTokens: null,
          sizeBytes: 100,
          truncated: false,
          mediaCount: 0,
          structureCount: 0,
          rawContent: raw,
          retainRaw: false,
          createdAt: 1,
          updatedAt: 1,
        }),
      ).rejects.toThrow();
    });
  });

  describe('permission events and file operations', () => {
    it('enforces privacy checks and cascades deletes from sessions', async () => {
      const { executor, generationId, projectId } = await createSeededExecutor();

      await expect(
        PermissionEventStore.insert(executor, {
          sessionId: 'session-1',
          generationId,
          promptText: 'Allow file access?',
          retainPrompt: false,
          decision: 'approved',
          mode: 'normal',
          waitIntervalMs: 100,
          createdAt: 1,
          updatedAt: 1,
        }),
      ).rejects.toThrow();

      const permissionId = await PermissionEventStore.insert(executor, {
        sessionId: 'session-1',
        generationId,
        promptText: 'Allow file access?',
        retainPrompt: true,
        decision: 'approved',
        mode: 'normal',
        waitIntervalMs: 100,
        createdAt: 1,
        updatedAt: 1,
      });

      const fileId = await FileOperationStore.insert(executor, {
        sessionId: 'session-1',
        generationId,
        operation: 'read',
        normalizedPath: '/safe/path',
        pathCategory: 'source',
        rawPath: '/home/user/secret',
        retainRaw: true,
        status: 'completed',
        startTime: 1,
        endTime: 2,
        createdAt: 1,
        updatedAt: 1,
      });

      expect(
        (await PermissionEventStore.getById(executor, 'session-1', permissionId))?.promptText,
      ).toBe('Allow file access?');
      const file = await FileOperationStore.getById(executor, 'session-1', fileId);
      expect(file?.rawPath).toBe('/home/user/secret');
      expect(file?.operation).toBe('read');

      await SessionStore.delete(executor, projectId, 'session-1');
      expect(
        await PermissionEventStore.getById(executor, 'session-1', permissionId),
      ).toBeUndefined();
      expect(await FileOperationStore.getById(executor, 'session-1', fileId)).toBeUndefined();
    });
  });

  describe('command executions and normalized events', () => {
    it('retains raw command and raw details only with the retain flag', async () => {
      const { executor, generationId } = await createSeededExecutor();

      await expect(
        CommandExecutionStore.insert(executor, {
          sessionId: 'session-1',
          generationId,
          commandCategory: 'git',
          rawCommand: 'git push origin main',
          retainRaw: false,
          exitCode: 0,
          signal: null,
          status: 'completed',
          startTime: 1,
          endTime: 2,
          createdAt: 1,
          updatedAt: 1,
        }),
      ).rejects.toThrow();

      const commandId = await CommandExecutionStore.insert(executor, {
        sessionId: 'session-1',
        generationId,
        commandCategory: 'git',
        rawCommand: 'git push origin main',
        retainRaw: true,
        exitCode: 0,
        signal: null,
        status: 'completed',
        startTime: 1,
        endTime: 2,
        createdAt: 1,
        updatedAt: 1,
      });

      const command = await CommandExecutionStore.getById(executor, 'session-1', commandId);
      expect(command?.rawCommand).toBe('git push origin main');

      await expect(
        NormalizedEventStore.insert(executor, {
          sessionId: 'session-1',
          generationId,
          eventType: 'cache',
          eventVersion: 1,
          rawDetails: '{"secret":"value"}',
          retainRaw: false,
          createdAt: 1,
          updatedAt: 1,
        }),
      ).rejects.toThrow();

      const eventId = await NormalizedEventStore.insert(executor, {
        sessionId: 'session-1',
        generationId,
        eventType: 'cache',
        eventVersion: 1,
        rawDetails: '{"ok":true}',
        retainRaw: true,
        createdAt: 1,
        updatedAt: 1,
      });

      const event = await NormalizedEventStore.getById(executor, 'session-1', eventId);
      expect(event?.rawDetails).toBe('{"ok":true}');
    });
  });

  describe('component evidence links', () => {
    it('connects a component to multiple evidence grains with exactly-one enforcement', async () => {
      const { executor, generationId, agentComponentId } = await createSeededExecutor();

      const turnId = await TurnStore.insert(executor, {
        sessionId: 'session-1',
        generationId,
        ordering: 1,
        role: 'human',
        sourceIdentityId: null,
        startTime: 1,
        endTime: 2,
        createdAt: 1,
        updatedAt: 1,
      });

      const messageId = await MessageStore.insert(executor, {
        sessionId: 'session-1',
        generationId,
        turnId,
        parentMessageId: null,
        ordering: 1,
        role: 'user',
        messageType: 'text',
        sourceIdentityId: null,
        timestamp: 1,
        retainedContent: null,
        retainContent: false,
        createdAt: 1,
        updatedAt: 1,
      });

      const turnLink = await ComponentEvidenceLinkStore.insert(executor, {
        componentId: agentComponentId,
        sessionId: 'session-1',
        generationId,
        evidenceType: 'turn',
        linkType: 'primary',
        turnId,
        messageId: null,
        invocationId: null,
        payloadId: null,
        taskId: null,
        validationId: null,
        fileOperationId: null,
        commandExecutionId: null,
        createdAt: 1,
        updatedAt: 1,
      });

      const messageLink = await ComponentEvidenceLinkStore.insert(executor, {
        componentId: agentComponentId,
        sessionId: 'session-1',
        generationId,
        evidenceType: 'message',
        linkType: 'supporting',
        turnId: null,
        messageId,
        invocationId: null,
        payloadId: null,
        taskId: null,
        validationId: null,
        fileOperationId: null,
        commandExecutionId: null,
        createdAt: 1,
        updatedAt: 1,
      });

      const byComponent = await ComponentEvidenceLinkStore.listByComponent(
        executor,
        agentComponentId,
      );
      expect(byComponent).toHaveLength(2);
      expect(byComponent.map((l) => l.evidenceType).sort()).toEqual(['message', 'turn']);

      const bySession = await ComponentEvidenceLinkStore.listBySession(executor, 'session-1');
      expect(bySession).toHaveLength(2);
      expect(bySession.map((l) => l.id).sort()).toEqual([turnLink, messageLink].sort());

      await expect(
        ComponentEvidenceLinkStore.insert(executor, {
          componentId: agentComponentId,
          sessionId: 'session-1',
          generationId,
          evidenceType: 'turn',
          linkType: 'primary',
          turnId: null,
          messageId,
          invocationId: null,
          payloadId: null,
          taskId: null,
          validationId: null,
          fileOperationId: null,
          commandExecutionId: null,
          createdAt: 1,
          updatedAt: 1,
        }),
      ).rejects.toThrow();
    });
  });

  describe('session_relations', () => {
    it('records parent/root relation and cascades from sessions', async () => {
      const { executor, projectId, generationId } = await createSeededExecutor();

      const childInput: InsertSessionInput = {
        id: 'session-child',
        projectId,
        ingestionSourceId: 'ingestion-session',
        environmentId: 'environment-session',
        harness: 'claude_code',
        nativeSessionId: 'native-child',
        currentGenerationId: null,
        occurrenceTime: 1,
        finality: 'open',
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
        createdAt: 1,
        updatedAt: 1,
      };
      await SessionStore.insert(executor, childInput);

      const relationId = await SessionRelationStore.insert(executor, {
        sessionId: 'session-child',
        parentSessionId: 'session-1',
        rootSessionId: 'session-1',
        spawnInvocationId: null,
        depth: 1,
        inclusionSemantics: 'native',
        generationId,
        createdAt: 1,
        updatedAt: 1,
      });

      const relation = await SessionRelationStore.getById(executor, 'session-child', relationId);
      expect(relation?.parentSessionId).toBe('session-1');
      expect(relation?.depth).toBe(1);

      await SessionStore.delete(executor, projectId, 'session-child');
      expect(
        await SessionRelationStore.getById(executor, 'session-child', relationId),
      ).toBeUndefined();
    });
  });
});
