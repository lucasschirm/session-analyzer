import type {
  ComponentSummary,
  NormalizedEvidenceRecord,
} from '@lucasschirm/sal-transformer-shared';
import { stableId } from './session-spine.js';
import type { DevinInvocationKind } from './tool-invocations.js';

/**
 * Attributes Devin invocation evidence back to the components it exercised.
 *
 * `session-components.ts` records which Tools/Skills/Agents a session was
 * *offered* (`session_component_exposures`); this module records which of them
 * the session actually *used*. Ingestion aggregates the emitted
 * `component_evidence_link` records into `session_component_stats`
 * (`packages/db/src/ingestion.ts`'s `upsertSessionComponentStats`), which is
 * the sole "used" signal the Available / Used / Unused reports join against —
 * without these links every Devin component reads as declared-but-unused, no
 * matter how many times it ran.
 *
 * Matching is by `(kind, nativeId)` against the canonical `invocation`
 * payloads, i.e. exactly the comparison `devin-transformer.ts`'s
 * `isConfirmedRuntimeComponent` already performs for `temporalRole`, so the
 * two can never disagree. Skill and Agent names come from the same
 * domain-resolving reader (`invocationKindAndName`), which is why the
 * component ids line up: `extractInvokedComponents` derives an identity from
 * every invocation, so a component always exists for anything that ran.
 */

interface InvocationKey {
  readonly kind: DevinInvocationKind;
  readonly name: string;
}

function keyFor(kind: string, name: string): string {
  return `${kind}\u0000${name}`;
}

function invocationKeyOf(record: NormalizedEvidenceRecord): InvocationKey | null {
  const payload = record.payload;
  if (typeof payload !== 'object' || payload === null) return null;
  const { kind, name } = payload as { kind?: unknown; name?: unknown };
  if (typeof kind !== 'string' || typeof name !== 'string' || name.length === 0) return null;
  if (kind !== 'tool' && kind !== 'skill' && kind !== 'agent') return null;
  return { kind, name };
}

/**
 * Builds one `component_evidence_link` record per (invocation, component)
 * pair restricted to `sessionId` — child subagent sessions own their own
 * activity (and own exposures), so a root session's link set never absorbs a
 * descendant's invocations (`.agents/rules/analytics-domain-distinctions.md`,
 * Metric Disjointness).
 */
export function buildComponentEvidenceLinkRecords(
  sessionId: string,
  components: readonly ComponentSummary[],
  invocationRecords: readonly NormalizedEvidenceRecord[],
  rootArtifactId: string,
): NormalizedEvidenceRecord[] {
  const byKey = new Map<string, ComponentSummary>();
  for (const component of components) {
    if (component.kind !== 'tool' && component.kind !== 'skill' && component.kind !== 'agent') {
      continue;
    }
    const nativeId = component.identity.nativeId;
    if (!nativeId) continue;
    const key = keyFor(component.kind, nativeId);
    const existing = byKey.get(key);
    // When one name resolves to several identities — e.g. a `.devin/skills/foo`
    // file-backed skill and the `skill/foo` cog component of the same session —
    // attribute the usage to the session-scoped identity, since this report
    // measures what ran in THIS session.
    if (existing && !component.sessionScoped) continue;
    byKey.set(key, component);
  }
  if (byKey.size === 0) return [];

  const records: NormalizedEvidenceRecord[] = [];
  for (const record of invocationRecords) {
    if (record.recordType !== 'invocation') continue;
    if (record.sessionId !== sessionId) continue;
    const key = invocationKeyOf(record);
    if (!key) continue;
    const component = byKey.get(keyFor(key.kind, key.name));
    if (!component) continue;

    const linkId = stableId('component_link', {
      session: sessionId,
      component: component.componentId,
      grain: record.recordId,
    });
    records.push({
      recordId: linkId,
      recordType: 'component_evidence_link',
      sessionId,
      parentId: record.recordId,
      sourceEventId: record.sourceEventId,
      provenance: {
        artifactId: rootArtifactId,
        sourceEventId: record.sourceEventId,
        sourceField: 'tool_call_json',
        path: rootArtifactId,
      },
      payload: {
        linkId,
        componentId: component.componentId,
        grainType: 'invocation',
        grainId: record.recordId,
        applicability: `tool_call_state:${key.kind}`,
        startSequence: 0,
        endSequence: 0,
        availabilityCompleteness: 'complete',
        injectionCompleteness: 'complete',
        state: 'linked',
      },
    });
  }
  return records;
}
