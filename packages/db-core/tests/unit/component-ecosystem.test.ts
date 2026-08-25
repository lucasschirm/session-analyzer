import { beforeAll, describe, expect, it } from 'vitest';
import {
  COMPONENT_ECOSYSTEM_DDL,
  COMPONENT_ECOSYSTEM_MIGRATIONS_FRAGMENT,
  ComponentAliasStore,
  ComponentAvailabilityEventStore,
  ComponentContextEventStore,
  ComponentIdentityStore,
  ComponentInstallationStore,
  ComponentLifecycleEventStore,
  ComponentRelationshipStore,
  ComponentVersionStore,
  ConfigurationSnapshotStore,
  SessionComponentExposureStore,
  SnapshotCompletenessStore,
  SnapshotComponentStore,
} from '../../src/component-ecosystem.js';
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
import { getSqlite3, WasmSqliteExecutor } from '../helpers/sqlite-wasm-adapter.js';

beforeAll(async () => {
  await getSqlite3();
});

async function createEcosystemExecutor(): Promise<WasmSqliteExecutor> {
  const executor = await WasmSqliteExecutor.create();
  await executor.exec(FRESH_SCHEMA_SQL);
  await executor.exec(COMPONENT_ECOSYSTEM_DDL);
  return executor;
}

interface SeedResult {
  executor: WasmSqliteExecutor;
  tenantId: string;
  portfolioId: string;
  ingestionSourceId: string;
  environmentId: string;
  projectId: string;
  sourceProjectId: string;
  workspaceId: string;
  sessionId: string;
}

