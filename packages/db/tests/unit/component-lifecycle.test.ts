import {
  ComponentAliasStore,
  ComponentIdentityStore,
  FRESH_SCHEMA_SQL,
} from '@lucasschirm/sal-db-core';
import type { ComponentSummary } from '@lucasschirm/sal-transformer';
import { describe, expect, it } from 'vitest';
import { WasmSqliteExecutor } from '../../../db-core/tests/helpers/sqlite-wasm-adapter.js';
import {
  ComponentLifecycleEngine,
  type ManifestArtifactReference,
} from '../../src/component-lifecycle.js';

const PORTFOLIO_ID = 'pf-lifecycle';
const ENVIRONMENT_ID = 'env-lifecycle';
const PROJECT_ID = 'prj-lifecycle';
const SESSION_ID = 'sess-lifecycle';
const SESSION_AFTER = 'sess-after';
const ANALYSIS_RELEASE_ID = 'ar-lifecycle';
const GENERATION_ID = 'gen-lifecycle';

function setupExecutor(): Promise<WasmSqliteExecutor> {
  return WasmSqliteExecutor.create();
}

async function seedIdentity(executor: WasmSqliteExecutor): Promise<void> {
  await executor.exec(FRESH_SCHEMA_SQL);
  await executor.exec(
    'INSERT INTO tenants (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)',
    ['ten-lifecycle', 'Default', 0, 0],
  );
  await executor.exec(
    'INSERT INTO portfolios (id, tenant_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    [PORTFOLIO_ID, 'ten-lifecycle', 'Default', 0, 0],
  );
  await executor.exec(
    'INSERT INTO ingestion_sources (id, portfolio_id, native_source_id, display_name, type, authority, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ['src-lifecycle', PORTFOLIO_ID, 'default', 'Default', 'sync', 'local', 0, 0],
  );
  await executor.exec(
    'INSERT INTO environments (id, ingestion_source_id, native_environment_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    [ENVIRONMENT_ID, 'src-lifecycle', 'dev', 0, 0],
  );
  await executor.exec(
    'INSERT INTO projects (id, portfolio_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    [PROJECT_ID, PORTFOLIO_ID, 'project', 0, 0],
  );
  await executor.exec(
    'INSERT INTO source_projects (id, project_id, ingestion_source_id, native_project_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ['sp-lifecycle', PROJECT_ID, 'src-lifecycle', 'project', 0, 0],
  );
  await executor.exec(
    'INSERT INTO sessions (id, project_id, ingestion_source_id, environment_id, harness, native_session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [SESSION_ID, PROJECT_ID, 'src-lifecycle', ENVIRONMENT_ID, 'claude-code', SESSION_ID, 0, 0],
  );
  await executor.exec(
    'INSERT INTO analysis_releases (id, ontology_version, metric_registry_version, statistical_policy_version, rollup_policy_version, mapping_version, created_at, is_default) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [ANALYSIS_RELEASE_ID, '1', '1', '1', '1', '1', 0, 1],
  );
  await executor.exec(
    `INSERT INTO transformation_generations (
      id, session_id, analysis_release_id, parser_version, transformer_version,
      ontology_version, metric_version, schema_version, status, source_availability,
      created_at, committed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      GENERATION_ID,
      SESSION_ID,
      ANALYSIS_RELEASE_ID,
      '1',
      '1',
      '1',
      '1',
      '1',
      'committed',
      'local',
      0,
      0,
    ],
  );
}

function baseInput(): Omit<
  Parameters<ComponentLifecycleEngine['apply']>[1],
  'manifestArtifacts' | 'components' | 'completeness' | 'temporalRole' | 'ordering' | 'captureTime'
> {
  return {
    portfolioId: PORTFOLIO_ID,
    environmentId: ENVIRONMENT_ID,
    projectId: PROJECT_ID,
    sessionId: SESSION_ID,
    harness: 'claude-code',
    generationId: GENERATION_ID,
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

describe('ComponentLifecycleEngine', () => {
  it('generates baseline lifecycle, availability, context, and exposure events', async () => {
    const executor = await setupExecutor();
    await seedIdentity(executor);
    const engine = new ComponentLifecycleEngine(PORTFOLIO_ID);

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

    expect(result.lifecycleEventIds.length).toBeGreaterThan(0);
    expect(result.availabilityEventIds.length).toBeGreaterThan(0);
    expect(result.contextEventIds.length).toBeGreaterThan(0);
    expect(result.exposureIds.length).toBeGreaterThan(0);

    const { rows: lifecycle } = await executor.exec(
      'SELECT event_type FROM component_lifecycle_events WHERE snapshot_id = ?',
      [result.snapshotId],
    );
    expect(lifecycle.map((r) => r.event_type)).toEqual(['baseline']);

    const { rows: availability } = await executor.exec(
      'SELECT event_type FROM component_availability_events WHERE snapshot_id = ?',
      [result.snapshotId],
    );
    expect(availability.map((r) => r.event_type)).toEqual(['offered']);

    const { rows: context } = await executor.exec(
      'SELECT event_type FROM component_context_events WHERE snapshot_id = ?',
      [result.snapshotId],
    );
    expect(context.map((r) => r.event_type)).toEqual(['listed']);

    const { rows: exposures } = await executor.exec(
      'SELECT status FROM session_component_exposures WHERE session_id = ?',
      [SESSION_ID],
    );
    expect(exposures.map((r) => r.status)).toEqual(['available_not_loaded']);
  });

  it('infers added, updated, removed lifecycle events and keeps record types separate', async () => {
    const executor = await setupExecutor();
    await seedIdentity(executor);
    const engine = new ComponentLifecycleEngine(PORTFOLIO_ID);

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
      'SELECT event_type FROM component_lifecycle_events WHERE snapshot_id = ? ORDER BY event_type',
      [second.snapshotId],
    );
    const types = rows.map((r) => r.event_type);
    expect(types).toEqual(expect.arrayContaining(['added', 'removed', 'updated']));
    expect(types.filter((t) => t === 'updated').length).toBe(1);
    expect(types.filter((t) => t === 'added').length).toBe(1);
    expect(types.filter((t) => t === 'removed').length).toBe(1);

    const { rows: availability } = await executor.exec(
      'SELECT DISTINCT event_type FROM component_availability_events WHERE snapshot_id = ?',
      [second.snapshotId],
    );
    const availabilityTypes = availability.map((r) => r.event_type).sort();
    expect(availabilityTypes).toEqual(expect.arrayContaining(['offered', 'unavailable']));

    const { rows: context } = await executor.exec(
      'SELECT DISTINCT event_type FROM component_context_events WHERE snapshot_id = ?',
      [second.snapshotId],
    );
    const contextTypes = context.map((r) => r.event_type).sort();
    expect(contextTypes).toEqual(expect.arrayContaining(['listed', 'removed', 'replaced']));
  });

  it('does not create exposures from post_session snapshots', async () => {
    const executor = await setupExecutor();
    await seedIdentity(executor);
    const engine = new ComponentLifecycleEngine(PORTFOLIO_ID);

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

  it('builds before/after cohorts from lifecycle boundaries', async () => {
    const executor = await setupExecutor();
    await seedIdentity(executor);
    const engine = new ComponentLifecycleEngine(PORTFOLIO_ID);

    const _first = await executor.transaction(async (tx) =>
      engine.apply(tx, {
        ...baseInput(),
        ordering: 1,
        captureTime: 1000,
        temporalRole: 'pre_session',
        manifestArtifacts: [makeArtifact('.claude/skills/greet/SKILL.md', 'skill-v1')],
        components: [makeComponent('skill', 'greet', 'skill:greet', 'skill-v1')],
      }),
    );

    await executor.exec(
      'INSERT INTO sessions (id, project_id, ingestion_source_id, environment_id, harness, native_session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [
        SESSION_AFTER,
        PROJECT_ID,
        'src-lifecycle',
        ENVIRONMENT_ID,
        'claude-code',
        SESSION_AFTER,
        0,
        0,
      ],
    );

    const updated = await executor.transaction(async (tx) =>
      engine.apply(tx, {
        ...baseInput(),
        sessionId: SESSION_AFTER,
        ordering: 2,
        captureTime: 2000,
        temporalRole: 'pre_session',
        manifestArtifacts: [makeArtifact('.claude/skills/greet/SKILL.md', 'skill-v2')],
        components: [makeComponent('skill', 'greet', 'skill:greet', 'skill-v2')],
      }),
    );

    const { rows: events } = await executor.exec(
      'SELECT id FROM component_lifecycle_events WHERE snapshot_id = ? AND event_type = ?',
      [updated.snapshotId, 'updated'],
    );
    expect(events.length).toBe(1);

    await executor.transaction(async (tx) =>
      engine.buildCohortsFromLifecycleEvent(tx, {
        lifecycleEventId: String(events[0].id),
        analysisReleaseId: ANALYSIS_RELEASE_ID,
        recipeId: 'skill:greet-version-change',
        recipeVersion: 1,
        generationId: GENERATION_ID,
      }),
    );

    const { rows: cohorts } = await executor.exec(
      'SELECT id FROM comparison_cohorts WHERE recipe_id = ?',
      ['skill:greet-version-change'],
    );
    expect(cohorts.length).toBe(1);

    const { rows: members } = await executor.exec(
      'SELECT group_label FROM comparison_cohort_members WHERE cohort_id = ?',
      [cohorts[0].id],
    );
    expect(members.some((m) => m.group_label === 'before')).toBe(true);
    expect(members.some((m) => m.group_label === 'after')).toBe(true);
  });

  it('groups concurrent configuration changes into a single cohort', async () => {
    const executor = await setupExecutor();
    await seedIdentity(executor);
    const engine = new ComponentLifecycleEngine(PORTFOLIO_ID);

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

    await executor.exec(
      'INSERT INTO sessions (id, project_id, ingestion_source_id, environment_id, harness, native_session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [
        SESSION_AFTER,
        PROJECT_ID,
        'src-lifecycle',
        ENVIRONMENT_ID,
        'claude-code',
        SESSION_AFTER,
        0,
        0,
      ],
    );

    const second = await executor.transaction(async (tx) =>
      engine.apply(tx, {
        ...baseInput(),
        sessionId: SESSION_AFTER,
        ordering: 2,
        captureTime: 2000,
        temporalRole: 'pre_session',
        manifestArtifacts: [
          makeArtifact('.claude/skills/greet/SKILL.md', 'skill-v2'),
          makeArtifact('.claude/rules/be-kind.md', 'rule-v2'),
        ],
        components: [
          makeComponent('skill', 'greet', 'skill:greet', 'skill-v2'),
          makeComponent('rule', 'be-kind', 'rule:be-kind', 'rule-v2'),
        ],
        completeness: { skill: 'complete', rule: 'complete' },
      }),
    );

    const groupId = second.snapshotId;
    await executor.transaction(async (tx) =>
      engine.buildCohortsForConcurrentGroup(tx, {
        concurrentEventGroupId: groupId,
        analysisReleaseId: ANALYSIS_RELEASE_ID,
        recipeId: 'concurrent-skill-rule-update',
        recipeVersion: 1,
        generationId: GENERATION_ID,
      }),
    );

    const { rows: cohorts } = await executor.exec(
      'SELECT id, metadata FROM comparison_cohorts WHERE recipe_id = ?',
      ['concurrent-skill-rule-update'],
    );
    expect(cohorts.length).toBe(1);

    const metadata = JSON.parse(String(cohorts[0].metadata));
    expect(metadata.concurrentEventGroupId).toBe(groupId);

    const { rows: events } = await executor.exec(
      'SELECT concurrent_event_group_id FROM component_lifecycle_events WHERE snapshot_id = ?',
      [second.snapshotId],
    );
    expect(new Set(events.map((e) => e.concurrent_event_group_id)).size).toBe(1);

    const { rows: members } = await executor.exec(
      'SELECT group_label FROM comparison_cohort_members WHERE cohort_id = ?',
      [cohorts[0].id],
    );
    expect(members.some((m) => m.group_label === 'before')).toBe(true);
    expect(members.some((m) => m.group_label === 'after')).toBe(true);
  });

  it('computes exposure intervals across multiple runtime snapshots', async () => {
    const executor = await setupExecutor();
    await seedIdentity(executor);
    const engine = new ComponentLifecycleEngine(PORTFOLIO_ID);

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
        captureTime: 1500,
        temporalRole: 'runtime',
        manifestArtifacts: [makeArtifact('.claude/skills/greet/SKILL.md', 'skill-v2')],
        components: [makeComponent('skill', 'greet', 'skill:greet', 'skill-v2')],
      }),
    );

    const { rows } = await executor.exec(
      `SELECT status, start_time, end_time
       FROM session_component_exposures
       WHERE session_id = ?
       ORDER BY start_time`,
      [SESSION_ID],
    );
    expect(rows.length).toBe(2);
    expect(rows[0].status).toBe('available_not_loaded');
    expect(rows[0].end_time).toBe(1500);
    expect(rows[1].status).toBe('available_not_loaded');
    expect(rows[1].end_time).toBeNull();
  });

  it('closes exposure intervals for removed components', async () => {
    const executor = await setupExecutor();
    await seedIdentity(executor);
    const engine = new ComponentLifecycleEngine(PORTFOLIO_ID);

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

    await executor.transaction(async (tx) =>
      engine.apply(tx, {
        ...baseInput(),
        ordering: 2,
        captureTime: 2000,
        temporalRole: 'pre_session',
        manifestArtifacts: [makeArtifact('.claude/skills/greet/SKILL.md', 'skill-v1')],
        components: [makeComponent('skill', 'greet', 'skill:greet', 'skill-v1')],
        completeness: { skill: 'complete', rule: 'complete' },
      }),
    );

    const { rows } = await executor.exec(
      `SELECT e.id, e.component_id, e.end_time, ci.canonical_source_identity
       FROM session_component_exposures e
       JOIN component_identities ci ON ci.id = e.component_id
       WHERE e.session_id = ?
       ORDER BY e.start_time`,
      [SESSION_ID],
    );
    const ruleExposure = rows.find((r) => String(r.canonical_source_identity).startsWith('rule:'));
    expect(ruleExposure).toBeDefined();
    expect(ruleExposure.end_time).toBe(2000);
  });

  it('treats aliased cross-harness components as one identity', async () => {
    const executor = await setupExecutor();
    await seedIdentity(executor);
    const engine = new ComponentLifecycleEngine(PORTFOLIO_ID);

    const _first = await executor.transaction(async (tx) => {
      const result = await engine.apply(tx, {
        ...baseInput(),
        ordering: 1,
        captureTime: 1000,
        temporalRole: 'pre_session',
        manifestArtifacts: [makeArtifact('.claude/rules/foo.md', 'rule-v1')],
        components: [makeComponent('rule', 'foo', 'rule:foo', 'rule-v1')],
      });
      const oldId = result.componentIds[0];
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
      return result;
    });

    const second = await executor.transaction(async (tx) =>
      engine.apply(tx, {
        ...baseInput(),
        ordering: 2,
        captureTime: 2000,
        temporalRole: 'pre_session',
        manifestArtifacts: [makeArtifact('.claude/rules/baz.md', 'rule-v3')],
        components: [makeComponent('rule', 'baz', 'rule:baz', 'rule-v3')],
      }),
    );

    const { rows } = await executor.exec(
      'SELECT event_type FROM component_lifecycle_events WHERE snapshot_id = ?',
      [second.snapshotId],
    );
    expect(rows.map((r) => r.event_type)).toEqual(['updated']);
  });

  it('records explicit availability and context events', async () => {
    const executor = await setupExecutor();
    await seedIdentity(executor);
    const engine = new ComponentLifecycleEngine(PORTFOLIO_ID);

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

    const { rows } = await executor.exec(
      'SELECT id FROM component_identities WHERE canonical_source_identity = ?',
      ['skill:greet'],
    );
    const componentId = String(rows[0].id);

    await executor.transaction(async (tx) => {
      await engine.recordAvailabilityEvent(tx, {
        componentId,
        environmentId: ENVIRONMENT_ID,
        sessionId: SESSION_ID,
        eventType: 'enabled',
        startTime: 1200,
        source: 'invocation',
      });
      await engine.recordContextEvent(tx, {
        componentId,
        environmentId: ENVIRONMENT_ID,
        sessionId: SESSION_ID,
        eventType: 'loaded',
        startTime: 1200,
        source: 'invocation',
      });
    });

    const { rows: availability } = await executor.exec(
      'SELECT event_type FROM component_availability_events WHERE component_id = ?',
      [componentId],
    );
    expect(availability.some((r) => r.event_type === 'enabled')).toBe(true);

    const { rows: context } = await executor.exec(
      'SELECT event_type FROM component_context_events WHERE component_id = ?',
      [componentId],
    );
    expect(context.some((r) => r.event_type === 'loaded')).toBe(true);
  });
});
