import { parseAtifTranscript, parseDevinJsonlText } from '@lucasschirm/sal-devin-session-parser';
import type {
  ArtifactClassificationResult,
  ComponentSummary,
  ConfigurationSnapshot,
  DetectionResult,
  Issue,
  MetricCapability,
  NormalizedEvidenceRecord,
  Provenance,
  SessionTransformer,
  TransformContext,
  TransformResult,
  UnknownArtifactBundle,
} from '@lucasschirm/sal-transformer-shared';
import { getDevinMetricCapabilities } from './capabilities.js';
import {
  artifactIdFor,
  classifyDevinArtifacts,
  completenessFromComponents,
} from './classification.js';
import { buildDevinCompactionRecords } from './compaction.js';
import {
  DEVIN_METRIC_DEFINITION_VERSION,
  type DevinMetricValue,
  deriveDevinMetrics,
} from './metrics/index.js';
import { parseDevinBundle } from './parse-bundle.js';
import { deriveDevinSessionComponents } from './session-components.js';
import { buildSessionSpine, deriveSessionId, resolveSourceIdentity } from './session-spine.js';
import { buildDevinSubagentEvidence } from './subagent-evidence.js';
import { buildTokenUsageRecords } from './token-usage.js';
import { buildToolInvocationRecords } from './tool-invocations.js';

/**
 * Devin CLI session transformer.
 *
 * Identification criteria:
 * - Primary: `bundle.harness === 'devin'` (manifest harness identity).
 * - Fallback: `transcript.jsonl` contains `devin-session-jsonl/v1` line types
 *   (`session`, `message`, `tool_call`, `prompt`), or `native/atif-transcript.json`
 *   has `schema_version === 'ATIF-v1.7'`.
 *
 * Key fields mapped:
 * - Session identity: `sessions.id`, `working_directory`, `model`, `agent_mode`,
 *   `created_at`, `last_activity_at`, `main_chain_id`.
 * - Messages: `message_nodes.node_id`/`parent_node_id`/`chat_message.{message_id,role,content}`.
 * - Tool calls: `tool_call_state.tool_call_json` ACP `kind` (`edit|execute|search`).
 * - Token usage: `native/atif-transcript.json` `final_metrics` and/or
 *   `sessions.metadata.response_dimensions`.
 *
 * Known limitations (documented inline):
 * - `message_nodes.created_at` is unreliable; message order comes from the node
 *   tree (`node_id`/`parent_node_id`/`main_chain_id`), never from `created_at`.
 * - Skill and Agent invocation counts are derived from `tool_call_state`'s
 *   `functions.skill:*`/`functions.run_subagent:*` ACP calls (DS-F11 (#288)).
 *   `plugins/discovered.json` (the cross-session skill/agent definition
 *   catalog) is never captured and is not needed for these counts.
 * - Per-session cost is pending the `sessions.model` -> `models.json` `model_uid`
 *   join planned for DS-F4 and is reported as unavailable.
 */

export const DEVIN_TRANSFORMER_ID = 'devin';
// Bumped 0.2.0 -> 0.3.0 for DS-B28 (#294): ordering (dedup + orphan
// exclusion) and new Sub Agent evidence output shape changed. Feeds
// `deterministicGenerationId` (packages/db/src/ingestion.ts) alongside
// `DEVIN_METRIC_DEFINITION_VERSION`, forcing a fresh generation on reprocess
// rather than silently mixing pre-/post-fix output.
// Bumped 0.3.0 -> 0.4.0 for DS-B25 (#285): `buildTokenUsageRecords`'s
// `model_usage` evidence-record shape changed (one record per ATIF
// generation step instead of always one per session, per-turn `model`
// attribution). No metric-version bump: `devin:tokens:total:*`'s formula,
// population, and comparability group are unchanged (still sourced from
// `atif.finalMetrics`/`response_dimensions` aggregate fields, byte-identical
// per tier), and `model_usage`/`model_requests` are not yet ingested by
// `packages/db` — see the issue for the full justification. Still forces a
// fresh generation on reprocess so no analysis mixes pre-/post-fix
// `model_usage` evidence shapes.
// Bumped 0.4.0 -> 0.5.0 for DS-B31 (#290): `buildTokenUsageRecords`'s
// `model_usage` payload gained `effort`/`normalizedEffort` fields (derived
// from the Devin model catalog's `label`, never `model_uid` alone — see
// `effort.ts`), and `metrics/definitions.ts`/`derive.ts` gained the new
// `devin:effort:changes:root_only`/`:inclusive` metric ids (own `version: 1`
// — Devin and Claude never share a metric id in this codebase, so this is
// not a coverage extension of `CLAUDE_CODE_TRANSFORMER_VERSION`'s own bump
// for the same concept). Forces a fresh generation on reprocess so no
// analysis mixes pre-/post-#290 `model_usage`/metric output.
export const DEVIN_TRANSFORMER_VERSION = '0.5.0';
export const DEVIN_ONTOLOGY_VERSION = '0.1.0';
// `DEVIN_METRIC_DEFINITION_VERSION` is NOT declared here: it is imported
// from `./metrics/comparability.js` (re-exported below) so there is exactly
// ONE source of truth for it. A prior revision of this file declared a
// second, separately-bumped local constant of the same name that fed
// `TransformResult.metricDefinitionVersion` (and therefore
// `deterministicGenerationId`) while `comparability.ts`'s copy (the one
// `deriveDevinMetrics`/`comparabilityGroupFor` actually use for
// comparability-group ids) had already moved on -- the two silently drifted
// out of sync. Re-exported here only so external consumers of this
// package's index (`export * from './devin-transformer.js'`) keep seeing it
// at the same path.
export { DEVIN_METRIC_DEFINITION_VERSION };

