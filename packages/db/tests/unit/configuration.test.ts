import {
  ComponentAliasStore,
  ComponentIdentityStore,
  FRESH_SCHEMA_SQL,
} from '@lucasschirm/sal-db-core';
import type { ComponentSummary } from '@lucasschirm/sal-transformer-shared';
import { describe, expect, it } from 'vitest';
import { WasmSqliteExecutor } from '../../../db-core/tests/helpers/sqlite-wasm-adapter.js';
import {
  type ApplyConfigurationSnapshotInput,
  ConfigurationSnapshotEngine,
  classifyManifestArtifact,
  type ManifestArtifactReference,
} from '../../src/configuration.js';

const PORTFOLIO_ID = 'pf-default';
const ENVIRONMENT_ID = 'env-default';
const PROJECT_ID = 'prj-default';
const SESSION_ID = 'sess-1';

function setupExecutor(): Promise<WasmSqliteExecutor> {
  return WasmSqliteExecutor.create();
}

async function seedIdentity(executor: WasmSqliteExecutor): Promise<void> {
  await executor.exec(FRESH_SCHEMA_SQL);
  await executor.exec(
    'INSERT INTO tenants (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)',
    ['ten-default', 'Default', 0, 0],
  );
  await executor.exec(
    'INSERT INTO portfolios (id, tenant_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    [PORTFOLIO_ID, 'ten-default', 'Default', 0, 0],
  );
  await executor.exec(
    'INSERT INTO ingestion_sources (id, portfolio_id, native_source_id, display_name, type, authority, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ['src-default', PORTFOLIO_ID, 'default', 'Default', 'sync', 'local', 0, 0],
  );
  await executor.exec(
    'INSERT INTO environments (id, ingestion_source_id, native_environment_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    [ENVIRONMENT_ID, 'src-default', 'dev', 0, 0],
  );
  await executor.exec(
    'INSERT INTO projects (id, portfolio_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    [PROJECT_ID, PORTFOLIO_ID, 'project', 0, 0],
  );
  await executor.exec(
    'INSERT INTO source_projects (id, project_id, ingestion_source_id, native_project_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ['sp-default', PROJECT_ID, 'src-default', 'project', 0, 0],
  );
  await executor.exec(
    'INSERT INTO sessions (id, project_id, ingestion_source_id, environment_id, harness, native_session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [SESSION_ID, PROJECT_ID, 'src-default', ENVIRONMENT_ID, 'claude-code', SESSION_ID, 0, 0],
  );
}

function baseInput(): Omit<
  ApplyConfigurationSnapshotInput,
  'manifestArtifacts' | 'components' | 'completeness' | 'temporalRole' | 'ordering' | 'captureTime'
> {
  return {
    portfolioId: PORTFOLIO_ID,
    environmentId: ENVIRONMENT_ID,
    projectId: PROJECT_ID,
    sessionId: SESSION_ID,
    harness: 'claude-code',
  };
}

function makeComponent(
  kind: 'skill' | 'rule' | 'agent' | 'mcp' | 'settings',
  name: string,
  canonicalId: string,
  sha256: string,
): ComponentSummary {
  return {
    componentId: canonicalId,
    kind,
    identity: {
      canonicalId,
      nativeId: name,
      displayName: name,
      provider: '',
      integration: 'claude-code',
    },
    sourceArtifactIds: [`sha256:${sha256}`],
  };
}

function makeArtifact(
  relativePath: string,
  sha256: string,
  status: 'uploaded' | 'failed' | 'skipped' | 'pending' = 'uploaded',
): ManifestArtifactReference {
  return { relativePath, sha256, size: 1, status };
}

describe('classifyManifestArtifact', () => {
  it('classifies by harness + scope + path + hash, not by content blob', () => {
    const a: ManifestArtifactReference = {
      relativePath: '.claude/skills/greet/SKILL.md',
      sha256: 'abc123',
      size: 1,
      harness: 'claude-code',
      scope: 'workspace',
    };
    const b: ManifestArtifactReference = {
      relativePath: '.claude/agents/greet.md',
      sha256: 'abc123',
      size: 1,
      harness: 'claude-code',
      scope: 'workspace',
    };
    expect(classifyManifestArtifact(a).kind).toBe('skill');
    expect(classifyManifestArtifact(b).kind).toBe('agent');
    expect(classifyManifestArtifact(a).sha256).toBe('abc123');
  });

  it('marks unsupported harnesses as unclassified', () => {
    const ref: ManifestArtifactReference = {
      relativePath: '.claude/skills/greet/SKILL.md',
      sha256: 'abc',
      size: 1,
      harness: 'unknown-harness',
    };
    expect(classifyManifestArtifact(ref).kind).toBe('unclassified');
    expect(classifyManifestArtifact(ref).confidence).toBe('unclassified');
  });
});