async function seedIdentityAndSession(): Promise<SeedResult> {
  const executor = await createEcosystemExecutor();
  const tenantId = 'tenant-eco';
  const portfolioId = 'portfolio-eco';
  const ingestionSourceId = 'ingestion-eco';
  const environmentId = 'environment-eco';
  const projectId = 'project-eco';
  const sourceProjectId = 'source-project-eco';
  const workspaceId = 'workspace-eco';
  const sessionId = 'session-eco';

  await TenantStore.insert(executor, {
    id: tenantId,
    name: 'Eco Tenant',
    createdAt: 1,
    updatedAt: 1,
  });

  await PortfolioStore.insert(executor, {
    id: portfolioId,
    tenantId,
    name: 'Eco Portfolio',
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
    supportsCursor: true,
    supportsCheckpoint: false,
    createdAt: 1,
    updatedAt: 1,
  });

  await EnvironmentStore.insert(executor, portfolioId, {
    id: environmentId,
    ingestionSourceId,
    nativeEnvironmentId: 'env-1',
    createdAt: 1,
    updatedAt: 1,
  });

  await ProjectStore.insert(executor, {
    id: projectId,
    portfolioId,
    name: 'eco-project',
    createdAt: 1,
    updatedAt: 1,
  });

  await SourceProjectStore.insert(executor, portfolioId, {
    id: sourceProjectId,
    projectId,
    ingestionSourceId,
    nativeProjectId: 'native-eco',
    createdAt: 1,
    updatedAt: 1,
  });

  await WorkspaceStore.insert(executor, portfolioId, {
    id: workspaceId,
    projectId,
    nativeWorkspaceId: 'ws-1',
    scopeChain: JSON.stringify(['/home/user/eco']),
    path: '/home/user/eco',
    createdAt: 1,
    updatedAt: 1,
  });

  await executor.exec(
    `INSERT INTO sessions (
      id, project_id, ingestion_source_id, environment_id, harness,
      native_session_id, finality, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      sessionId,
      projectId,
      ingestionSourceId,
      environmentId,
      'claude',
      'native-session-1',
      'open',
      1,
      1,
    ],
  );

  return {
    executor,
    tenantId,
    portfolioId,
    ingestionSourceId,
    environmentId,
    projectId,
    sourceProjectId,
    workspaceId,
    sessionId,
  };
}

async function seedSecondEnvironment(
  executor: WasmSqliteExecutor,
  portfolioId: string,
  ingestionSourceId: string,
): Promise<string> {
  const environmentId = 'environment-eco-2';
  await EnvironmentStore.insert(executor, portfolioId, {
    id: environmentId,
    ingestionSourceId,
    nativeEnvironmentId: 'env-2',
    createdAt: 1,
    updatedAt: 1,
  });
  return environmentId;
}

describe('component ecosystem schema and stores', () => {
  it('creates all twelve component ecosystem tables', async () => {
    const executor = await createEcosystemExecutor();
    const { rows } = await executor.exec(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    );
    const names = rows.map((row) => row.name);

    expect(names).toContain('component_identities');
    expect(names).toContain('component_aliases');
    expect(names).toContain('component_versions');
    expect(names).toContain('component_relationships');
    expect(names).toContain('component_installations');
    expect(names).toContain('configuration_snapshots');
    expect(names).toContain('snapshot_completeness');
    expect(names).toContain('snapshot_components');
    expect(names).toContain('component_lifecycle_events');
    expect(names).toContain('component_availability_events');
    expect(names).toContain('component_context_events');
    expect(names).toContain('session_component_exposures');
  });

  it('exports a checksummed migration fragment starting at id 23', () => {
    expect(COMPONENT_ECOSYSTEM_MIGRATIONS_FRAGMENT).toHaveLength(12);
    for (let i = 0; i < COMPONENT_ECOSYSTEM_MIGRATIONS_FRAGMENT.length; i++) {
      const migration = COMPONENT_ECOSYSTEM_MIGRATIONS_FRAGMENT[i];
      expect(migration.id).toBe(23 + i);
      expect(migration.name).toMatch(/^create-/);
      expect(migration.checksum).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  describe('ComponentIdentityStore', () => {
    it('performs a full round trip and scopes by portfolio', async () => {
      const { executor, portfolioId } = await seedIdentityAndSession();

      const id = await ComponentIdentityStore.insert(executor, {
        portfolioId,
        kind: 'tool',
        owner: 'anthropic',
        integration: 'claude_code',
        nativeId: 'tool-1',
        canonicalSourceIdentity: 'claude://tools/tool-1',
        displayName: 'My Tool',
        safeMetadata: JSON.stringify({ path: '.claude/tools/tool-1' }),
        createdAt: 1,
        updatedAt: 1,
      });

      const byId = await ComponentIdentityStore.getById(executor, portfolioId, id);
      expect(byId).toEqual(
        expect.objectContaining({
          id,
          portfolioId,
          kind: 'tool',
          owner: 'anthropic',
          integration: 'claude_code',
          nativeId: 'tool-1',
          canonicalSourceIdentity: 'claude://tools/tool-1',
          displayName: 'My Tool',
        }),
      );

      const byUnique = await ComponentIdentityStore.getByUniqueIdentity(executor, portfolioId, {
        kind: 'tool',
        owner: 'anthropic',
        integration: 'claude_code',
        nativeId: 'tool-1',
        canonicalSourceIdentity: 'claude://tools/tool-1',
      });
      expect(byUnique?.id).toBe(id);

      const all = await ComponentIdentityStore.listByPortfolio(executor, portfolioId);
      expect(all).toHaveLength(1);

      await ComponentIdentityStore.update(executor, portfolioId, id, {
        displayName: 'My Renamed Tool',
        updatedAt: 2,
      });
      const updated = await ComponentIdentityStore.getById(executor, portfolioId, id);
      expect(updated?.displayName).toBe('My Renamed Tool');
      expect(updated?.updatedAt).toBe(2);

      await ComponentIdentityStore.delete(executor, portfolioId, id);
      expect(await ComponentIdentityStore.getById(executor, portfolioId, id)).toBeUndefined();
    });

    it('enforces identity uniqueness on kind/owner/integration/native-id/canonical-source, not display name', async () => {
      const { executor, portfolioId } = await seedIdentityAndSession();

      const id1 = await ComponentIdentityStore.insert(executor, {
        portfolioId,
        kind: 'tool',
        owner: 'anthropic',
        integration: 'claude_code',
        nativeId: 'tool-1',
        canonicalSourceIdentity: 'claude://tools/tool-1',
        displayName: 'Shared Name',
        createdAt: 1,
        updatedAt: 1,
      });

      const id2 = await ComponentIdentityStore.insert(executor, {
        portfolioId,
        kind: 'tool',
        owner: 'anthropic',
        integration: 'claude_code',
        nativeId: 'tool-1',
        canonicalSourceIdentity: 'opencode://tools/tool-1',
        displayName: 'Shared Name',
        createdAt: 1,
        updatedAt: 1,
      });

      expect(id1).not.toBe(id2);
      expect(await ComponentIdentityStore.listByPortfolio(executor, portfolioId)).toHaveLength(2);

      await expect(
        ComponentIdentityStore.insert(executor, {
          portfolioId,
          kind: 'tool',
          owner: 'anthropic',
          integration: 'claude_code',
          nativeId: 'tool-1',
          canonicalSourceIdentity: 'claude://tools/tool-1',
          displayName: 'Different Display Name',
          createdAt: 1,
          updatedAt: 1,
        }),
      ).rejects.toThrow();
    });
  });

  describe('ComponentAliasStore', () => {
    it('stores alias edges with source and confidence and resolves them', async () => {
      const { executor, portfolioId } = await seedIdentityAndSession();

      const claudeId = await ComponentIdentityStore.insert(executor, {
        portfolioId,
        kind: 'tool',
        owner: 'anthropic',
        integration: 'claude_code',
        nativeId: 'tool-1',
        canonicalSourceIdentity: 'claude://tools/tool-1',
        displayName: 'Tool One',
        createdAt: 1,
        updatedAt: 1,
      });

      const openCodeId = await ComponentIdentityStore.insert(executor, {
        portfolioId,
        kind: 'tool',
        owner: 'opencode',
        integration: 'opencode',
        nativeId: 'tool-1',
        canonicalSourceIdentity: 'opencode://tools/tool-1',
        displayName: 'Tool One',
        createdAt: 1,
        updatedAt: 1,
      });

      const aliasId = await ComponentAliasStore.insert(executor, {
        portfolioId,
        sourceComponentId: claudeId,
        targetComponentId: openCodeId,
        source: 'manual-mapping-v1',
        confidence: 0.95,
        reason: 'same display name, verified by native id',
        createdAt: 1,
      });

      const byId = await ComponentAliasStore.getById(executor, portfolioId, aliasId);
      expect(byId).toEqual(
        expect.objectContaining({
          id: aliasId,
          sourceComponentId: claudeId,
          targetComponentId: openCodeId,
          source: 'manual-mapping-v1',
          confidence: 0.95,
          reason: 'same display name, verified by native id',
        }),
      );

      const fromSource = await ComponentAliasStore.listBySource(executor, portfolioId, claudeId);
      expect(fromSource).toHaveLength(1);
      expect(fromSource[0].targetComponentId).toBe(openCodeId);

      const fromTarget = await ComponentAliasStore.listByTarget(executor, portfolioId, openCodeId);
      expect(fromTarget).toHaveLength(1);
      expect(fromTarget[0].sourceComponentId).toBe(claudeId);

      const resolved = await ComponentAliasStore.resolveAliases(executor, portfolioId, claudeId, 3);
      expect(resolved).toContain(openCodeId);
    });

    it('keeps same-name cross-harness components separate when no alias exists', async () => {
      const { executor, portfolioId } = await seedIdentityAndSession();

      const claudeId = await ComponentIdentityStore.insert(executor, {
        portfolioId,
        kind: 'tool',
        owner: 'anthropic',
        integration: 'claude_code',
        nativeId: 'tool-1',
        canonicalSourceIdentity: 'claude://tools/tool-1',
        displayName: 'Tool One',
        createdAt: 1,
        updatedAt: 1,
      });

      const openCodeId = await ComponentIdentityStore.insert(executor, {
        portfolioId,
        kind: 'tool',
        owner: 'opencode',
        integration: 'opencode',
        nativeId: 'tool-1',
        canonicalSourceIdentity: 'opencode://tools/tool-1',
        displayName: 'Tool One',
        createdAt: 1,
        updatedAt: 1,
      });

      const resolved = await ComponentAliasStore.resolveAliases(executor, portfolioId, claudeId, 3);
      expect(resolved).toHaveLength(0);

      const aliases = await ComponentAliasStore.listBySource(executor, portfolioId, claudeId);
      expect(aliases).toHaveLength(0);

      expect(claudeId).not.toBe(openCodeId);
    });
  });

  describe('ComponentVersionStore and SnapshotComponentStore', () => {
    it('performs round trips with source pointers', async () => {
      const { executor, portfolioId } = await seedIdentityAndSession();

      const componentId = await ComponentIdentityStore.insert(executor, {
        portfolioId,
        kind: 'tool',
        owner: 'anthropic',
        integration: 'claude_code',
        nativeId: 'tool-1',
        canonicalSourceIdentity: 'claude://tools/tool-1',
        displayName: 'Tool One',
        createdAt: 1,
        updatedAt: 1,
      });

      const versionId = await ComponentVersionStore.insert(executor, {
        componentId,
        contentHash: 'sha256-content',
        configHash: 'sha256-config',
        schemaHash: 'sha256-schema',
        sourcePointer: '.claude/tools/tool-1#/def',
        createdAt: 1,
      });

      const version = await ComponentVersionStore.getById(executor, componentId, versionId);
      expect(version).toEqual(
        expect.objectContaining({
          id: versionId,
          componentId,
          contentHash: 'sha256-content',
          sourcePointer: '.claude/tools/tool-1#/def',
        }),
      );

      const snapshotId = await ConfigurationSnapshotStore.insert(executor, {
        environmentId: 'environment-eco',
        ordering: 1,
        captureTime: 1,
        ingestionTime: 1,
        harness: 'claude',
        temporalRole: 'pre_session',
        createdAt: 1,
      });

      const snapshotComponentId = await SnapshotComponentStore.insert(executor, {
        snapshotId,
        componentVersionId: versionId,
        sourceScope: 'workspace',
        sourcePointer: '.claude/tools/tool-1#/def',
        createdAt: 1,
      });

      const snapshotComponent = await SnapshotComponentStore.getById(
        executor,
        snapshotId,
        snapshotComponentId,
      );
      expect(snapshotComponent).toEqual(
        expect.objectContaining({
          id: snapshotComponentId,
          snapshotId,
          componentVersionId: versionId,
          sourceScope: 'workspace',
          sourcePointer: '.claude/tools/tool-1#/def',
        }),
      );
    });
  });

  describe('ComponentInstallationStore and SessionComponentExposureStore', () => {
    it('scopes installations and exposures by environment while sharing canonical identity', async () => {
      const { executor, portfolioId, ingestionSourceId, environmentId, projectId, sessionId } =
        await seedIdentityAndSession();
      const environment2Id = await seedSecondEnvironment(executor, portfolioId, ingestionSourceId);

      const componentId = await ComponentIdentityStore.insert(executor, {
        portfolioId,
        kind: 'tool',
        owner: 'anthropic',
        integration: 'claude_code',
        nativeId: 'tool-1',
        canonicalSourceIdentity: 'claude://tools/tool-1',
        displayName: 'Tool One',
        createdAt: 1,
        updatedAt: 1,
      });

      const installation1Id = await ComponentInstallationStore.insert(executor, {
        componentId,
        environmentId,
        scope: 'project',
        projectId,
        effectiveStartAt: 1,
        createdAt: 1,
        updatedAt: 1,
      });

      const installation2Id = await ComponentInstallationStore.insert(executor, {
        componentId,
        environmentId: environment2Id,
        scope: 'global',
        effectiveStartAt: 1,
        createdAt: 1,
        updatedAt: 1,
      });

      expect(installation1Id).not.toBe(installation2Id);

      const env1Installations = await ComponentInstallationStore.listByEnvironment(
        executor,
        environmentId,
      );
      expect(env1Installations).toHaveLength(1);
      expect(env1Installations[0].scope).toBe('project');

      const env2Installations = await ComponentInstallationStore.listByEnvironment(
        executor,
        environment2Id,
      );
      expect(env2Installations).toHaveLength(1);
      expect(env2Installations[0].scope).toBe('global');

      const componentInstallations = await ComponentInstallationStore.listByComponent(
        executor,
        componentId,
      );
      expect(componentInstallations).toHaveLength(2);

      const exposureId = await SessionComponentExposureStore.insert(executor, {
        sessionId,
        componentId,
        environmentId,
        status: 'available_not_loaded',
        startSequence: 1,
        startTime: 1,
        createdAt: 1,
        updatedAt: 1,
      });

      const exposure = await SessionComponentExposureStore.getById(executor, sessionId, exposureId);
      expect(exposure).toEqual(
        expect.objectContaining({
          id: exposureId,
          sessionId,
          componentId,
          environmentId,
          status: 'available_not_loaded',
        }),
      );

      await SessionComponentExposureStore.update(executor, sessionId, exposureId, {
        endSequence: 10,
        endTime: 10,
        updatedAt: 2,
      });
      const updated = await SessionComponentExposureStore.getById(executor, sessionId, exposureId);
      expect(updated?.endSequence).toBe(10);
      expect(updated?.endTime).toBe(10);
    });
  });

  describe('event separation', () => {
    it('stores lifecycle, availability, context, and exposure records separately', async () => {
      const { executor, portfolioId, environmentId, sessionId } = await seedIdentityAndSession();

      const componentId = await ComponentIdentityStore.insert(executor, {
        portfolioId,
        kind: 'tool',
        owner: 'anthropic',
        integration: 'claude_code',
        nativeId: 'tool-1',
        canonicalSourceIdentity: 'claude://tools/tool-1',
        displayName: 'Tool One',
        createdAt: 1,
        updatedAt: 1,
      });

      const versionId = await ComponentVersionStore.insert(executor, {
        componentId,
        contentHash: 'sha256-content',
        createdAt: 1,
      });

      const lifecycleId = await ComponentLifecycleEventStore.insert(executor, {
        componentId,
        environmentId,
        eventType: 'added',
        afterVersionId: versionId,
        createdAt: 1,
      });

      const availabilityId = await ComponentAvailabilityEventStore.insert(executor, {
        componentId,
        environmentId,
        sessionId,
        eventType: 'offered',
        startTime: 1,
        createdAt: 1,
      });

      const contextId = await ComponentContextEventStore.insert(executor, {
        componentId,
        environmentId,
        sessionId,
        eventType: 'loaded',
        startTime: 1,
        sourcePointer: '.claude/tools/tool-1#/def',
        createdAt: 1,
      });

      const exposureId = await SessionComponentExposureStore.insert(executor, {
        sessionId,
        componentId,
        environmentId,
        status: 'loaded',
        startSequence: 1,
        startTime: 1,
        createdAt: 1,
        updatedAt: 1,
      });

      expect(
        await ComponentLifecycleEventStore.getById(executor, componentId, lifecycleId),
      ).toEqual(expect.objectContaining({ eventType: 'added', afterVersionId: versionId }));

      expect(
        await ComponentAvailabilityEventStore.getById(executor, componentId, availabilityId),
      ).toEqual(expect.objectContaining({ eventType: 'offered' }));

      expect(await ComponentContextEventStore.getById(executor, componentId, contextId)).toEqual(
        expect.objectContaining({ eventType: 'loaded' }),
      );

      expect(await SessionComponentExposureStore.getById(executor, sessionId, exposureId)).toEqual(
        expect.objectContaining({ status: 'loaded' }),
      );

      const lifecycleEvents = await ComponentLifecycleEventStore.listByComponent(
        executor,
        componentId,
      );
      expect(lifecycleEvents).toHaveLength(1);

      const availabilityEvents = await ComponentAvailabilityEventStore.listByComponent(
        executor,
        componentId,
      );
      expect(availabilityEvents).toHaveLength(1);

      const contextEvents = await ComponentContextEventStore.listByComponent(executor, componentId);
      expect(contextEvents).toHaveLength(1);
    });
  });

  describe('ConfigurationSnapshotStore and SnapshotCompletenessStore', () => {
    it('performs round trips with completeness status per component kind', async () => {
      const { executor, environmentId, projectId, workspaceId } = await seedIdentityAndSession();

      const snapshotId = await ConfigurationSnapshotStore.insert(executor, {
        environmentId,
        projectId,
        workspaceId,
        ordering: 1,
        captureTime: 1,
        ingestionTime: 1,
        harness: 'claude',
        temporalRole: 'pre_session',
        createdAt: 1,
      });

      const snapshot = await ConfigurationSnapshotStore.getById(
        executor,
        environmentId,
        snapshotId,
      );
      expect(snapshot).toEqual(
        expect.objectContaining({
          id: snapshotId,
          environmentId,
          projectId,
          workspaceId,
          ordering: 1,
          temporalRole: 'pre_session',
        }),
      );

      const completenessId = await SnapshotCompletenessStore.insert(executor, {
        snapshotId,
        componentKind: 'tool',
        status: 'partial',
        expectedCount: 10,
        observedCount: 7,
        reason: 'manifest v2 is not exhaustive',
        createdAt: 1,
      });

      const completeness = await SnapshotCompletenessStore.getById(
        executor,
        snapshotId,
        completenessId,
      );
      expect(completeness).toEqual(
        expect.objectContaining({
          id: completenessId,
          snapshotId,
          componentKind: 'tool',
          status: 'partial',
          expectedCount: 10,
          observedCount: 7,
        }),
      );
    });
  });

  describe('ComponentRelationshipStore', () => {
    it('stores MCP-to-tool, parent-child, and causation relationships', async () => {
      const { executor, portfolioId } = await seedIdentityAndSession();

      const mcpId = await ComponentIdentityStore.insert(executor, {
        portfolioId,
        kind: 'mcp_server',
        owner: 'example',
        integration: 'mcp',
        nativeId: 'server-1',
        canonicalSourceIdentity: 'mcp://server-1',
        displayName: 'MCP Server',
        createdAt: 1,
        updatedAt: 1,
      });

      const toolId = await ComponentIdentityStore.insert(executor, {
        portfolioId,
        kind: 'tool',
        owner: 'example',
        integration: 'mcp',
        nativeId: 'tool-1',
        canonicalSourceIdentity: 'mcp://server-1/tools/tool-1',
        displayName: 'Server Tool',
        createdAt: 1,
        updatedAt: 1,
      });

      const relationshipId = await ComponentRelationshipStore.insert(executor, {
        portfolioId,
        sourceComponentId: mcpId,
        targetComponentId: toolId,
        relationshipType: 'mcp_to_tool',
        source: 'manifest-v3',
        confidence: 1,
        createdAt: 1,
      });

      const relationship = await ComponentRelationshipStore.getById(
        executor,
        portfolioId,
        relationshipId,
      );
      expect(relationship).toEqual(
        expect.objectContaining({
          id: relationshipId,
          sourceComponentId: mcpId,
          targetComponentId: toolId,
          relationshipType: 'mcp_to_tool',
          source: 'manifest-v3',
          confidence: 1,
        }),
      );

      const fromSource = await ComponentRelationshipStore.listBySource(
        executor,
        portfolioId,
        mcpId,
      );
      expect(fromSource).toHaveLength(1);

      const byType = await ComponentRelationshipStore.listByType(
        executor,
        portfolioId,
        'mcp_to_tool',
      );
      expect(byType).toHaveLength(1);
    });
  });

  describe('parameterized query coverage and foreign keys', () => {
    it('does not execute unsanitized input as SQL', async () => {
      const { executor, portfolioId } = await seedIdentityAndSession();
      const malicious = "' OR '1'='1";

      const id = await ComponentIdentityStore.insert(executor, {
        portfolioId,
        kind: 'tool',
        owner: 'anthropic',
        integration: 'claude_code',
        nativeId: 'tool-1',
        canonicalSourceIdentity: malicious,
        displayName: 'My Tool',
        createdAt: 1,
        updatedAt: 1,
      });

      const found = await ComponentIdentityStore.getByUniqueIdentity(executor, portfolioId, {
        kind: 'tool',
        owner: 'anthropic',
        integration: 'claude_code',
        nativeId: 'tool-1',
        canonicalSourceIdentity: malicious,
      });
      expect(found?.id).toBe(id);
      expect(found?.canonicalSourceIdentity).toBe(malicious);

      const all = await ComponentIdentityStore.listByPortfolio(executor, portfolioId);
      expect(all).toHaveLength(1);
    });

    it('rejects inserts with missing foreign keys and cascades deletes', async () => {
      const { executor, portfolioId } = await seedIdentityAndSession();

      await expect(
        ComponentIdentityStore.insert(executor, {
          portfolioId: 'missing-portfolio',
          kind: 'tool',
          owner: 'anthropic',
          integration: 'claude_code',
          nativeId: 'tool-1',
          canonicalSourceIdentity: 'claude://tools/tool-1',
          displayName: 'My Tool',
          createdAt: 1,
          updatedAt: 1,
        }),
      ).rejects.toThrow(/FOREIGN/i);

      const componentId = await ComponentIdentityStore.insert(executor, {
        portfolioId,
        kind: 'tool',
        owner: 'anthropic',
        integration: 'claude_code',
        nativeId: 'tool-1',
        canonicalSourceIdentity: 'claude://tools/tool-1',
        displayName: 'My Tool',
        createdAt: 1,
        updatedAt: 1,
      });

      const aliasId = await ComponentAliasStore.insert(executor, {
        portfolioId,
        sourceComponentId: componentId,
        targetComponentId: componentId,
        source: 'self',
        confidence: 1,
        createdAt: 1,
      });

      await ComponentIdentityStore.delete(executor, portfolioId, componentId);
      expect(
        await ComponentIdentityStore.getById(executor, portfolioId, componentId),
      ).toBeUndefined();
      expect(await ComponentAliasStore.getById(executor, portfolioId, aliasId)).toBeUndefined();
    });
  });
});
