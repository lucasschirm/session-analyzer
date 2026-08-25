import type { SqliteTransaction } from '@lucasschirm/sal-db-core';
import {
  ComponentAliasStore,
  ComponentIdentityStore,
  ComponentLifecycleEventStore,
  ComponentVersionStore,
  ConfigurationSnapshotStore,
  type ConfigurationSnapshotTemporalRole,
  deterministicComponentVersionId,
  type InsertComponentIdentityInput,
  type InsertSessionComponentExposureInput,
  SessionComponentExposureStore,
  SnapshotCompletenessStore,
  SnapshotComponentStore,
} from '@lucasschirm/sal-db-core';
import type {
  ComponentCompleteness,
  ComponentSummary,
  SourcePointer,
} from '@lucasschirm/sal-transformer';

export type { ConfigurationSnapshotTemporalRole };

export interface ManifestArtifactReference {
  readonly relativePath: string;
  readonly sha256: string;
  readonly size: number;
  readonly status?: 'uploaded' | 'failed' | 'skipped' | 'pending';
  readonly mediaType?: string;
  readonly harness?: string;
  readonly scope?: string;
}

export interface ClassifiedManifestArtifact {
  readonly relativePath: string;
  readonly sha256: string;
  readonly kind: string;
  readonly scope: string;
  readonly role: string | null;
  readonly mediaType: string;
  readonly confidence: 'exact' | 'inferred' | 'unclassified';
  readonly reason: string | null;
}

export interface ApplyConfigurationSnapshotInput {
  readonly portfolioId: string;
  readonly environmentId: string;
  readonly projectId?: string | null;
  readonly workspaceId?: string | null;
  readonly sessionId?: string | null;
  readonly generationId?: string | null;
  readonly sourceManifestId?: string | null;
  readonly harness: string;
  readonly harnessVersion?: string;
  readonly scopeChain?: string | null;
  readonly repositoryId?: string | null;
  readonly ordering: number;
  readonly captureTime: number;
  readonly ingestionTime?: number;
  readonly temporalRole: ConfigurationSnapshotTemporalRole;
  readonly manifestArtifacts: readonly ManifestArtifactReference[];
  readonly classifiedArtifacts?: readonly ClassifiedManifestArtifact[];
  readonly components: readonly ComponentSummary[];
  readonly completeness?: Readonly<Record<string, ComponentCompleteness>>;
}

export interface ConfigurationSnapshotResult {
  readonly snapshotId: string;
  readonly classifiedArtifacts: readonly ClassifiedManifestArtifact[];
  readonly componentIds: readonly string[];
  readonly versionIds: readonly string[];
  readonly completenessIds: readonly string[];
  readonly snapshotComponentIds: readonly string[];
  readonly lifecycleEventIds: readonly string[];
  readonly exposureIds: readonly string[];
}

const CLASSIFIABLE_KINDS = new Set<string>([
  'tool',
  'skill',
  'agent',
  'rule',
  'mcp_server',
  'plugin',
  'setting',
  'model',
  'version',
]);

const KNOWN_COMPONENT_KINDS = new Set<string>([
  'tool',
  'skill',
  'agent',
  'rule',
  'mcp',
  'settings',
  'subagent',
  'model',
  'version',
  'plugin',
]);

function normalizeSlashes(input: string): string {
  return input.replace(/\\/g, '/');
}

function inferMediaType(relativePath: string, fallback?: string): string {
  const normalized = normalizeSlashes(relativePath).toLowerCase();
  if (normalized.endsWith('.jsonl')) return 'application/jsonl';
  if (normalized.endsWith('.json')) return 'application/json';
  if (normalized.endsWith('.md')) return 'text/markdown';
  if (fallback && fallback !== 'application/octet-stream') return fallback;
  return 'text/plain';
}

function deriveArtifactScope(relativePath: string, kind: string): string {
  const normalized = normalizeSlashes(relativePath);
  if (kind === 'transcript' || /(^|\/)subagents\//.test(normalized)) {
    return 'session';
  }
  if (
    /^~\/\.claude\//.test(normalized) ||
    /(^|\/)(Users|home)\/[^/]+\/\.claude\//.test(normalized) ||
    /(^|\/)\.claude\.json$/i.test(normalized)
  ) {
    return 'global';
  }
  if (
    /(^|\/)\.claude\//.test(normalized) ||
    /\.mcp\.json$/i.test(normalized) ||
    /(^|\/)(CLAUDE|AGENTS)\.md$/i.test(normalized)
  ) {
    return 'workspace';
  }
  return 'runtime';
}

