import { sha256Hex } from '@lucasschirm/sal-sync-core';
import type {
  ArtifactClassificationResult,
  ComponentSummary,
  DetectionResult,
  MetricCapability,
  NormalizedEvidenceRecord,
  ScalarMetricValue,
  SessionSummary,
  SessionTransformer,
  SourceIdentity,
  TransformContext,
  TransformResult,
  UnknownArtifactBundle,
} from '@lucasschirm/sal-transformer-shared';
import type { ManualIngestionBundle } from '../../src/manifest.js';

export interface BenchmarkScale {
  /** Number of distinct projects. */
  readonly projects: number;
  /** Number of distinct ingestion sources. */
  readonly sources: number;
  /** Number of distinct environments. */
  readonly environments: number;
  /** Number of root sessions to generate. */
  readonly sessions: number;
  /** Sub-agent tree depth per root session. */
  readonly childDepth: number;
  /** Sub-agent children at each tree level. */
  readonly childCount: number;
  /** Evidence records per session. */
  readonly evidenceCount: number;
  /** Characters of synthetic payload per evidence record. */
  readonly payloadSize: number;
  /** Components in the configuration snapshot per session. */
  readonly componentCount: number;
  /** Fraction of sessions that arrive late (0..1). */
  readonly lateArrivalRatio?: number;
  /** Fraction of sessions to mark for deletion (0..1). */
  readonly deleteRatio?: number;
}

export interface BenchmarkSession {
  readonly sessionId: string;
  readonly rootSessionId: string;
  readonly parentSessionId?: string;
  readonly projectId: string;
  readonly sourceId: string;
  readonly environmentId?: string;
  readonly harness: string;
  readonly mode: string;
  readonly taskCohort: string;
  readonly startTime: string;
  readonly endTime: string;
  readonly finality: 'final' | 'partial' | 'censored';
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheCreationTokens: number;
  readonly cacheReadTokens: number;
  readonly toolCount: number;
  readonly filesRead: number;
  readonly filesWritten: number;
  readonly evidenceCount: number;
  readonly payloadSize: number;
  readonly componentCount: number;
  readonly isLateArrival: boolean;
  readonly isDeleted: boolean;
}

export interface BenchmarkFixture {
  readonly sessions: readonly BenchmarkSession[];
  readonly rootSessions: readonly BenchmarkSession[];
  readonly projects: readonly string[];
  readonly sources: readonly string[];
  readonly environments: readonly string[];
  readonly scale: BenchmarkScale;
}

const HARNESSES = ['claude-code', 'agentic-pi', 'antigravity', 'opencode', 'mcp'] as const;
const MODES = ['auto', 'plan', 'review'] as const;
const COHORTS = ['feature', 'bug', 'refactor', 'explore'] as const;

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

function deterministicChoice<T>(seed: string, choices: readonly T[]): T {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) % 1_000_000_007;
  }
  return choices[Math.abs(hash) % choices.length];
}

function makePayload(size: number): string {
  const word = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. ';
  const repeats = Math.ceil(size / word.length);
  return word.repeat(repeats).slice(0, size);
}

export function makeMetricDefinition(
  metricId: string,
  rootInclusion: 'root_only' | 'inclusive' = 'root_only',
) {
  return {
    metricId,
    version: 1,
    label: metricId,
    description: `${metricId} benchmark metric`,
    family: 'benchmark',
    measurementClass: 'observed' as const,
    unit: 'count',
    valueType: 'integer' as const,
    grain: 'session',
    dimensions: [],
    populationRule: 'all',
    statusRule: 'none',
    aggregation: 'sum',
    statisticalPolicyId: 'benchmark-default',
    comparabilityGroupInputs: [],
    missingDataBehavior: 'unknown' as const,
    rootInclusion,
    provenanceRequirement: 'optional',
  };
}

export function makeMetricValue(
  metricId: string,
  value: number,
  rootScope: 'root_only' | 'inclusive' = 'root_only',
): ScalarMetricValue & {
  readonly grain: string;
  readonly dimensions: Record<string, string>;
  readonly class: 'observed';
  readonly confidence: number;
  readonly rootScope: 'root_only' | 'inclusive';
  readonly evidenceRecordIds: readonly string[];
  readonly provenance: readonly [];
  readonly definition: ReturnType<typeof makeMetricDefinition>;
} {
  return {
    metricId,
    definitionVersion: '1',
    value,
    exact: true,
    unit: 'count',
    comparabilityGroupId: 'cgrp-default',
    grain: 'session',
    dimensions: {},
    class: 'observed',
    confidence: 1,
    rootScope,
    evidenceRecordIds: [],
    provenance: [],
    definition: makeMetricDefinition(metricId, rootScope),
  };
}

