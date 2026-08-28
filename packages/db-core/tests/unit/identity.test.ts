import { beforeAll, describe, expect, it } from 'vitest';

import {
  deterministicEnvironmentId,
  deterministicIngestionSourceId,
  deterministicPortfolioId,
  deterministicSourceProjectId,
  EnvironmentStore,
  IngestionSourceStore,
  NO_OP_REASSIGNMENT_HOOKS,
  PortfolioStore,
  ProjectMappingStore,
  ProjectStore,
  type ReassignmentHooks,
  RepositoryStore,
  SourceProjectStore,
  TenantStore,
  WorkspaceStore,
} from '../../src/identity.js';
import { MIGRATIONS, MigrationRunner } from '../../src/index.js';
import { getSqlite3, WasmSqliteExecutor } from '../helpers/sqlite-wasm-adapter.js';

beforeAll(async () => {
  await getSqlite3();
});

async function createMigratedExecutor(): Promise<WasmSqliteExecutor> {
  const executor = await WasmSqliteExecutor.create();
  const runner = new MigrationRunner(executor, MIGRATIONS);
  await runner.migrate();
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
}

async function seedIdentityHierarchy(): Promise<SeedResult> {
  const executor = await createMigratedExecutor();
  const tenantId = 'tenant-1';
  const portfolioId = 'portfolio-1';
  const ingestionSourceId = deterministicIngestionSourceId(portfolioId, 'claude-local');
  const environmentId = 'environment-1';
  const projectId = 'project-1';
  const nativeProjectId = 'native-project-1';

  await TenantStore.insert(executor, {
    id: tenantId,
    name: 'Local Tenant',
    createdAt: 1,
    updatedAt: 1,
  });

  await PortfolioStore.insert(executor, {
    id: portfolioId,
    tenantId,
    name: 'Default Portfolio',
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
    userProfile: 'user-1',
    deviceProfile: 'device-1',
    harnessHome: '/home/user/.claude',
    configRoot: '/home/user/.claude',
    integrationInstallation: 'cli-1',
    createdAt: 1,
    updatedAt: 1,
  });

  await ProjectStore.insert(executor, {
    id: projectId,
    portfolioId,
    name: 'default-project',
    displayName: 'Default Project',
    metadata: JSON.stringify({ tags: ['default'] }),
    createdAt: 1,
    updatedAt: 1,
  });

  const sourceProjectId = await SourceProjectStore.insert(executor, portfolioId, {
    projectId,
    ingestionSourceId,
    nativeProjectId,
    createdAt: 1,
    updatedAt: 1,
  });

  return {
    executor,
    tenantId,
    portfolioId,
    ingestionSourceId,
    environmentId,
    projectId,
    sourceProjectId,
  };
}