function classifyClaudeArtifact(reference: ManifestArtifactReference): ClassifiedManifestArtifact {
  const normalized = normalizeSlashes(reference.relativePath).toLowerCase();
  let result: { kind: string; role?: string } | undefined;

  if (/(^|\/)subagents\/[^/]+\.meta\.json$/.test(normalized)) {
    result = { kind: 'subagent', role: 'metadata' };
  } else if (/(^|\/)subagents\/[^/]+\.jsonl$/.test(normalized)) {
    result = { kind: 'subagent', role: 'transcript' };
  } else if (/(^|\/)\.claude\/skills\/[^/]+\/skill\.md$/.test(normalized)) {
    result = { kind: 'skill' };
  } else if (/(^|\/)\.claude\/agents\/[^/]+\.md$/.test(normalized)) {
    result = { kind: 'agent' };
  } else if (/(^|\/)\.claude\/rules\/.*\.md$/.test(normalized)) {
    result = { kind: 'rule' };
  } else if (/(^|\/)(claude|agents)\.md$/.test(normalized)) {
    result = { kind: 'rule' };
  } else if (/(^|\/)\.claude\/settings\.json$/.test(normalized)) {
    result = { kind: 'settings' };
  } else if (/(^|\/)\.claude\/settings\.local\.json$/.test(normalized)) {
    result = { kind: 'settings' };
  } else if (/(^|\/)\.mcp\.json$/.test(normalized)) {
    result = { kind: 'mcp' };
  } else if (/(^|\/)\.claude\.json$/.test(normalized)) {
    result = { kind: 'mcp' };
  } else if (/(^|\/)\.claude\/.*\.json$/.test(normalized)) {
    result = { kind: 'settings' };
  } else if (normalized.endsWith('.jsonl') && reference.scope === 'session') {
    result = { kind: 'transcript' };
  }

  if (!result) {
    return {
      relativePath: reference.relativePath,
      sha256: reference.sha256,
      kind: 'unclassified',
      scope: reference.scope ?? deriveArtifactScope(reference.relativePath, 'unclassified'),
      role: null,
      mediaType: inferMediaType(reference.relativePath, reference.mediaType),
      confidence: 'unclassified',
      reason: 'path does not match a supported Claude artifact pattern',
    };
  }

  const scope = reference.scope ?? deriveArtifactScope(reference.relativePath, result.kind);
  return {
    relativePath: reference.relativePath,
    sha256: reference.sha256,
    kind: result.kind,
    scope,
    role: result.role ?? null,
    mediaType: inferMediaType(reference.relativePath, reference.mediaType),
    confidence: 'exact',
    reason: null,
  };
}

export function classifyManifestArtifact(
  reference: ManifestArtifactReference,
): ClassifiedManifestArtifact {
  const harness = reference.harness ?? 'claude-code';
  if (harness === 'claude-code') {
    return classifyClaudeArtifact(reference);
  }
  return {
    relativePath: reference.relativePath,
    sha256: reference.sha256,
    kind: 'unclassified',
    scope: reference.scope ?? 'runtime',
    role: null,
    mediaType: inferMediaType(reference.relativePath, reference.mediaType),
    confidence: 'unclassified',
    reason: `no classifier for harness ${harness}`,
  };
}

export function classifyManifestArtifacts(
  references: readonly ManifestArtifactReference[],
): ClassifiedManifestArtifact[] {
  return references.map(classifyManifestArtifact);
}

function canonicalKind(kind: string): string | undefined {
  switch (kind) {
    case 'mcp':
      return 'mcp_server';
    case 'settings':
      return 'setting';
    case 'subagent':
      return undefined;
    default:
      return KNOWN_COMPONENT_KINDS.has(kind) ? kind : undefined;
  }
}

function sourcePointerToString(pointer?: SourcePointer): string {
  if (!pointer) return '';
  return JSON.stringify(pointer);
}

