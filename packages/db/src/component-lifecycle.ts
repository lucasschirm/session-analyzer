import type { SqliteTransaction } from '@lucasschirm/sal-db-core';
import {
  ComparisonCohortMemberStore,
  ComparisonCohortStore,
  ComponentAvailabilityEventStore,
  ComponentContextEventStore,
  SessionComponentExposureStore,
} from '@lucasschirm/sal-db-core';

import {
  type ApplyConfigurationSnapshotInput,
  ConfigurationSnapshotEngine,
  type ConfigurationSnapshotResult,
} from './configuration.js';

export type { ApplyConfigurationSnapshotInput };

export interface ComponentLifecycleResult extends ConfigurationSnapshotResult {
  readonly availabilityEventIds: readonly string[];
  readonly contextEventIds: readonly string[];
  readonly cohortIds: readonly string[];
}

export interface AvailabilityEventInput {
  readonly componentId: string;
  readonly environmentId: string;
  readonly sessionId?: string | null;
  readonly eventType:
    | 'offered'
    | 'deferred'
    | 'enabled'
    | 'disabled'
    | 'connected'
    | 'disconnected'
    | 'unavailable';
  readonly snapshotId?: string | null;
  readonly generationId?: string | null;
  readonly startTime: number;
  readonly endTime?: number | null;
  readonly source?: string | null;
  readonly safeMetadata?: string | null;
  readonly createdAt?: number;
}

export interface ContextEventInput {
  readonly componentId: string;
  readonly environmentId: string;
  readonly sessionId?: string | null;
  readonly eventType:
    | 'listed'
    | 'loaded'
    | 'injected'
    | 'reinjected'
    | 'replaced'
    | 'compacted'
    | 'removed';
  readonly snapshotId?: string | null;
  readonly generationId?: string | null;
  readonly startTime: number;
  readonly endTime?: number | null;
  readonly sourcePointer?: string;
  readonly source?: string | null;
  readonly safeMetadata?: string | null;
  readonly createdAt?: number;
}

export interface ExposureIntervalInput {
  readonly sessionId: string;
  readonly componentId: string;
  readonly environmentId: string;
  readonly status: 'unavailable' | 'not_applicable' | 'available_not_loaded' | 'loaded' | 'unknown';
  readonly startSequence: number;
  readonly endSequence?: number | null;
  readonly startTime: number;
  readonly endTime?: number | null;
  readonly snapshotId?: string | null;
  readonly generationId?: string | null;
  readonly safeMetadata?: string | null;
}

export interface CohortBuildInput {
  readonly lifecycleEventId?: string | null;
  readonly concurrentEventGroupId?: string | null;
  readonly analysisReleaseId: string;
  readonly recipeId: string;
  readonly recipeVersion: number;
  readonly dimensionName?: string | null;
  readonly dimensionValue?: string | null;
  readonly generationId?: string | null;
}

interface LifecycleEventRow {
  readonly id: string;
  readonly component_id: string;
  readonly environment_id: string;
  readonly event_type: string;
  readonly before_version_id: string | null;
  readonly after_version_id: string | null;
  readonly concurrent_event_group_id: string | null;
  readonly snapshot_id: string | null;
  readonly generation_id: string | null;
  readonly created_at: number;
}

interface SnapshotComponentRow {
  readonly component_id: string;
  readonly component_version_id: string;
  readonly snapshot_id: string;
}

function makeSafeMetadata(...parts: (string | null | undefined)[]): string {
  return JSON.stringify(Object.fromEntries(parts.map((p, i) => [`_${i}`, p ?? null])));
}

function asOptionalString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function asNumber(value: unknown): number {
  return value === null || value === undefined ? 0 : Number(value);
}

export class ComponentLifecycleEngine {
  constructor(private readonly portfolioId: string) {}