describe('ConfigurationSnapshotEngine', () => {
  it('records per-component-type snapshot completeness', async () => {
    const executor = await setupExecutor();
    await seedIdentity(executor);
    const engine = new ConfigurationSnapshotEngine(PORTFOLIO_ID);

    const result = await executor.transaction(async (tx) =>
      engine.apply(tx, {
        ...baseInput(),
        ordering: 1,
        captureTime: 1000,
        temporalRole: 'pre_session',
        manifestArtifacts: [
          makeArtifact('.claude/skills/greet/SKILL.md', 'skill-hash'),
          makeArtifact('.claude/rules/be-kind.md', 'rule-hash', 'failed'),
        ],
        components: [makeComponent('skill', 'greet', 'skill:greet', 'skill-hash')],
      }),
    );

    const { rows } = await executor.exec(
      'SELECT component_kind, status FROM snapshot_completeness WHERE snapshot_id = ?',
      [result.snapshotId],
    );
    const skill = rows.find((r) => r.component_kind === 'skill');
    const rule = rows.find((r) => r.component_kind === 'rule');
    expect(skill?.status).toBe('complete');
    expect(rule?.status).toBe('partial');
  });

  it('creates baseline additions from the first complete state', async () => {
    const executor = await setupExecutor();
    await seedIdentity(executor);
    const engine = new ConfigurationSnapshotEngine(PORTFOLIO_ID);

    const result = await executor.transaction(async (tx) =>
      engine.apply(tx, {
        ...baseInput(),
        ordering: 1,
        captureTime: 1000,
        temporalRole: 'pre_session',
        manifestArtifacts: [makeArtifact('.claude/skills/greet/SKILL.md', 'skill-hash')],
        components: [makeComponent('skill', 'greet', 'skill:greet', 'skill-hash')],
      }),
    );

    const { rows } = await executor.exec(
      'SELECT event_type FROM component_lifecycle_events WHERE snapshot_id = ?',
      [result.snapshotId],
    );
    expect(rows.map((r) => r.event_type)).toEqual(['baseline']);
  });

  it('infers added, updated and removed lifecycle events between complete snapshots', async () => {
    const executor = await setupExecutor();
    await seedIdentity(executor);
    const engine = new ConfigurationSnapshotEngine(PORTFOLIO_ID);

    const first = await executor.transaction(async (tx) =>
      engine.apply(tx, {
        ...baseInput(),
        ordering: 1,
        captureTime: 1000,
        temporalRole: 'pre_session',
        manifestArtifacts: [
          makeArtifact('.claude/skills/greet/SKILL.md', 'skill-v1'),
          makeArtifact('.claude/rules/be-kind.md', 'rule-v1'),
        ],
        components: [
          makeComponent('skill', 'greet', 'skill:greet', 'skill-v1'),
          makeComponent('rule', 'be-kind', 'rule:be-kind', 'rule-v1'),
        ],
        completeness: { skill: 'complete', rule: 'complete' },
      }),
    );

    const firstEvents = await executor.exec(
      'SELECT event_type FROM component_lifecycle_events WHERE snapshot_id = ?',
      [first.snapshotId],
    );
    expect(firstEvents.rows.map((r) => r.event_type).sort()).toEqual(['baseline', 'baseline']);

    const second = await executor.transaction(async (tx) =>
      engine.apply(tx, {
        ...baseInput(),
        ordering: 2,
        captureTime: 2000,
        temporalRole: 'pre_session',
        manifestArtifacts: [
          makeArtifact('.claude/skills/greet/SKILL.md', 'skill-v2'),
          makeArtifact('.claude/rules/new-rule.md', 'rule-v2'),
        ],
        components: [
          makeComponent('skill', 'greet', 'skill:greet', 'skill-v2'),
          makeComponent('rule', 'new-rule', 'rule:new-rule', 'rule-v2'),
        ],
        completeness: { skill: 'complete', rule: 'complete' },
      }),
    );

    const { rows } = await executor.exec(
      'SELECT event_type, component_id FROM component_lifecycle_events WHERE snapshot_id = ? ORDER BY event_type',
      [second.snapshotId],
    );
    const types = rows.map((r) => r.event_type);
    expect(types).toEqual(expect.arrayContaining(['added', 'removed', 'updated']));
    expect(types.filter((t) => t === 'updated').length).toBe(1);
    expect(types.filter((t) => t === 'added').length).toBe(1);
    expect(types.filter((t) => t === 'removed').length).toBe(1);
  });

  it('does not prove removal from a partial snapshot', async () => {
    const executor = await setupExecutor();
    await seedIdentity(executor);
    const engine = new ConfigurationSnapshotEngine(PORTFOLIO_ID);

    await executor.transaction(async (tx) =>
      engine.apply(tx, {
        ...baseInput(),
        ordering: 1,
        captureTime: 1000,
        temporalRole: 'pre_session',
        manifestArtifacts: [
          makeArtifact('.claude/skills/greet/SKILL.md', 'skill-v1'),
          makeArtifact('.claude/rules/be-kind.md', 'rule-v1'),
        ],
        components: [
          makeComponent('skill', 'greet', 'skill:greet', 'skill-v1'),
          makeComponent('rule', 'be-kind', 'rule:be-kind', 'rule-v1'),
        ],
        completeness: { skill: 'complete', rule: 'complete' },
      }),
    );

    const second = await executor.transaction(async (tx) =>
      engine.apply(tx, {
        ...baseInput(),
        ordering: 2,
        captureTime: 2000,
        temporalRole: 'pre_session',
        manifestArtifacts: [
          makeArtifact('.claude/skills/greet/SKILL.md', 'skill-v1'),
          makeArtifact('.claude/rules/be-kind.md', 'rule-v1', 'failed'),
        ],
        components: [makeComponent('skill', 'greet', 'skill:greet', 'skill-v1')],
        completeness: { skill: 'complete', rule: 'partial' },
      }),
    );

    const { rows } = await executor.exec(
      'SELECT event_type FROM component_lifecycle_events WHERE snapshot_id = ?',
      [second.snapshotId],
    );
    expect(rows.some((r) => r.event_type === 'removed')).toBe(false);
  });

  it('filters session exposures by temporal role', async () => {
    const executor = await setupExecutor();
    await seedIdentity(executor);
    const engine = new ConfigurationSnapshotEngine(PORTFOLIO_ID);

    await executor.transaction(async (tx) =>
      engine.apply(tx, {
        ...baseInput(),
        ordering: 1,
        captureTime: 1000,
        temporalRole: 'pre_session',
        manifestArtifacts: [makeArtifact('.claude/skills/greet/SKILL.md', 'skill-v1')],
        components: [makeComponent('skill', 'greet', 'skill:greet', 'skill-v1')],
      }),
    );

    await executor.transaction(async (tx) =>
      engine.apply(tx, {
        ...baseInput(),
        ordering: 2,
        captureTime: 2000,
        temporalRole: 'post_session',
        manifestArtifacts: [makeArtifact('.claude/skills/greet/SKILL.md', 'skill-v1')],
        components: [makeComponent('skill', 'greet', 'skill:greet', 'skill-v1')],
      }),
    );

    const { rows } = await executor.exec(
      'SELECT COUNT(*) AS c FROM session_component_exposures WHERE session_id = ?',
      [SESSION_ID],
    );
    expect(rows[0].c).toBe(1);
  });

  it('treats an unproven component rename as remove and add', async () => {
    const executor = await setupExecutor();
    await seedIdentity(executor);
    const engine = new ConfigurationSnapshotEngine(PORTFOLIO_ID);

    await executor.transaction(async (tx) =>
      engine.apply(tx, {
        ...baseInput(),
        ordering: 1,
        captureTime: 1000,
        temporalRole: 'pre_session',
        manifestArtifacts: [makeArtifact('.claude/rules/foo.md', 'rule-v1')],
        components: [makeComponent('rule', 'foo', 'rule:foo', 'rule-v1')],
      }),
    );

    const second = await executor.transaction(async (tx) =>
      engine.apply(tx, {
        ...baseInput(),
        ordering: 2,
        captureTime: 2000,
        temporalRole: 'pre_session',
        manifestArtifacts: [makeArtifact('.claude/rules/bar.md', 'rule-v2')],
        components: [makeComponent('rule', 'bar', 'rule:bar', 'rule-v2')],
      }),
    );

    const { rows } = await executor.exec(
      'SELECT event_type FROM component_lifecycle_events WHERE snapshot_id = ? ORDER BY event_type',
      [second.snapshotId],
    );
    expect(rows.map((r) => r.event_type)).toEqual(['added', 'removed']);
  });

  it('treats an aliased component rename as an update', async () => {
    const executor = await setupExecutor();
    await seedIdentity(executor);
    const engine = new ConfigurationSnapshotEngine(PORTFOLIO_ID);

    const first = await executor.transaction(async (tx) =>
      engine.apply(tx, {
        ...baseInput(),
        ordering: 1,
        captureTime: 1000,
        temporalRole: 'pre_session',
        manifestArtifacts: [makeArtifact('.claude/rules/foo.md', 'rule-v1')],
        components: [makeComponent('rule', 'foo', 'rule:foo', 'rule-v1')],
      }),
    );

    const second = await executor.transaction(async (tx) => {
      const oldId = first.componentIds[0];
      const newId = await ComponentIdentityStore.insert(tx, {
        portfolioId: PORTFOLIO_ID,
        kind: 'rule',
        integration: 'claude-code',
        nativeId: 'baz',
        canonicalSourceIdentity: 'rule:baz',
        displayName: 'baz',
      });
      await ComponentAliasStore.insert(tx, {
        portfolioId: PORTFOLIO_ID,
        sourceComponentId: oldId,
        targetComponentId: newId,
        source: 'test',
        confidence: 1,
      });
      return engine.apply(tx, {
        ...baseInput(),
        ordering: 2,
        captureTime: 2000,
        temporalRole: 'pre_session',
        manifestArtifacts: [makeArtifact('.claude/rules/baz.md', 'rule-v3')],
        components: [makeComponent('rule', 'baz', 'rule:baz', 'rule-v3')],
      });
    });

    const { rows } = await executor.exec(
      'SELECT event_type FROM component_lifecycle_events WHERE snapshot_id = ?',
      [second.snapshotId],
    );
    expect(rows.map((r) => r.event_type)).toEqual(['updated']);
  });
});