function computeContentHash(
  component: ComponentSummary,
  manifestArtifacts: readonly ManifestArtifactReference[],
): string {
  for (const id of component.sourceArtifactIds ?? []) {
    if (id.startsWith('sha256:')) {
      return id.slice(7);
    }
    if (id.startsWith('path:')) {
      const path = normalizeSlashes(id.slice(5));
      for (const artifact of manifestArtifacts) {
        if (normalizeSlashes(artifact.relativePath) === path) {
          return artifact.sha256;
        }
      }
    }
  }
  return component.componentId;
}

function mapComponentIdentityInput(
  portfolioId: string,
  component: ComponentSummary,
): InsertComponentIdentityInput {
  const kind = canonicalKind(component.kind);
  if (!kind) {
    throw new Error(`Unsupported component kind: ${component.kind}`);
  }
  return {
    portfolioId,
    kind,
    owner: component.identity.provider ?? '',
    integration: component.identity.integration ?? '',
    nativeId: component.identity.nativeId ?? '',
    canonicalSourceIdentity: component.identity.canonicalId ?? component.componentId,
    displayName: component.identity.displayName ?? null,
    safeMetadata: null,
  };
}

function narrowIdentityKey(input: InsertComponentIdentityInput): {
  readonly kind: string;
  readonly owner: string;
  readonly integration: string;
  readonly nativeId: string;
  readonly canonicalSourceIdentity: string;
} {
  return {
    kind: input.kind,
    owner: input.owner ?? '',
    integration: input.integration ?? '',
    nativeId: input.nativeId ?? '',
    canonicalSourceIdentity: input.canonicalSourceIdentity,
  };
}

function mapCompletenessToStatus(value: ComponentCompleteness): string {
  switch (value) {
    case 'complete':
      return 'complete';
    case 'partial':
      return 'partial';
    case 'unsupported':
      return 'unsupported';
    default:
      return 'unknown';
  }
}

function computeSnapshotCompleteness(
  components: readonly ComponentSummary[],
  classified: readonly ClassifiedManifestArtifact[],
  manifestArtifacts: readonly ManifestArtifactReference[],
): Record<string, string> {
  const unclassifiedCount = classified.filter(
    (c) => c.kind === 'unclassified' || c.confidence === 'unclassified',
  ).length;

  const componentKinds = new Map<string, number>();
  for (const component of components) {
    const kind = canonicalKind(component.kind);
    if (!kind) continue;
    componentKinds.set(kind, (componentKinds.get(kind) ?? 0) + 1);
  }

  const artifactStatusByKind = new Map<string, { uploaded: number; other: number }>();
  for (let i = 0; i < classified.length; i++) {
    const c = classified[i];
    const kind = canonicalKind(c.kind);
    if (!kind) continue;
    const status = manifestArtifacts[i]?.status ?? 'uploaded';
    const current = artifactStatusByKind.get(kind) ?? { uploaded: 0, other: 0 };
    if (status === 'uploaded') {
      current.uploaded += 1;
    } else {
      current.other += 1;
    }
    artifactStatusByKind.set(kind, current);
  }

  const completeness: Record<string, string> = {};
  for (const [kind, count] of componentKinds) {
    const artifact = artifactStatusByKind.get(kind);
    const hasIssue = unclassifiedCount > 0 || (artifact ? artifact.other > 0 : false);
    if (count > 0 && !hasIssue) {
      completeness[kind] = 'complete';
    } else if (count > 0 && hasIssue) {
      completeness[kind] = 'partial';
    }
  }

  for (const [kind, status] of artifactStatusByKind) {
    if (completeness[kind]) continue;
    if (status.other > 0) {
      completeness[kind] = 'partial';
    }
  }

  return completeness;
}

export class ConfigurationSnapshotEngine {
  constructor(private readonly portfolioId: string) {}