function buildSession(
  projectIndex: number,
  sourceIndex: number,
  environmentIndex: number,
  sessionIndex: number,
  scale: BenchmarkScale,
  startMs: number,
  parentSession?: BenchmarkSession,
  depth = 0,
): BenchmarkSession {
  const projectId = `proj-${pad(projectIndex, 4)}`;
  const sourceId = `src-${pad(sourceIndex, 3)}`;
  const environmentId = `env-${pad(environmentIndex, 3)}`;
  const role = parentSession ? `child-${depth}` : 'root';
  const sessionId = `sess-${pad(projectIndex, 4)}-${pad(sessionIndex, 6)}-${role}`;
  const rootSessionId = parentSession ? parentSession.rootSessionId : sessionId;
  const parentSessionId = parentSession?.sessionId;

  const baseTime = startMs + sessionIndex * 60_000;
  const lateRatio = scale.lateArrivalRatio ?? 0;
  const lateOffset = lateRatio > 0 && sessionIndex % 1000 === 0 ? 24 * 60 * 60 * 1000 : 0;
  const startTime = new Date(baseTime - lateOffset).toISOString();
  const endTime = new Date(baseTime + 5 * 60_000).toISOString();

  const harnessSeed = `${projectId}:${sourceId}:${sessionId}`;
  const mode = deterministicChoice(harnessSeed, MODES);
  const taskCohort = deterministicChoice(`${harnessSeed}:cohort`, COHORTS);

  const deleteRatio = scale.deleteRatio ?? 0;
  const isDeleted = deleteRatio > 0 && sessionIndex % 100 === 99;
  const isLateArrival = lateOffset > 0;

  const evidenceCount = parentSession
    ? Math.max(1, Math.floor(scale.evidenceCount / (depth + 2)))
    : scale.evidenceCount;

  return {
    sessionId,
    rootSessionId,
    parentSessionId,
    projectId,
    sourceId,
    environmentId,
    harness: deterministicChoice(harnessSeed, HARNESSES),
    mode,
    taskCohort,
    startTime,
    endTime,
    finality: isDeleted ? 'censored' : 'final',
    inputTokens: 500 + (sessionIndex % 5000),
    outputTokens: 200 + (sessionIndex % 2000),
    cacheCreationTokens: 50 + (sessionIndex % 500),
    cacheReadTokens: 30 + (sessionIndex % 300),
    toolCount: 10 + (sessionIndex % 100),
    filesRead: sessionIndex % 10,
    filesWritten: sessionIndex % 5,
    evidenceCount,
    payloadSize: scale.payloadSize,
    componentCount: scale.componentCount,
    isLateArrival,
    isDeleted,
  };
}

export function generateBenchmarkFixture(scale: BenchmarkScale): BenchmarkFixture {
  const sessions: BenchmarkSession[] = [];
  const projects: string[] = [];
  const sources: string[] = [];
  const environments: string[] = [];
  const rootSessions: BenchmarkSession[] = [];
  const startMs = Date.UTC(2025, 7, 1);

  for (let p = 0; p < scale.projects; p++) {
    projects.push(`proj-${pad(p, 4)}`);
  }
  for (let s = 0; s < scale.sources; s++) {
    sources.push(`src-${pad(s, 3)}`);
  }
  for (let e = 0; e < scale.environments; e++) {
    environments.push(`env-${pad(e, 3)}`);
  }

  let sessionIndex = 0;
  for (let p = 0; p < scale.projects; p++) {
    for (let s = 0; s < scale.sessions; s++) {
      const sourceIndex = s % scale.sources;
      const environmentIndex = s % scale.environments;
      const root = buildSession(p, sourceIndex, environmentIndex, sessionIndex++, scale, startMs);
      sessions.push(root);
      rootSessions.push(root);

      function addChildren(parent: BenchmarkSession, depth: number) {
        if (depth >= scale.childDepth) return;
        for (let c = 0; c < scale.childCount; c++) {
          const child = buildSession(
            p,
            sourceIndex,
            environmentIndex,
            sessionIndex++,
            scale,
            startMs,
            parent,
            depth + 1,
          );
          sessions.push(child);
          addChildren(child, depth + 1);
        }
      }
      addChildren(root, 0);
    }
  }

  return {
    sessions,
    rootSessions,
    projects,
    sources,
    environments,
    scale,
  };
}

export async function getManualBundle(session: BenchmarkSession): Promise<ManualIngestionBundle> {
  const content = JSON.stringify({ sessionId: session.sessionId, seed: session.sessionId });
  const sha256 = await sha256Hex(new TextEncoder().encode(content) as Uint8Array<ArrayBuffer>);
  const source: SourceIdentity = {
    sourceId: session.sourceId,
    environmentId: session.environmentId,
    projectId: session.projectId,
    sessionId: session.sessionId,
  };

  return {
    artifacts: [
      {
        relativePath: 'transcript.jsonl',
        mediaType: 'application/jsonl',
        content,
        sha256,
        size: content.length,
        status: 'uploaded',
      },
    ],
    source,
    harness: session.harness,
    projectId: session.projectId,
    sessionId: session.sessionId,
  };
}

export class BenchmarkTransformer implements SessionTransformer<UnknownArtifactBundle> {
  readonly id = 'benchmark-transformer';
  readonly harnesses = Array.from(HARNESSES) as readonly string[];
  readonly transformerVersion = '0.1.0';
  readonly ontologyVersion = '0.1.0';
  private readonly sessionsById = new Map<string, BenchmarkSession>();