  async apply(
    tx: SqliteTransaction,
    input: ApplyConfigurationSnapshotInput,
  ): Promise<ComponentLifecycleResult> {
    const snapshot = new ConfigurationSnapshotEngine(this.portfolioId);
    const base = await snapshot.apply(tx, input);

    const availabilityEventIds: string[] = [];
    const contextEventIds: string[] = [];

    const lifecycleRows = await this.loadLifecycleRows(tx, base.snapshotId);
    const sessionId = input.sessionId ?? null;
    const captureTime = input.captureTime;

    for (const event of lifecycleRows) {
      const availabilityType = lifecycleToAvailabilityType(event.event_type);
      const contextType = lifecycleToContextType(event.event_type);

      if (availabilityType) {
        const id = await ComponentAvailabilityEventStore.insert(tx, {
          componentId: event.component_id,
          environmentId: event.environment_id,
          sessionId,
          eventType: availabilityType,
          snapshotId: event.snapshot_id,
          generationId: event.generation_id,
          startTime: captureTime,
          source: 'component-lifecycle',
          safeMetadata: makeSafeMetadata(event.id, event.before_version_id, event.after_version_id),
          createdAt: event.created_at,
        });
        availabilityEventIds.push(id);
      }

      if (contextType) {
        const id = await ComponentContextEventStore.insert(tx, {
          componentId: event.component_id,
          environmentId: event.environment_id,
          sessionId,
          eventType: contextType,
          snapshotId: event.snapshot_id,
          generationId: event.generation_id,
          startTime: captureTime,
          sourcePointer: '',
          source: 'component-lifecycle',
          safeMetadata: makeSafeMetadata(event.id, event.before_version_id, event.after_version_id),
          createdAt: event.created_at,
        });
        contextEventIds.push(id);
      }
    }

    await this.reconcileExposures(tx, base.snapshotId, input);

    return {
      ...base,
      availabilityEventIds,
      contextEventIds,
      cohortIds: [],
    };
  }

  async recordAvailabilityEvent(
    tx: SqliteTransaction,
    input: AvailabilityEventInput,
  ): Promise<string> {
    return ComponentAvailabilityEventStore.insert(tx, input);
  }

  async recordContextEvent(tx: SqliteTransaction, input: ContextEventInput): Promise<string> {
    return ComponentContextEventStore.insert(tx, input);
  }

  async recordExposureInterval(
    tx: SqliteTransaction,
    input: ExposureIntervalInput,
  ): Promise<string> {
    const open = await this.findOpenExposure(tx, input.sessionId, input.componentId);
    if (open) {
      await SessionComponentExposureStore.update(tx, input.sessionId, open, {
        endTime: input.startTime,
        endSequence: input.startSequence,
      });
    }
    return SessionComponentExposureStore.insert(tx, input);
  }

  async buildCohortsFromLifecycleEvent(
    tx: SqliteTransaction,
    input: CohortBuildInput,
  ): Promise<string[]> {
    if (!input.lifecycleEventId) return [];

    const event = await this.loadLifecycleRowById(tx, input.lifecycleEventId);
    if (!event) return [];
    if (event.event_type !== 'updated') return [];
    if (!event.before_version_id || !event.after_version_id) return [];

    const beforeSessions = await this.findSessionsWithVersion(
      tx,
      event.component_id,
      event.before_version_id,
      event.created_at,
      'before',
    );
    const afterSessions = await this.findSessionsWithVersion(
      tx,
      event.component_id,
      event.after_version_id,
      event.created_at,
      'after',
    );

    const cohortId = await this.createCohort(
      tx,
      input,
      event.created_at,
      event.concurrent_event_group_id,
    );

    await this.addCohortMembers(tx, cohortId, event, beforeSessions, afterSessions, input);

    return [cohortId];
  }

  async buildCohortsForConcurrentGroup(
    tx: SqliteTransaction,
    input: CohortBuildInput,
  ): Promise<string> {
    if (!input.concurrentEventGroupId) {
      throw new Error('concurrentEventGroupId is required');
    }

    const events = await this.loadLifecycleRowsByGroup(tx, input.concurrentEventGroupId);
    if (events.length === 0) {
      throw new Error(`No lifecycle events for group ${input.concurrentEventGroupId}`);
    }

    const referenceTime = events[0].created_at;
    const beforeSessions = new Set<string>();
    const afterSessions = new Set<string>();

    for (const event of events) {
      if (event.before_version_id) {
        const sessions = await this.findSessionsWithVersion(
          tx,
          event.component_id,
          event.before_version_id,
          referenceTime,
          'before',
        );
        for (const s of sessions) beforeSessions.add(s);
      }
      if (event.after_version_id) {
        const sessions = await this.findSessionsWithVersion(
          tx,
          event.component_id,
          event.after_version_id,
          referenceTime,
          'after',
        );
        for (const s of sessions) afterSessions.add(s);
      }
    }

    const cohortId = await this.createCohort(
      tx,
      input,
      referenceTime,
      input.concurrentEventGroupId,
    );

    const exclusiveBefore = new Set<string>(
      [...beforeSessions].filter((s) => !afterSessions.has(s)),
    );

    const generationId = input.generationId ?? events[0].generation_id ?? 'unknown';

    for (const sessionId of exclusiveBefore) {
      await ComparisonCohortMemberStore.insert(tx, {
        cohortId,
        sessionId,
        generationId,
        groupLabel: 'before',
        concurrentEventId: null,
      });
    }

    for (const sessionId of afterSessions) {
      await ComparisonCohortMemberStore.insert(tx, {
        cohortId,
        sessionId,
        generationId,
        groupLabel: 'after',
        concurrentEventId: null,
      });
    }

    return cohortId;
  }