  async apply(
    tx: SqliteTransaction,
    input: ApplyConfigurationSnapshotInput,
  ): Promise<ConfigurationSnapshotResult> {
    const classified =
      input.classifiedArtifacts ?? classifyManifestArtifacts(input.manifestArtifacts);

    const completeness = input.completeness
      ? Object.fromEntries(
          Object.entries(input.completeness).map(([k, v]) => [
            canonicalKind(k) ?? k,
            mapCompletenessToStatus(v),
          ]),
        )
      : computeSnapshotCompleteness(input.components, classified, input.manifestArtifacts);

    const snapshotId = await ConfigurationSnapshotStore.insert(tx, {
      sessionId: input.sessionId ?? null,
      generationId: input.generationId ?? null,
      ordering: input.ordering,
      scopeChain: input.scopeChain ?? null,
      captureTime: input.captureTime,
      ingestionTime: input.ingestionTime,
      harness: input.harness,
      temporalRole: input.temporalRole,
      sourceManifestId: input.sourceManifestId ?? null,
      environmentId: input.environmentId,
      projectId: input.projectId ?? null,
      workspaceId: input.workspaceId ?? null,
      safeMetadata: JSON.stringify({
        harnessVersion: input.harnessVersion,
        repositoryId: input.repositoryId,
      }),
    });

    const completenessIds: string[] = [];
    for (const [kind, status] of Object.entries(completeness)) {
      if (!CLASSIFIABLE_KINDS.has(kind)) continue;
      const id = await SnapshotCompletenessStore.insert(tx, {
        snapshotId,
        componentKind: kind,
        status,
        observedCount: input.components.filter((c) => canonicalKind(c.kind) === kind).length,
        reason:
          status === 'partial'
            ? 'some expected artifacts were missing, failed, or unclassified'
            : null,
      });
      completenessIds.push(id);
    }

    const componentIdByCanonical = new Map<string, string>();
    const versionIdByComponent = new Map<string, string>();
    const componentIds: string[] = [];
    const versionIds: string[] = [];

    for (const component of input.components) {
      const kind = canonicalKind(component.kind);
      if (!kind) continue;
      const identityInput = mapComponentIdentityInput(this.portfolioId, component);
      const canonicalId = identityInput.canonicalSourceIdentity;
      let componentId = componentIdByCanonical.get(canonicalId);
      if (!componentId) {
        const existing = await ComponentIdentityStore.getByUniqueIdentity(
          tx,
          this.portfolioId,
          narrowIdentityKey(identityInput),
        );
        if (existing) {
          componentId = existing.id;
        } else {
          componentId = await ComponentIdentityStore.insert(tx, identityInput);
        }
        componentIdByCanonical.set(canonicalId, componentId);
        componentIds.push(componentId);
      }

      const contentHash = computeContentHash(component, input.manifestArtifacts);
      const versionId = await this.ensureComponentVersion(
        tx,
        componentId,
        contentHash,
        component,
        input.manifestArtifacts,
        classified,
      );
      versionIdByComponent.set(canonicalId, versionId);
      versionIds.push(versionId);
    }

    const snapshotComponentIds: string[] = [];
    for (const component of input.components) {
      const kind = canonicalKind(component.kind);
      if (!kind) continue;
      const canonicalId = component.identity.canonicalId ?? component.componentId;
      const componentId = componentIdByCanonical.get(canonicalId);
      const versionId = versionIdByComponent.get(canonicalId);
      if (!componentId || !versionId) continue;

      const sourceArtifact = this.findComponentSourceArtifact(
        component,
        input.manifestArtifacts,
        classified,
      );
      const sourceScope = sourceArtifact?.scope ?? 'runtime';
      const sourcePointer = sourceArtifact ? sourcePointerToString(component.sourcePointer) : '';

      const id = await SnapshotComponentStore.insert(tx, {
        snapshotId,
        componentVersionId: versionId,
        sourceScope,
        sourcePointer,
      });
      snapshotComponentIds.push(id);
    }

    const lifecycleEventIds = await this.inferLifecycleEvents(tx, snapshotId, input, completeness);
    const exposureIds = await this.applyExposures(tx, snapshotId, input);

    return {
      snapshotId,
      classifiedArtifacts: classified,
      componentIds,
      versionIds,
      completenessIds,
      snapshotComponentIds,
      lifecycleEventIds,
      exposureIds,
    };
  }

  private findComponentSourceArtifact(
    component: ComponentSummary,
    manifestArtifacts: readonly ManifestArtifactReference[],
    classified: readonly ClassifiedManifestArtifact[],
  ): ClassifiedManifestArtifact | undefined {
    for (const id of component.sourceArtifactIds ?? []) {
      if (id.startsWith('sha256:')) {
        const hash = id.slice(7);
        for (let i = 0; i < manifestArtifacts.length; i++) {
          if (manifestArtifacts[i].sha256 === hash) {
            return classified[i];
          }
        }
      } else if (id.startsWith('path:')) {
        const path = normalizeSlashes(id.slice(5));
        for (let i = 0; i < manifestArtifacts.length; i++) {
          if (normalizeSlashes(manifestArtifacts[i].relativePath) === path) {
            return classified[i];
          }
        }
      }
    }
    return undefined;
  }