describe('identity schema and stores', () => {
  it('migrates the identity tables into the database', async () => {
    const executor = await createMigratedExecutor();
    const { rows } = await executor.exec(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    );
    const names = rows.map((row) => row.name);

    expect(names).toContain('tenants');
    expect(names).toContain('portfolios');
    expect(names).toContain('ingestion_sources');
    expect(names).toContain('environments');
    expect(names).toContain('projects');
    expect(names).toContain('source_projects');
    expect(names).toContain('project_mappings');
    expect(names).toContain('repositories');
    expect(names).toContain('workspaces');
  });

  describe('TenantStore', () => {
    it('performs a full round trip', async () => {
      const executor = await createMigratedExecutor();
      await TenantStore.insert(executor, {
        id: 'tenant-1',
        name: 'Local Tenant',
        trustedAuthority: 'local',
        createdAt: 1,
        updatedAt: 1,
      });

      const tenant = await TenantStore.getById(executor, 'tenant-1');
      expect(tenant).toEqual({
        id: 'tenant-1',
        name: 'Local Tenant',
        trustedAuthority: 'local',
        createdAt: 1,
        updatedAt: 1,
      });

      const all = await TenantStore.list(executor);
      expect(all).toHaveLength(1);
      expect(all[0].id).toBe('tenant-1');

      await TenantStore.update(executor, 'tenant-1', {
        name: 'Renamed Tenant',
        trustedAuthority: 'trusted',
        updatedAt: 2,
      });
      const updated = await TenantStore.getById(executor, 'tenant-1');
      expect(updated?.name).toBe('Renamed Tenant');
      expect(updated?.trustedAuthority).toBe('trusted');
      expect(updated?.updatedAt).toBe(2);

      await TenantStore.delete(executor, 'tenant-1');
      expect(await TenantStore.getById(executor, 'tenant-1')).toBeUndefined();
    });
  });

  describe('PortfolioStore', () => {
    it('performs a full round trip and scopes by tenant', async () => {
      const executor = await createMigratedExecutor();
      await TenantStore.insert(executor, { id: 't1', name: 'T1', createdAt: 1, updatedAt: 1 });
      await TenantStore.insert(executor, { id: 't2', name: 'T2', createdAt: 1, updatedAt: 1 });

      const id = await PortfolioStore.insert(executor, {
        tenantId: 't1',
        name: 'P1',
        description: 'desc',
        createdAt: 1,
        updatedAt: 1,
      });

      expect(await PortfolioStore.getById(executor, 't1', id)).toEqual(
        expect.objectContaining({
          id,
          tenantId: 't1',
          name: 'P1',
          description: 'desc',
        }),
      );
      expect(await PortfolioStore.getById(executor, 't2', id)).toBeUndefined();

      const all = await PortfolioStore.listByTenant(executor, 't1');
      expect(all).toHaveLength(1);
      expect(all[0].name).toBe('P1');

      await PortfolioStore.update(executor, 't1', id, { name: 'P1-renamed', updatedAt: 2 });
      const updated = await PortfolioStore.getById(executor, 't1', id);
      expect(updated?.name).toBe('P1-renamed');

      await PortfolioStore.delete(executor, 't1', id);
      expect(await PortfolioStore.getById(executor, 't1', id)).toBeUndefined();
      expect(await PortfolioStore.listByTenant(executor, 't1')).toHaveLength(0);
    });

    it('generates deterministic ids from tenant and name', async () => {
      const executor = await createMigratedExecutor();
      await TenantStore.insert(executor, { id: 't1', name: 'T1', createdAt: 1, updatedAt: 1 });
      const id = await PortfolioStore.insert(executor, {
        tenantId: 't1',
        name: 'P1',
        createdAt: 1,
        updatedAt: 1,
      });
      expect(id).toBe(deterministicPortfolioId('t1', 'P1'));
    });
  });

  describe('IngestionSourceStore', () => {
    it('performs a full round trip and scopes by portfolio', async () => {
      const { executor, tenantId, portfolioId } = await seedIdentityHierarchy();
      const otherPortfolioId = await PortfolioStore.insert(executor, {
        tenantId,
        name: 'Other',
        createdAt: 1,
        updatedAt: 1,
      });

      const source = await IngestionSourceStore.getById(executor, portfolioId, 'src-unknown');
      expect(source).toBeUndefined();

      const id = await IngestionSourceStore.insert(executor, {
        portfolioId: otherPortfolioId,
        nativeSourceId: 'manual',
        displayName: 'Manual Uploads',
        type: 'manual',
        authority: 'local',
        createdAt: 1,
        updatedAt: 1,
      });

      expect(await IngestionSourceStore.getById(executor, otherPortfolioId, id)).toEqual(
        expect.objectContaining({
          id,
          portfolioId: otherPortfolioId,
          nativeSourceId: 'manual',
          displayName: 'Manual Uploads',
          type: 'manual',
          authority: 'local',
          supportsCursor: false,
          supportsCheckpoint: false,
        }),
      );
      expect(await IngestionSourceStore.getById(executor, portfolioId, id)).toBeUndefined();

      await IngestionSourceStore.update(executor, otherPortfolioId, id, {
        nativeSourceId: 'manual',
        displayName: 'Manual',
        type: 'manual',
        authority: 'local',
        updatedAt: 2,
      });
      expect(
        (await IngestionSourceStore.getById(executor, otherPortfolioId, id))?.displayName,
      ).toBe('Manual');

      await IngestionSourceStore.delete(executor, otherPortfolioId, id);
      expect(await ingestionSourceCount(executor, otherPortfolioId)).toBe(0);
    });
  });

  describe('EnvironmentStore', () => {
    it('performs a full round trip and scopes by portfolio', async () => {
      const { executor, portfolioId, ingestionSourceId } = await seedIdentityHierarchy();

      const id = await EnvironmentStore.insert(executor, portfolioId, {
        ingestionSourceId,
        nativeEnvironmentId: 'env-2',
        userProfile: 'user-2',
        createdAt: 1,
        updatedAt: 1,
      });
      expect(id).toBe(deterministicEnvironmentId(ingestionSourceId, 'env-2'));

      const env = await EnvironmentStore.getById(executor, portfolioId, id);
      expect(env).toEqual(
        expect.objectContaining({
          id,
          ingestionSourceId,
          nativeEnvironmentId: 'env-2',
          userProfile: 'user-2',
        }),
      );

      const all = await EnvironmentStore.listByPortfolio(executor, portfolioId);
      expect(all).toHaveLength(2);

      await EnvironmentStore.delete(executor, portfolioId, id);
      expect(await EnvironmentStore.listByPortfolio(executor, portfolioId)).toHaveLength(1);
    });

    it('rejects inserts when the ingestion source belongs to another portfolio', async () => {
      const { executor, tenantId, portfolioId } = await seedIdentityHierarchy();
      const otherPortfolioId = await PortfolioStore.insert(executor, {
        tenantId,
        name: 'Other',
        createdAt: 1,
        updatedAt: 1,
      });
      const otherSourceId = await IngestionSourceStore.insert(executor, {
        portfolioId: otherPortfolioId,
        nativeSourceId: 'other-source',
        displayName: 'Other',
        type: 'manual',
        authority: 'local',
        createdAt: 1,
        updatedAt: 1,
      });

      await expect(
        EnvironmentStore.insert(executor, portfolioId, {
          ingestionSourceId: otherSourceId,
          nativeEnvironmentId: 'env-x',
          createdAt: 1,
          updatedAt: 1,
        }),
      ).rejects.toThrow(/not inserted/);
    });
  });

  describe('ProjectStore', () => {
    it('performs a full round trip and scopes by portfolio', async () => {
      const { executor, tenantId, portfolioId } = await seedIdentityHierarchy();
      const otherPortfolioId = await PortfolioStore.insert(executor, {
        tenantId,
        name: 'Other',
        createdAt: 1,
        updatedAt: 1,
      });

      await ProjectStore.insert(executor, {
        id: 'project-2',
        portfolioId,
        name: 'second-project',
        displayName: 'Second Project',
        createdAt: 1,
        updatedAt: 1,
      });

      expect(await ProjectStore.getById(executor, portfolioId, 'project-2')).toEqual(
        expect.objectContaining({ id: 'project-2', name: 'second-project' }),
      );
      expect(await ProjectStore.getById(executor, otherPortfolioId, 'project-2')).toBeUndefined();

      expect(await ProjectStore.getByName(executor, portfolioId, 'second-project')).toEqual(
        expect.objectContaining({ id: 'project-2' }),
      );

      const all = await ProjectStore.listByPortfolio(executor, portfolioId);
      expect(all.map((p) => p.name)).toEqual(['default-project', 'second-project']);

      await ProjectStore.update(executor, portfolioId, 'project-2', {
        name: 'second-project-renamed',
        updatedAt: 2,
      });
      expect((await ProjectStore.getById(executor, portfolioId, 'project-2'))?.name).toBe(
        'second-project-renamed',
      );

      await ProjectStore.delete(executor, portfolioId, 'project-2');
      expect(await ProjectStore.listByPortfolio(executor, portfolioId)).toHaveLength(1);
    });
  });

  describe('SourceProjectStore', () => {
    it('creates deterministic source project ids', async () => {
      const { executor, portfolioId, ingestionSourceId, projectId } = await seedIdentityHierarchy();
      const id = await SourceProjectStore.insert(executor, portfolioId, {
        projectId,
        ingestionSourceId,
        nativeProjectId: 'native-2',
        createdAt: 1,
        updatedAt: 1,
      });
      expect(id).toBe(deterministicSourceProjectId(ingestionSourceId, 'native-2'));
    });

    it('enforces source-native project id uniqueness within an ingestion source', async () => {
      const { executor, portfolioId, ingestionSourceId, projectId, sourceProjectId } =
        await seedIdentityHierarchy();

      await SourceProjectStore.insert(executor, portfolioId, {
        projectId,
        ingestionSourceId,
        nativeProjectId: 'unique-native',
        createdAt: 1,
        updatedAt: 1,
      });

      await expect(
        SourceProjectStore.insert(executor, portfolioId, {
          projectId: 'project-2',
          ingestionSourceId,
          nativeProjectId: 'unique-native',
          createdAt: 1,
          updatedAt: 1,
        }),
      ).rejects.toThrow();

      const sp = await SourceProjectStore.getById(executor, portfolioId, sourceProjectId);
      expect(sp).toBeDefined();
    });

    it('scopes queries by portfolio', async () => {
      const { executor, tenantId, portfolioId, ingestionSourceId, projectId, sourceProjectId } =
        await seedIdentityHierarchy();
      const otherPortfolioId = await PortfolioStore.insert(executor, {
        tenantId,
        name: 'Other-Portfolio',
        createdAt: 1,
        updatedAt: 1,
      });

      expect(await SourceProjectStore.getById(executor, otherPortfolioId, sourceProjectId)).toBe(
        undefined,
      );
      expect(
        await SourceProjectStore.getByNativeId(
          executor,
          otherPortfolioId,
          ingestionSourceId,
          'native-project-1',
        ),
      ).toBe(undefined);

      const all = await SourceProjectStore.listByPortfolio(executor, portfolioId);
      expect(all).toHaveLength(1);
      expect(all[0].id).toBe(sourceProjectId);

      expect(await SourceProjectStore.listByProject(executor, portfolioId, projectId)).toHaveLength(
        1,
      );
    });
  });

  describe('RepositoryStore and WorkspaceStore', () => {
    it('perform full round trips scoped by portfolio', async () => {
      const { executor, portfolioId, projectId } = await seedIdentityHierarchy();

      await RepositoryStore.insert(executor, portfolioId, {
        id: 'repo-1',
        projectId,
        remoteUrlSafe: 'https://example.com/repo-1.git',
        vcsKind: 'git',
        defaultBranch: 'main',
        createdAt: 1,
        updatedAt: 1,
      });

      const repo = await RepositoryStore.getById(executor, portfolioId, 'repo-1');
      expect(repo).toEqual(
        expect.objectContaining({
          id: 'repo-1',
          projectId,
          remoteUrlSafe: 'https://example.com/repo-1.git',
          vcsKind: 'git',
          defaultBranch: 'main',
        }),
      );

      await WorkspaceStore.insert(executor, portfolioId, {
        id: 'ws-1',
        projectId,
        repositoryId: 'repo-1',
        nativeWorkspaceId: 'ws-native-1',
        scopeChain: JSON.stringify(['/home/user/project']),
        path: '/home/user/project',
        createdAt: 1,
        updatedAt: 1,
      });

      const ws = await WorkspaceStore.getById(executor, portfolioId, 'ws-1');
      expect(ws).toEqual(
        expect.objectContaining({
          id: 'ws-1',
          projectId,
          repositoryId: 'repo-1',
          nativeWorkspaceId: 'ws-native-1',
          path: '/home/user/project',
        }),
      );

      await WorkspaceStore.delete(executor, portfolioId, 'ws-1');
      await RepositoryStore.delete(executor, portfolioId, 'repo-1');
      expect(await WorkspaceStore.getById(executor, portfolioId, 'ws-1')).toBeUndefined();
      expect(await RepositoryStore.getById(executor, portfolioId, 'repo-1')).toBeUndefined();
    });

    it('rejects a workspace linked to a repository in a different project', async () => {
      const { executor, portfolioId, projectId } = await seedIdentityHierarchy();
      const otherProjectId = 'project-2';
      await ProjectStore.insert(executor, {
        id: otherProjectId,
        portfolioId,
        name: 'other-project',
        createdAt: 1,
        updatedAt: 1,
      });
      await RepositoryStore.insert(executor, portfolioId, {
        id: 'repo-2',
        projectId: otherProjectId,
        remoteUrlSafe: 'https://example.com/repo-2.git',
        createdAt: 1,
        updatedAt: 1,
      });

      await expect(
        WorkspaceStore.insert(executor, portfolioId, {
          id: 'ws-bad',
          projectId,
          repositoryId: 'repo-2',
          createdAt: 1,
          updatedAt: 1,
        }),
      ).rejects.toThrow(/not inserted/);
    });
  });

  describe('ProjectMappingStore', () => {
    it('records create, merge, split mappings scoped by portfolio', async () => {
      const { executor, portfolioId, ingestionSourceId } = await seedIdentityHierarchy();
      const projectId = 'project-2';
      await ProjectStore.insert(executor, {
        id: projectId,
        portfolioId,
        name: 'second-project',
        createdAt: 1,
        updatedAt: 1,
      });

      const id = await ProjectMappingStore.recordMapping(executor, portfolioId, {
        projectId,
        ingestionSourceId,
        nativeProjectId: 'native-2',
        mappingType: 'create',
        actor: 'test',
        reason: 'initial mapping',
        createdAt: 1,
      });

      const mapping = await ProjectMappingStore.getById(executor, portfolioId, id);
      expect(mapping).toEqual(
        expect.objectContaining({
          id,
          projectId,
          mappingType: 'create',
          actor: 'test',
          reason: 'initial mapping',
        }),
      );

      expect(
        await ProjectMappingStore.listByProject(executor, portfolioId, projectId),
      ).toHaveLength(1);
    });

    it('rejects mapping records when the project is not in the portfolio', async () => {
      const { executor, tenantId, ingestionSourceId } = await seedIdentityHierarchy();
      const otherPortfolioId = await PortfolioStore.insert(executor, {
        tenantId,
        name: 'Other',
        createdAt: 1,
        updatedAt: 1,
      });

      await expect(
        ProjectMappingStore.recordMapping(executor, otherPortfolioId, {
          projectId: 'project-1',
          ingestionSourceId,
          nativeProjectId: 'native-1',
          mappingType: 'create',
          createdAt: 1,
        }),
      ).rejects.toThrow(/not inserted/);
    });

    it('reassigns a source project transactionally and triggers stub rebuild hooks', async () => {
      const { executor, portfolioId, sourceProjectId, projectId } = await seedIdentityHierarchy();
      const otherProjectId = 'project-2';
      await ProjectStore.insert(executor, {
        id: otherProjectId,
        portfolioId,
        name: 'second-project',
        createdAt: 1,
        updatedAt: 1,
      });

      const calls: string[] = [];
      const hooks: ReassignmentHooks = {
        rebuildContributions: (_tx, sourceProjectIdArg, from, to) => {
          calls.push(`contributions:${sourceProjectIdArg}:${from}:${to}`);
          return undefined;
        },
        rebuildLifecycle: (_tx, sourceProjectIdArg, from, to) => {
          calls.push(`lifecycle:${sourceProjectIdArg}:${from}:${to}`);
          return undefined;
        },
        rebuildExposure: (_tx, sourceProjectIdArg, from, to) => {
          calls.push(`exposure:${sourceProjectIdArg}:${from}:${to}`);
          return undefined;
        },
        rebuildCohorts: (_tx, sourceProjectIdArg, from, to) => {
          calls.push(`cohorts:${sourceProjectIdArg}:${from}:${to}`);
          return undefined;
        },
      };

      await ProjectMappingStore.reassignProject(
        executor,
        portfolioId,
        sourceProjectId,
        otherProjectId,
        { reason: 'merging projects', mappingId: 'pm-reassign-1', hooks },
      );

      const moved = await SourceProjectStore.getById(executor, portfolioId, sourceProjectId);
      expect(moved?.projectId).toBe(otherProjectId);

      const mapping = await ProjectMappingStore.getById(executor, portfolioId, 'pm-reassign-1');
      expect(mapping).toEqual(
        expect.objectContaining({
          id: 'pm-reassign-1',
          projectId: otherProjectId,
          priorProjectId: projectId,
          sourceProjectId,
          mappingType: 'reassign',
          reason: 'merging projects',
        }),
      );

      expect(calls).toEqual([
        `contributions:${sourceProjectId}:${projectId}:${otherProjectId}`,
        `lifecycle:${sourceProjectId}:${projectId}:${otherProjectId}`,
        `exposure:${sourceProjectId}:${projectId}:${otherProjectId}`,
        `cohorts:${sourceProjectId}:${projectId}:${otherProjectId}`,
      ]);
    });

    it('rolls back a reassignment when a rebuild hook fails', async () => {
      const { executor, portfolioId, sourceProjectId, projectId } = await seedIdentityHierarchy();
      const otherProjectId = 'project-2';
      await ProjectStore.insert(executor, {
        id: otherProjectId,
        portfolioId,
        name: 'second-project',
        createdAt: 1,
        updatedAt: 1,
      });

      const hooks: ReassignmentHooks = {
        ...NO_OP_REASSIGNMENT_HOOKS,
        rebuildContributions: () => {
          throw new Error('rebuild failed');
        },
      };

      await expect(
        ProjectMappingStore.reassignProject(
          executor,
          portfolioId,
          sourceProjectId,
          otherProjectId,
          { hooks },
        ),
      ).rejects.toThrow(/rebuild failed/);

      const unmoved = await SourceProjectStore.getById(executor, portfolioId, sourceProjectId);
      expect(unmoved?.projectId).toBe(projectId);

      const mappings = await ProjectMappingStore.listByProject(
        executor,
        portfolioId,
        otherProjectId,
      );
      expect(mappings).toHaveLength(0);
    });
  });

  describe('foreign keys and cascade behavior', () => {
    it('cascades portfolio deletion through the identity hierarchy', async () => {
      const { executor, portfolioId } = await seedIdentityHierarchy();
      await RepositoryStore.insert(executor, portfolioId, {
        id: 'repo-1',
        projectId: 'project-1',
        remoteUrlSafe: 'https://example.com/repo.git',
        createdAt: 1,
        updatedAt: 1,
      });

      await PortfolioStore.delete(executor, 'tenant-1', portfolioId);

      const count = async (table: string): Promise<number> => {
        const { rows } = await executor.exec(`SELECT COUNT(*) as n FROM ${table}`);
        return Number(rows[0].n);
      };

      expect(await count('portfolios')).toBe(0);
      expect(await count('ingestion_sources')).toBe(0);
      expect(await count('environments')).toBe(0);
      expect(await count('projects')).toBe(0);
      expect(await count('source_projects')).toBe(0);
      expect(await count('repositories')).toBe(0);
    });

    it('enforces foreign keys for identity tables', async () => {
      const executor = await createMigratedExecutor();
      await expect(
        (async () =>
          executor.exec(
            'INSERT INTO projects (id, portfolio_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
            ['p1', 'missing-portfolio', 'name', 1, 1],
          ))(),
      ).rejects.toThrow(/FOREIGN/i);
    });
  });

  describe('parameterized query coverage', () => {
    it('does not execute unsanitized input as SQL', async () => {
      const { executor, portfolioId, ingestionSourceId, projectId } = await seedIdentityHierarchy();
      const malicious = "' OR '1'='1";
      const id = await SourceProjectStore.insert(executor, portfolioId, {
        projectId,
        ingestionSourceId,
        nativeProjectId: malicious,
        createdAt: 1,
        updatedAt: 1,
      });

      const found = await SourceProjectStore.getByNativeId(
        executor,
        portfolioId,
        ingestionSourceId,
        malicious,
      );
      expect(found?.id).toBe(id);
      expect(found?.nativeProjectId).toBe(malicious);

      const all = await SourceProjectStore.listByPortfolio(executor, portfolioId);
      expect(all).toHaveLength(2);
    });
  });
});

async function ingestionSourceCount(
  executor: WasmSqliteExecutor,
  portfolioId: string,
): Promise<number> {
  const { rows } = await executor.exec(
    'SELECT COUNT(*) as n FROM ingestion_sources WHERE portfolio_id = ?',
    [portfolioId],
  );
  return Number(rows[0].n);
}