  async reconcileExposures(
    tx: SqliteTransaction,
    snapshotId: string,
    input: ApplyConfigurationSnapshotInput,
  ): Promise<void> {
    const sessionId = input.sessionId ?? null;
    if (!sessionId) return;

    const versionMap = await this.loadSnapshotVersionMap(tx, snapshotId);
    if (versionMap.length === 0) return;

    const presentComponentIds = new Set(versionMap.map((v) => v.component_id));
    const referenceTime = input.captureTime;
    const endSequence = input.ordering;

    const { rows } = await tx.exec(
      `SELECT id, component_id FROM session_component_exposures
       WHERE session_id = ? AND end_time IS NULL`,
      [sessionId],
    );

    for (const row of rows) {
      const componentId = asOptionalString(row.component_id) ?? '';
      const exposureId = asOptionalString(row.id) ?? '';
      if (!exposureId) continue;
      if (presentComponentIds.has(componentId)) continue;

      await SessionComponentExposureStore.update(tx, sessionId, exposureId, {
        endTime: referenceTime,
        endSequence,
      });
    }
  }

  async loadSnapshotVersionMap(
    tx: SqliteTransaction,
    snapshotId: string,
  ): Promise<readonly SnapshotComponentRow[]> {
    const { rows } = await tx.exec(
      `SELECT sc.component_version_id, sc.snapshot_id,
              cv.component_id
       FROM snapshot_components sc
       JOIN component_versions cv ON cv.id = sc.component_version_id
       WHERE sc.snapshot_id = ?`,
      [snapshotId],
    );
    return rows.map((r) => ({
      component_id: asOptionalString(r.component_id) ?? '',
      component_version_id: asOptionalString(r.component_version_id) ?? '',
      snapshot_id: asOptionalString(r.snapshot_id) ?? '',
    }));
  }

  private async loadLifecycleRows(
    tx: SqliteTransaction,
    snapshotId: string,
  ): Promise<readonly LifecycleEventRow[]> {
    const { rows } = await tx.exec(
      `SELECT id, component_id, environment_id, event_type, before_version_id, after_version_id,
              concurrent_event_group_id, snapshot_id, generation_id, created_at
       FROM component_lifecycle_events
       WHERE snapshot_id = ?
       ORDER BY created_at`,
      [snapshotId],
    );
    return rows.map((r) => this.rowToLifecycleEvent(r));
  }

  private async loadLifecycleRowById(
    tx: SqliteTransaction,
    id: string,
  ): Promise<LifecycleEventRow | undefined> {
    const { rows } = await tx.exec(
      `SELECT id, component_id, environment_id, event_type, before_version_id, after_version_id,
              concurrent_event_group_id, snapshot_id, generation_id, created_at
       FROM component_lifecycle_events
       WHERE id = ?`,
      [id],
    );
    if (rows.length === 0) return undefined;
    return this.rowToLifecycleEvent(rows[0]);
  }

  private async loadLifecycleRowsByGroup(
    tx: SqliteTransaction,
    groupId: string,
  ): Promise<readonly LifecycleEventRow[]> {
    const { rows } = await tx.exec(
      `SELECT id, component_id, environment_id, event_type, before_version_id, after_version_id,
              concurrent_event_group_id, snapshot_id, generation_id, created_at
       FROM component_lifecycle_events
       WHERE concurrent_event_group_id = ?
       ORDER BY created_at`,
      [groupId],
    );
    return rows.map((r) => this.rowToLifecycleEvent(r));
  }