  addFixture(fixture: BenchmarkFixture): void {
    for (const session of fixture.sessions) {
      this.sessionsById.set(session.sessionId, session);
    }
  }

  addSession(session: BenchmarkSession): void {
    this.sessionsById.set(session.sessionId, session);
  }

  detect(_bundle: UnknownArtifactBundle): DetectionResult {
    return { kind: 'matched', harness: this.harnesses[0] ?? 'claude-code', confidence: 1 };
  }

  classifyArtifacts(_bundle: UnknownArtifactBundle): ArtifactClassificationResult {
    return {
      artifacts: [],
      configurationSnapshot: { completeness: {}, components: [] },
      components: [],
    };
  }

  getCapabilities(): MetricCapability[] {
    return [];
  }

  transform(bundle: UnknownArtifactBundle, _context: TransformContext): TransformResult {
    const sessionId = bundle.sourceIdentity?.sessionId ?? 'session-unknown';
    const session = this.sessionsById.get(sessionId);
    if (!session) {
      return {
        bundleHash: '',
        parserId: 'benchmark',
        parserVersion: '0.1.0',
        transformerId: this.id,
        transformerVersion: this.transformerVersion,
        ontologyVersion: this.ontologyVersion,
        metricDefinitionVersion: '0.1.0',
        evidence: [],
        sessionSummaries: [],
        componentSummaries: [],
        metricValues: [],
        distributions: [],
        configurationSnapshot: { completeness: {}, components: [] },
        capabilities: [],
        unavailableReasons: [],
        provenance: [],
        warnings: [],
        errors: [{ code: 'unknown_session', severity: 'fatal', message: sessionId }],
      };
    }

    const rootSession: SessionSummary = {
      sessionId: session.sessionId,
      rootSessionId: session.rootSessionId,
      parentSessionId: session.parentSessionId,
      harness: session.harness,
      startTime: session.startTime,
      endTime: session.endTime,
      finality: session.finality,
    };

    const summaries: SessionSummary[] = [rootSession];
    if (session.sessionId === session.rootSessionId) {
      for (const child of this.sessionsById.values()) {
        if (
          child.rootSessionId === session.rootSessionId &&
          child.sessionId !== session.sessionId
        ) {
          summaries.push({
            sessionId: child.sessionId,
            rootSessionId: child.rootSessionId,
            parentSessionId: child.parentSessionId,
            harness: child.harness,
            startTime: child.startTime,
            endTime: child.endTime,
            finality: child.finality,
          });
        }
      }
    }

    const metricValues: ScalarMetricValue[] = [
      makeMetricValue('input_tokens', session.inputTokens, 'root_only'),
      makeMetricValue('output_tokens', session.outputTokens, 'root_only'),
      makeMetricValue('cache_creation_tokens', session.cacheCreationTokens, 'root_only'),
      makeMetricValue('cache_read_tokens', session.cacheReadTokens, 'root_only'),
      makeMetricValue('total_tokens', session.inputTokens + session.outputTokens, 'inclusive'),
      makeMetricValue('tool_count', session.toolCount, 'root_only'),
      makeMetricValue('files_read', session.filesRead, 'root_only'),
      makeMetricValue('files_written', session.filesWritten, 'root_only'),
    ];

    const evidence: NormalizedEvidenceRecord[] = [];
    for (let i = 0; i < session.evidenceCount; i++) {
      evidence.push({
        recordId: `ev-${session.sessionId}-${i}`,
        recordType: i % 3 === 0 ? 'message' : i % 3 === 1 ? 'tool_execution' : 'model_request',
        sessionId: session.sessionId,
        sourceEventId: `event-${i}`,
        provenance: {},
        payload: makePayload(session.payloadSize),
      });
    }

    const components: ComponentSummary[] = [];
    for (let i = 0; i < session.componentCount; i++) {
      components.push({
        componentId: `comp-${session.sessionId}-${i}`,
        kind: 'model',
        identity: { canonicalId: `comp-${i}` },
        version: '1.0.0',
        sourceArtifactIds: ['transcript.jsonl'],
      });
    }

    const completeness: Record<string, 'complete' | 'partial' | 'unavailable' | 'unsupported'> = {};
    const kinds = ['transcript', 'usage', 'tools', 'subagents', 'files'];
    for (let i = 0; i < kinds.length; i++) {
      completeness[kinds[i]] = i % 2 === 0 ? 'complete' : 'partial';
    }

    return {
      bundleHash: '',
      parserId: 'benchmark',
      parserVersion: '0.1.0',
      transformerId: this.id,
      transformerVersion: this.transformerVersion,
      ontologyVersion: this.ontologyVersion,
      metricDefinitionVersion: '0.1.0',
      evidence,
      sessionSummaries: summaries,
      componentSummaries: components,
      metricValues,
      distributions: [],
      configurationSnapshot: {
        completeness,
        components,
        temporalRole: 'post_session',
      },
      capabilities: [],
      unavailableReasons: [],
      provenance: [],
      warnings: [],
      errors: [],
    };
  }
}