  private async ensureComponentVersion(
    tx: SqliteTransaction,
    componentId: string,
    contentHash: string,
    component: ComponentSummary,
    manifestArtifacts: readonly ManifestArtifactReference[],
    classified: readonly ClassifiedManifestArtifact[],
  ): Promise<string> {
    const sourceArtifact = this.findComponentSourceArtifact(
      component,
      manifestArtifacts,
      classified,
    );
    const sourcePointer = sourceArtifact ? sourcePointerToString(component.sourcePointer) : '';
    const configHash = '';
    const schemaHash = '';
    const versionId = deterministicComponentVersionId(
      componentId,
      contentHash,
      configHash,
      schemaHash,
    );

    const existing = await ComponentVersionStore.getById(tx, componentId, versionId);
    if (existing) return existing.id;

    return ComponentVersionStore.insert(tx, {
      id: versionId,
      componentId,
      contentHash,
      configHash,
      schemaHash,
      sourcePointer,
      safeMetadata: JSON.stringify({ nativeId: component.identity.nativeId }),
    });
  }

  private async inferLifecycleEvents(
    tx: SqliteTransaction,
    snapshotId: string,
    input: ApplyConfigurationSnapshotInput,
    completeness: Record<string, string>,
  ): Promise<string[]> {
    const eventIds: string[] = [];
    const groupId = snapshotId;

    const candidateKinds = new Set<string>();
    for (const component of input.components) {
      const kind = canonicalKind(component.kind);
      if (kind) candidateKinds.add(kind);
    }
    for (const kind of Object.keys(completeness)) {
      if (CLASSIFIABLE_KINDS.has(kind)) candidateKinds.add(kind);
    }

    for (const kind of candidateKinds) {
      const currentStatus = completeness[kind];
      if (!currentStatus) continue;

      const previous = await this.findPreviousCompleteSnapshot(tx, input, kind, snapshotId);
      const currentMap = await this.loadSnapshotVersionMap(tx, snapshotId, kind);

      if (!previous) {
        if (currentStatus !== 'complete') continue;
        for (const [componentId, info] of currentMap) {
          const id = await ComponentLifecycleEventStore.insert(tx, {
            componentId,
            environmentId: input.environmentId,
            eventType: 'baseline',
            afterVersionId: info.versionId,
            snapshotId,
            generationId: input.generationId ?? null,
            concurrentEventGroupId: groupId,
            source: 'configuration-snapshot',
            createdAt: input.captureTime,
          });
          eventIds.push(id);
        }
        continue;
      }

      const previousMap = await this.loadSnapshotVersionMap(tx, previous.id, kind);
      const previousHandled = new Set<string>();
      const currentHandled = new Set<string>();

      for (const [componentId, currentInfo] of currentMap) {
        const previousInfo = previousMap.get(componentId);
        if (previousInfo) {
          if (previousInfo.versionId !== currentInfo.versionId) {
            const id = await ComponentLifecycleEventStore.insert(tx, {
              componentId,
              environmentId: input.environmentId,
              eventType: 'updated',
              beforeVersionId: previousInfo.versionId,
              afterVersionId: currentInfo.versionId,
              snapshotId,
              generationId: input.generationId ?? null,
              concurrentEventGroupId: groupId,
              source: 'configuration-snapshot',
              createdAt: input.captureTime,
            });
            eventIds.push(id);
          }
          previousHandled.add(componentId);
          currentHandled.add(componentId);
          continue;
        }

        const aliasedPrevious = await this.findAliasedComponent(tx, componentId, previousMap);
        if (aliasedPrevious) {
          const id = await ComponentLifecycleEventStore.insert(tx, {
            componentId,
            environmentId: input.environmentId,
            eventType: 'updated',
            beforeVersionId: aliasedPrevious.versionId,
            afterVersionId: currentInfo.versionId,
            snapshotId,
            generationId: input.generationId ?? null,
            concurrentEventGroupId: groupId,
            source: 'configuration-snapshot',
            createdAt: input.captureTime,
          });
          eventIds.push(id);
          previousHandled.add(aliasedPrevious.componentId);
          currentHandled.add(componentId);
          continue;
        }

        const eventType = currentStatus === 'complete' ? 'added' : 'added';
        const id = await ComponentLifecycleEventStore.insert(tx, {
          componentId,
          environmentId: input.environmentId,
          eventType,
          afterVersionId: currentInfo.versionId,
          snapshotId,
          generationId: input.generationId ?? null,
          concurrentEventGroupId: groupId,
          source: 'configuration-snapshot',
          createdAt: input.captureTime,
        });
        eventIds.push(id);
        currentHandled.add(componentId);
      }

      if (currentStatus === 'complete') {
        for (const [componentId, previousInfo] of previousMap) {
          if (previousHandled.has(componentId)) continue;
          const aliasedCurrent = await this.findAliasedComponent(tx, componentId, currentMap);
          if (aliasedCurrent) {
            const id = await ComponentLifecycleEventStore.insert(tx, {
              componentId,
              environmentId: input.environmentId,
              eventType: 'updated',
              beforeVersionId: previousInfo.versionId,
              afterVersionId: aliasedCurrent.versionId,
              snapshotId,
              generationId: input.generationId ?? null,
              concurrentEventGroupId: groupId,
              source: 'configuration-snapshot',
              createdAt: input.captureTime,
            });
            eventIds.push(id);
            currentHandled.add(aliasedCurrent.componentId);
            continue;
          }

          const id = await ComponentLifecycleEventStore.insert(tx, {
            componentId,
            environmentId: input.environmentId,
            eventType: 'removed',
            beforeVersionId: previousInfo.versionId,
            snapshotId,
            generationId: input.generationId ?? null,
            concurrentEventGroupId: groupId,
            source: 'configuration-snapshot',
            createdAt: input.captureTime,
          });
          eventIds.push(id);
        }
      }
    }

    return eventIds;
  }