  private rowToLifecycleEvent(row: Record<string, unknown>): LifecycleEventRow {
    return {
      id: asOptionalString(row.id) ?? '',
      component_id: asOptionalString(row.component_id) ?? '',
      environment_id: asOptionalString(row.environment_id) ?? '',
      event_type: asOptionalString(row.event_type) ?? '',
      before_version_id: asOptionalString(row.before_version_id),
      after_version_id: asOptionalString(row.after_version_id),
      concurrent_event_group_id: asOptionalString(row.concurrent_event_group_id),
      snapshot_id: asOptionalString(row.snapshot_id),
      generation_id: asOptionalString(row.generation_id),
      created_at: asNumber(row.created_at),
    };
  }

  private async findOpenExposure(
    tx: SqliteTransaction,
    sessionId: string,
    componentId: string,
  ): Promise<string | undefined> {
    const { rows } = await tx.exec(
      `SELECT id FROM session_component_exposures
       WHERE session_id = ? AND component_id = ? AND end_time IS NULL
       ORDER BY start_time DESC LIMIT 1`,
      [sessionId, componentId],
    );
    if (rows.length === 0) return undefined;
    return asOptionalString(rows[0].id) ?? undefined;
  }

  private async findSessionsWithVersion(
    tx: SqliteTransaction,
    componentId: string,
    versionId: string,
    referenceTime: number,
    side: 'before' | 'after',
  ): Promise<readonly string[]> {
    const operator = side === 'before' ? '<' : '>=';
    const { rows } = await tx.exec(
      `SELECT DISTINCT e.session_id
       FROM session_component_exposures e
       JOIN snapshot_components sc ON sc.snapshot_id = e.snapshot_id
       WHERE e.component_id = ?
         AND sc.component_version_id = ?
         AND e.start_time ${operator} ?`,
      [componentId, versionId, referenceTime],
    );
    return rows.map((r) => asOptionalString(r.session_id) ?? '');
  }

  private async createCohort(
    tx: SqliteTransaction,
    input: CohortBuildInput,
    referenceTime: number,
    concurrentGroupId: string | null,
  ): Promise<string> {
    const existing = await ComparisonCohortStore.getByRecipeAndType(
      tx,
      input.analysisReleaseId,
      input.recipeId,
      input.recipeVersion,
      'before_after',
      input.dimensionName ?? null,
      input.dimensionValue ?? null,
    );

    if (existing) {
      return existing.id;
    }

    return ComparisonCohortStore.insert(tx, {
      analysisReleaseId: input.analysisReleaseId,
      cohortType: 'before_after',
      recipeId: input.recipeId,
      recipeVersion: input.recipeVersion,
      dimensionName: input.dimensionName ?? null,
      dimensionValue: input.dimensionValue ?? null,
      referenceTime,
      startTime: referenceTime,
      endTime: null,
      metadata: JSON.stringify({
        concurrentEventGroupId: concurrentGroupId,
        source: 'component-lifecycle',
      }),
    });
  }

  private async addCohortMembers(
    tx: SqliteTransaction,
    cohortId: string,
    event: LifecycleEventRow,
    beforeSessions: readonly string[],
    afterSessions: readonly string[],
    input: CohortBuildInput,
  ): Promise<void> {
    const afterSet = new Set(afterSessions);
    const generationId = input.generationId ?? event.generation_id ?? 'unknown';

    for (const sessionId of beforeSessions) {
      if (afterSet.has(sessionId)) continue;
      await ComparisonCohortMemberStore.insert(tx, {
        cohortId,
        sessionId,
        generationId,
        groupLabel: 'before',
        concurrentEventId: event.id,
      });
    }

    for (const sessionId of afterSessions) {
      await ComparisonCohortMemberStore.insert(tx, {
        cohortId,
        sessionId,
        generationId,
        groupLabel: 'after',
        concurrentEventId: event.id,
      });
    }
  }
}

function lifecycleToAvailabilityType(
  lifecycleType: string,
):
  | 'offered'
  | 'unavailable'
  | 'enabled'
  | 'disabled'
  | 'connected'
  | 'disconnected'
  | 'deferred'
  | null {
  switch (lifecycleType) {
    case 'baseline':
    case 'added':
    case 'updated':
      return 'offered';
    case 'removed':
      return 'unavailable';
    default:
      return null;
  }
}

function lifecycleToContextType(
  lifecycleType: string,
): 'listed' | 'loaded' | 'injected' | 'reinjected' | 'replaced' | 'compacted' | 'removed' | null {
  switch (lifecycleType) {
    case 'baseline':
    case 'added':
      return 'listed';
    case 'updated':
      return 'replaced';
    case 'removed':
      return 'removed';
    default:
      return null;
  }
}