function hasManifestHarness(bundle: UnknownArtifactBundle): string | undefined {
  const withHarness = bundle as UnknownArtifactBundle & { harness?: string };
  return withHarness.harness;
}

function toTextContent(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  return undefined;
}

function isDevinSessionLine(text: string): boolean {
  const first = text.split('\n').find((line) => line.trim().length > 0);
  if (!first) return false;
  const result = parseDevinJsonlText(first);
  return result.lines.length > 0;
}

function isAtifArtifact(text: string): boolean {
  try {
    const parsed: unknown = JSON.parse(text);
    const result = parseAtifTranscript(parsed);
    return result.ok;
  } catch {
    return false;
  }
}

function makeIssue(
  code: string,
  message: string,
  severity: 'warning' | 'fatal' | 'recoverable',
  path?: string,
): Issue {
  return { code, severity, message, provenance: path ? { path } : undefined };
}

function makeProvenanceFromArtifacts(classification: ArtifactClassificationResult): Provenance[] {
  return classification.artifacts.map((a) => ({
    artifactId: artifactIdFor(a),
    path: a.relativePath,
  }));
}

/**
 * Whether `component` has actual invocation evidence backing it, not just
 * declared availability. `agent` components are always confirmed: they are
 * derived exclusively from a real `run_subagent` `tool_call_state` record
 * (`extractAgentComponents`), so their mere presence is confirmed usage.
 * `skill` and `tool` (MCP wrapper) components can be declared-only —
 * `extractSkillComponents` derives from `skill/<name>` cog presence alone,
 * and `extractMcpToolComponents` derives from a cog's declared
 * `toolAvailability.mode === 'allow'` list, present in nearly every session
 * whether used or not (session-components.ts doc comments) — so those two
 * kinds are only confirmed when a matching `kind`+`name` invocation record
 * exists in `invocationRecords`.
 */
function isConfirmedRuntimeComponent(
  component: ComponentSummary,
  invocationRecords: readonly NormalizedEvidenceRecord[],
): boolean {
  if (component.kind === 'agent') return true;
  const nativeId = component.identity.nativeId;
  if (!nativeId) return false;
  return invocationRecords.some((record) => {
    if (record.recordType !== 'invocation') return false;
    const payload = record.payload as { kind?: string; name?: string };
    return payload.kind === component.kind && payload.name === nativeId;
  });
}

/**
 * Merges `cogs_json`/`tool_call_state`-derived session components (DS-F11
 * (#288)) with `classification.components` (currently always `[]` — see
 * `classifyDevinArtifacts`) and recomputes `configurationSnapshot` from the
 * merged list, reusing `completenessFromComponents` so completeness
 * accounting stays in one place.
 *
 * `temporalRole` is `'runtime'` only when at least one session component has
 * actual invocation evidence (`isConfirmedRuntimeComponent`) — never
 * unconditionally, since declared-but-unconfirmed components (e.g. the MCP
 * wrapper tool AllowList, present in nearly every session regardless of use)
 * would otherwise overclaim they were "active during the session". Absent
 * any confirmed invocation, this falls back to `'capture_only'` — the same
 * convention `packages/db/src/manual-ingestion.ts`'s `adjustForManual` and
 * `packages/db/src/configuration.ts`'s `applyExposures` already use for
 * "captured, but not asserted as pre-session or runtime activity" (choosing
 * `'capture_only'` rather than inventing a new temporal state).
 */