  private async findPreviousCompleteSnapshot(
    tx: SqliteTransaction,
    input: ApplyConfigurationSnapshotInput,
    kind: string,
    currentSnapshotId: string,
  ): Promise<{ id: string; ordering: number; captureTime: number; createdAt: number } | undefined> {
    const { rows } = await tx.exec(
      `SELECT s.id, s.ordering, s.capture_time, s.created_at
       FROM configuration_snapshots s
       WHERE s.environment_id = ?
         AND COALESCE(s.project_id, '') = ?
         AND COALESCE(s.workspace_id, '') = ?
         AND s.harness = ?
         AND COALESCE(s.scope_chain, '') = ?`,
      [
        input.environmentId,
        input.projectId ?? '',
        input.workspaceId ?? '',
        input.harness,
        input.scopeChain ?? '',
      ],
    );

    const candidates: { id: string; ordering: number; captureTime: number; createdAt: number }[] =
      [];
    for (const row of rows) {
      const id = String(row.id);
      if (id === currentSnapshotId) continue;
      const ordering = Number(row.ordering ?? 0);
      const captureTime = Number(row.capture_time ?? 0);
      const createdAt = Number(row.created_at ?? 0);

      const completeness = await SnapshotCompletenessStore.listBySnapshot(tx, id);
      if (completeness.some((c) => c.componentKind === kind && c.status === 'complete')) {
        candidates.push({ id, ordering, captureTime, createdAt });
      }
    }

    const newSnapshot = await ConfigurationSnapshotStore.getById(
      tx,
      input.environmentId,
      currentSnapshotId,
    );
    if (!newSnapshot) return undefined;

    const newTuple = {
      id: currentSnapshotId,
      ordering: newSnapshot.ordering,
      captureTime: newSnapshot.captureTime,
      createdAt: newSnapshot.createdAt,
    };

    candidates.sort((a, b) => compareCanonicalOrder(a, b));
    const index = candidates.findIndex((c) => compareCanonicalOrder(c, newTuple) >= 0);
    if (index > 0) {
      return candidates[index - 1];
    }
    const last = candidates[candidates.length - 1];
    if (last && compareCanonicalOrder(last, newTuple) < 0) {
      return last;
    }
    return undefined;
  }

