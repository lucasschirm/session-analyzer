import type { SqliteTransaction } from '@lucasschirm/sal-db-core';

const LIFECYCLE_TABLES = [
  'session_component_exposures',
  'component_availability_events',
  'component_context_events',
  'comparison_cohort_members',
] as const;

const LIFECYCLE_EVENTS_DELETE_SQL = `DELETE FROM component_lifecycle_events
  WHERE snapshot_id IN (
    SELECT cs.id FROM configuration_snapshots cs
    WHERE cs.session_id = ? AND COALESCE(cs.generation_id, '') = ?
  )`;

export async function deleteLifecycleRowsForGeneration(
  tx: SqliteTransaction,
  sessionId: string,
  generationId: string,
): Promise<void> {
  for (const table of LIFECYCLE_TABLES) {
    await tx.exec(`DELETE FROM ${table} WHERE session_id = ? AND COALESCE(generation_id, '') = ?`, [
      sessionId,
      generationId,
    ]);
  }
  await tx.exec(LIFECYCLE_EVENTS_DELETE_SQL, [sessionId, generationId]);
  if (generationId)
    await tx.exec(`DELETE FROM insight_evidence WHERE generation_id = ?`, [generationId]);
}