function mergeSessionComponents(
  classification: ArtifactClassificationResult,
  sessionComponents: readonly ComponentSummary[],
  invocationRecords: readonly NormalizedEvidenceRecord[],
): { components: ComponentSummary[]; configurationSnapshot: ConfigurationSnapshot } {
  const components = [...classification.components, ...sessionComponents];
  const unclassifiedCount = classification.artifacts.filter(
    (a) => a.kind === 'unclassified',
  ).length;
  const hasConfirmedRuntimeComponent = sessionComponents.some((c) =>
    isConfirmedRuntimeComponent(c, invocationRecords),
  );
  return {
    components,
    configurationSnapshot: {
      completeness: completenessFromComponents(components, unclassifiedCount),
      components,
      temporalRole: hasConfirmedRuntimeComponent ? 'runtime' : 'capture_only',
    },
  };
}

export const DevinTransformer: SessionTransformer<UnknownArtifactBundle> = {
  id: DEVIN_TRANSFORMER_ID,
  harnesses: [DEVIN_TRANSFORMER_ID],
  transformerVersion: DEVIN_TRANSFORMER_VERSION,
  ontologyVersion: DEVIN_ONTOLOGY_VERSION,

  detect(bundle: UnknownArtifactBundle): DetectionResult {
    const manifestHarness = hasManifestHarness(bundle);
    if (manifestHarness === DEVIN_TRANSFORMER_ID) {
      return {
        kind: 'matched',
        harness: DEVIN_TRANSFORMER_ID,
        confidence: 1,
        reason: 'manifest harness identity',
      };
    }
    if (manifestHarness !== undefined && manifestHarness.length > 0) {
      return { kind: 'unmatched', reason: `manifest harness is ${manifestHarness}` };
    }

    const artifacts = bundle.artifacts ?? [];
    if (artifacts.length === 0) {
      return { kind: 'unmatched', reason: 'bundle contains no artifacts' };
    }

    let jsonlRootCount = 0;
    let atifRootCount = 0;
    const recognizedArtifacts = new Set<string>();
    for (const artifact of artifacts) {
      const normalized = artifact.relativePath.replace(/\\/g, '/').toLowerCase();
      const text = toTextContent(artifact.content);
      if (normalized === 'transcript.jsonl' && text) {
        if (isDevinSessionLine(text)) {
          jsonlRootCount++;
          recognizedArtifacts.add(artifact.relativePath);
        }
      } else if (normalized === 'native/atif-transcript.json' && text) {
        if (isAtifArtifact(text)) {
          atifRootCount++;
          recognizedArtifacts.add(artifact.relativePath);
        }
      } else if (/^native\//.test(normalized)) {
        recognizedArtifacts.add(artifact.relativePath);
      }
    }

    if (recognizedArtifacts.size === 0) {
      return { kind: 'unmatched', reason: 'no recognized Devin artifacts' };
    }

    if (jsonlRootCount > 1 || (jsonlRootCount === 0 && atifRootCount > 1)) {
      return {
        kind: 'unmatched',
        reason: 'ambiguous: multiple root transcripts without a manifest main transcript path',
      };
    }

    const rootTranscriptCount = jsonlRootCount + atifRootCount;
    if (rootTranscriptCount === 0) {
      return {
        kind: 'unmatched',
        reason: 'recognized Devin artifacts present but no root transcript',
      };
    }

    return {
      kind: 'matched',
      harness: DEVIN_TRANSFORMER_ID,
      confidence: Math.max(0.5, 0.5 + recognizedArtifacts.size / (artifacts.length * 2)),
      reason:
        recognizedArtifacts.size === artifacts.length
          ? 'all artifacts recognized as Devin'
          : 'some artifacts recognized as Devin',
    };
  },

  classifyArtifacts(bundle: UnknownArtifactBundle): ArtifactClassificationResult {
    return classifyDevinArtifacts(bundle.artifacts);
  },

  getCapabilities(bundle?: UnknownArtifactBundle): MetricCapability[] {
    return getDevinMetricCapabilities(bundle);
  },

  transform(bundle: UnknownArtifactBundle, context: TransformContext): TransformResult {
    const classification = this.classifyArtifacts(bundle);
    const warnings: Issue[] = [...(classification.warnings ?? [])];
    const errors: Issue[] = [];

    const parsed = parseDevinBundle(bundle);
    warnings.push(...parsed.warnings);

    const rootArtifact = classification.artifacts.find(
      (a: { kind: string; role?: string; relativePath: string }) =>
        a.kind === 'transcript' && a.role !== 'native',
    );
    const rootContent = bundle.artifacts.find(
      (a: { relativePath: string }) => a.relativePath === rootArtifact?.relativePath,
    );
    const rootArtifactId = rootContent ? artifactIdFor(rootContent) : context.sourceFingerprint;

    if (!parsed.rootTranscriptText) {
      errors.push(
        makeIssue('missing_root_transcript', 'No root transcript artifact found', 'fatal'),
      );
      const failureCaps = getDevinMetricCapabilities(bundle);
      return {
        bundleHash: context.sourceFingerprint,
        parserId: context.parserId,
        parserVersion: context.parserVersion,
        transformerId: DEVIN_TRANSFORMER_ID,
        transformerVersion: DEVIN_TRANSFORMER_VERSION,
        ontologyVersion: DEVIN_ONTOLOGY_VERSION,
        metricDefinitionVersion: DEVIN_METRIC_DEFINITION_VERSION,
        evidence: [],
        sessionSummaries: [],
        componentSummaries: classification.components,
        metricValues: [],
        distributions: [],
        configurationSnapshot: classification.configurationSnapshot,
        capabilities: failureCaps,
        unavailableReasons: failureCaps
          .filter((c) => c.state === 'unavailable')
          .map((c) => ({
            metricId: c.metricId,
            definitionVersion: c.definitionVersion,
            reason: c.reason ?? 'unavailable',
          })),
        provenance: makeProvenanceFromArtifacts(classification),
        warnings,
        errors,
      };
    }

    const nativeSessionId = parsed.sessionLine?.id ?? 'unknown';
    const sessionId = deriveSessionId(context, bundle.sourceIdentity, nativeSessionId);

    const spine = buildSessionSpine(
      sessionId,
      parsed.sessionLine,
      parsed.orderedMessages,
      parsed.atif?.steps ?? [],
      rootArtifactId,
    );
    const toolResult = buildToolInvocationRecords(sessionId, parsed.toolCalls, rootArtifactId);
    const tokenResult = buildTokenUsageRecords(
      sessionId,
      parsed.sessionLine,
      parsed.atif,
      parsed.models,
      rootArtifactId,
    );
    const compactionRecords = buildDevinCompactionRecords(
      sessionId,
      parsed.orderedMessages,
      parsed.prompts,
      rootArtifactId,
    );
    const subagentRecords = buildDevinSubagentEvidence(
      sessionId,
      parsed.detachedMessages,
      rootArtifactId,
    );
    const sourceId = resolveSourceIdentity(context, bundle.sourceIdentity).sourceId;
    const sessionComponents = deriveDevinSessionComponents(
      sourceId,
      parsed.sessionLine?.cogsJson,
      parsed.toolCalls,
      rootArtifactId,
    );
    const merged = mergeSessionComponents(classification, sessionComponents, toolResult.records);

    const allEvidence: NormalizedEvidenceRecord[] = [
      ...spine.records,
      ...toolResult.records,
      ...tokenResult.records,
      ...compactionRecords,
      ...subagentRecords,
    ];

    const tokenUsage = {
      prompt: tokenResult.prompt,
      completion: tokenResult.completion,
      cached: tokenResult.cached,
      total: tokenResult.total,
      steps: tokenResult.steps,
      exact: tokenResult.exact,
      recordId: tokenResult.records[0]?.recordId ?? '',
    };

    const metrics = deriveDevinMetrics(
      parsed.sessionLine,
      parsed.atif,
      parsed.orderedMessages,
      allEvidence,
      tokenUsage,
      rootArtifactId,
      sessionId,
    );

    const allProvenance: Provenance[] = [
      ...makeProvenanceFromArtifacts(classification),
      ...metrics.metricProvenance,
    ];

    return {
      bundleHash: context.sourceFingerprint,
      parserId: context.parserId,
      parserVersion: context.parserVersion,
      transformerId: DEVIN_TRANSFORMER_ID,
      transformerVersion: DEVIN_TRANSFORMER_VERSION,
      ontologyVersion: DEVIN_ONTOLOGY_VERSION,
      metricDefinitionVersion: DEVIN_METRIC_DEFINITION_VERSION,
      evidence: allEvidence,
      sessionSummaries: [spine.summary],
      componentSummaries: merged.components,
      metricValues: metrics.metricValues as readonly DevinMetricValue[],
      distributions: [],
      configurationSnapshot: merged.configurationSnapshot,
      capabilities: metrics.capabilities,
      unavailableReasons: metrics.unavailableReasons,
      provenance: allProvenance,
      warnings,
      errors,
    };
  },
};
