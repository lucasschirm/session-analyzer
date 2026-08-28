import { fail, pass } from './lib/runner.mjs';
import { explainPlan, openFreshDb } from './lib/sqlite.mjs';

const gate = 'index usage';

const cases = [
  {
    sql: 'SELECT * FROM sessions WHERE project_id = ?',
    params: ['project-1'],
    expectedIndexes: ['idx_sessions_project'],
  },
  {
    sql: 'SELECT * FROM sessions WHERE current_generation_id = ?',
    params: ['gen-1'],
    expectedIndexes: ['idx_sessions_current_generation'],
  },
  {
    sql: 'SELECT * FROM sessions WHERE id = ?',
    params: ['sess-1'],
    expectedIndexes: ['idx_sessions_id', 'sqlite_autoindex_sessions_1', 'INTEGER PRIMARY KEY'],
  },
  {
    sql: 'SELECT * FROM metric_values WHERE session_id = ? AND generation_id = ?',
    params: ['sess-1', 'gen-1'],
    expectedIndexes: ['idx_metric_values_session'],
  },
  {
    sql: 'SELECT * FROM metric_values WHERE metric_definition_id = ? AND comparability_group_id = ? AND generation_id = ?',
    params: ['md-1', 'cgrp-1', 'gen-1'],
    expectedIndexes: ['idx_metric_values_unique'],
  },
  {
    sql: 'SELECT * FROM project_daily_rollups WHERE project_id = ? AND day_bucket = ?',
    params: ['project-1', '2026-08-24'],
    expectedIndexes: ['idx_project_daily_rollups_day'],
  },
  {
    sql: 'SELECT * FROM project_dimension_rollups WHERE project_id = ? AND analysis_release_id = ? AND comparability_group_id = ?',
    params: ['project-1', 'ar-1', 'cgrp-1'],
    expectedIndexes: ['idx_project_dimension_rollups_unique'],
  },
  {
    sql: 'SELECT * FROM source_manifests WHERE session_id = ?',
    params: ['sess-1'],
    expectedIndexes: ['idx_source_manifests_session'],
  },
  {
    sql: 'SELECT * FROM turns WHERE session_id = ? ORDER BY ordering',
    params: ['sess-1'],
    expectedIndexes: ['idx_turns_session_ordering'],
  },
  {
    sql: 'SELECT * FROM messages WHERE turn_id = ?',
    params: ['turn-1'],
    expectedIndexes: ['idx_messages_turn'],
  },
  {
    sql: 'SELECT * FROM component_lifecycle_events WHERE component_id = ?',
    params: ['comp-1'],
    expectedIndexes: ['idx_component_lifecycle_events_component'],
  },
  {
    sql: 'SELECT * FROM manifest_artifacts WHERE source_manifest_id = ?',
    params: ['manifest-1'],
    expectedIndexes: ['idx_manifest_artifacts_manifest'],
  },
  {
    sql: `SELECT mv.id
          FROM metric_values mv
          JOIN metric_definitions md ON md.id = mv.metric_definition_id
          JOIN sessions s ON s.id = mv.session_id
          JOIN transformation_generations tg ON tg.id = mv.generation_id
          WHERE s.project_id = ?
            AND tg.analysis_release_id = ?
            AND mv.comparability_group_id = ?
            AND mv.metric_definition_id = ?
            AND s.current_generation_id = mv.generation_id`,
    params: ['project-1', 'ar-1', 'cgrp-1', 'md-1'],
    expectedIndexes: ['idx_metric_values_unique', 'idx_sessions_project', 'sqlite_autoindex'],
  },
];

const db = await openFreshDb();
const failures = [];

for (const { sql, params, expectedIndexes } of cases) {
  let plan;
  try {
    plan = explainPlan(db, sql, ...params);
  } catch (err) {
    failures.push(`query failed: ${sql}\n  ${err.message}`);
    continue;
  }

  const details = plan.map((p) => String(p.detail));
  const hasScan = details.some((d) => d.includes('SCAN ') && !d.includes('sqlite_master'));
  const usedExpected = details.some((d) => expectedIndexes.some((idx) => d.includes(idx)));

  if (hasScan) {
    failures.push(`plan contains table scan:\n  SQL: ${sql}\n  ${details.join('\n  ')}`);
    continue;
  }
  if (!usedExpected) {
    failures.push(
      `expected index not used:\n  SQL: ${sql}\n  expected one of: ${expectedIndexes.join(', ')}\n  ${details.join('\n  ')}`,
    );
  }
}

if (failures.length > 0) {
  fail(gate, failures.join('\n---\n'));
}
pass(gate);