  private async loadSnapshotVersionMap(
    tx: SqliteTransaction,
    snapshotId: string,
    kind: string,
  ): Promise<
    Map<
      string,
      { componentId: string; versionId: string; nativeId: string; canonicalSourceIdentity: string }
    >
  > {
    const { rows } = await tx.exec(
      `SELECT sc.component_version_id, sc.source_scope, sc.source_pointer,
              cv.component_id, ci.kind, ci.native_id, ci.canonical_source_identity
       FROM snapshot_components sc
       JOIN component_versions cv ON cv.id = sc.component_version_id
       JOIN component_identities ci ON ci.id = cv.component_id
       WHERE sc.snapshot_id = ? AND ci.kind = ?`,
      [snapshotId, kind],
    );

    const map = new Map<
      string,
      { componentId: string; versionId: string; nativeId: string; canonicalSourceIdentity: string }
    >();
    for (const row of rows) {
      const componentId = String(row.component_id);
      map.set(componentId, {
        componentId,
        versionId: String(row.component_version_id),
        nativeId: String(row.native_id ?? ''),
        canonicalSourceIdentity: String(row.canonical_source_identity ?? ''),
      });
    }
    return map;
  }

  private async findAliasedComponent(
    tx: SqliteTransaction,
    fromComponentId: string,
    targetMap: Map<
      string,
      { componentId: string; versionId: string; nativeId: string; canonicalSourceIdentity: string }
    >,
  ): Promise<{ componentId: string; versionId: string } | undefined> {
    for (const [targetId] of targetMap) {
      if (targetId === fromComponentId) continue;
      const fromAliases = await ComponentAliasStore.resolveAliases(
        tx,
        this.portfolioId,
        fromComponentId,
      );
      if (fromAliases.includes(targetId)) {
        const info = targetMap.get(targetId);
        if (info) return { componentId: targetId, versionId: info.versionId };
      }
      const toAliases = await ComponentAliasStore.resolveAliases(tx, this.portfolioId, targetId);
      if (toAliases.includes(fromComponentId)) {
        const info = targetMap.get(targetId);
        if (info) return { componentId: targetId, versionId: info.versionId };
      }
    }
    return undefined;
  }

  private async applyExposures(
    tx: SqliteTransaction,
    snapshotId: string,
    input: ApplyConfigurationSnapshotInput,
  ): Promise<string[]> {
    if (input.temporalRole !== 'pre_session' && input.temporalRole !== 'runtime') {
      return [];
    }
    if (!input.sessionId) return [];

    const exposureIds: string[] = [];
    for (const component of input.components) {
      const kind = canonicalKind(component.kind);
      if (!kind) continue;
      const canonicalId = component.identity.canonicalId ?? component.componentId;
      const componentId = await this.resolveComponentId(tx, canonicalId);
      if (!componentId) continue;

      const open = await this.findOpenExposure(tx, input.sessionId, componentId);
      if (open && input.sessionId) {
        await SessionComponentExposureStore.update(tx, input.sessionId, open, {
          endTime: input.captureTime,
          endSequence: input.ordering,
        });
      }

      const exposureInput: InsertSessionComponentExposureInput = {
        sessionId: input.sessionId,
        componentId,
        environmentId: input.environmentId,
        status: 'available_not_loaded',
        startSequence: input.ordering,
        startTime: input.captureTime,
        snapshotId,
        generationId: input.generationId ?? null,
      };
      const id = await SessionComponentExposureStore.insert(tx, exposureInput);
      exposureIds.push(id);
    }

    return exposureIds;
  }

  private async resolveComponentId(
    tx: SqliteTransaction,
    canonicalSourceIdentity: string,
  ): Promise<string | undefined> {
    const { rows } = await tx.exec(
      `SELECT id FROM component_identities
       WHERE portfolio_id = ? AND canonical_source_identity = ?`,
      [this.portfolioId, canonicalSourceIdentity],
    );
    if (rows.length === 0) return undefined;
    return String(rows[0].id);
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
    return String(rows[0].id);
  }
}

function compareCanonicalOrder(
  a: { id: string; ordering: number; captureTime: number; createdAt: number },
  b: { id: string; ordering: number; captureTime: number; createdAt: number },
): number {
  if (a.ordering !== b.ordering) return a.ordering - b.ordering;
  if (a.captureTime !== b.captureTime) return a.captureTime - b.captureTime;
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a.id.localeCompare(b.id);
}
